import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = new URL("../../../", import.meta.url).pathname;
export const RUN_ID = "2026-11-11T16-17-38-928Z";
export const PARQUET_SHA256 =
  "8a7f8d817100e70200b2a9932820a0d38f2ab55de2c20fefdf3ef51d3cf4eaa5";
const parquet = join(
  REPO,
  "data/out",
  RUN_ID,
  "los-angeles_property_roll2026_slice.parquet",
);
export const hasRealData = existsSync(parquet);

/** Stage the real run files (gitignored data/) the way the Lambda sees them after the S3 copy. */
export function stageRealData(): string {
  const dir = mkdtempSync(join(tmpdir(), "api-data-"));
  copyFileSync(
    parquet,
    join(dir, "los-angeles_property_roll2026_slice.parquet"),
  );
  copyFileSync(
    join(REPO, "runs", RUN_ID, "run_manifest.json"),
    join(dir, "run_manifest.json"),
  );
  copyFileSync(
    join(REPO, "runs/run_history.jsonl"),
    join(dir, "run_history.jsonl"),
  );
  return dir;
}
