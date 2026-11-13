/**
 * Run history (runs/run_history.jsonl): one row per run ID. Rebuilding a run that is already
 * recorded with the same Parquet sha256 adds nothing; the same run ID with a different Parquet
 * fails, because a changed build needs a new run ID. A permit run also records its permit
 * Parquet files (permit_files), and they must match too; rows written before permits lack them.
 * Paths are parameters so tests can use a temporary directory.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface HistoryFile {
  role: string;
  path: string;
  sha256: string;
}

export interface HistoryRow {
  run_id: string;
  parquet_path?: string;
  parquet_sha256?: string;
  /** Permit runs only: the permit Parquet files; absent in earlier rows. */
  permit_files?: HistoryFile[];
  [key: string]: unknown;
}

const fileDigests = (files: HistoryFile[] | undefined) =>
  JSON.stringify(
    (files ?? [])
      .map((f) => [f.role, f.sha256])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
  );

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
  permitFiles?: HistoryFile[],
): HistoryPlan {
  const same = history.filter((r) => r.run_id === runId);
  if (same.length === 0) return { kind: "new", previous: history.at(-1) };
  const other = same.find((r) => r.parquet_sha256 !== parquetSha256);
  if (other)
    throw new Error(
      `run ${runId} is already in the run history with Parquet sha256 ${other.parquet_sha256 ?? "(none)"}; ` +
        `this build gives ${parquetSha256}. A changed build needs a new run ID.`,
    );
  const permitsDiffer = same.find(
    (r) => fileDigests(r.permit_files) !== fileDigests(permitFiles),
  );
  if (permitsDiffer)
    throw new Error(
      `run ${runId} is already in the run history with other permit files; a changed build needs a new run ID.`,
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
    row.permit_files,
  );
  if (plan.kind === "recorded") return "already-recorded";
  appendFileSync(historyPath, JSON.stringify(row) + "\n");
  return "added";
}
