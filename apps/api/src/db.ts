/**
 * Data access: stream the run files from S3 to /tmp at cold start (each Parquet's sha256 is computed on the
 * stream and verified), open DuckDB, create the shared views, then lock DuckDB down to exactly those files.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  CONTRACT,
  permitViewsSql,
  propertyViewsSql,
  runViewsSql,
} from "@oracle-la/views";
import type { Db } from "./db-types.ts";

/** The permit Parquet roles of a permit run, as in the permit_files of its runs/run_history.jsonl row. */
export const PERMIT_ROLES = [
  "permits",
  "permit_parcels",
  "permit_contractors",
] as const;
export type PermitRole = (typeof PERMIT_ROLES)[number];
/** One permit Parquet: its role, its file name under the run prefix and its sha256. */
export interface PermitFile {
  role: PermitRole;
  file: string;
  sha256: string;
}

export interface DataConfig {
  runId: string;
  parquetSha256: string;
  /** The run's Parquet file name (the base name of parquet_path in runs/run_history.jsonl). */
  parquetFile: string;
  /** The run's three permit Parquet files, one per role. */
  permitFiles: PermitFile[];
  /** S3 source; omitted when localDir is set (tests, local runs). */
  bucket?: string;
  prefix?: string;
  localDir?: string;
  tmpDir?: string;
}

export type { Db };

/** A plain Parquet file name: no directory part, so it names one object under the run prefix. */
const PARQUET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.parquet$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The permit files from their JSON form (the PERMIT_FILES environment variable): exactly one entry per
 * role, each a plain Parquet file name and a sha256. Anything else fails before any S3 call.
 */
export function parsePermitFiles(json: string): PermitFile[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error("bad permit files: not JSON");
  }
  const ok =
    Array.isArray(v) &&
    v.length === PERMIT_ROLES.length &&
    PERMIT_ROLES.every(
      (role) =>
        v.filter(
          (f: Partial<PermitFile> | null) =>
            f?.role === role &&
            typeof f.file === "string" &&
            PARQUET_FILE.test(f.file) &&
            typeof f.sha256 === "string" &&
            SHA256.test(f.sha256) &&
            Object.keys(f).length === 3,
        ).length === 1,
    );
  if (!ok)
    throw new Error(
      `bad permit files: expected one {role, file, sha256} for each of ${PERMIT_ROLES.join(", ")}`,
    );
  return v as PermitFile[];
}

const runFiles = (cfg: DataConfig) => {
  const byRole = Object.fromEntries(
    cfg.permitFiles.map((f) => [f.role, f]),
  ) as Partial<Record<PermitRole, PermitFile>>;
  for (const f of [cfg.parquetFile, ...cfg.permitFiles.map((p) => p.file)])
    if (!PARQUET_FILE.test(f))
      throw new Error(`bad Parquet file name: ${JSON.stringify(f)}`);
  if (
    cfg.permitFiles.length !== PERMIT_ROLES.length ||
    PERMIT_ROLES.some((r) => !byRole[r])
  )
    throw new Error(
      `bad permit files: expected one for each of ${PERMIT_ROLES.join(", ")}`,
    );
  return {
    parquet: cfg.parquetFile,
    permits: byRole.permits!.file,
    permit_parcels: byRole.permit_parcels!.file,
    permit_contractors: byRole.permit_contractors!.file,
    manifest: "run_manifest.json",
    history: "run_history.jsonl",
  } as const;
};
type FileKey = keyof ReturnType<typeof runFiles>;
/** The run files whose sha256 is verified: the four Parquet files. */
const VERIFIED: FileKey[] = [
  "parquet",
  "permits",
  "permit_parcels",
  "permit_contractors",
];

/** JSON-safe values: BIGINT -> number (all counts are far below 2^53), dates -> ISO 8601 UTC, other DuckDB values -> string. */
export function toPlain(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toPlain);
  if (v && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null)
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, toPlain(x)]),
      );
    return String(v);
  }
  return v;
}

/** Pipe a stream to a file, computing its sha256 on the way: one pass, never the whole object in memory. */
async function copyHashed(src: Readable, path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    src,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(path),
  );
  return hash.digest("hex");
}

/** sha256 of a local file, read as a stream. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The local paths of the run files and the Parquet files' sha256 (computed while copying, or read once locally). */
async function fetchFiles(
  cfg: DataConfig,
  s3: S3Client,
): Promise<{
  paths: Record<FileKey, string>;
  sha256: Partial<Record<FileKey, string>>;
}> {
  const files = runFiles(cfg);
  const dir =
    cfg.localDir ?? join(cfg.tmpDir ?? "/tmp", "oracle-data", cfg.runId);
  const paths = Object.fromEntries(
    Object.entries(files).map(([k, f]) => [k, join(dir, f)]),
  ) as Record<FileKey, string>;
  if (cfg.localDir) {
    const sha256: Partial<Record<FileKey, string>> = {};
    for (const k of VERIFIED) sha256[k] = await hashFile(paths[k]);
    return { paths, sha256 };
  }
  mkdirSync(dir, { recursive: true });
  const digests = await Promise.all(
    (Object.keys(files) as FileKey[]).map(async (k) => {
      const res = await s3.send(
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: `${cfg.prefix ?? ""}${files[k]}`,
        }),
      );
      if (!res.Body) throw new Error(`S3 object ${files[k]} has no body`);
      return [k, await copyHashed(res.Body as Readable, paths[k])] as const;
    }),
  );
  return { paths, sha256: Object.fromEntries(digests) };
}

export async function openDb(
  cfg: DataConfig,
  s3: S3Client = new S3Client({}),
): Promise<Db> {
  const t0 = Date.now();
  const { paths: files, sha256: got } = await fetchFiles(cfg, s3);
  const expected: Partial<Record<FileKey, string>> = {
    parquet: cfg.parquetSha256,
    ...Object.fromEntries(cfg.permitFiles.map((f) => [f.role, f.sha256])),
  };
  for (const k of VERIFIED)
    if (got[k] !== expected[k])
      throw new Error(
        `${k === "parquet" ? "parquet" : `${k} parquet`} sha256 mismatch: expected ${expected[k]}, got ${got[k]}`,
      );

  const instance = await DuckDBInstance.create(":memory:", {
    threads: "2",
    memory_limit: "512MB",
    home_directory: cfg.tmpDir ?? "/tmp",
    temp_directory: join(cfg.tmpDir ?? "/tmp", "duckdb"),
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  });
  const c: DuckDBConnection = await instance.connect();
  await c.run(propertyViewsSql({ propertyParquet: files.parquet }));
  await c.run(
    permitViewsSql({
      permitsParquet: files.permits,
      permitParcelsParquet: files.permit_parcels,
      permitContractorsParquet: files.permit_contractors,
    }),
  );
  await c.run(
    runViewsSql({ runManifest: files.manifest, runHistory: files.history }),
  );
  // Lockdown: allow exactly the six run files, then forbid any other file access and freeze settings.
  const list = Object.values(files)
    .map((p) => `'${p.replace(/'/g, "''")}'`)
    .join(", ");
  await c.run(
    `set allowed_paths = [${list}]; set enable_external_access = false; set lock_configuration = true;`,
  );

  const rows = async (sql: string, params?: unknown[]) =>
    (await c.runAndReadAll(sql, params as never))
      .getRowObjectsJS()
      .map((r) => toPlain(r) as Record<string, unknown>);
  const years = (
    await rows(
      "select distinct roll_year from oracle.v_property where roll_year is not null",
    )
  ).map((r) => Number(r.roll_year));
  if (years.length !== 1)
    throw new Error(`expected one roll year, found ${years.join(",")}`);
  const [run] = await rows(
    "select cast(derived_field_reference_date as varchar) as d from oracle.v_run",
  );
  const referenceDate = String(run?.d ?? "");
  if (!/^\d{4}-\d\d-\d\d$/.test(referenceDate))
    throw new Error(
      `the run manifest has no reference date (derived_field_reference_date)`,
    );
  for (const v of CONTRACT.views) await rows(`select 1 from ${v} limit 1`);
  return {
    rows,
    runId: cfg.runId,
    parquetSha256: got.parquet!,
    permitFiles: PERMIT_ROLES.map((role) => ({
      role,
      sha256: got[role]!,
    })),
    rollYear: years[0]!,
    referenceDate,
    loadMs: Date.now() - t0,
  };
}
