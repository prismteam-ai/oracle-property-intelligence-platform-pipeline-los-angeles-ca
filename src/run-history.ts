/**
 * Run history (runs/run_history.jsonl): one row per run ID. Rebuilding a run that is already
 * recorded with the same Parquet sha256 adds nothing; the same run ID with a different Parquet
 * fails, because a changed build needs a new run ID. A permit run also records its permit
 * Parquet files (permit_files), and they must match too; rows written before permits lack them.
 *
 * Run IDs carry a build digest (src/run-config.ts), so a changed build gets a new ID by itself.
 * Rows recorded before the digest (no build_digest) keep their IDs: a build whose Parquet and
 * permit files equal such a row's is that run, already recorded, and adds no row.
 *
 * A new row records how it relates to the previous run: run_kind ("rebuild" when every input cache
 * digest equals the previous run's, else "new data"), rebuild_of, source_changes and the schema
 * changes per table. Rows are appended in finished_at order, so the last line is the latest run.
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
  finished_at?: string;
  parquet_path?: string;
  parquet_sha256?: string;
  /** Permit runs only: the permit Parquet files; absent in earlier rows. */
  permit_files?: HistoryFile[];
  /** Runs recorded with a build digest only (src/run-config.ts buildDigest). */
  build_digest?: string;
  [key: string]: unknown;
}

const fileDigests = (files: HistoryFile[] | undefined) =>
  JSON.stringify(
    (files ?? [])
      .map((f) => [f.role, f.sha256])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
  );

/** True when the row records this Parquet sha256 and these permit files (by role and sha256). */
export function hasSameFiles(
  row: HistoryRow,
  parquetSha256: string,
  permitFiles?: HistoryFile[],
): boolean {
  return (
    row.parquet_sha256 === parquetSha256 &&
    fileDigests(row.permit_files) === fileDigests(permitFiles)
  );
}

export type HistoryPlan =
  /** Already recorded (same run ID, or a run recorded before the build digest with the same files). */
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
  if (same.length === 0) {
    // A run recorded before the build digest, with the same files, is this build under its old ID.
    const recorded = history.find(
      (r) =>
        r.build_digest === undefined &&
        hasSameFiles(r, parquetSha256, permitFiles),
    );
    if (recorded) return { kind: "recorded", row: recorded };
    return { kind: "new", previous: history.at(-1) };
  }
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

const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const finishedMs = (r: { run_id: string; finished_at?: unknown }) => {
  if (typeof r.finished_at !== "string" || !ISO_MS.test(r.finished_at))
    throw new Error(`run ${r.run_id} has no ISO finished_at`);
  return Date.parse(r.finished_at);
};

/**
 * Append the row unless its run is already recorded. A new row's finished_at must be later than
 * every recorded one, so the last line is always the latest run. Earlier lines are never rewritten.
 */
export function appendRunHistory(
  historyPath: string,
  row: HistoryRow & { parquet_sha256: string; finished_at: string },
): "added" | "already-recorded" {
  const history = readHistory(historyPath);
  const plan = planHistory(
    history,
    row.run_id,
    row.parquet_sha256,
    row.permit_files,
  );
  if (plan.kind === "recorded") return "already-recorded";
  const t = finishedMs(row);
  const latest = history.reduce(
    (m, r) => Math.max(m, finishedMs(r)),
    -Infinity,
  );
  if (!(t > latest))
    throw new Error(
      `run ${row.run_id} finished_at ${row.finished_at} is not later than every recorded run; nothing appended`,
    );
  appendFileSync(historyPath, JSON.stringify(row) + "\n");
  return "added";
}

/** The parts of a run manifest that record input cache files and their sha256. */
export interface InputManifestLike {
  cache?: {
    summary?: { path: string; sha256: string };
    manifest?: { path: string; sha256: string };
    download_script?: { copy_that_ran?: { path: string; sha256: string } };
    pages?: Array<{ path: string; body_sha256: string }>;
  };
  permit_caches?: Record<
    string,
    {
      files?: Array<{ path: string; sha256: string }>;
      pages?: Array<{ path: string; json_sha256: string; gz_sha256: string }>;
    }
  >;
  files?: Array<{ path: string; sha256: string }>;
}

/**
 * Every input cache digest a run manifest records, as sorted lines "<cache> <path> <sha256>": the
 * roll cache's summary, page manifest, the download script copy in it and every page body; each
 * permit cache's files and pages; and, for a run from raw pages, the files outside data/out/ and
 * data/seeds/.
 */
export function inputCacheDigests(m: InputManifestLike): string[] {
  const lines: string[] = [];
  const c = m.cache;
  if (c) {
    for (const f of [c.summary, c.manifest, c.download_script?.copy_that_ran])
      if (f) lines.push(`roll ${f.path} ${f.sha256}`);
    for (const p of c.pages ?? [])
      lines.push(`roll ${p.path} ${p.body_sha256}`);
  }
  for (const [name, pc] of Object.entries(m.permit_caches ?? {})) {
    if (!pc || typeof pc !== "object") continue;
    for (const f of pc.files ?? []) lines.push(`${name} ${f.path} ${f.sha256}`);
    for (const p of pc.pages ?? [])
      lines.push(`${name} ${p.path} ${p.json_sha256} ${p.gz_sha256}`);
  }
  if (!c)
    for (const f of m.files ?? [])
      if (!/^data\/(out|seeds)\//.test(f.path))
        lines.push(`file ${f.path} ${f.sha256}`);
  return [...new Set(lines)].sort();
}

export interface RebuildFields {
  /** "rebuild": every input cache digest equals the previous run's; otherwise "new data". */
  run_kind: "rebuild" | "new data";
  /** The previous run's ID for a rebuild, else null. */
  rebuild_of: string | null;
  /** "none" for a rebuild, else null. */
  source_changes: "none" | null;
}

/** Decide the run kind from the input cache digests of this build and of the previous run. */
export function rebuildFields(
  inputs: string[],
  previous: { run_id: string; inputs: string[] } | undefined,
): RebuildFields {
  const same =
    previous !== undefined &&
    inputs.length > 0 &&
    JSON.stringify([...inputs].sort()) ===
      JSON.stringify([...previous.inputs].sort());
  return same
    ? {
        run_kind: "rebuild",
        rebuild_of: previous.run_id,
        source_changes: "none",
      }
    : { run_kind: "new data", rebuild_of: null, source_changes: null };
}

export interface ParquetColumn {
  name: string;
  type: string;
}

export interface TableSchemaChange {
  added: string[];
  removed: string[];
  /** Columns in both whose type changed, as "name: old -> new". */
  retyped: string[];
  /** The previous run had no file in this role. */
  new_table?: true;
  /** This build has no file in this role. */
  removed_table?: true;
}

/**
 * Columns added, removed and retyped per table (by role) against the previous run's Parquet
 * schemas; this build's tables in the order given, then any table it no longer has. No previous
 * run: null.
 */
export function schemaChanges(
  previous: Record<string, ParquetColumn[]> | undefined,
  current: Record<string, ParquetColumn[]>,
): Record<string, TableSchemaChange> | null {
  if (!previous) return null;
  const out: Record<string, TableSchemaChange> = {};
  for (const [role, cols] of Object.entries(current)) {
    const before = previous[role];
    const old = new Map((before ?? []).map((c) => [c.name, c.type]));
    const now = new Map(cols.map((c) => [c.name, c.type]));
    out[role] = {
      added: cols.filter((c) => !old.has(c.name)).map((c) => c.name),
      removed: (before ?? [])
        .filter((c) => !now.has(c.name))
        .map((c) => c.name),
      retyped: cols
        .filter((c) => old.has(c.name) && old.get(c.name) !== c.type)
        .map((c) => `${c.name}: ${old.get(c.name)} -> ${c.type}`),
      ...(before === undefined && { new_table: true as const }),
    };
  }
  for (const [role, cols] of Object.entries(previous))
    if (!(role in current))
      out[role] = {
        added: [],
        removed: cols.map((c) => c.name),
        retyped: [],
        removed_table: true,
      };
  return out;
}
