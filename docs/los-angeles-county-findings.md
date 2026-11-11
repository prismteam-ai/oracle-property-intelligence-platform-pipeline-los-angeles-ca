# Los Angeles County, CA: findings (increment 1, local parcel pilot)

Status: the increment-1 pilot ran on 2026-11-11 (run `2026-11-11T16-17-38-928Z`).
The preflight passes with the approved permit exception, the scope guard passes, and
22,313 rows were downloaded and built. Nothing has been published.
Snapshot: 2026-11-11T15:52Z. Machine-readable catalog: `docs/los-angeles-sources.yaml`.

## Scope of increment 1

- A local parcel slice only, with nothing leaving the VM: no AWS, no IPFS or pinning, no
  Atlas, no push. The Oracle runtime (Restate, Postgres, Batch) is not started.
- Pilot area: City of LA parcels in ZIP 91405, 91406 and 91411, so that LADBS permits
  can join later.
- Roll year: **2026**, the latest roll published on data.lacounty.gov. The slice has
  **22,313 parcels** in roll 2026, compared with 22,303 in roll 2025.

## 1. Assessor (appraiser) source

- Official hub: LA County Open Data, https://data.lacounty.gov (Assessor's Office hub page).
- Dataset: "Assessor Parcel Data Roll 2026", Hub item `0d3ac33a76e1495bb7fc522a8085729c`,
  modified 2026-10-14.
  Query API: `https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0/query`
  (table, no geometry, maxRecordCount 1000, pagination supported).
- Older rolls: "Assessor Parcel Data (Rolls 2021 - 2025)" `Parcel_Data_2021_Table` (12.1M
  rows). Rolls 2006-2020 are split across three more tables. The bulk CSV zip for
  2021-2025 is https://apps.gis.lacounty.gov/static/hub/Assessor/Assessor_Parcel_Roll_2021_2025.zip.
- Monthly changes: "Assessor Parcel Change Data (Current)" `Parcel_Change_File`. This is
  the candidate change feed for incremental runs.
- Access: plain anonymous REST. No CAPTCHA and no session. A browser is not needed
  because this is a documented JSON API, not a portal page.
  robots.txt: data.lacounty.gov sets `Crawl-delay: 60` and disallows only admin paths.
  services.arcgis.com and apps.gis.lacounty.gov serve no robots.txt. The pilot rate is at
  most 1 request every 2 s, sequential.
- Terms: the LA County eGIS Terms of Use, https://egis-lacounty.hub.arcgis.com/pages/terms-of-use.
  Data is "for informational purposes". Republication rights must be checked before any
  IPFS publication.
- Per-parcel portal (not used): https://portal.assessor.lacounty.gov/

### Fields (roll 2026 table)

SitusZIP, TaxRateArea_CITY, AIN, RollYear, TaxRateArea, AssessorID, PropertyLocation,
UseType, UseCode, UseCodeDescChar1-4, totBuildingDataLines, YearBuilt, EffectiveYearBuilt,
SQFTmain, Bedrooms, Bathrooms, Units, RecordingDate, Roll_* values and exemptions,
isTaxableParcel, netTaxableValue, ParcelClassification, AdminRegion, Cluster,
ParcelBoundaryDescription, SitusHouseNo, SitusFraction, SitusDirection, SitusStreet,
SitusUnit, SitusCity, SitusZIP5, rowID, CENTER_LAT, CENTER_LON, OBJECTID.

- **There are no owner name, mailing address or contact fields.** No person entities
  are possible, and no never-published owner Parquet is needed.
- `RecordingDate` is the date of the latest recorded document. It is not guaranteed to
  be a sale or transfer. The "owner unchanged 10+ years" flag is derived from it and
  carries that caveat.
- Out-of-area owner: this cannot be derived because there is no mailing address. The
  field is null. Owner mailing data sits in the secured "LACounty_Parcel_OwnershipSecure"
  service, which is not open and is not used.
- `YearBuilt` and `EffectiveYearBuilt` are strings (YYYY). They are a roof-age **proxy**,
  not a roof date.
- `TaxRateArea_CITY` values are space-padded (for example `'ARCADIA    '`), so trim them
  before joining. `SitusCity` is free text from the situs address (for example
  `VAN NUYS CA`), so the pilot uses the tax-rate-area city to decide jurisdiction.

## 2. Parcel identifier

- AIN: 10 digits, handled as a string with leading zeros kept. AssessorID is the
  formatted version, `9999-999-999`.
- The LADBS permit datasets carry APN/AIN-style fields. The join key will be checked in
  the permit increment.

## 3. Counts (parcel gate)

| Measure                                             | Value                                              |
| --------------------------------------------------- | -------------------------------------------------- |
| Roll 2026 assessed rows (canonical)                 | 2,428,433                                          |
| GIS parcel polygons (`LACounty_Parcel/MapServer/0`) | 2,433,388                                          |
| Discrepancy                                         | 0.20% (GIS above the roll; below the 2% threshold) |
| Pilot slice, roll 2026                              | 22,313 (all `TaxRateArea_CITY = 'LOS ANGELES'`)    |
| Pilot slice, roll 2025                              | 22,303                                             |

## 4. Permits are split by jurisdiction

There are 89 jurisdictions: 88 incorporated cities plus unincorporated, taken from the
distinct `TaxRateArea_CITY` values in roll 2026.

- **City of Los Angeles**: LADBS publishes permits on data.lacity.org (Socrata, `Crawl-delay: 1`).
  Datasets: issued 2020-present `pi9x-tg5x`, 2010-2019 `dyxf-7hc4`, before 2010 `e67z-kt2n`;
  submitted `gwh9-jnip`, `n3xg-rixm`, `b6ii-mhed`; plus electrical, mechanical and
  certificate-of-occupancy datasets. **These cover the City of LA only.**
- **Unincorporated LA County**: EPIC-LA (https://epicla.lacounty.gov/, LA County Public
  Works). It is reachable, but the vendor, history depth and search-by-AIN have not been
  probed.
- **The other 87 cities** each run their own permit system (for example Long Beach,
  Glendale, Santa Clarita, Pasadena). None has been discovered yet.
- No county one-stop covers municipal history (`assumes_unified_countywide_history: false`).

## 5. Later sources (not in increment 1)

- CSLB (Contractors State License Board) licence data is the official contractor licence
  identity. It is the California equivalent of Florida DBPR.
- California Secretary of State (bizfile Online) is the official business entity
  registry, the California equivalent of Florida Sunbiz.
- BBB is enrichment only.
- **Sunbiz and DBPR do not apply** to California and are skipped.

## 6. Readiness preflight (`validate-county-readiness.py`), 2026-11-11

**Overall: BLOCKED (exit 1); seed_allowed=false.**

| Gate             | Status         | Evidence                                                                    |
| ---------------- | -------------- | --------------------------------------------------------------------------- |
| catalog_metadata | PASS           | Los Angeles CA, slug los-angeles, FIPS 06037                                |
| parcel           | PASS           | tax_roll 2,428,433 vs GIS 2,433,388 (0.20%)                                 |
| permit           | BLOCKED        | 88 of 89 jurisdictions unclassified (unincorporated/EPIC-LA plus 87 cities) |
| destination      | NOT_APPLICABLE | writes_in_scope=false (local files only)                                    |
| enrichment       | PASS           | no BBB claim                                                                |

Under the kit's rules the seed stays blocked until every jurisdiction is classified, or
until an approved permit-gate exception is recorded in `approved_exceptions`. The user
chose Option A, a scoped exception, and approved it on 2026-11-11 (section 6a). Evidence of the blocked gate: `docs/evidence/la-preflight-blocked.json`.

### 6a. Approved permit-gate exception (approved by Mario Ferraro, 2026-11-11)

Active entry in `approved_exceptions` of `docs/los-angeles-sources.yaml`:

```yaml
approved_exceptions:
  - gate: permit
    reason: >-
      Increment 1 only: parcels only, City of Los Angeles, ZIP codes 91405, 91406 and
      91411, LA County Assessor roll 2026. No permits are harvested in this increment.
      The 88 jurisdictions without a classified permit source are not yet covered and
      are listed by name in docs/los-angeles-county-findings.md (section 6b) and in
      run_manifest.json limitations. Expires when permits are added; the readiness
      check is then re-run without it. Full-county parcels are outside this scope and
      need their own approved exception.
    scope:
      {
        increment: 1,
        data: parcels-only,
        jurisdiction: Los Angeles,
        zips: ["91405", "91406", "91411"],
        roll_year: "2026",
      }
    permits_harvested: false
    not_yet_covered_count: 88
    expires: "Expires when permits are added; the readiness check is then re-run without it."
    approved_by: "Mario Ferraro, 2026-11-11"
```

How the validator reads it: `_approved()` in the kit's `validate-county-readiness.py`
matches any `approved_exceptions` item with `gate: permit` and a non-empty `reason`. The
permit gate then reports `APPROVED_EXCEPTION`, and overall becomes PASS (exit 0) because
the other gates are PASS or NOT_APPLICABLE. The validator **ignores** `scope`, `expires`
and the other extra keys. It does not enforce scope or expiry, and it would also pass a
full-county preflight while the entry is present. Enforcement is therefore procedural:
the entry is removed when permits are added. Enforcing it automatically would need a kit validator
change (for example, checking `expires`/`scope` against a run-scope argument). That
change has not been made.

### 6b. Jurisdictions not yet covered (88, no classified permit source)

Unincorporated Los Angeles County (EPIC-LA), Agoura Hills, Alhambra, Arcadia, Artesia, Avalon, Azusa, Baldwin Park, Bell, Bell Gardens, Bellflower, Beverly Hills, Bradbury, Burbank, Calabasas, Carson, Cerritos, Claremont, Commerce, Compton, Covina, Cudahy, Culver City, Diamond Bar, Downey, Duarte, El Monte, El Segundo, Gardena, Glendale, Glendora, Hawaiian Gardens, Hawthorne, Hermosa Beach, Hidden Hills, Huntington Park, Industry, Inglewood, Irwindale, La Canada Flintridge, La Habra Heights, La Mirada, La Puente, La Verne, Lakewood, Lancaster, Lawndale, Lomita, Long Beach, Lynwood, Malibu, Manhattan Beach, Maywood, Monrovia, Montebello, Monterey Park, Norwalk, Palmdale, Palos Verdes Estates, Paramount, Pasadena, Pico Rivera, Pomona, Rancho Palos Verdes, Redondo Beach, Rolling Hills, Rolling Hills Estates, Rosemead, San Dimas, San Fernando, San Gabriel, San Marino, Santa Clarita, Santa Fe Springs, Santa Monica, Sierra Madre, Signal Hill, South El Monte, South Gate, South Pasadena, Temple City, Torrance, Vernon, Walnut, West Covina, West Hollywood, Westlake Village, Whittier.

The only classified jurisdiction is the City of Los Angeles (LADBS on data.lacity.org),
and its permits are not harvested in increment 1 either.

## 7. Publication blockers

- **Republication rights are unverified.** The LA County eGIS Terms of Use
  (https://egis-lacounty.hub.arcgis.com/pages/terms-of-use) describe the data as "for
  informational purposes", and nothing explicitly grants republication. No artifact
  derived from this source may be published (IPFS or anywhere else) until those rights
  are confirmed. This blocks publication, not local pilot work.

## 8. Implementation choices

- Language: **TypeScript (Node 22) with DuckDB**, per the kit engineering guidelines.
  Python is used only to run the kit's own readiness validator.

## 9. Open decisions for the later full-county run

- **Restate and Postgres are not decided.** They may run only for the duration of a run
  and be torn down or scaled to zero afterwards, or be replaced. Nothing is always-on.
- The run ends in local CARs, CIDs, the user's own artifact manifest and run history,
  with no upload. **IPFS publication is the last step and needs user approval. There is
  no Atlas.**
- How a bulk file enters the runtime: as both seed and capture. The roll pages become
  the seed (parcel list and ETA denominator) and are also stored as per-parcel captures
  keyed by AIN with the exact request URL, so the transform reads stored captures and
  does not re-fetch.
- Other needs: the full roll (2.43M rows, about 2,430 pages at 1000 rows each,
  roughly 81 min at 1 request per 2 s); S3 for raw data in eu-north-1 (AWS mode); a
  transform validated against the lexicon; elephant-cli `validate`/`hash` for local CARs
  only; a permit adapter per jurisdiction; CSLB and CA SOS adapters.

## 10. Scope guard (pipeline repo; the kit checker is unchanged)

- What it is: `src/scope-guard.ts`. It runs before any seed or download, and
  `fetch-slice.ts` and `build-outputs.ts` call it first.
- What it checks: it compares the run config (`config/la-pilot-run.json`) with the
  approved permit exception in `docs/los-angeles-sources.yaml`. It fails with exit 1
  and a list of every mismatch when any of these differ: jurisdiction (Los Angeles), ZIP
  set (91405/91406/91411), roll year (2026), or `permits_harvested` (false).
  - It also fails when no permit exception is present or its scope is incomplete.
  - A full-county run (no jurisdiction or ZIPs), a different ZIP, a different roll year
    or permits turned on all fail.
- How to run it: `node src/scope-guard.ts [run-config.json] [sources.yaml]`.
  Tests: `pnpm test`, which runs one pass case and one failing case (full county,
  different ZIP, different roll year, permits on).
- The guard does **not** modify the kit's `validate-county-readiness.py`. That checker
  still ignores `scope` and `expires`. Expiry stays manual: the exception expires when
  permits are added; the readiness check is then re-run without it. Full-county parcels
  are outside this scope and need their own approved exception; the guard rejects a
  full-county run under this one.

## 11. Pilot run results (run 2026-11-11T16-17-38-928Z)

| Measure                                             | Value                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Source count for the scope (`returnCountOnly`)      | 22,313                                                                            |
| Rows downloaded / staged / in Parquet / in seed CSV | 22,313 / 22,313 / 22,313 / 22,313                                                 |
| Raw pages                                           | 23 (1000 rows each, last page 313), about 49 s at 1 request every 2 s, no retries |
| Distinct AINs                                       | 22,313 (no duplicates; all 10 digits)                                             |
| With coordinates                                    | 22,224 (99.60%)                                                                   |
| With year built                                     | 22,142 (99.23%); 171 source values of `0` set to null                             |
| With effective year built                           | 22,157 (99.30%); 156 values of `0` set to null                                    |
| With last recording date                            | 22,270; 9,764 flagged `owner_unchanged_10y_proxy` (reference date 2026-11-11)     |
| Use types                                           | SFR 15,006; CND 3,513; R-I 1,942; C/I 1,656; OTH 111; VAC 85                      |

DuckDB proof (`node src/query-radius.ts`):

- Point: 34.1990, -118.4870 (Van Nuys, 91406). The nearest parcel is 0.02 mi away.
- Radius 5 miles, age threshold 15 years (a parameter) on roll year 2026, so the rule is
  year built < 2026 - 15, i.e. `year_built <= 2010`.
- Result: **21,388 parcels**, built 1885-2010, farthest 4.14 mi. Each row carries
  `source_request_url`, `source_retrieved_at` and `source_page_sha256`.
- Since increment 2 the CLI queries the shared view contract (`packages/views`): the
  `oracle.roof_age_candidates` macro and the `oracle.v_*` views, never raw Parquet
  columns. The as-of year is the roll year in the data (it was the current year before;
  both are 2026 for this run), and the counts are unchanged (21,388; 5,110 at 1 mile;
  20,548 at 30 years).
- With `--age 30` the result is 20,548 (built 1995 or earlier).
- Full output: `data/out/<run_id>/radius-query-result.json` (gitignored).

Radius comparison (2026-11-11). Same point (34.1990, -118.4870), threshold 15 years
(built 2010 or earlier), `--radius` parameter in miles (default 5):

| Radius  | Matches | Farthest match | Year built range |
| ------- | ------- | -------------- | ---------------- |
| 1 mile  | 5,110   | 1.00 mi        | 1895-2010        |
| 5 miles | 21,388  | 4.14 mi        | 1885-2010        |

At 5 miles the radius extends beyond the 3-ZIP slice, so the count covers the slice only.

Small data notes:

- `city_name` is the situs city exactly as the source gives it: mostly `LOS ANGELES`,
  but also neighbourhood names (VAN NUYS, SHERMAN OAKS, LAKE BALBOA, NORTH HOLLYWOOD)
  and one `VAN NUYS,` artifact.
- Jurisdiction is decided by `tax_rate_area_city`, which is `LOS ANGELES` for every row.

## 12. Publishable table and lexicon names

File: `data/out/<run_id>/los-angeles_property_roll2026_slice.parquet`, one row per AIN.
Names come from the bundled kit catalog (`use-neutral-lexicon` model-c), not from the
live Elephant lexicon or MCP, which were not available.

| Class (lexicon) | Columns                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| property        | `parcel_identifier` (AIN), `property_structure_built_year`, `property_effective_built_year`                                                                                                                         |
| address         | `unnormalized_address`, `street_number`, `street_pre_directional_text`, `street_name`, `unit_identifier`, `city_name`, `postal_code`, `plus_four_postal_code`, `county_name`, `state_code`, `latitude`, `longitude` |

**Not verified as lexicon fields:**

- `request_identifier` and `source_http_request`. They are used by the Oracle runtime
  but are absent from the bundled catalog. `source_http_request` is stored as a plain
  GET URL string, not as the Elephant request object.

**Not lexicon fields** (named here, documented):

- `assessor_id_formatted`
- `roof_age_basis` (labels year built as a PROXY)
- `source_use_type`, `source_use_code`, `source_use_code_description`
- `coordinate_basis`, `tax_rate_area_city`, `roll_year`
- `last_recording_date`, `owner_unchanged_10y_proxy`, `out_of_area_owner` (always null)
- `source_http_method`, `source_retrieved_at`, `source_page_sha256`, `source_page_file`,
  `source_name`

**Deliberately not used:**

- `sales_history.ownership_transfer_date`, because the recording date is not proven to
  be a transfer.
- The `property_type` and `property_usage_type` enums, because no mapping from the LA
  use codes has been made yet.

**Personal data:** the build fails if any owner, mail, contact, phone or email column
appears. The source has none, so there are no person entities and no private owner file.

## 13. Files and rebuild steps (data is gitignored and never committed)

Code and config (committable):

- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (pnpm settings), `tsconfig.json`
- `config/la-pilot-run.json`
- `src/run-config.ts`, `src/scope-guard.ts`, `src/fetch-slice.ts`, `src/stage-raw.ts`,
  `src/build-outputs.ts`, `src/query-radius.ts`
- `test/scope-guard.test.ts`

Run metadata (no rows, no addresses):

- `runs/<run_id>/run_manifest.json`: file names, sizes, sha256, row counts, sources, roll
  year 2026, limitations including the 88 jurisdictions and the publication blocker.
- `runs/run_history.jsonl`: appended once per run, with the delta against the previous run.

Data (gitignored under `data/`):

- `data/raw/los-angeles/roll-2026/<run_id>/`: raw pages `page-NNNN.json`,
  `receipts.jsonl`, `fetch-summary.json`
- `data/work/<run_id>/rows.ndjson`: staging file
- `data/out/<run_id>/`: the Parquet, a seed copy and the query result
- `data/seeds/los-angeles.csv`: the runtime seed

Rebuild (Node >= 22.18, which runs TypeScript directly; pnpm 12.16.1 from the
`packageManager` field, enabled with `corepack enable pnpm`):

```
pnpm install --frozen-lockfile
pnpm test
node src/scope-guard.ts
node src/fetch-slice.ts                       # guard, count, paged download, receipts
node src/build-outputs.ts data/raw/los-angeles/roll-2026/<run_id>
node src/query-radius.ts --parquet data/out/<run_id>/los-angeles_property_roll2026_slice.parquet [--lat=34.1990 --lon=-118.4870 --radius 5 --age 15]
```

Seed recording in the manifest:

- **Later manifests:** they list the per-run seed `data/out/<run_id>/los-angeles-seed.csv`
  as the run's artifact, with its sha256. The shared runtime path
  `data/seeds/los-angeles.csv` is recorded separately with `copy_of` (the per-run path),
  the same digest, and a note that the next run overwrites it. The build fails if the
  two digests differ (`src/manifest-files.ts`, tested in `test/manifest-files.test.ts`).
- **Run 2026-11-11T16-17-38-928Z:** its manifest predates this layout and lists only the
  shared path `data/seeds/los-angeles.csv`, with sha256
  `3f22ec65deba994ca34c0f5350da8b2692e2314049e19fab9761342f703ba895`. Hashing the per-run
  copy `data/out/2026-11-11T16-17-38-928Z/los-angeles-seed.csv` on 2026-11-11 gives the
  same digest, so the recorded digest matches. That manifest is left unchanged.

A later run writes a new run directory and appends to the history. Previous outputs are
never overwritten, except `data/seeds/los-angeles.csv`, which always holds the latest
seed.

Package manager: pnpm 12.16.1 (kit: pnpm workspaces), with one lockfile
(`pnpm-lock.yaml`), exact versions, a 14-day minimum release age and no allowed
install scripts (`pnpm-workspace.yaml`). The manifest of run 2026-11-11T16-17-38-928Z is a tool record left as written; it lists `npm ci --ignore-scripts` as its install step. Install with `pnpm install --frozen-lockfile`.

Tests run on Vitest (kit testing guideline), with `vitest.config.ts` at the repo root. The only runtime dependencies are
`@duckdb/node-api` and `yaml`.
