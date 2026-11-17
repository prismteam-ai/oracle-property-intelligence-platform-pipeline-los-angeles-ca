/**
 * The run under test and the numbers measured on one run.
 *
 * The run under test is the latest row of runs/run_history.jsonl: the run the data API serves
 * (apps/api/cdk/bin/app.ts) and the one the real-data tests open. Its manifest gives the counts the build recorded
 * (rows, pages, permit and contractor rows, the reference date, the permit coverage).
 *
 * A number written in a real-data test was measured by hand on MEASURED_RUN. It is the expected value only when the
 * run under test was built from the same input caches (by sha256): then any difference is a change in the code. On
 * other inputs the test checks the value against the run itself (plain SQL on the views, another route, the
 * manifest), and measured() leaves the written number out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { REPO } from "./helpers.ts";

/** The run the written numbers were measured on: the rebuild of the 12 Nov 2026 permit run. */
export const MEASURED_RUN = "2026-11-12T14-00-51-383Z-bc7f18f2e9cf2";

interface CacheFiles {
  files: Array<{ path: string; sha256: string }>;
  rows: number;
  pages: unknown[];
}
/** The parts of a run manifest the tests read. */
export interface RunManifest {
  run_id: string;
  run_kind?: string;
  rebuild_of?: string | null;
  source_changes?: string | null;
  cache: { manifest: { sha256: string; pages: number } };
  permit_caches?: {
    permits: CacheFiles;
    contractors: CacheFiles & { staged: number };
  };
  row_counts: { parquet: number; raw_pages: number };
  permits?: { reference_date: string };
  coverage: {
    permit_data?: {
      parcels_with_permit_data: number;
      parcels_without_permit_data: number;
      parcels_with_permits: number;
    };
  };
}

export interface HistoryRow {
  run_id: string;
  manifest_path: string;
  run_kind?: string;
  rebuild_of?: string | null;
  source_changes?: string | null;
}

/** runs/run_history.jsonl, oldest first (recorded rows; never edited). */
export const HISTORY: HistoryRow[] = readFileSync(
  join(REPO, "runs/run_history.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as HistoryRow);

const readManifest = (path: string) =>
  JSON.parse(readFileSync(join(REPO, path), "utf8")) as RunManifest;

/** The run under test's manifest (the latest history row's). */
export const MANIFEST = readManifest(HISTORY.at(-1)!.manifest_path);
const MEASURED = readManifest(`runs/${MEASURED_RUN}/run_manifest.json`);

const files = (m: RunManifest, k: "permits" | "contractors") =>
  JSON.stringify(m.permit_caches?.[k].files ?? null);
/**
 * REAL_DATA_AS_NEW=1 treats the run under test as built from new inputs, so every measured() value is left out:
 * it shows that each test's own checks against the run stand without the written numbers.
 */
const AS_NEW = process.env.REAL_DATA_AS_NEW === "1";
/** True when the run under test was built from MEASURED_RUN's roll cache. */
export const SAME_ROLL =
  !AS_NEW && MANIFEST.cache.manifest.sha256 === MEASURED.cache.manifest.sha256;
/** True when it was built from all of MEASURED_RUN's caches: the roll, the permits and the contractor view. */
export const SAME_INPUTS =
  SAME_ROLL &&
  files(MANIFEST, "permits") === files(MEASURED, "permits") &&
  files(MANIFEST, "contractors") === files(MEASURED, "contractors");

/** The run under test's counts as its build recorded them. */
export const RUN = {
  rows: MANIFEST.row_counts.parquet,
  rollPages: MANIFEST.cache.manifest.pages,
  permits: MANIFEST.permit_caches!.permits.rows,
  permitPages: MANIFEST.permit_caches!.permits.pages.length,
  contractorRows: MANIFEST.permit_caches!.contractors.staged,
  contractorPages: MANIFEST.permit_caches!.contractors.pages.length,
  referenceDate: MANIFEST.permits!.reference_date,
  permitData: MANIFEST.coverage.permit_data!,
};

/**
 * A value measured on MEASURED_RUN: itself when the run under test has the same inputs ("roll": the same roll
 * cache is enough), else any value (the test's own check against the run applies). Compare with toEqual.
 */
export function measured<T>(value: T, inputs: "roll" | "all" = "all"): T {
  return (inputs === "roll" ? SAME_ROLL : SAME_INPUTS)
    ? value
    : (expect.anything() as T);
}

/** n in the answers' number format (en-US thousands commas). */
export const fmt = (n: number) => n.toLocaleString("en-US");
