import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PermitFile, PermitRole } from "../src/db.ts";

export const REPO = new URL("../../../", import.meta.url).pathname;

/** The latest run in runs/run_history.jsonl: the run the data API serves (as apps/api/cdk/bin/app.ts). */
const latest = (
  readFileSync(join(REPO, "runs/run_history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l)) as Array<{
    run_id: string;
    parquet_path: string;
    parquet_sha256: string;
    manifest_path: string;
    permit_files?: Array<{ role: PermitRole; path: string; sha256: string }>;
  }>
).at(-1)!;
export const RUN_ID = latest.run_id;
export const PARQUET_SHA256 = latest.parquet_sha256;
export const PARQUET_FILE = basename(latest.parquet_path);
/** The latest run's permit Parquet files, as the CDK app passes them (PERMIT_FILES). */
export const PERMIT_FILES: PermitFile[] = (latest.permit_files ?? []).map(
  (f) => ({ role: f.role, file: basename(f.path), sha256: f.sha256 }),
);
/** The run's Parquet under the gitignored data/ (relative to the repo, as in the history row). */
export const PARQUET_PATH = latest.parquet_path;
const parquet = join(REPO, latest.parquet_path);
export const hasRealData =
  existsSync(parquet) &&
  (latest.permit_files ?? []).every((f) => existsSync(join(REPO, f.path)));

/** The temporary folders a test file makes; removeAll() deletes each one and everything in it. */
export interface TempFolders {
  make(): string;
  removeAll(): void;
}

/**
 * New temporary folders named prefix + a random suffix under parent (the DuckDB temp folders, api-tmp-). Each
 * caller calls removeAll() in an afterAll, which also runs when a test or a beforeAll fails.
 */
export function tempFolders(
  prefix = "api-tmp-",
  parent = tmpdir(),
): TempFolders {
  const dirs: string[] = [];
  return {
    make() {
      const dir = mkdtempSync(join(parent, prefix));
      dirs.push(dir);
      return dir;
    },
    removeAll() {
      for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A staged copy of run files in its own temporary folder; remove() deletes the folder and everything in it. */
export interface Staged {
  dir: string;
  remove(): void;
}

/**
 * Copy each [source path, file name] pair into a new temporary folder under parent. If a copy fails, the
 * folder is removed before the error is rethrown, so a failed staging leaves nothing behind.
 */
export function stageFiles(
  files: Array<[string, string]>,
  parent = tmpdir(),
): Staged {
  const dir = mkdtempSync(join(parent, "api-data-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  try {
    for (const [src, name] of files) copyFileSync(src, join(dir, name));
  } catch (e) {
    remove();
    throw e;
  }
  return { dir, remove };
}

/**
 * Stage the real run files (gitignored data/) the way the Lambda sees them after the S3 copy. The copy holds
 * the full run files, so every caller calls remove() when done, in an afterAll (it also runs when a test fails).
 */
export function stageRealData(): Staged {
  return stageFiles([
    [parquet, PARQUET_FILE],
    ...(latest.permit_files ?? []).map((f): [string, string] => [
      join(REPO, f.path),
      basename(f.path),
    ]),
    [join(REPO, latest.manifest_path), "run_manifest.json"],
    [join(REPO, "runs/run_history.jsonl"), "run_history.jsonl"],
  ]);
}
