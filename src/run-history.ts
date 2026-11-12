/**
 * Run history (runs/run_history.jsonl): one row per run ID. Rebuilding a run that is already
 * recorded with the same Parquet sha256 adds nothing; the same run ID with a different Parquet
 * fails, because a changed build needs a new run ID. Paths are parameters so tests can use a
 * temporary directory.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface HistoryRow {
  run_id: string;
  parquet_path?: string;
  parquet_sha256?: string;
  [key: string]: unknown;
}

export type HistoryPlan =
  /** Same run ID and same Parquet sha256: already recorded, nothing to add. */
  | { kind: "recorded"; row: HistoryRow }
  /** A run ID not yet in the history; `previous` is the last recorded run, if any. */
  | { kind: "new"; previous: HistoryRow | undefined };

export function readHistory(historyPath: string): HistoryRow[] {
  if (!existsSync(historyPath)) return [];
  return readFileSync(historyPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HistoryRow);
}

export function planHistory(
  history: HistoryRow[],
  runId: string,
  parquetSha256: string,
): HistoryPlan {
  const same = history.filter((r) => r.run_id === runId);
  if (same.length === 0) return { kind: "new", previous: history.at(-1) };
  const other = same.find((r) => r.parquet_sha256 !== parquetSha256);
  if (other)
    throw new Error(
      `run ${runId} is already in the run history with Parquet sha256 ${other.parquet_sha256 ?? "(none)"}; ` +
        `this build gives ${parquetSha256}. A changed build needs a new run ID.`,
    );
  return { kind: "recorded", row: same.at(-1)! };
}

/** Append the row unless its run is already recorded with the same Parquet sha256. */
export function appendRunHistory(
  historyPath: string,
  row: HistoryRow & { parquet_sha256: string },
): "added" | "already-recorded" {
  const plan = planHistory(
    readHistory(historyPath),
    row.run_id,
    row.parquet_sha256,
  );
  if (plan.kind === "recorded") return "already-recorded";
  appendFileSync(historyPath, JSON.stringify(row) + "\n");
  return "added";
}
