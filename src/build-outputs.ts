/**
 * Build the run outputs from a verified download: the pilot's raw pages (receipts.jsonl) or,
 * when the run config says "input": "roll-cache", the whole-roll cache written by
 * scripts/fetch-roll.mjs (src/stage-cache.ts). Outputs:
 *  - seed CSV (data/seeds/los-angeles.csv) for the runtime CountyIngest feeder
 *  - publishable Parquet (no owner, mailing or contact fields)
 *  - runs/<run_id>/run_manifest.json and an appended runs/run_history.jsonl
 * It first runs the scope guard and the kit's readiness validator (src/readiness.ts) and stops
 * unless both pass.
 *
 * Usage: KIT_DIR=<team kit checkout> node src/build-outputs.ts <raw-run-dir | roll-cache-dir> [run-config.json]
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { parse } from "yaml";
import { guardOrThrow } from "./scope-guard.ts";
import { isCountyWide, loadRunConfig, whereClause } from "./run-config.ts";
import { stageRaw } from "./stage-raw.ts";
import {
  cacheRunId,
  PAGES_DIR,
  readCacheSummary,
  stageCache,
  type CachePage,
} from "./stage-cache.ts";
import { fileEntry, seedFileEntries } from "./manifest-files.ts";
import { runReadiness } from "./readiness.ts";
import {
  personalDataColumns,
  propertyTableSql,
  sqlLiteral as lit,
} from "./property-sql.ts";
import { appendRunHistory, planHistory, readHistory } from "./run-history.ts";

const rawDir = process.argv[2];
if (!rawDir)
  throw new Error(
    "usage: node src/build-outputs.ts <raw-run-dir | roll-cache-dir> [run-config.json]",
  );
const configPath = process.argv[3] ?? "config/la-pilot-run.json";
const cfg = loadRunConfig(configPath);
guardOrThrow(configPath, cfg.sources_catalog);
// Fails closed unless the kit validator passes on the catalog (KIT_DIR names the kit checkout).
const readiness = runReadiness(cfg.sources_catalog);

const fromCache = cfg.input === "roll-cache";
const countyWide = isCountyWide(cfg);
// Pilot: the raw run directory's name. Roll cache: the cache summary's generated_at.
const cacheSummary = fromCache ? readCacheSummary(rawDir) : undefined;
const runId = cacheSummary ? cacheRunId(cacheSummary) : basename(rawDir);
const fetchSummary = fromCache
  ? undefined
  : (JSON.parse(
      readFileSync(join(rawDir, "fetch-summary.json"), "utf8"),
    ) as Record<string, unknown> & {
      expected_count: number;
      downloaded_rows: number;
      count_request_url: string;
    });
const workDir = join("data", "work", runId);
const outDir = join("data", "out", runId);
const seedDir = join("data", "seeds");
const runsDir = join("runs", runId);
for (const d of [workDir, outDir, seedDir, runsDir])
  mkdirSync(d, { recursive: true });

const ndjson = join(workDir, "rows.ndjson");
let receipts: Awaited<ReturnType<typeof stageRaw>>["receipts"] = [];
let cachePages: CachePage[] = [];
let stagedRows: number;
let referenceDate: string;
if (fromCache) {
  const staged = await stageCache(rawDir, ndjson, {
    queryUrl: cfg.source.query_url,
    where: whereClause(cfg),
  });
  cachePages = staged.pages;
  stagedRows = staged.rows;
  referenceDate = cachePages[0]!.fetched_at.slice(0, 10);
} else {
  const staged = await stageRaw(rawDir, ndjson);
  receipts = staged.receipts;
  stagedRows = staged.rows;
  referenceDate = receipts[0]!.retrieved_at.slice(0, 10);
}

const parquetName = `los-angeles_property_roll${cfg.roll_year}${countyWide ? "" : "_slice"}.parquet`;
const parquetPath = join(outDir, parquetName);
const seedRunPath = join(outDir, "los-angeles-seed.csv");
const seedPath = join(seedDir, "los-angeles.csv");

// File-backed under data/work, so a county-size build can spill to disk instead of failing.
const dbPath = join(workDir, "build.duckdb");
for (const f of [dbPath, `${dbPath}.wal`]) rmSync(f, { force: true });
const db = await DuckDBInstance.create(dbPath, {
  threads: "2",
  memory_limit: "2GB",
  temp_directory: join(workDir, "duckdb-tmp"),
});
const c = await db.connect();
const q = async (sql: string) =>
  (await c.runAndReadAll(sql)).getRowObjectsJson() as Array<
    Record<string, unknown>
  >;

// Column types come from every row of a county-size file, not only the first sample.
await c.run(
  `create table raw as select * from read_json(${lit(ndjson)}, format='newline_delimited'${fromCache ? ", sample_size=-1" : ""})`,
);

await c.run(propertyTableSql(referenceDate, cfg.source.name));

const cols = (
  await q(
    `select column_name from information_schema.columns where table_name='property'`,
  )
).map((r) => String(r.column_name));
const bad = personalDataColumns(cols);
if (bad.length)
  throw new Error(
    `personal-data columns in publishable table: ${bad.join(", ")}`,
  );
const dupes = await q(
  `select count(*) - count(distinct parcel_identifier) d from property`,
);
if (Number(dupes[0]!.d) !== 0) throw new Error("duplicate parcel_identifier");

// The Parquet is written next to its final path first, so a recorded run's file is never replaced.
// A run already in the history with the same Parquet is not recorded again: its Parquet, seed,
// manifest and history row stay as they are. The same run ID with a different Parquet fails.
const parquetPartial = `${parquetPath}.partial`;
await c.run(
  `copy property to ${lit(parquetPartial)} (format parquet, compression zstd)`,
);
const historyPath = join("runs", "run_history.jsonl");
const parquetSha256 = createHash("sha256")
  .update(readFileSync(parquetPartial))
  .digest("hex");
let historyPlan: ReturnType<typeof planHistory>;
try {
  historyPlan = planHistory(readHistory(historyPath), runId, parquetSha256);
} catch (err) {
  rmSync(parquetPartial);
  throw err;
}
if (historyPlan.kind === "recorded") {
  rmSync(parquetPartial);
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        already_recorded: true,
        parquet: parquetPath,
        parquet_sha256: parquetSha256,
        manifest: historyPlan.row.manifest_path,
        note: "same run ID and same Parquet sha256: no history row added; Parquet, seed and manifest left as recorded",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
renameSync(parquetPartial, parquetPath);

await c.run(`copy (select parcel_identifier as parcel_id, request_identifier as source_identifier, unnormalized_address as situs_address,
  assessor_id_formatted, roll_year, latitude, longitude from property order by parcel_id) to ${lit(seedRunPath)} (header, delimiter ',')`);
if (existsSync(seedPath)) console.log(`replacing existing ${seedPath}`);
copyFileSync(seedRunPath, seedPath);

const stats = (
  await q(`select count(*) n,
  count(latitude) filter (where longitude is not null) coords,
  count(property_structure_built_year) yb,
  count(property_effective_built_year) eyb,
  count(last_recording_date) rec,
  count(*) filter (where owner_unchanged_10y_proxy) unchanged10,
  min(property_structure_built_year) yb_min, max(property_structure_built_year) yb_max
  from property`)
)[0]!;
const parquetRows = Number(
  (await q(`select count(*) n from read_parquet(${lit(parquetPath)})`))[0]!.n,
);
const seedRows = Number(
  (
    await q(`select count(*) n from read_csv(${lit(seedRunPath)}, header=true)`)
  )[0]!.n,
);
const byUse = await q(
  `select source_use_type, count(*) n from property group by 1 order by 2 desc`,
);

// Delta against the previous run in run history (by parcel identifier and file digest).
const prev = historyPlan.previous;
let delta: Record<string, unknown> = {
  previous_run_id: null,
  note: "first run; every row is new",
  added: parquetRows,
  removed: 0,
};
if (prev?.parquet_path && existsSync(prev.parquet_path)) {
  const d = (
    await q(`select
    (select count(*) from read_parquet(${lit(parquetPath)}) n where n.parcel_identifier not in (select parcel_identifier from read_parquet(${lit(prev.parquet_path)}))) added,
    (select count(*) from read_parquet(${lit(prev.parquet_path)}) o where o.parcel_identifier not in (select parcel_identifier from read_parquet(${lit(parquetPath)}))) removed`)
  )[0]!;
  delta = {
    previous_run_id: prev.run_id,
    added: Number(d.added),
    removed: Number(d.removed),
  };
}

const catalog = parse(readFileSync(cfg.sources_catalog, "utf8")) as {
  permits: { jurisdictions: Array<{ jurisdiction: string; status: string }> };
};
const notCovered = catalog.permits.jurisdictions
  .filter((j) => j.status === "needs-review")
  .map((j) =>
    j.jurisdiction === "unincorporated"
      ? "Unincorporated Los Angeles County (EPIC-LA)"
      : j.jurisdiction,
  );
if (notCovered.length !== 88)
  throw new Error(
    `expected 88 not-yet-covered jurisdictions, found ${notCovered.length}`,
  );

const n = Number(stats.n);
const share = (k: string) => Math.round((Number(stats[k]) / n) * 10000) / 100;
const sha256File = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
// Roll cache files are recorded by their path inside the cache directory, never an absolute path.
const cacheFileEntry = (rel: string, rows: number | null, role: string) => ({
  ...fileEntry(join(rawDir, rel), rows, role, false),
  path: rel,
});
const FETCH_ROLL_SCRIPT = "scripts/fetch-roll.mjs";
const cache = cacheSummary && {
  name: basename(rawDir),
  note: "Paths are relative to the roll cache directory. The raw pages stay there and are not copied; the build stages only the fields it reads (src/raw-fields.ts).",
  where: whereClause(cfg),
  summary: {
    path: "summary.json",
    sha256: sha256File(join(rawDir, "summary.json")),
    generated_at: cacheSummary.generated_at,
    total_rows: cacheSummary.total_rows,
    source_count_at_start: cacheSummary.source_count_at_start,
    year_built_rule: "download summary: any year above 0",
    rows_with_year_built: cacheSummary.rows_with_year_built,
    rows_with_year_built_pct: cacheSummary.rows_with_year_built_pct,
    rows_with_coordinates_pct: cacheSummary.rows_with_coordinates_pct,
  },
  manifest: {
    path: "manifest.jsonl",
    sha256: sha256File(join(rawDir, "manifest.jsonl")),
    pages: cachePages.length,
  },
  download_script: {
    committed: {
      path: FETCH_ROLL_SCRIPT,
      sha256: sha256File(FETCH_ROLL_SCRIPT),
    },
    copy_that_ran: {
      path: "fetch-roll.mjs",
      sha256: sha256File(join(rawDir, "fetch-roll.mjs")),
      note: "the copy in the roll cache directory that downloaded these pages",
    },
  },
  pages: cachePages.map((p) => ({
    page: p.page,
    path: `${PAGES_DIR}/${p.file}`,
    request_url: p.request_url,
    fetched_at: p.fetched_at,
    http_status: p.http_status,
    rows: p.rows,
    oid_min: p.oid_min,
    oid_max: p.oid_max,
    body_bytes: p.bytes,
    body_sha256: p.sha256,
  })),
};
const manifest = {
  run_id: runId,
  run_name: cfg.run_name,
  generated_at: new Date().toISOString(),
  county: cfg.county,
  state: cfg.state,
  fips: "06037",
  roll_year: cfg.roll_year,
  scope: {
    increment: cfg.increment,
    data: cfg.data,
    jurisdiction: cfg.jurisdiction,
    zips: cfg.zips,
    permits_harvested: cfg.permits_harvested,
    where: whereClause(cfg),
  },
  readiness: {
    ...readiness,
    evidence: [
      "docs/evidence/la-preflight-blocked.json",
      "docs/evidence/la-preflight-pass.json",
      ...(countyWide ? ["docs/evidence/la-preflight-pass-county.json"] : []),
    ],
    scope_guard: "PASS",
  },
  sources: [
    {
      name: cfg.source.name,
      role: `canonical assessed parcel roll (${countyWide ? "county-wide" : "slice"})`,
      hub_page:
        "https://data.lacounty.gov/datasets/assessor-parcel-data-rolls-2021-present-1",
      hub_item_id: cfg.source.hub_item_id,
      query_url: cfg.source.query_url,
      count_request_url: fetchSummary?.count_request_url ?? null,
      terms_of_use: "https://egis-lacounty.hub.arcgis.com/pages/terms-of-use",
      access: "anonymous REST, sequential, >= 2 s between requests",
      ...(cache && {
        request_urls:
          "one per page in cache.pages; the source count is in cache.summary (the cache does not record the count request URL)",
      }),
    },
  ],
  ...(cache && { cache }),
  row_counts: {
    expected_from_source_count: cacheSummary
      ? cacheSummary.source_count_at_start
      : fetchSummary!.expected_count,
    downloaded: cacheSummary
      ? cacheSummary.total_rows
      : fetchSummary!.downloaded_rows,
    staged: stagedRows,
    parquet: parquetRows,
    seed_csv: seedRows,
    raw_pages: fromCache ? cachePages.length : receipts.length,
  },
  coverage: {
    with_coordinates: Number(stats.coords),
    with_coordinates_pct: share("coords"),
    with_year_built: Number(stats.yb),
    with_year_built_pct: share("yb"),
    with_effective_year_built: Number(stats.eyb),
    with_effective_year_built_pct: share("eyb"),
    with_last_recording_date: Number(stats.rec),
    owner_unchanged_10y_proxy_true: Number(stats.unchanged10),
    year_built_min: stats.yb_min,
    year_built_max: stats.yb_max,
    by_source_use_type: byUse,
  },
  derived_field_reference_date: referenceDate,
  delta,
  files: [
    fileEntry(
      parquetPath,
      parquetRows,
      "publishable property table (publish only after user approval and rights check)",
      true,
    ),
    ...seedFileEntries(seedRunPath, seedPath, seedRows),
    ...(fromCache
      ? [
          cacheFileEntry("summary.json", null, "roll cache summary"),
          cacheFileEntry(
            "manifest.jsonl",
            cachePages.length,
            "roll cache page manifest (request URL, HTTP status, body sha256 per page)",
          ),
        ]
      : [
          fileEntry(
            join(rawDir, "receipts.jsonl"),
            receipts.length,
            "raw page receipts",
            false,
          ),
          ...receipts.map((r) =>
            fileEntry(
              join(rawDir, r.file),
              r.rows,
              "raw source page (byte-preserved)",
              false,
            ),
          ),
        ]),
  ],
  limitations: [
    countyWide
      ? `County-wide: all of Los Angeles County (89 jurisdictions), no ZIP filter, roll ${cfg.roll_year}, built from the whole-roll cache (${cachePages.length} pages). The cache was downloaded with every field; the build keeps only the fields it reads.`
      : `Pilot slice only: City of Los Angeles, ZIP ${cfg.zips.join("/")}, roll ${cfg.roll_year}. Not county coverage.`,
    "No permits harvested in this increment. Permit sources not yet covered (88 jurisdictions without a classified permit source): " +
      notCovered.join(", ") +
      ".",
    "City of Los Angeles permits (LADBS, data.lacity.org) are classified but not harvested in this increment.",
    "PUBLICATION BLOCKER: republication rights under the LA County eGIS Terms of Use ('for informational purposes') are unverified. Nothing may be published until confirmed and approved.",
    "Year built and effective year built are a roof-age PROXY, not roof installation dates. Source value 0 is treated as unknown (null).",
    "last_recording_date is the assessor's latest recorded document date, not necessarily a sale or ownership transfer. owner_unchanged_10y_proxy = last_recording_date <= reference date - 10 years; it can understate (non-transfer recordings) and is null when no date.",
    "out_of_area_owner is null for every row: the open roll has no owner mailing address. Owner mailing data exists only in a secured county service that is not used.",
    "No owner names, mailing addresses or contact fields exist in the source; no person entities and no private owner file were produced.",
    "Coordinates are assessor parcel center points, not rooftop or address-point geocodes; rows without them are left null (not geocoded).",
    "Lexicon names are taken from the bundled kit catalog (use-neutral-lexicon model-c) without the live Elephant lexicon/MCP; source_* columns, roof_age_basis, coordinate_basis, *_proxy, last_recording_date, tax_rate_area_city, roll_year and assessor_id_formatted are not lexicon fields; property_usage_type/property_type enums are not mapped (raw use code kept).",
    countyWide
      ? `Radius queries see every parcel with assessor coordinates; the ${n - Number(stats.coords)} parcels without them never appear in radius results.`
      : "Radius queries over this file only see the 3-ZIP slice; parcels outside the slice inside the radius are absent.",
  ],
  rebuild: fromCache
    ? [
        "pnpm install --frozen-lockfile",
        `node src/scope-guard.ts ${configPath}`,
        `node ${FETCH_ROLL_SCRIPT} <roll-cache-dir>   (downloads the whole roll; network)`,
        `KIT_DIR=<team kit checkout> node src/build-outputs.ts <roll-cache-dir> ${configPath}`,
        "node src/query-radius.ts --parquet data/out/<run_id>/" + parquetName,
      ]
    : [
        "pnpm install --frozen-lockfile",
        "node src/scope-guard.ts",
        "node src/fetch-slice.ts",
        "KIT_DIR=<team kit checkout> node src/build-outputs.ts data/raw/los-angeles/roll-2026/<run_id>",
        "node src/query-radius.ts --parquet data/out/<run_id>/" + parquetName,
      ],
};
const manifestPath = join(runsDir, "run_manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const manifestSha = createHash("sha256")
  .update(readFileSync(manifestPath))
  .digest("hex");
const parquetEntry = manifest.files[0]!;
if (parquetEntry.sha256 !== parquetSha256)
  throw new Error(`${parquetPath} changed during the build`);
appendRunHistory(historyPath, {
  run_id: runId,
  finished_at: manifest.generated_at,
  county: cfg.county,
  roll_year: cfg.roll_year,
  scope: manifest.scope,
  sources: manifest.sources.map((s) => s.query_url),
  row_counts: manifest.row_counts,
  delta,
  parquet_path: parquetPath,
  parquet_sha256: parquetSha256,
  manifest_path: manifestPath,
  manifest_sha256: manifestSha,
  published: false,
});

console.log(
  JSON.stringify(
    {
      manifest: manifestPath,
      parquet: parquetPath,
      seed: seedPath,
      row_counts: manifest.row_counts,
      coverage: manifest.coverage,
    },
    null,
    2,
  ),
);
