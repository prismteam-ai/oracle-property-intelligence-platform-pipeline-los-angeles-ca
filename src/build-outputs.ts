/**
 * Build the pilot outputs from a verified raw download:
 *  - seed CSV (data/seeds/los-angeles.csv) for the runtime CountyIngest feeder
 *  - publishable Parquet (no owner, mailing or contact fields)
 *  - runs/<run_id>/run_manifest.json and an appended runs/run_history.jsonl
 * It first runs the scope guard and the kit's readiness validator (src/readiness.ts) and stops
 * unless both pass.
 *
 * Usage: KIT_DIR=<team kit checkout> node src/build-outputs.ts <raw-run-dir> [run-config.json]
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
import { loadRunConfig, whereClause } from "./run-config.ts";
import { stageRaw } from "./stage-raw.ts";
import { fileEntry, seedFileEntries } from "./manifest-files.ts";
import { runReadiness } from "./readiness.ts";
import { appendRunHistory, planHistory, readHistory } from "./run-history.ts";

const rawDir = process.argv[2];
if (!rawDir)
  throw new Error(
    "usage: node src/build-outputs.ts <raw-run-dir> [run-config.json]",
  );
const configPath = process.argv[3] ?? "config/la-pilot-run.json";
const cfg = loadRunConfig(configPath);
guardOrThrow(configPath, cfg.sources_catalog);
// Fails closed unless the kit validator passes on the catalog (KIT_DIR names the kit checkout).
const readiness = runReadiness(cfg.sources_catalog);

const runId = basename(rawDir);
const fetchSummary = JSON.parse(
  readFileSync(join(rawDir, "fetch-summary.json"), "utf8"),
) as Record<string, unknown> & {
  expected_count: number;
  downloaded_rows: number;
};
const workDir = join("data", "work", runId);
const outDir = join("data", "out", runId);
const seedDir = join("data", "seeds");
const runsDir = join("runs", runId);
for (const d of [workDir, outDir, seedDir, runsDir])
  mkdirSync(d, { recursive: true });

const ndjson = join(workDir, "rows.ndjson");
const { receipts, rows: stagedRows } = await stageRaw(rawDir, ndjson);
const referenceDate = receipts[0]!.retrieved_at.slice(0, 10);

const parquetName = `los-angeles_property_roll${cfg.roll_year}_slice.parquet`;
const parquetPath = join(outDir, parquetName);
const seedRunPath = join(outDir, "los-angeles-seed.csv");
const seedPath = join(seedDir, "los-angeles.csv");

const db = await DuckDBInstance.create(":memory:", {
  threads: "2",
  memory_limit: "2GB",
});
const c = await db.connect();
const q = async (sql: string) =>
  (await c.runAndReadAll(sql)).getRowObjectsJson() as Array<
    Record<string, unknown>
  >;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

await c.run(
  `create table raw as select * from read_json(${lit(ndjson)}, format='newline_delimited')`,
);

// Publishable table. Column names follow bundled lexicon (kit use-neutral-lexicon model-c) where one exists;
// source_* and *_proxy columns are not lexicon fields (see findings section 10).
await c.run(`
create table property as
select
  AIN::varchar                                                    as parcel_identifier,
  AssessorID::varchar                                             as assessor_id_formatted,
  AIN::varchar                                                    as request_identifier,
  case when try_cast(YearBuilt as integer) between 1800 and 2100 then try_cast(YearBuilt as integer) end as property_structure_built_year,
  case when try_cast(EffectiveYearBuilt as integer) between 1800 and 2100 then try_cast(EffectiveYearBuilt as integer) end as property_effective_built_year,
  'PROXY: assessor year built / effective year built; not a roof installation date' as roof_age_basis,
  nullif(trim(UseType), '')                                       as source_use_type,
  nullif(trim(UseCode), '')                                       as source_use_code,
  concat_ws(' | ', nullif(trim(UseCodeDescChar1), ''), nullif(trim(UseCodeDescChar2), ''), nullif(trim(UseCodeDescChar3), ''), nullif(trim(UseCodeDescChar4), '')) as source_use_code_description,
  nullif(regexp_replace(trim(PropertyLocation), '\\s+', ' ', 'g'), '') as unnormalized_address,
  nullif(trim(concat_ws(' ', nullif(trim(SitusHouseNo::varchar), '0'), nullif(trim(SitusFraction), ''))), '') as street_number,
  nullif(trim(SitusDirection), '')                                as street_pre_directional_text,
  nullif(trim(SitusStreet), '')                                   as street_name,
  nullif(trim(SitusUnit), '')                                     as unit_identifier,
  nullif(trim(regexp_replace(trim(SitusCity), '\\s+CA$', '')), '') as city_name,
  nullif(trim(SitusZIP5), '')                                     as postal_code,
  nullif(split_part(trim(SitusZIP), '-', 2), '')                  as plus_four_postal_code,
  'Los Angeles'                                                   as county_name,
  'CA'                                                            as state_code,
  nullif(CENTER_LAT::double, 0)                                   as latitude,
  nullif(CENTER_LON::double, 0)                                   as longitude,
  'assessor parcel center point (CENTER_LAT/CENTER_LON)'          as coordinate_basis,
  trim(TaxRateArea_CITY)                                          as tax_rate_area_city,
  RollYear::varchar                                               as roll_year,
  case when RecordingDate is not null then cast(epoch_ms(RecordingDate::bigint) as date) end as last_recording_date,
  case when RecordingDate is null then null
       else cast(epoch_ms(RecordingDate::bigint) as date) <= (date ${lit(referenceDate)} - interval 10 year) end as owner_unchanged_10y_proxy,
  cast(null as boolean)                                           as out_of_area_owner,
  _request_url                                                    as source_http_request,
  'GET'                                                           as source_http_method,
  cast(_retrieved_at as timestamptz)                              as source_retrieved_at,
  _page_sha256                                                    as source_page_sha256,
  _page_file                                                      as source_page_file,
  ${lit(cfg.source.name)}                                         as source_name
from raw
order by parcel_identifier`);

const forbidden =
  /owner_?name|mail|contact|phone|email|grantee|grantor|taxpayer/i;
const cols = (
  await q(
    `select column_name from information_schema.columns where table_name='property'`,
  )
).map((r) => String(r.column_name));
const bad = cols.filter(
  (n) =>
    forbidden.test(n) &&
    n !== "owner_unchanged_10y_proxy" &&
    n !== "out_of_area_owner",
);
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
    ],
    scope_guard: "PASS",
  },
  sources: [
    {
      name: cfg.source.name,
      role: "canonical assessed parcel roll (slice)",
      hub_page:
        "https://data.lacounty.gov/datasets/assessor-parcel-data-rolls-2021-present-1",
      hub_item_id: cfg.source.hub_item_id,
      query_url: cfg.source.query_url,
      count_request_url: fetchSummary.count_request_url,
      terms_of_use: "https://egis-lacounty.hub.arcgis.com/pages/terms-of-use",
      access: "anonymous REST, sequential, >= 2 s between requests",
    },
  ],
  row_counts: {
    expected_from_source_count: fetchSummary.expected_count,
    downloaded: fetchSummary.downloaded_rows,
    staged: stagedRows,
    parquet: parquetRows,
    seed_csv: seedRows,
    raw_pages: receipts.length,
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
  ],
  limitations: [
    `Pilot slice only: City of Los Angeles, ZIP ${cfg.zips.join("/")}, roll ${cfg.roll_year}. Not county coverage.`,
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
    "Radius queries over this file only see the 3-ZIP slice; parcels outside the slice inside the radius are absent.",
  ],
  rebuild: [
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
