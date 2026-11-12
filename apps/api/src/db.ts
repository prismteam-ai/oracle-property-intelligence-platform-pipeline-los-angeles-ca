/**
 * Data access: copy the run files from S3 to /tmp at cold start (sha256-verified), open DuckDB,
 * create the shared views, then lock DuckDB down to exactly those files.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { CONTRACT, propertyViewsSql, runViewsSql } from "@oracle-la/views";
import type { Db } from "./db-types.ts";

export interface DataConfig {
  runId: string;
  parquetSha256: string;
  /** S3 source; omitted when localDir is set (tests, local runs). */
  bucket?: string;
  prefix?: string;
  localDir?: string;
  tmpDir?: string;
}

export type { Db };

const FILES = {
  parquet: "los-angeles_property_roll2026_slice.parquet",
  manifest: "run_manifest.json",
  history: "run_history.jsonl",
} as const;

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

export const sha256 = (b: Buffer): string =>
  createHash("sha256").update(b).digest("hex");

async function fetchFiles(
  cfg: DataConfig,
  s3: S3Client,
): Promise<Record<keyof typeof FILES, string>> {
  const dir =
    cfg.localDir ?? join(cfg.tmpDir ?? "/tmp", "oracle-data", cfg.runId);
  if (cfg.localDir)
    return {
      parquet: join(dir, FILES.parquet),
      manifest: join(dir, FILES.manifest),
      history: join(dir, FILES.history),
    };
  mkdirSync(dir, { recursive: true });
  const out = {} as Record<keyof typeof FILES, string>;
  await Promise.all(
    (Object.keys(FILES) as Array<keyof typeof FILES>).map(async (k) => {
      const res = await s3.send(
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: `${cfg.prefix ?? ""}${FILES[k]}`,
        }),
      );
      const bytes = Buffer.from(await res.Body!.transformToByteArray());
      const path = join(dir, FILES[k]);
      writeFileSync(path, bytes);
      out[k] = path;
    }),
  );
  return out;
}

export async function openDb(
  cfg: DataConfig,
  s3: S3Client = new S3Client({}),
): Promise<Db> {
  const t0 = Date.now();
  const files = await fetchFiles(cfg, s3);
  const got = sha256(readFileSync(files.parquet));
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
