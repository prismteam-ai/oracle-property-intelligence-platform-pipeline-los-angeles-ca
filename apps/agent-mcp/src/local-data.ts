/**
 * Local data wiring: the data API's own openDb and appRouter.createCaller over the run files in the repository
 * (runs/run_history.jsonl, its latest row's manifest, its property Parquet and its three permit Parquet files under
 * data/), staged the way the Lambda sees them after its S3 copy (one directory, the base names), through symbolic
 * links (no copy of any Parquet). openDb verifies each Parquet's sha256 at load.
 */
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { placeIndexFor, type DataQueries } from "@oracle-la/agent";
import { appRouter } from "@oracle-la/api/router";
// openDb is not in @oracle-la/api's package exports ("./router", "./contract"), so it is imported by relative path
// here; the main session may add an export instead (design brief §1).
import { openDb, parsePermitFiles } from "../../api/src/db.ts";

/** The repository root (this file is apps/agent-mcp/src/local-data.ts). */
export const DEFAULT_REPO_ROOT = fileURLToPath(
  new URL("../../../", import.meta.url),
);

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

/** The latest row of runs/run_history.jsonl: the run the data API serves. */
export function latestRun(repoRoot: string): RunHistoryRow {
  const rows = readFileSync(join(repoRoot, "runs/run_history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as RunHistoryRow);
  const latest = rows.at(-1);
  if (!latest) throw new Error("runs/run_history.jsonl has no run");
  return latest;
}

type Ctx = Parameters<typeof appRouter.createCaller>[0];

export interface LocalData {
  runId: string;
  queries: DataQueries;
  /** The tRPC caller over the same Db (for checks against the API itself). */
  caller: ReturnType<typeof appRouter.createCaller>;
}

/**
 * Open the latest run of a repository checkout. `stageDir` and `tmpDir` default to fresh temporary directories;
 * they are scratch space (the links and DuckDB's temp files), not data.
 */
export async function openLocalData(
  opts: {
    repoRoot?: string;
    stageDir?: string;
    tmpDir?: string;
  } = {},
): Promise<LocalData> {
  const repoRoot = resolve(opts.repoRoot ?? DEFAULT_REPO_ROOT);
  const run = latestRun(repoRoot);
  const abs = (p: string) => (isAbsolute(p) ? p : join(repoRoot, p));
  const stage = opts.stageDir ?? mkdtempSync(join(tmpdir(), "agent-data-"));
  const parquetFile = basename(run.parquet_path);
  symlinkSync(abs(run.parquet_path), join(stage, parquetFile));
  // The history row's permit files as the CDK app passes them (role, base name of the path, sha256), validated by
  // the API's own parser: one per role, plain Parquet names, hex sha256. A run without them fails here.
  const permitFiles = parsePermitFiles(
    JSON.stringify(
      (run.permit_files ?? []).map((f) => ({
        role: f.role,
        file: basename(f.path),
        sha256: f.sha256,
      })),
    ),
  );
  for (const f of run.permit_files ?? [])
    symlinkSync(abs(f.path), join(stage, basename(f.path)));
  symlinkSync(abs(run.manifest_path), join(stage, "run_manifest.json"));
  symlinkSync(
    join(repoRoot, "runs/run_history.jsonl"),
    join(stage, "run_history.jsonl"),
  );
  const db = await openDb({
    runId: run.run_id,
    parquetSha256: run.parquet_sha256,
    parquetFile,
    permitFiles,
    localDir: stage,
    tmpDir: opts.tmpDir ?? mkdtempSync(join(tmpdir(), "agent-tmp-")),
  });
  const ctx: Ctx = {
    db: async () => db,
    logger: { info() {}, warn() {} },
    metrics: { addMetric() {} },
  };
  const caller = appRouter.createCaller(ctx);
  return {
    runId: run.run_id,
    caller,
    queries: {
      parcels: caller.parcels,
      explorer: caller.explorer,
      permits: caller.permits,
      // Candidate data API route places.resolve; until then the PlaceIndex reads the same Db.
      places: placeIndexFor(db),
    },
  };
}
