/**
 * The run history of a repository checkout and the data files its latest run needs. No DuckDB
 * and no data API here: the eval CLI checks the files with this before it builds a model client or creates its
 * output folder, and local-data.ts checks them before it stages anything, so a checkout without the run's data/
 * (a worktree has runs/ but no data/) fails with a message that names the first missing file and how to point at a
 * checkout that has them, instead of DuckDB's ENOENT.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** The run history, relative to the repository root. */
export const RUN_HISTORY = "runs/run_history.jsonl";

export interface RunHistoryRow {
  run_id: string;
  parquet_sha256: string;
  /** Relative to the repository root, e.g. data/out/<run_id>/<name>.parquet. */
  parquet_path: string;
  /** Relative to the repository root, e.g. runs/<run_id>/run_manifest.json. */
  manifest_path: string;
  /** The run's permit Parquet files: role, path relative to the repository root, sha256. */
  permit_files?: Array<{ role: string; path: string; sha256: string }>;
}

/** runs/run_history.jsonl has no run, or a line that is not JSON. */
export class RunHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunHistoryError";
  }
}

/** The latest row of runs/run_history.jsonl: the run the data API serves. */
export function latestRun(repoRoot: string): RunHistoryRow {
  const file = join(repoRoot, RUN_HISTORY);
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .map((l, i) => ({ l: l.trim(), n: i + 1 }))
    .filter(({ l }) => l !== "")
    .map(({ l, n }) => {
      try {
        return JSON.parse(l) as RunHistoryRow;
      } catch {
        throw new RunHistoryError(`${file} line ${n} is not JSON`);
      }
    });
  const latest = rows.at(-1);
  if (!latest) throw new RunHistoryError(`${file} has no run`);
  return latest;
}

/** A history path (relative to the repository root, or absolute) as a file path. */
export function underRepo(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : join(repoRoot, p);
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * The files the latest run needs that are missing under `repoRoot`, as the history writes them (relative to the
 * repository root, or absolute), in order: runs/run_history.jsonl alone when the history itself is missing, else
 * the run's parquet_path, manifest_path and every permit_files path. A broken symbolic link counts as missing.
 * Empty when all are there. Reads only the history; creates nothing. Throws RunHistoryError for a history with no
 * run or a line that is not JSON.
 */
export function missingRunFiles(repoRoot: string): string[] {
  const root = resolve(repoRoot);
  if (!isFile(join(root, RUN_HISTORY))) return [RUN_HISTORY];
  const run = latestRun(root);
  return [
    run.parquet_path,
    run.manifest_path,
    ...(run.permit_files ?? []).map((f) => f.path),
  ].filter((p) => !isFile(underRepo(root, p)));
}

/** "the run's data files are missing under <repo> (first missing: <path>; N missing)", shared by both messages. */
export function runFilesMissingText(
  repoRoot: string,
  missing: readonly string[],
): string {
  return `the run's data files are missing under ${repoRoot} (first missing: ${missing[0]}; ${missing.length} missing)`;
}

/** The latest run's data files are missing under a checkout (openLocalData, before anything is staged). */
export class RunFilesMissingError extends Error {
  readonly repoRoot: string;
  readonly missing: readonly string[];
  constructor(repoRoot: string, missing: readonly string[]) {
    super(
      `${runFilesMissingText(repoRoot, missing)}. Point at a checkout that has them: ORACLE_REPO_DIR=<checkout>.`,
    );
    this.name = "RunFilesMissingError";
    this.repoRoot = repoRoot;
    this.missing = missing;
  }
}
