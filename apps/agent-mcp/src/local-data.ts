/**
 * Local data wiring: the data API's own openDb and appRouter.createCaller over the run files in the repository
 * (runs/run_history.jsonl, its latest row's manifest, its property Parquet and its three permit Parquet files under
 * data/), staged the way the Lambda sees them after its S3 copy (one directory, the base names), through symbolic
 * links (no copy of any Parquet). openDb verifies each Parquet's sha256 at load.
 *
 * A checkout without the run's data files (a worktree has runs/ but no data/) is refused before anything is staged,
 * with a RunFilesMissingError (run-files.ts) that names the first missing file and ORACLE_REPO_DIR, instead of
 * DuckDB's ENOENT.
 */
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DataQueries } from "@oracle-la/agent";
import { appRouter } from "@oracle-la/api/router";
// openDb is not in @oracle-la/api's package exports ("./router", "./contract"), so it is imported by relative path
// here; the main session may add an export instead.
import { openDb, parsePermitFiles } from "../../api/src/db.ts";
import {
  RUN_HISTORY,
  RunFilesMissingError,
  RunHistoryError,
  latestRun,
  missingRunFiles,
  underRepo,
  type RunHistoryRow,
} from "./run-files.ts";

/** The repository root (this file is apps/agent-mcp/src/local-data.ts). */
export const DEFAULT_REPO_ROOT = fileURLToPath(
  new URL("../../../", import.meta.url),
);

// The run history and its files (run-files.ts), re-exported for the existing importers of this module.
export {
  RUN_HISTORY,
  RunFilesMissingError,
  RunHistoryError,
  latestRun,
  missingRunFiles,
  type RunHistoryRow,
};

type Ctx = Parameters<typeof appRouter.createCaller>[0];

export interface LocalData {
  runId: string;
  queries: DataQueries;
  /** The tRPC caller over the same Db (for checks against the API itself). */
  caller: ReturnType<typeof appRouter.createCaller>;
}

/**
 * Open the latest run of a repository checkout. `stageDir` and `tmpDir` default to fresh temporary directories;
 * they are scratch space (the links and DuckDB's temp files), not data. Throws RunFilesMissingError (nothing
 * created) when the run's files are not all under `repoRoot`.
 */
export async function openLocalData(
  opts: {
    repoRoot?: string;
    stageDir?: string;
    tmpDir?: string;
  } = {},
): Promise<LocalData> {
  const repoRoot = resolve(opts.repoRoot ?? DEFAULT_REPO_ROOT);
  const missing = missingRunFiles(repoRoot);
  if (missing.length > 0) throw new RunFilesMissingError(repoRoot, missing);
  const run = latestRun(repoRoot);
  const abs = (p: string) => underRepo(repoRoot, p);
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
  symlinkSync(join(repoRoot, RUN_HISTORY), join(stage, "run_history.jsonl"));
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
      // The data API's places.resolve (packages/views/src/place-index.ts, its index built on the first call).
      places: caller.places,
    },
  };
}
