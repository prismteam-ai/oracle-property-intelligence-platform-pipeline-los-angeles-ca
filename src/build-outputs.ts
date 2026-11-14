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
 * A permit run (config permits_harvested, input roll-cache) also stages the LADBS permit and
 * contractor caches (src/stage-permits.ts, src/stage-contractors.ts) and builds the permit tables
 * and the effective roof year (src/permit-sql.ts). Its reference date is the permit cache's
 * generated_at date.
 *
 * Run ID <T>-b<D> (src/run-config.ts): T is the latest generated_at of the caches (the raw run
 * directory's name for the pilot), D the first 12 hex characters of the build digest over the
 * Parquet files and the run manifest. The build writes into data/work/<T>/build/, computes D, then
 * moves the files to data/out/<ID>/. Parquet files identical to a run recorded before the build
 * digest are that run: nothing is added, and its ID is named. The manifest and the history row
 * record run_kind, rebuild_of, source_changes, build_digest and schema_changes against the
 * previous run (src/run-history.ts).
 *
 * --dry-run builds the same files and computes the same ID, moves them to data/work/<ID>/dry-run/
 * and writes nothing under runs/, data/out/ or data/seeds/, and no history line. Its run manifest
 * is the one the recorded build would write (recorded paths), with dry_run true.
 *
 * Usage: KIT_DIR=<team kit checkout> node src/build-outputs.ts <raw-run-dir | roll-cache-dir> [run-config.json]
 *          [--permit-cache <dir> --contractor-cache <dir>] [--dry-run]
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
import {
  buildDigest,
  isCountyWide,
  isUnder,
  loadRunConfig,
  manifestDigestSha256,
  referenceDateOf,
  RUN_ID_PLACEHOLDER,
  runIdOf,
  runTimeFromCaches,
  whereClause,
} from "./run-config.ts";
import {
  CONTRACTOR_FIELDS,
  PERMIT_FIELDS,
  PERMIT_FLAG_ONLY_FIELDS,
} from "./permit-fields.ts";
import {
  buildPermitTables,
  PUBLISHED_TABLES,
  type PermitBuildStats,
} from "./permit-sql.ts";
import { readPermitCache, stagePermits } from "./stage-permits.ts";
import {
  CONTRACTOR_VIEW,
  readContractorCache,
  stageContractors,
} from "./stage-contractors.ts";
import { stageRaw } from "./stage-raw.ts";
import {
  CONTRACTOR_WINDOW_SQL,
  contractorCoverage,
  contractorIdentityLimitation,
  contractorRowsLimitation,
  type ContractorWindow,
} from "./contractor-identity.ts";
import {
  cacheRunId,
  PAGES_DIR,
  readCacheSummary,
  stageCache,
  type CachePage,
} from "./stage-cache.ts";
import { fileEntry, recordedSeedFileEntries } from "./manifest-files.ts";
import { runReadiness } from "./readiness.ts";
import {
  personalDataColumns,
  propertyTableSql,
  sqlLiteral as lit,
} from "./property-sql.ts";
import {
  appendRunHistory,
  hasSameFiles,
  inputCacheDigests,
  planHistory,
  readHistory,
  rebuildFields,
  schemaChanges,
  type HistoryFile,
  type HistoryRow,
  type InputManifestLike,
  type ParquetColumn,
} from "./run-history.ts";

const USAGE =
  "usage: node src/build-outputs.ts <raw-run-dir | roll-cache-dir> [run-config.json] [--permit-cache <dir> --contractor-cache <dir>] [--dry-run]";
const args = process.argv.slice(2);
const VALUE_OPTIONS = ["--permit-cache", "--contractor-cache"];
const positional: string[] = [];
const options: Record<string, string> = {};
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--dry-run") dryRun = true;
  else if (VALUE_OPTIONS.includes(a)) {
    const v = args[++i];
    if (!v || v.startsWith("--"))
      throw new Error(`${a} needs a value\n${USAGE}`);
    options[a] = v;
  } else if (a.startsWith("--"))
    throw new Error(`unknown option ${a}\n${USAGE}`);
  else positional.push(a);
}
const rawDir = positional[0];
if (!rawDir || positional.length > 2) throw new Error(USAGE);
const configPath = positional[1] ?? "config/la-county-permits-run.json";
const cfg = loadRunConfig(configPath);
guardOrThrow(configPath, cfg.sources_catalog);
// Fails closed unless the kit validator passes on the catalog (KIT_DIR names the kit checkout).
const readiness = runReadiness(cfg.sources_catalog);

const fromCache = cfg.input === "roll-cache";
const countyWide = isCountyWide(cfg);
const withPermits = cfg.permits_harvested;
const permitCacheDir = options["--permit-cache"];
const contractorCacheDir = options["--contractor-cache"];
if (withPermits !== Boolean(permitCacheDir || contractorCacheDir))
  throw new Error(
    "--permit-cache and --contractor-cache go with a permit run (permits_harvested) only",
  );
if (
  withPermits &&
  (!fromCache || !permitCacheDir || !contractorCacheDir || !cfg.permit_sources)
)
  throw new Error(
    `a permit run reads the roll cache, both --permit-cache and --contractor-cache, and config permit_sources\n${USAGE}`,
  );
// The run ID's time part. Pilot: the raw run directory's name. Roll cache: the cache summary's
// generated_at. Permit run: the latest generated_at of the roll, permit and contractor caches.
const cacheSummary = fromCache ? readCacheSummary(rawDir) : undefined;
const permitCache = withPermits ? readPermitCache(permitCacheDir!) : undefined;
const contractorCache = withPermits
  ? readContractorCache(contractorCacheDir!)
  : undefined;
const runTime =
  permitCache && contractorCache && cacheSummary
    ? runTimeFromCaches([
        cacheSummary.generated_at,
        permitCache.summary.generated_at,
        contractorCache.summary.generated_at,
      ])
    : cacheSummary
      ? cacheRunId(cacheSummary)
      : basename(rawDir);
const fetchSummary = fromCache
  ? undefined
  : (JSON.parse(
      readFileSync(join(rawDir, "fetch-summary.json"), "utf8"),
    ) as Record<string, unknown> & {
      expected_count: number;
      downloaded_rows: number;
      count_request_url: string;
    });
const workDir = join("data", "work", runTime);
// Every output file is written here first (cleared first); the run ID is known only once they exist.
const buildDir = join(workDir, "build");
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
// The recorded data folder, named with the placeholder until the build digest gives the ID.
const recordedOutDir = join("data", "out", RUN_ID_PLACEHOLDER);
const seedDir = join("data", "seeds");

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
  // Every derived duration of a permit run counts to the permit cache's date.
  referenceDate = permitCache
    ? referenceDateOf(permitCache.summary.generated_at)
    : cachePages[0]!.fetched_at.slice(0, 10);
} else {
  const staged = await stageRaw(rawDir, ndjson);
  receipts = staged.receipts;
  stagedRows = staged.rows;
  referenceDate = receipts[0]!.retrieved_at.slice(0, 10);
}

const parquetName = `los-angeles_property_roll${cfg.roll_year}${countyWide ? "" : "_slice"}.parquet`;
const parquetPath = join(buildDir, parquetName);
const seedRunPath = join(buildDir, "los-angeles-seed.csv");
const seedPath = join(seedDir, "los-angeles.csv");
/** The recorded path of a file written in buildDir. */
const recordedPath = (path: string) => join(recordedOutDir, basename(path));

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
const sha256File = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

// Column types come from every row of a county-size file, not only the first sample.
await c.run(
  `create table raw as select * from read_json(${lit(ndjson)}, format='newline_delimited'${fromCache ? ", sample_size=-1" : ""})`,
);

await c.run(propertyTableSql(referenceDate, cfg.source.name));

// Permit run: stage both LADBS caches (all text, no type guessing) and build the permit tables.
let permitStats: PermitBuildStats | undefined;
let permitStaging:
  | {
      permits: Awaited<ReturnType<typeof stagePermits>>;
      contractors: Awaited<ReturnType<typeof stageContractors>>;
    }
  | undefined;
if (withPermits) {
  const sources = cfg.permit_sources!;
  const permits = await stagePermits(
    permitCacheDir!,
    join(workDir, "permits.ndjson"),
  );
  const sameSets = (a: string[], b: string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (!sameSets(Object.keys(permits.rowsByDataset), sources.permits.datasets))
    throw new Error("the permit cache's datasets are not the config's");
  if (!sameSets([CONTRACTOR_VIEW], sources.contractors.datasets))
    throw new Error(`the config's contractor view is not ${CONTRACTOR_VIEW}`);
  const contractors = await stageContractors(
    contractorCacheDir!,
    join(workDir, "contractors.ndjson"),
  );
  permitStaging = { permits, contractors };
  const asText = (fields: readonly string[]) =>
    `{${fields.map((f) => `${lit(f)}: 'VARCHAR'`).join(", ")}}`;
  const PROV = [
    "_dataset",
    "_page_file",
    "_request_url",
    "_retrieved_at",
    "_page_sha256",
  ];
  await c.run(
    `create table permit_raw as select * from read_json(${lit(join(workDir, "permits.ndjson"))}, format='newline_delimited', columns=${asText([...PERMIT_FIELDS, ...PROV, "_dataset_kind"])})`,
  );
  await c.run(
    `create table contractor_raw as select * from read_json(${lit(join(workDir, "contractors.ndjson"))}, format='newline_delimited', columns=${asText([...CONTRACTOR_FIELDS, ...PROV])})`,
  );
  permitStats = await buildPermitTables(c, {
    referenceDate,
    permitSourceName: sources.permits.name,
    contractorSourceName: sources.contractors.name,
  });
  await c.run("drop table permit_raw; drop table contractor_raw");
}

const publishedTables: readonly string[] = withPermits
  ? PUBLISHED_TABLES
  : ["property"];
for (const t of publishedTables) {
  const cols = (
    await q(
      `select column_name from information_schema.columns where table_name=${lit(t)}`,
    )
  ).map((r) => String(r.column_name));
  const bad = personalDataColumns(cols);
  if (bad.length)
    throw new Error(
      `personal-data columns in publishable table ${t}: ${bad.join(", ")}`,
    );
  const flagOnly = cols.filter((col) =>
    (PERMIT_FLAG_ONLY_FIELDS as readonly string[]).includes(col),
  );
  if (flagOnly.length)
    throw new Error(
      `${t} holds ${flagOnly.join(", ")}, which is never published`,
    );
}
const dupes = await q(
  `select count(*) - count(distinct parcel_identifier) d from property`,
);
if (Number(dupes[0]!.d) !== 0) throw new Error("duplicate parcel_identifier");

// Every file is written in buildDir; a recorded run's files are never replaced. A run already in
// the history with the same files is not recorded again: its Parquet, seed, manifest and history
// row stay as they are. The same run ID with a different Parquet fails.
await c.run(
  `copy property to ${lit(parquetPath)} (format parquet, compression zstd)`,
);
// Permit run: the three permit tables, each next to its final path first, as the property file.
const PERMIT_PARQUETS = [
  ["permit", "permits", "los-angeles_ladbs_permits.parquet"],
  [
    "permit_parcel",
    "permit_parcels",
    "los-angeles_ladbs_permit_parcels.parquet",
  ],
  [
    "permit_contractor",
    "permit_contractors",
    "los-angeles_ladbs_permit_contractors.parquet",
  ],
] as const;
const permitFiles: HistoryFile[] = [];
if (withPermits)
  for (const [table, role, name] of PERMIT_PARQUETS) {
    const path = join(buildDir, name);
    await c.run(
      `copy ${table} to ${lit(path)} (format parquet, compression zstd)`,
    );
    permitFiles.push({ role, path, sha256: sha256File(path) });
  }
const historyPath = join("runs", "run_history.jsonl");
const parquetSha256 = sha256File(parquetPath);
const history = readHistory(historyPath);

await c.run(`copy (select parcel_identifier as parcel_id, request_identifier as source_identifier, unnormalized_address as situs_address,
  assessor_id_formatted, roll_year, latitude, longitude from property order by parcel_id) to ${lit(seedRunPath)} (header, delimiter ',')`);

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

// Permit run facts for the manifest: Parquet row counts and the contractor rows' issue-date window.
const permitRows: Record<string, number> = {};
let contractorWindow: ContractorWindow = {
  first: null,
  last: null,
};
if (withPermits) {
  for (const f of permitFiles)
    permitRows[f.role] = Number(
      (await q(`select count(*) n from read_parquet(${lit(f.path)})`))[0]!.n,
    );
  const w = (await q(CONTRACTOR_WINDOW_SQL))[0]!;
  contractorWindow = {
    first: w.first === null ? null : String(w.first),
    last: w.last === null ? null : String(w.last),
  };
}
const permitLimitations = (ps: PermitBuildStats): string[] => {
  const total = Object.values(ps.permits).reduce((a, b) => a + b, 0);
  const unjoined = ps.join_by_method.unjoined ?? 0;
  const pct = (x: number) => Math.round((x / total) * 10000) / 100;
  const outside = Object.values(ps.joined_outside_permit_jurisdiction).reduce(
    (a, b) => a + b,
    0,
  );
  return [
    `Permits: City of Los Angeles only (LADBS, data.lacity.org): ${cfg.permit_sources!.permits.datasets.length} building-permit datasets, cached with the filter "work description contains ROOF", and the contractor view ${CONTRACTOR_VIEW}. Permit sources not yet covered (88 jurisdictions without a classified permit source): ` +
      notCovered.join(", ") +
      ".",
    `Permit-to-parcel join: the APN equal to the AIN, else a full address match (house number, normalized street name and ZIP; direction and fraction agree where both carry one; map book and page only narrow). No coordinate matching: the nearest parcel centre can be a neighbour's parcel. ${unjoined} of ${total} permits (${pct(unjoined)}%) stay unjoined, counted by cause in permits.unjoined_by_cause; their parcels keep the year-built proxy.`,
    `Condo buildings: a permit that matches the units of one building attaches to every unit (building_level) and is counted once (${ps.condo_buildings.permits} permits, ${ps.condo_buildings.units} units). The roof decision belongs to the owners' association.`,
    `Roofing work is roof_r or roof_only with whole-word matching; partial repairs are included. ${ps.roof_flag_groups.coating_only} permits are roofing work only through "COATING TO AN EXISTING ROOF": they stay in the permit table but never set a roof year.`,
    `Effective roof year: the year of the status date of the latest roofing permit with status Permit Finaled linked to the parcel (building-level links count for every unit); otherwise the year built, a PROXY (roof_age_basis says which). The status date is taken as the final date: a sample check against final inspections supports it, it is not a confirmation. Permits dated after the reference date or in a year before the year built are ignored (permits.roof_permits_ignored).`,
    `Status classes: open-issued (the only class counted as open for long-open), open-application (details only), closed, and unclear (Quality Review Completed, CofO in Progress: neither open nor closed). Unknown statuses are "unmapped" and counted. open_since is the issue date (open-issued) or the submitted date (open-application); open_days counts to the reference date ${referenceDate}, never the build date.`,
    "Permit work descriptions are not served: the free text can hold people's names. The build reads them only to set the roofing flags.",
    contractorRowsLimitation(contractorWindow),
    contractorIdentityLimitation(ps.contractor_identity),
    `${outside} permits join parcels outside the City of Los Angeles (by method in permits.joined_outside_permit_jurisdiction): border, annexation or APN-typo cases, kept and counted. Parcels outside the City of Los Angeles have no permit data (permit_data_available false).`,
    "The LADBS inspections dataset (9w5z-rg2h) is not used: it records final inspections for only part of the roofing permits, and the permit status is the more complete signal.",
    `Permit data terms: the building-permit datasets state no license (${cfg.permit_sources!.permits.terms_of_use}, May 2014); the contractor view is ${cfg.permit_sources!.contractors.license}. Attribution: ${cfg.permit_sources!.permits.attribution}.`,
  ];
};

const n = Number(stats.n);
const share = (k: string) => Math.round((Number(stats[k]) / n) * 10000) / 100;
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
const permitCaches = permitStaging && {
  note: "Paths are relative to each cache directory. The cache files are recorded by sha256; their contents are not copied. The derived roofing flag file in the permit cache is not read.",
  permits: {
    name: basename(permitCacheDir!),
    generated_at: permitCache!.summary.generated_at,
    files: permitStaging.permits.files,
    rows: permitStaging.permits.rows,
    rows_by_dataset: permitStaging.permits.rowsByDataset,
    pages: permitStaging.permits.pages.map((p) => ({
      dataset: p.dataset,
      kind: p.kind,
      path: `${PAGES_DIR}/${p.file}`,
      request_url: p.url,
      retrieved_at: p.retrieved_at,
      rows: p.row_count,
      json_sha256: p.sha256_json,
      gz_sha256: p.sha256_gz,
    })),
  },
  contractors: {
    name: basename(contractorCacheDir!),
    generated_at: contractorCache!.summary.generated_at,
    files: permitStaging.contractors.files,
    rows: permitStaging.contractors.rows,
    exact_duplicate_rows: permitStaging.contractors.duplicates,
    staged: permitStaging.contractors.staged,
    distinct_permits: permitStaging.contractors.distinctPermits,
    pages: contractorCache!.manifest.pages.map((p) => ({
      path: `${PAGES_DIR}/${p.file}`,
      request_url: p.url,
      retrieved_at: p.retrieved_at,
      rows: p.row_count,
      json_sha256: p.sha256_json,
      gz_sha256: p.sha256_gz,
    })),
  },
};

// Input cache files of this build, as src/run-history.ts inputCacheDigests reads a manifest.
const inputFiles = fromCache
  ? []
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
    ];
const inputs = inputCacheDigests({
  ...(cache && { cache }),
  ...(permitCaches && { permit_caches: permitCaches }),
  files: inputFiles,
} as InputManifestLike);

// This build's outputs (role, file in buildDir) and their Parquet schemas.
const outputs: Array<{ role: string; path: string; sha256: string }> = [
  { role: "property", path: parquetPath, sha256: parquetSha256 },
  ...permitFiles,
];
const parquetColumns = async (path: string): Promise<ParquetColumn[]> =>
  (await q(`describe select * from read_parquet(${lit(path)})`)).map((r) => ({
    name: String(r.column_name),
    type: String(r.column_type),
  }));
const schemas: Record<string, ParquetColumn[]> = {};
for (const o of outputs) schemas[o.role] = await parquetColumns(o.path);

// A previous run's recorded file, checked against its recorded sha256 before it is read.
const checked = new Map<string, string>();
const recordedFile = (path: unknown, sha256: unknown, what: string): string => {
  if (typeof path !== "string" || !existsSync(path))
    throw new Error(
      `the previous run's ${what} (${String(path)}) is needed for the delta, run_kind and schema_changes`,
    );
  if (!checked.has(path)) checked.set(path, sha256File(path));
  if (checked.get(path) !== sha256)
    throw new Error(`${path} does not match its recorded sha256`);
  return path;
};

/** How this build relates to a previous run: delta, run kind and schema changes. */
async function relationTo(prev: HistoryRow | undefined) {
  if (!prev)
    return {
      delta: {
        previous_run_id: null,
        note: "first run; every row is new",
        added: parquetRows,
        removed: 0,
      } as Record<string, unknown>,
      rebuild: rebuildFields(inputs, undefined),
      schema_changes: schemaChanges(undefined, schemas),
    };
  // Delta by parcel identifier.
  const prevParquet = recordedFile(
    prev.parquet_path,
    prev.parquet_sha256,
    "property Parquet",
  );
  const d = (
    await q(`select
    (select count(*) from read_parquet(${lit(parquetPath)}) n where n.parcel_identifier not in (select parcel_identifier from read_parquet(${lit(prevParquet)}))) added,
    (select count(*) from read_parquet(${lit(prevParquet)}) o where o.parcel_identifier not in (select parcel_identifier from read_parquet(${lit(parquetPath)}))) removed`)
  )[0]!;
  const prevSchemas: Record<string, ParquetColumn[]> = {
    property: await parquetColumns(prevParquet),
  };
  for (const f of prev.permit_files ?? [])
    prevSchemas[f.role] = await parquetColumns(
      recordedFile(f.path, f.sha256, `${f.role} Parquet`),
    );
  const prevManifest = JSON.parse(
    readFileSync(
      recordedFile(prev.manifest_path, prev.manifest_sha256, "run manifest"),
      "utf8",
    ),
  ) as InputManifestLike;
  return {
    delta: {
      previous_run_id: prev.run_id,
      added: Number(d.added),
      removed: Number(d.removed),
    } as Record<string, unknown>,
    rebuild: rebuildFields(inputs, {
      run_id: prev.run_id,
      inputs: inputCacheDigests(prevManifest),
    }),
    schema_changes: schemaChanges(prevSchemas, schemas),
  };
}

const seedEntries = recordedSeedFileEntries(
  {
    ...fileEntry(
      seedRunPath,
      seedRows,
      "runtime seed CSV for this run (parcel_id, source_identifier, situs_address + extras)",
      false,
    ),
    path: recordedPath(seedRunPath),
  },
  seedPath,
);

/**
 * The run manifest as the recorded build writes it, with the run ID as RUN_ID_PLACEHOLDER and
 * generated_at and build_digest still empty (neither is in the build digest).
 */
const makeManifest = (rel: Awaited<ReturnType<typeof relationTo>>) => ({
  run_id: RUN_ID_PLACEHOLDER,
  run_name: cfg.run_name,
  generated_at: "",
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
    ...(withPermits && { permit_jurisdictions: cfg.permit_jurisdictions }),
    where: whereClause(cfg),
  },
  dry_run: false,
  readiness: {
    ...readiness,
    evidence: [
      "docs/evidence/la-preflight-blocked.json",
      "docs/evidence/la-preflight-pass.json",
      ...(countyWide ? ["docs/evidence/la-preflight-pass-county.json"] : []),
      ...(withPermits
        ? ["docs/evidence/la-preflight-pass-county-permits.json"]
        : []),
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
      coverage: null,
    },
    ...(withPermits
      ? (["permits", "contractors"] as const).map((k) => {
          const src = cfg.permit_sources![k];
          return {
            name: src.name,
            role:
              k === "permits"
                ? "City of Los Angeles building permits (LADBS)"
                : "contractor rows of LADBS permits",
            datasets: src.datasets,
            query_urls: src.datasets.map(
              (d) => `https://data.lacity.org/resource/${d}.json`,
            ),
            terms_of_use: src.terms_of_use,
            license: src.license,
            attribution: src.attribution,
            access:
              "anonymous SoQL pages, cached locally; request URLs per page in permit_caches",
            // The contractor rows' issue-date window, the same values as the limitations sentence.
            coverage:
              k === "contractors" ? contractorCoverage(contractorWindow) : null,
          };
        })
      : []),
  ],
  ...(cache && { cache }),
  ...(permitCaches && { permit_caches: permitCaches }),
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
    ...(permitStaging && {
      permits: {
        staged: permitStaging.permits.rows,
        contractor_rows: permitStaging.contractors.rows,
        contractor_rows_staged: permitStaging.contractors.staged,
        parquet: permitRows,
      },
    }),
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
    ...(permitStats && { permit_data: permitStats.coverage }),
  },
  ...(permitStats && { permits: permitStats }),
  derived_field_reference_date: referenceDate,
  delta: rel.delta,
  run_kind: rel.rebuild.run_kind,
  rebuild_of: rel.rebuild.rebuild_of,
  source_changes: rel.rebuild.source_changes,
  build_digest: "",
  schema_changes: rel.schema_changes,
  files: [
    {
      ...fileEntry(
        parquetPath,
        parquetRows,
        "publishable property table (publish only after user approval and rights check)",
        true,
      ),
      path: recordedPath(parquetPath),
    },
    ...permitFiles.map((f) => ({
      ...fileEntry(
        f.path,
        permitRows[f.role] ?? null,
        `publishable ${f.role.replace("_", " ")} table (publish only after user approval and rights check)`,
        true,
      ),
      path: recordedPath(f.path),
    })),
    ...seedEntries,
    ...(fromCache
      ? [
          cacheFileEntry("summary.json", null, "roll cache summary"),
          cacheFileEntry(
            "manifest.jsonl",
            cachePages.length,
            "roll cache page manifest (request URL, HTTP status, body sha256 per page)",
          ),
        ]
      : inputFiles),
  ],
  limitations: [
    countyWide
      ? `County-wide: all of Los Angeles County (89 jurisdictions), no ZIP filter, roll ${cfg.roll_year}, built from the whole-roll cache (${cachePages.length} pages). The cache was downloaded with every field; the build keeps only the fields it reads.`
      : `Pilot slice only: City of Los Angeles, ZIP ${cfg.zips.join("/")}, roll ${cfg.roll_year}. Not county coverage.`,
    ...(permitStats
      ? permitLimitations(permitStats)
      : [
          "No permits harvested in this increment. Permit sources not yet covered (88 jurisdictions without a classified permit source): " +
            notCovered.join(", ") +
            ".",
          "City of Los Angeles permits (LADBS, data.lacity.org) are classified but not harvested in this increment.",
        ]),
    "PUBLICATION BLOCKER: republication rights under the LA County eGIS Terms of Use ('for informational purposes') are unverified. Nothing may be published until confirmed and approved.",
    "Year built and effective year built are a roof-age PROXY, not roof installation dates. Source value 0 is treated as unknown (null).",
    "last_recording_date is the assessor's latest recorded document date, not necessarily a sale or ownership transfer. owner_unchanged_10y_proxy = last_recording_date <= reference date - 10 years; it can understate (non-transfer recordings) and is null when no date.",
    "out_of_area_owner is null for every row: the open roll has no owner mailing address. Owner mailing data exists only in a secured county service that is not used.",
    "No owner names, mailing addresses or contact fields exist in the source; no person entities and no private owner file were produced.",
    "Coordinates are assessor parcel center points, not rooftop or address-point geocodes; rows without them are left null (not geocoded).",
    "Lexicon names are taken from the bundled kit catalog (use-neutral-lexicon model-c) without the live Elephant lexicon/MCP; source_* columns, roof_age_basis, coordinate_basis, *_proxy, last_recording_date, tax_rate_area_city, roll_year and assessor_id_formatted are not lexicon fields; property_usage_type/property_type enums are not mapped (raw use code kept).",
    ...(withPermits
      ? [
          "Permit tables: permit_number, application_received_date, permit_issue_date, unnormalized_address, postal_code, parcel_identifier, license_identifier, license_expiration_date, city_name, state_code and is_owner_builder follow the bundled lexicon; raw LADBS values keep source_* names (they are not lexicon enum values); status_date, the status class, open_since/open_days, the roofing flags, join columns, license class columns, contractors_business_name, the contractor identity columns (contractor_identity_key, canonical_business_name, name_variant_count, identity_permit_count), permit_data_available, effective_roof_year, roof_year_permit_number and the rule versions are not lexicon fields.",
        ]
      : []),
    countyWide
      ? `Radius queries see every parcel with assessor coordinates; the ${n - Number(stats.coords)} parcels without them never appear in radius results.`
      : "Radius queries over this file only see the 3-ZIP slice; parcels outside the slice inside the radius are absent.",
  ],
  rebuild: withPermits
    ? [
        "pnpm install --frozen-lockfile",
        `node src/scope-guard.ts ${configPath}`,
        `node ${FETCH_ROLL_SCRIPT} <roll-cache-dir>   (downloads the whole roll; network)`,
        "(the LADBS permit and contractor caches were downloaded by their own fetch.mjs; their sha256 is in permit_caches)",
        `KIT_DIR=<team kit checkout> node src/build-outputs.ts <roll-cache-dir> ${configPath} --permit-cache <permit-cache-dir> --contractor-cache <contractor-cache-dir>`,
        "node src/query-radius.ts --parquet data/out/<run_id>/" + parquetName,
      ]
    : fromCache
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
});

// The build digest and the run ID. If this build's files equal the last recorded run's, that run
// may be this very build: its manifest was made against the run before it, so try that first.
const digestOf = (m: ReturnType<typeof makeManifest>) =>
  buildDigest(
    outputs,
    manifestDigestSha256(
      m as unknown as Record<string, unknown>,
      RUN_ID_PLACEHOLDER,
    ),
  );
const last = history.at(-1);
let manifest = makeManifest(await relationTo(last));
let digest = digestOf(manifest);
if (
  last?.build_digest !== undefined &&
  digest !== last.build_digest &&
  hasSameFiles(last, parquetSha256, withPermits ? permitFiles : undefined)
) {
  const before = makeManifest(await relationTo(history.at(-2)));
  if (digestOf(before) === last.build_digest) {
    manifest = before;
    digest = last.build_digest;
  }
}
const runId = runIdOf(runTime, digest);
const historyPlan = planHistory(
  history,
  runId,
  parquetSha256,
  withPermits ? permitFiles : undefined,
);
if (historyPlan.kind === "recorded" && !dryRun) {
  rmSync(buildDir, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        run_id: historyPlan.row.run_id,
        already_recorded: true,
        this_build_id: runId,
        parquet: historyPlan.row.parquet_path,
        parquet_sha256: parquetSha256,
        manifest: historyPlan.row.manifest_path,
        note:
          historyPlan.row.run_id === runId
            ? "same run ID and the same files: no history row added; Parquet, seed and manifest left as recorded"
            : "the same Parquet and permit files as this run, recorded before the build digest: no history row added; its files left as recorded",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Move the files from buildDir to the run's folder (a dry run: data/work/<ID>/dry-run/).
const outDir = dryRun
  ? join("data", "work", runId, "dry-run")
  : join("data", "out", runId);
const runsDir = dryRun ? outDir : join("runs", runId);
if (dryRun) rmSync(outDir, { recursive: true, force: true });
for (const d of dryRun ? [outDir] : [outDir, runsDir])
  if (existsSync(d))
    throw new Error(
      `${d} exists but run ${runId} is not recorded; nothing replaced`,
    );
mkdirSync(join(outDir, ".."), { recursive: true });
renameSync(buildDir, outDir);
if (!dryRun) {
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(seedDir, { recursive: true });
  if (existsSync(seedPath)) console.log(`replacing existing ${seedPath}`);
  copyFileSync(join(outDir, basename(seedRunPath)), seedPath);
  if (sha256File(seedPath) !== seedEntries[1].sha256)
    throw new Error(`${seedPath} is not a byte copy of the run's seed`);
}

const written = {
  ...manifest,
  generated_at: new Date().toISOString(),
  build_digest: digest,
  dry_run: dryRun,
};
const manifestText = (JSON.stringify(written, null, 2) + "\n")
  .split(RUN_ID_PLACEHOLDER)
  .join(runId);
const manifestPath = join(runsDir, "run_manifest.json");
writeFileSync(manifestPath, manifestText);
const manifestSha = sha256File(manifestPath);
// The written manifest gives the same digest (recorded form: dry_run false).
if (
  buildDigest(
    outputs,
    manifestDigestSha256(
      {
        ...(JSON.parse(manifestText) as Record<string, unknown>),
        dry_run: false,
      },
      runId,
    ),
  ) !== digest
)
  throw new Error("the written run manifest does not give the build digest");
for (const f of [
  { path: join(outDir, parquetName), sha256: parquetSha256 },
  ...permitFiles.map((f) => ({
    path: join(outDir, basename(f.path)),
    sha256: f.sha256,
  })),
])
  if (sha256File(f.path) !== f.sha256)
    throw new Error(`${f.path} changed during the build`);
const recordedOut = join("data", "out", runId);
const recordedFiles = (
  JSON.parse(manifestText) as { files: Array<Record<string, unknown>> }
).files;
if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dry_run: true,
        run_id: runId,
        build_digest: digest,
        run_kind: manifest.run_kind,
        rebuild_of: manifest.rebuild_of,
        schema_changes: manifest.schema_changes,
        history:
          historyPlan.kind === "recorded"
            ? `already recorded as ${historyPlan.row.run_id}: a recorded build adds no row`
            : "a recorded build would add one row",
        reference_date: referenceDate,
        manifest: manifestPath,
        files: recordedFiles
          .filter((f) => isUnder(String(f.path), recordedOut))
          .map((f) => ({
            path: join(outDir, String(f.name)),
            size_bytes: f.size_bytes,
            sha256: f.sha256,
            rows: f.row_count,
          })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const recordedPermitFiles = permitFiles.map((f) => ({
  ...f,
  path: join(recordedOut, basename(f.path)),
}));
appendRunHistory(historyPath, {
  run_id: runId,
  finished_at: written.generated_at,
  county: cfg.county,
  roll_year: cfg.roll_year,
  scope: manifest.scope,
  sources: manifest.sources.flatMap((s) =>
    "query_url" in s ? [s.query_url] : s.query_urls,
  ),
  row_counts: manifest.row_counts,
  delta: manifest.delta,
  run_kind: manifest.run_kind,
  rebuild_of: manifest.rebuild_of,
  source_changes: manifest.source_changes,
  build_digest: digest,
  schema_changes: manifest.schema_changes,
  parquet_path: join(recordedOut, parquetName),
  parquet_sha256: parquetSha256,
  ...(withPermits && { permit_files: recordedPermitFiles }),
  manifest_path: manifestPath,
  manifest_sha256: manifestSha,
  published: false,
});

console.log(
  JSON.stringify(
    {
      run_id: runId,
      run_kind: manifest.run_kind,
      manifest: manifestPath,
      parquet: join(recordedOut, parquetName),
      seed: seedPath,
      row_counts: manifest.row_counts,
      coverage: manifest.coverage,
    },
    null,
    2,
  ),
);
