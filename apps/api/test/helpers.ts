import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
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

/** Stage the real run files (gitignored data/) the way the Lambda sees them after the S3 copy. */
export function stageRealData(): string {
  const dir = mkdtempSync(join(tmpdir(), "api-data-"));
  copyFileSync(parquet, join(dir, PARQUET_FILE));
  for (const f of latest.permit_files ?? [])
    copyFileSync(join(REPO, f.path), join(dir, basename(f.path)));
  copyFileSync(
    join(REPO, latest.manifest_path),
    join(dir, "run_manifest.json"),
  );
  copyFileSync(
    join(REPO, "runs/run_history.jsonl"),
    join(dir, "run_history.jsonl"),
  );
  return dir;
}
