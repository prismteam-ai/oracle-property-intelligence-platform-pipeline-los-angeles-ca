/**
 * One command for a new permit run, from a fresh LADBS fetch to the local build:
 *   1. fetch the permit sets into a new cache folder, then summarize it at once (its summary time sets the run's
 *      time and reference date);
 *   2. fetch the contractor view into a new cache folder, then summarize it against the permit cache;
 *   3. compare the new caches with the previous run's (--previous): stop when a cache's rows differ by more than
 *      --max-change-pct (default 1) or a column is new or missing;
 *   4. copy each fetch script into the cache it downloaded (the build records its sha256);
 *   5. build the run with --dry-run; with --real, then build it for real (data/out/<ID>/, runs/<ID>/ and one line
 *      in runs/run_history.jsonl).
 * It never commits, uploads or deploys: it prints those steps for the operator, each one separate and explicit.
 * --from-caches <permit-cache> <contractor-cache> skips steps 1 and 2 (no network): a rebuild from caches on disk.
 * --reuse-contractor-cache <dir> skips step 2 only (the contractor view is not downloaded): the run is built with
 * that recorded cache, left as it is, and its manifest names it (permit_caches.contractors: name, generated_at,
 * sha256 of its files).
 *
 * Usage:
 *   KIT_DIR=<team kit checkout> node scripts/permit-run.ts --roll-cache <dir> --cache-root <dir>
 *     --license-read-at <ISO time, UTC> --previous <permit-cache> <contractor-cache> [--real] [--max-change-pct <n>]
 *   KIT_DIR=<team kit checkout> node scripts/permit-run.ts --roll-cache <dir>
 *     --from-caches <permit-cache> <contractor-cache> [--previous <permit-cache> <contractor-cache>] [--real]
 *   Add --plan to print the steps without running any.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const REPO = fileURLToPath(new URL("..", import.meta.url));
export const CONFIG = "config/la-county-permits-run.json";
const SCRIPTS = {
  permits: "scripts/ladbs-permits/fetch.mjs",
  contractors: "scripts/ladbs-contractors/fetch.mjs",
} as const;

export interface Options {
  rollCache: string;
  cacheRoot?: string;
  licenseReadAt?: string;
  fromCaches?: [string, string];
  reuseContractorCache?: string;
  previous?: [string, string];
  maxChangePct: number;
  real: boolean;
  plan: boolean;
  config: string;
}

const USAGE =
  "usage: node scripts/permit-run.ts --roll-cache <dir> (--cache-root <dir> (--license-read-at <ISO time> | --reuse-contractor-cache <dir>) --previous <permit-cache> <contractor-cache> | --from-caches <permit-cache> <contractor-cache> [--previous <permit-cache> <contractor-cache>]) [--max-change-pct <n>] [--config <file>] [--real] [--plan]";

/** The options from argv; throws on anything missing, unknown or contradictory. */
export function parseArgs(argv: string[]): Options {
  const o: Partial<Options> = {
    maxChangePct: 1,
    real: false,
    plan: false,
    config: CONFIG,
  };
  const value = (i: number, name: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--"))
      throw new Error(`${name} needs a value\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--roll-cache") o.rollCache = value(++i, a);
    else if (a === "--cache-root") o.cacheRoot = value(++i, a);
    else if (a === "--license-read-at") o.licenseReadAt = value(++i, a);
    else if (a === "--config") o.config = value(++i, a);
    else if (a === "--reuse-contractor-cache")
      o.reuseContractorCache = value(++i, a);
    else if (a === "--from-caches" || a === "--previous") {
      const pair: [string, string] = [value(++i, a), value(++i, a)];
      if (a === "--from-caches") o.fromCaches = pair;
      else o.previous = pair;
    } else if (a === "--max-change-pct") {
      const n = Number(value(++i, a));
      if (!Number.isFinite(n) || n < 0)
        throw new Error(`--max-change-pct needs a number of 0 or more`);
      o.maxChangePct = n;
    } else if (a === "--real") o.real = true;
    else if (a === "--plan") o.plan = true;
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (!o.rollCache) throw new Error(`--roll-cache is required\n${USAGE}`);
  if (o.fromCaches) {
    if (o.cacheRoot || o.licenseReadAt || o.reuseContractorCache)
      throw new Error(
        "--from-caches builds from caches on disk: no --cache-root, --license-read-at or --reuse-contractor-cache (nothing is fetched)",
      );
  } else {
    if (!o.cacheRoot) throw new Error(`a fetch needs --cache-root\n${USAGE}`);
    if (!o.licenseReadAt === !o.reuseContractorCache)
      throw new Error(
        "a fetch needs exactly one of --license-read-at (the contractor view is downloaded) and --reuse-contractor-cache (it is not)",
      );
    if (!o.previous)
      throw new Error(
        "a fetch needs --previous <permit-cache> <contractor-cache>: the new caches are compared with them before the build",
      );
  }
  return o as Options;
}

/** UTC time as used in cache folder names: 2026-11-17T01-02-03Z. */
export const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");

/** The two new cache folders under the cache root, named by kind and time. */
export function newCacheDirs(root: string, now: Date): [string, string] {
  const t = stamp(now);
  return [
    join(resolve(root), `ladbs-permits-${t}`),
    join(resolve(root), `ladbs-contractors-${t}`),
  ];
}

export interface Step {
  /** What the step does, in plain words. */
  label: string;
  /** The command, run from the repository root. */
  argv: string[];
  network: boolean;
}

/** The steps the command runs, in order. */
export function plan(
  o: Options,
  now: Date,
): {
  permitCache: string;
  contractorCache: string;
  steps: Step[];
} {
  const [permitCache, newContractorCache] =
    o.fromCaches?.map((d) => resolve(d)) ?? newCacheDirs(o.cacheRoot!, now);
  const contractorCache = o.reuseContractorCache
    ? resolve(o.reuseContractorCache)
    : newContractorCache;
  const node = process.execPath;
  const steps: Step[] = [];
  if (!o.fromCaches)
    steps.push(
      {
        label: "download the LADBS permit sets into a new cache folder",
        argv: [node, SCRIPTS.permits, permitCache!],
        network: true,
      },
      {
        label: "summarize the permit cache (its time sets the run's time)",
        argv: [node, SCRIPTS.permits, "summarize", permitCache!],
        network: false,
      },
    );
  if (!o.fromCaches && !o.reuseContractorCache)
    steps.push(
      {
        label: "download the LADBS contractor view into a new cache folder",
        argv: [
          node,
          SCRIPTS.contractors,
          contractorCache!,
          "--license-read-at",
          o.licenseReadAt!,
        ],
        network: true,
      },
      {
        label: "summarize the contractor cache against the permit cache",
        argv: [
          node,
          SCRIPTS.contractors,
          "summarize",
          contractorCache!,
          permitCache!,
        ],
        network: false,
      },
    );
  const build = [
    node,
    "src/build-outputs.ts",
    resolve(o.rollCache),
    o.config,
    "--permit-cache",
    permitCache!,
    "--contractor-cache",
    contractorCache!,
  ];
  steps.push({
    label: "build the run as a dry run (data/work/<ID>/dry-run/ only)",
    argv: [...build, "--dry-run"],
    network: false,
  });
  if (o.real)
    steps.push({
      label:
        "build the run (data/out/<ID>/, runs/<ID>/run_manifest.json, one line in runs/run_history.jsonl)",
      argv: build,
      network: false,
    });
  return {
    permitCache: permitCache!,
    contractorCache: contractorCache!,
    steps,
  };
}

/** Rows and the column names seen in a cache's pages (every row of every page). */
export function cacheShape(dir: string): { rows: number; columns: string[] } {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    status: string;
    pages: Array<{ file: string }>;
  };
  if (m.status !== "complete")
    throw new Error(`${dir}: cache status is "${m.status}"`);
  const columns = new Set<string>();
  let rows = 0;
  for (const p of m.pages) {
    const page = JSON.parse(
      gunzipSync(readFileSync(join(dir, "pages", p.file))).toString(),
    ) as Array<Record<string, unknown>>;
    rows += page.length;
    for (const r of page) for (const k of Object.keys(r)) columns.add(k);
  }
  return { rows, columns: [...columns].sort() };
}

/** Why the new cache may not be built against the previous one: an empty list when it may. */
export function compareShapes(
  kind: string,
  next: { rows: number; columns: string[] },
  prev: { rows: number; columns: string[] },
  maxChangePct: number,
): string[] {
  const out: string[] = [];
  const pct = prev.rows
    ? (Math.abs(next.rows - prev.rows) / prev.rows) * 100
    : 100;
  if (pct > maxChangePct)
    out.push(
      `${kind}: ${next.rows} rows against ${prev.rows} before (${pct.toFixed(2)}% change, more than ${maxChangePct}%)`,
    );
  const added = next.columns.filter((c) => !prev.columns.includes(c));
  const missing = prev.columns.filter((c) => !next.columns.includes(c));
  if (added.length) out.push(`${kind}: new column(s) ${added.join(", ")}`);
  if (missing.length)
    out.push(`${kind}: missing column(s) ${missing.join(", ")}`);
  return out;
}

/**
 * Copy each fetch script into the cache it just downloaded, as the build expects (it records the copy's sha256).
 * Only caches this command fetched get a copy: a cache on disk (--from-caches, --reuse-contractor-cache) is never
 * written to. A copy already in a new cache is an error.
 */
export function copyFetchScripts(
  fetched: Array<{ kind: keyof typeof SCRIPTS; dir: string }>,
): string[] {
  return fetched.map(({ kind, dir }) => {
    const to = join(dir, "fetch.mjs");
    if (existsSync(to))
      throw new Error(`${to} exists: a new cache has no fetch script yet`);
    copyFileSync(join(REPO, SCRIPTS[kind]), to);
    return `${to}: copied from ${SCRIPTS[kind]}`;
  });
}

/** The steps the command never runs: the operator runs each, separately, after reviewing the run. */
export function nextSteps(runId: string): string[] {
  return [
    `check: node src/query-radius.ts --parquet data/out/${runId}/los-angeles_property_roll2026.parquet; REQUIRE_REAL_DATA=1 pnpm test`,
    `commit: git add runs/${runId}/run_manifest.json runs/run_history.jsonl (the run's records only; never edited by hand)`,
    `upload (AWS, approval): the 6 objects of data/out/${runId}/ and runs/ (4 Parquet files, the run manifest, the run history) to runs/${runId}/ in the DataBucket output, each with aws s3api put-object --if-none-match '*', then read back with sha256`,
    "deploy (AWS, approval): from apps/api, pnpm exec cdk diff OracleLaDataApi, review, then cdk deploy OracleLaDataApi with the default approval",
  ];
}

function run(step: Step): void {
  console.log(`\n== ${step.label}${step.network ? " (network)" : ""}`);
  const r = spawnSync(step.argv[0]!, step.argv.slice(1), {
    cwd: REPO,
    stdio: "inherit",
  });
  if (r.status !== 0)
    throw new Error(
      `stopped: "${step.label}" exited with ${r.status ?? r.signal}`,
    );
}

function main(argv: string[]): void {
  const o = parseArgs(argv);
  const { permitCache, contractorCache, steps } = plan(o, new Date());
  if (o.plan) {
    for (const s of steps)
      console.log(
        `${s.label}${s.network ? " (network)" : ""}:\n  ${s.argv.join(" ")}`,
      );
    console.log("then, never run by this command:");
    for (const s of nextSteps("<ID>")) console.log(`  ${s}`);
    return;
  }
  if (!o.fromCaches)
    for (const d of o.reuseContractorCache
      ? [permitCache]
      : [permitCache, contractorCache])
      if (existsSync(d))
        throw new Error(`refusing: the cache folder ${d} exists`);
  const fetches = steps.filter((s) => !s.argv.includes("src/build-outputs.ts"));
  const builds = steps.filter((s) => s.argv.includes("src/build-outputs.ts"));
  for (const s of fetches) run(s);
  if (o.previous) {
    const problems = [
      ...compareShapes(
        "permits",
        cacheShape(permitCache),
        cacheShape(o.previous[0]),
        o.maxChangePct,
      ),
      ...compareShapes(
        "contractors",
        cacheShape(contractorCache),
        cacheShape(o.previous[1]),
        o.maxChangePct,
      ),
    ];
    if (problems.length)
      throw new Error(`stopped before the build:\n  ${problems.join("\n  ")}`);
    console.log(
      `\n== the new caches match the previous ones within ${o.maxChangePct}% and with the same columns`,
    );
  }
  const fetched = o.fromCaches
    ? []
    : [
        { kind: "permits" as const, dir: permitCache },
        ...(o.reuseContractorCache
          ? []
          : [{ kind: "contractors" as const, dir: contractorCache }]),
      ];
  if (fetched.length) {
    console.log("\n== copy the fetch scripts into the new caches");
    for (const l of copyFetchScripts(fetched)) console.log(`  ${l}`);
  }
  for (const s of builds) run(s);
  if (!o.real) {
    console.log(
      `\nDry run done. Build for real with the same command and --real, or:\n  ${plan(
        { ...o, real: true },
        new Date(),
      )
        .steps.at(-1)!
        .argv.join(" ")}`,
    );
    return;
  }
  const last = readFileSync(join(REPO, "runs/run_history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .at(-1)!;
  const runId = (JSON.parse(last) as { run_id: string }).run_id;
  console.log(
    `\nRun ${runId} built. Caches: ${permitCache}, ${contractorCache}.\nNot done by this command, each a separate step:`,
  );
  for (const s of nextSteps(runId)) console.log(`  ${s}`);
}

// Run only as a script (the test imports the functions above).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
