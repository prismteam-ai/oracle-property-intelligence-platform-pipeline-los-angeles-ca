/**
 * Data access: stream the run files from S3 to /tmp at cold start (the Parquet's sha256 is computed on the
 * stream and verified), open DuckDB, create the shared views, then lock DuckDB down to exactly those files.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { CONTRACT, propertyViewsSql, runViewsSql } from "@oracle-la/views";
import type { Db } from "./db-types.ts";

export interface DataConfig {
  runId: string;
  parquetSha256: string;
  /** The run's Parquet file name (the base name of parquet_path in runs/run_history.jsonl). */
  parquetFile: string;
  /** S3 source; omitted when localDir is set (tests, local runs). */
  bucket?: string;
  prefix?: string;
  localDir?: string;
  tmpDir?: string;
}

export type { Db };

/** A plain Parquet file name: no directory part, so it names one object under the run prefix. */
const PARQUET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.parquet$/;
const runFiles = (parquetFile: string) =>
  ({
    parquet: parquetFile,
    manifest: "run_manifest.json",
    history: "run_history.jsonl",
  }) as const;
type FileKey = keyof ReturnType<typeof runFiles>;

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

/** The local paths of the run files and the Parquet's sha256 (computed while copying, or read once locally). */
async function fetchFiles(
  cfg: DataConfig,
  s3: S3Client,
): Promise<{ paths: Record<FileKey, string>; parquetSha256: string }> {
  if (!PARQUET_FILE.test(cfg.parquetFile))
    throw new Error(
      `bad Parquet file name: ${JSON.stringify(cfg.parquetFile)}`,
    );
  const files = runFiles(cfg.parquetFile);
  const dir =
    cfg.localDir ?? join(cfg.tmpDir ?? "/tmp", "oracle-data", cfg.runId);
  const paths = Object.fromEntries(
    Object.entries(files).map(([k, f]) => [k, join(dir, f)]),
  ) as Record<FileKey, string>;
  if (cfg.localDir) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(paths.parquet))
      hash.update(chunk as Buffer);
    return { paths, parquetSha256: hash.digest("hex") };
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
  return {
    paths,
    parquetSha256: Object.fromEntries(digests).parquet!,
  };
}

export async function openDb(
  cfg: DataConfig,
  s3: S3Client = new S3Client({}),
): Promise<Db> {
  const t0 = Date.now();
  const { paths: files, parquetSha256: got } = await fetchFiles(cfg, s3);
  if (got !== cfg.parquetSha256)
    throw new Error(
      `parquet sha256 mismatch: expected ${cfg.parquetSha256}, got ${got}`,
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
    runViewsSql({ runManifest: files.manifest, runHistory: files.history }),
  );
  // Lockdown: allow exactly the three files, then forbid any other file access and freeze settings.
  const list = [files.parquet, files.manifest, files.history]
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
  for (const v of CONTRACT.views) await rows(`select 1 from ${v} limit 1`);
  return {
    rows,
    runId: cfg.runId,
    parquetSha256: got,
    rollYear: years[0]!,
    loadMs: Date.now() - t0,
  };
}
