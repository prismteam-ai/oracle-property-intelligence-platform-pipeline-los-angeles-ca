# Los Angeles County, CA: findings (increment 1 pilot, increment 4 county run, increment 5 permits run and its rebuild)

Status:

- The increment-1 pilot ran on 2026-11-11 (run `2026-11-11T16-17-38-928Z`): 22,313 rows
  were downloaded and built. It stays documented here as history.
- The increment-4 county run `2026-11-12T01-44-04-047Z` built all **2,428,433 parcels**
  of roll 2026 from the verified roll cache (section 11b). The hosted data API serves it
  from its private bucket (section 11c).
- The increment-5 run `2026-11-12T14-00-51-383Z` adds City of Los Angeles building
  permits (296,909) and their contractor rows (113,642) from local caches of the LADBS
  open data, joined to the same 2,428,433 parcels, with an effective roof year per parcel
  (sections 11d and 14). The data API serves this run.
- The rebuild run `2026-11-12T14-00-51-383Z-bc7f18f2e9cf2` (2026-11-14) is a rebuild with
  no source changes of the permits run: the same caches, built again with two new
  property columns (the land base year and a second 10-year ownership proxy, section 15)
  and the contractor identity columns (section 14l). Every earlier column keeps its
  values (section 11e). The data API still serves the permits run until it is redeployed
  on this one.
- The preflight passes with the increment-5 permit exception and the proven destination,
  and the scope guard passes. Nothing has been published publicly.

Snapshot: 2026-11-11T15:52Z. Machine-readable catalog: `docs/los-angeles-sources.yaml`.

## Scope of increment 1

- A local parcel slice only, with nothing leaving the VM: no AWS, no IPFS or pinning, no
  Atlas, no push. The Oracle runtime (Restate, Postgres, Batch) is not started.
- Pilot area: City of LA parcels in ZIP 91405, 91406 and 91411, so that LADBS permits
  can join later.
- Roll year: **2026**, the latest roll published on data.lacounty.gov. The slice has
  **22,313 parcels** in roll 2026, compared with 22,303 in roll 2025.

## Scope of increment 4

- County-wide parcels: all 89 jurisdictions, no ZIP filter, roll 2026, parcels only, no
  permits. This is the second permit-gate exception, approved by Mario Ferraro on
  2026-11-12 (section 6a).
- Built locally from a cache of the whole roll (`scripts/fetch-roll.mjs`), then uploaded
  to the data API's existing private bucket and served by the existing API. The pilot
  files in the bucket are kept.
- Not used: the Oracle runtime (Restate, Postgres, Batch), the Query DB, Atlas,
  elephant-cli and IPFS.

## Scope of increment 5

- All of the county's 2,428,433 parcels (roll 2026, no ZIP filter) plus the City of Los
  Angeles building permits whose work description contains ROOF, and the contractor rows
  of those permits, from LADBS on data.lacity.org. This is the third permit-gate
  exception, approved by Mario Ferraro on 2026-11-13 (section 6a); the two earlier ones
  have expired.
- Built locally from three caches (the roll, the permits, the contractors); nothing is
  downloaded again. Permit data exists only for the City of Los Angeles: the other 88
  jurisdictions stay not yet covered (section 6b).
- Not used: the Oracle runtime, the Query DB, Atlas, elephant-cli, IPFS, CSLB, BBB and
  the LADBS inspections dataset (section 14j).

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
- `Roll_LandBaseYear` is the land's base year under Prop 13. Since the rebuild run it
  gives a second ownership proxy, with its own caveat (section 15).
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

| Measure                                             | Value                                               |
| --------------------------------------------------- | --------------------------------------------------- |
| Roll 2026 assessed rows (canonical)                 | 2,428,433                                           |
| GIS parcel polygons (`LACounty_Parcel/MapServer/0`) | 2,433,388                                           |
| Discrepancy                                         | 0.20% (GIS above the roll; below the 2% threshold)  |
| Pilot slice, roll 2026                              | 22,313 (all `TaxRateArea_CITY = 'LOS ANGELES'`)     |
| Pilot slice, roll 2025                              | 22,303                                              |
| County run, roll 2026                               | 2,428,433 (the whole roll; equals the source count) |

## 4. Permits are split by jurisdiction

There are 89 jurisdictions: 88 incorporated cities plus unincorporated, taken from the
distinct `TaxRateArea_CITY` values in roll 2026.

- **City of Los Angeles**: LADBS publishes permits on data.lacity.org (Socrata, `Crawl-delay: 1`).
  Datasets: issued 2020-present `pi9x-tg5x`, 2010-2019 `dyxf-7hc4`, before 2010 `e67z-kt2n`;
  submitted `gwh9-jnip`, `n3xg-rixm`, `b6ii-mhed`; plus electrical, mechanical and
  certificate-of-occupancy datasets. **These cover the City of LA only.** Increment 5
  builds the six building-permit datasets and the contractor view `8guu-8f5m` (section 14).
- **Unincorporated LA County**: EPIC-LA (https://epicla.lacounty.gov/, LA County Public
  Works). It is reachable, but the vendor, history depth and search-by-AIN have not been
  probed.
- **The other 87 cities** each run their own permit system (for example Long Beach,
  Glendale, Santa Clarita, Pasadena). None has been discovered yet.
- No county one-stop covers municipal history (`assumes_unified_countywide_history: false`).

## 5. Later sources (not in increment 1)

- CSLB (Contractors State License Board) license data is the official contractor license
  identity. It is the California equivalent of Florida DBPR.
- California Secretary of State (bizfile Online) is the official business entity
  registry, the California equivalent of Florida Sunbiz.
- BBB is enrichment only.
- **Sunbiz and DBPR do not apply** to California and are skipped.

## 6. Readiness preflight (`validate-county-readiness.py`)

**Now: overall PASS (exit 0); seed_allowed and ingest_allowed are true.**

| Gate             | Status             | Evidence                                                                                    |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| catalog_metadata | PASS               | Los Angeles CA, slug los-angeles, FIPS 06037                                                |
| parcel           | PASS               | tax_roll 2,428,433 vs GIS 2,433,388 (0.20%)                                                 |
| permit           | APPROVED_EXCEPTION | the increment-5 exception of 2026-11-13 (section 6a)                                        |
| destination      | PASS               | proven from two independent sources: the CloudFormation stack output and the S3 bucket tags |
| enrichment       | PASS               | no BBB claim                                                                                |

The destination block in the catalog names the project (the OracleLaDataApi stack) and
the environment (non-production, as declared), and holds no bucket name, ARN or ID: the
run files go to the data API's private bucket, which is resolved from the stack output at
upload time.

The validator's outputs, written by the tool and never edited:

| File (`docs/evidence/`)                 | Date       | Overall | Permit             | Destination    |
| --------------------------------------- | ---------- | ------- | ------------------ | -------------- |
| `la-preflight-blocked.json`             | 2026-11-11 | BLOCKED | BLOCKED            | NOT_APPLICABLE |
| `la-preflight-pass.json`                | 2026-11-11 | PASS    | APPROVED_EXCEPTION | NOT_APPLICABLE |
| `la-preflight-pass-destination.json`    | 2026-11-12 | PASS    | APPROVED_EXCEPTION | PASS           |
| `la-preflight-pass-county.json`         | 2026-11-12 | PASS    | APPROVED_EXCEPTION | PASS           |
| `la-preflight-pass-county-permits.json` | 2026-11-13 | PASS    | APPROVED_EXCEPTION | PASS           |

On 2026-11-11 the permit gate was BLOCKED: 88 of 89 jurisdictions were unclassified
(unincorporated/EPIC-LA plus 87 cities), and the destination was NOT_APPLICABLE because
the pilot wrote local files only (`writes_in_scope: false`). Under the kit's rules the
seed stays blocked until every jurisdiction is classified, or until an approved
permit-gate exception is recorded in `approved_exceptions`. The user chose Option A, a
scoped exception, and approved it on 2026-11-11 (section 6a).

The build runs the validator itself (`src/readiness.ts`). It first checks the validator
file against its sha256 at kit commit 71b8341 and fails on a mismatch. It fails closed
unless the result is PASS with the permit exception and seed and ingest are allowed. The
run manifest records the kit commit, the validator's sha256, each gate's status and the
sha256 of the output (for the county run, the bytes of `la-preflight-pass-county.json`;
for the permits run, the bytes of `la-preflight-pass-county-permits.json`).

### 6a. Permit-gate exceptions: the current one and the expired ones

`approved_exceptions` in `docs/los-angeles-sources.yaml` holds one permit entry, for
increment 5 (approved by Mario Ferraro on 2026-11-13):

```yaml
approved_exceptions:
  - gate: permit
    reason: >-
      Increment 5: all of Los Angeles County's parcels (the 89 jurisdictions: 88
      incorporated cities and the unincorporated areas), no ZIP filter, LA County
      Assessor roll 2026, plus City of Los Angeles building permits and their
      contractor rows from the LADBS open-data caches (data.lacity.org). The 88
      jurisdictions without a classified permit source are not yet covered: they stay
      needs-review and are listed by name in docs/los-angeles-county-findings.md
      (section 6b) and in run_manifest.json limitations. Expires when those
      jurisdictions are classified; the readiness check is then re-run without it.
    scope:
      {
        increment: 5,
        data: parcels-and-permits,
        jurisdiction: all,
        zips: [],
        roll_year: "2026",
        permit_jurisdictions: [Los Angeles],
      }
    permits_harvested: true
    not_yet_covered_count: 88
    expires: "Expires when the 88 jurisdictions are classified; the readiness check is then re-run without it."
    approved_by: "Mario Ferraro, 2026-11-13"
```

The two earlier entries expired on 2026-11-13, when permits were added. They moved,
unchanged, to `expired_exceptions`, each with `expired: "2026-11-13"` and the reason:

- increment 4 (approved 2026-11-12): parcels only, all of Los Angeles County, no ZIP
  filter, roll 2026, no permits;
- increment 1 (approved 2026-11-11): parcels only, City of Los Angeles, ZIP codes 91405,
  91406 and 91411, roll 2026, no permits.

Neither the validator nor the scope guard reads `expired_exceptions`, so
`config/la-pilot-run.json` and `config/la-county-run.json` are now refused by the scope
guard. Their runs stay recorded as they were.

How the validator reads it: `_approved()` in the kit's `validate-county-readiness.py`
matches any `approved_exceptions` item with `gate: permit` and a non-empty `reason`. The
permit gate then reports `APPROVED_EXCEPTION`, and overall becomes PASS (exit 0) because
the other gates are PASS or NOT_APPLICABLE. The validator **ignores** `scope`, `expires`
and the other extra keys. It does not enforce scope or expiry, and it would pass a
preflight of any scope while an entry is present. Scope is enforced by this repo's scope
guard (section 10); expiry stays procedural: an expired entry moves to
`expired_exceptions`. Enforcing it automatically would need a kit validator
change (for example, checking `expires`/`scope` against a run-scope argument). That
change has not been made.

### 6b. Jurisdictions not yet covered (88, no classified permit source)

Unincorporated Los Angeles County (EPIC-LA), Agoura Hills, Alhambra, Arcadia, Artesia, Avalon, Azusa, Baldwin Park, Bell, Bell Gardens, Bellflower, Beverly Hills, Bradbury, Burbank, Calabasas, Carson, Cerritos, Claremont, Commerce, Compton, Covina, Cudahy, Culver City, Diamond Bar, Downey, Duarte, El Monte, El Segundo, Gardena, Glendale, Glendora, Hawaiian Gardens, Hawthorne, Hermosa Beach, Hidden Hills, Huntington Park, Industry, Inglewood, Irwindale, La Canada Flintridge, La Habra Heights, La Mirada, La Puente, La Verne, Lakewood, Lancaster, Lawndale, Lomita, Long Beach, Lynwood, Malibu, Manhattan Beach, Maywood, Monrovia, Montebello, Monterey Park, Norwalk, Palmdale, Palos Verdes Estates, Paramount, Pasadena, Pico Rivera, Pomona, Rancho Palos Verdes, Redondo Beach, Rolling Hills, Rolling Hills Estates, Rosemead, San Dimas, San Fernando, San Gabriel, San Marino, Santa Clarita, Santa Fe Springs, Santa Monica, Sierra Madre, Signal Hill, South El Monte, South Gate, South Pasadena, Temple City, Torrance, Vernon, Walnut, West Covina, West Hollywood, Westlake Village, Whittier.

The only classified jurisdiction is the City of Los Angeles (LADBS on data.lacity.org).
Its permits are built from increment 5 on (section 14); these 88 have none.

## 7. Publication blockers

- **Republication rights are unverified.** The LA County eGIS Terms of Use
  (https://egis-lacounty.hub.arcgis.com/pages/terms-of-use) describe the data as "for
  informational purposes", and nothing explicitly grants republication. No
  record-bearing artifact derived from this source may be published (IPFS or anywhere
  else) until those rights are confirmed. Files without records (the run manifest,
  coverage counts, the schema and the artifact manifest) may be published after approval.
  This blocks publication, not local pilot work.
- From the rebuild run on, the run manifest states the limitation as: "Publication: the
  data files of this run are not published. Republication rights for the County roll (LA
  County eGIS terms of use) and the City permit sets (no license stated) are not
  confirmed." The contractor view is not named because it states a license (CC BY 4.0,
  section 14a). The publish guard still blocks every data file; the three earlier run
  manifests keep their wording.

## 8. Implementation choices

- Language: **TypeScript (Node 22) with DuckDB**, per the kit engineering guidelines.
  Python is used only to run the kit's own readiness validator.

## 9. Open decisions for the later full-county run

The increment-4 county parcel run did not need these: it was built locally from the roll
cache and served by the existing data API (sections 11b and 11c). They stay open for the
Oracle runtime path.

- **Restate and Postgres are not decided.** They may run only for the duration of a run
  and be torn down or scaled to zero afterwards, or be replaced. Nothing is always-on.
- The run ends in local CARs, CIDs, the user's own artifact manifest and run history,
  with no upload. **IPFS publication is the last step and needs user approval. There is
  no Atlas.** The artifact manifest and the publishable directory (run manifest,
  coverage, schema, artifact manifest) are built by `src/build-ipfs-artifacts.ts`; only
  these record-free files are ever published, and every data file is listed with
  `published: false`.
- How a bulk file enters the runtime: as both seed and capture. The roll pages become
  the seed (parcel list and ETA denominator) and are also stored as per-parcel captures
  keyed by AIN with the exact request URL, so the transform reads stored captures and
  does not re-fetch.
- Other needs: the full roll (2.43M rows, about 2,430 pages at 1000 rows each,
  roughly 81 min at 1 request per 2 s); S3 for raw data in eu-north-1 (AWS mode); a
  transform validated against the lexicon; local CIDs and CARs of a run's files computed
  with ipfs-car 3.1.0 (UnixFS CIDv1, raw leaves, fixed 1 MiB chunks, balanced width 1024:
  IPIP-0499 unixfs-v1-2025 for files), not elephant-cli; elephant-cli only for the later
  Lexicon slice (validation, hash-to-CAR and CAR validation, local, no upload); a permit
  adapter per jurisdiction; CSLB and CA SOS adapters.

## 10. Scope guard (pipeline repo; the kit checker is unchanged)

- What it is: `src/scope-guard.ts`. It runs before any seed or download, and
  `fetch-slice.ts` and `build-outputs.ts` call it first.
- What it checks: it compares the run config with every entry in `approved_exceptions`
  in `docs/los-angeles-sources.yaml`, and passes only when the run is inside one of
  them: jurisdiction, ZIP set, roll year, `permits_harvested` and the set of permit
  jurisdictions all match. Otherwise it fails with exit 1 and each exception's
  mismatches. An exception must name its permit jurisdictions exactly when it harvests
  permits.
  - `config/la-county-permits-run.json` (jurisdiction `all`, no ZIPs, roll 2026,
    permits for Los Angeles) passes under the increment-5 entry.
  - `config/la-pilot-run.json` and `config/la-county-run.json` (no permits) are refused:
    their entries have expired (section 6a).
  - It also fails when no permit exception is present or a scope is incomplete.
- How to run it: `node src/scope-guard.ts [run-config.json] [sources.yaml]` (default:
  the permits config). Tests (`test/scope-guard.test.ts`): the permits config passes;
  the two earlier configs are refused; other permit jurisdictions, none, permits off, a
  ZIP filter, one city's parcels or another roll year all fail; expired entries are
  never read.
- The guard does **not** modify the kit's `validate-county-readiness.py`, which still
  ignores `scope` and `expires`.

## 11. Run results

### 11a. Pilot run (run 2026-11-11T16-17-38-928Z, history)

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
The 5-mile circle does not cover the whole slice either: 6 parcels lie 5.4-7.2 mi from
the reference point (34.1990, -118.4870). They are the 6 out-of-ZIP parcels listed
below.

Small data notes:

- Data-quality limitation, **pilot slice only** (the slice was defined by ZIP; the
  county run has no ZIP filter): the roll's ZIP disagrees with the coordinates for 6 of
  22,313 parcels, and the pilot slice is defined by that ZIP. AINs: 2317016013,
  2319005018, 2336001020, 2533019032, 2466029020, 2822012019. They stay in the slice;
  no outside check was made.

- `city_name` is the situs city exactly as the source gives it: mostly `LOS ANGELES`,
  but also neighborhood names (VAN NUYS, SHERMAN OAKS, LAKE BALBOA, NORTH HOLLYWOOD)
  and one `VAN NUYS,` artifact.
- Jurisdiction is decided by `tax_rate_area_city`, which is `LOS ANGELES` for every row.

### 11b. County run (run 2026-11-12T01-44-04-047Z)

Input: the roll cache written by `scripts/fetch-roll.mjs`, filter `RollYear = '2026'`,
2,429 pages fetched between 2026-11-12T00:19:24Z and 01:43:36Z, 0 errors logged, 0
duplicate AINs (the cache's `summary.json`). The build verifies every page against the
cache manifest before staging it (`src/stage-cache.ts`): HTTP 200, body sha256 and size,
the request URL and where clause, the row count, and OBJECTIDs without a gap from 1 to
2,428,433. It stages only the fields it reads (`src/raw-fields.ts`); the raw pages stay in
the cache. The run ID is the cache summary's `generated_at`.

| Measure                                             | Value                                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Source count at download                            | 2,428,433                                                                                                                        |
| Rows downloaded / staged / in Parquet / in seed CSV | 2,428,433 / 2,428,433 / 2,428,433 / 2,428,433                                                                                    |
| Cache pages                                         | 2,429 (1000 rows each, last page 433)                                                                                            |
| With coordinates                                    | 2,417,838 (99.56%); 10,595 without, never in radius results                                                                      |
| With year built (both rules, see below)             | 2,205,603 (90.82%)                                                                                                               |
| With effective year built                           | 2,206,589 (90.86%)                                                                                                               |
| With last recording date                            | 2,412,409; 1,120,743 flagged `owner_unchanged_10y_proxy` (reference date 2026-11-12)                                             |
| Use types                                           | SFR 1,510,517; CND 323,258; R-I 248,809; VAC 171,402; C/I 135,125; OTH 39,322                                                    |
| Delta against the pilot run                         | 2,406,120 added, 0 removed                                                                                                       |
| Parquet                                             | `los-angeles_property_roll2026.parquet`, 69,021,603 B, sha256 `44dab72ee031e2b33e42f541f5a8ee285506d7f672fc8b514fbae404c475ff34` |
| Build (local VM, 4 vCPU)                            | 1 min 54 s wall, peak RSS 2.19 GB; DuckDB file-backed under `data/work/<run_id>/`                                                |

**Year built: two rules, same result.**

- The download's summary (`scripts/fetch-roll.mjs`) counts any `YearBuilt` above 0:
  2,205,603 of 2,428,433 (90.82%).
- The build keeps a year built only between 1800 and 2100 (`src/property-sql.ts`); other
  values become null: also 2,205,603 (90.82%). No staged value is above 0 and outside
  1800-2100. The years run from 1801 to 2026.
- Parcels without a year built never appear in roof-age results. By use type:

| Use type | Parcels   | Without year built | Share  |
| -------- | --------- | ------------------ | ------ |
| VAC      | 171,402   | 170,007            | 99.19% |
| OTH      | 39,322    | 28,285             | 71.93% |
| C/I      | 135,125   | 8,691              | 6.43%  |
| R-I      | 248,809   | 3,664              | 1.47%  |
| CND      | 323,258   | 2,299              | 0.71%  |
| SFR      | 1,510,517 | 9,884              | 0.65%  |

**Radius counts** from (34.1990, -118.4870), older than 15 years (built 2010 or earlier),
with the shared `oracle.roof_age_candidates` macro:

| Radius   | Parcels |
| -------- | ------- |
| 1 mile   | 5,114   |
| 5 miles  | 143,389 |
| 10 miles | 373,785 |

At 1 mile the pilot found 5,110; the county run adds the parcels outside the pilot's
three ZIP codes. 10 miles is the API's maximum radius.

**The 25,000-point cap.** The API's points query returns at most 25,000 points, nearest
first (distance, then parcel ID), and marks the response as truncated when more qualify.
From the reference point at 15 years the 25,000th nearest parcel is 2.31 mi away
(2.309), so a radius beyond that returns the 25,000 nearest and is marked truncated. The
count (373,785 at 10 mi) is always complete.

### 11c. Hosted data API on the county run

The run's Parquet, run manifest and run history were uploaded to the data API's private
bucket under `runs/2026-11-12T01-44-04-047Z/`, each with a no-overwrite condition, and
read back with the same sha256. The pilot files there are unchanged. The API was then
redeployed on this run.

- Cold start on Lambda (1,024 MB): init 0.6 s, then the data load 6.4 s for the 69 MB
  Parquet (download, sha256 check, views). The first request took about 8.8 s at the
  client. Peak memory 298 MB of 1,024 MB. Warm requests took 3-6 ms in the function.
- Live counts equal the local ones: 5,114 / 143,389 / 373,785 at 1 / 5 / 10 mi and 15
  years. The 10-mile points response held 25,000 IDs, marked truncated, with the same
  last parcel as the local query.

### 11d. Permits run (run 2026-11-12T14-00-51-383Z)

Inputs, all local caches, read only: the roll cache of the county run (`generated_at`
2026-11-12T01:44:04.047Z), the LADBS permit cache (2026-11-12T13:14:56.570Z) and the LADBS
contractor cache (2026-11-12T14:00:51.383Z). The run ID is the latest of the three times;
the reference date for every derived duration is the permit cache's date, 2026-11-12
(section 14k).

| Measure                     | Value                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Parcels                     | 2,428,433 (delta against the county run: 0 added, 0 removed)                                                                           |
| Permits staged / in Parquet | 296,909 / 296,909 (issued sets 287,817, submitted sets 9,092)                                                                          |
| Permit-parcel links         | 607,702                                                                                                                                |
| Contractor rows             | 113,661 in the cache, 19 exact duplicates staged once, 113,642 in Parquet                                                              |
| Readiness                   | PASS, permit gate APPROVED_EXCEPTION; output sha256 = `la-preflight-pass-county-permits.json`                                          |
| Property Parquet            | `los-angeles_property_roll2026.parquet`, 71,816,364 B, sha256 `3f949fb2d1d910033fff6aa2cc2875e87778f4a165c9ddb5390884edd278bad8`       |
| Permits Parquet             | `los-angeles_ladbs_permits.parquet`, 6,314,075 B, sha256 `b70c417a9123a352f8914e1a259cc2f2ad878da7eb0ce932eefd89c569c1db12`            |
| Permit-parcel Parquet       | `los-angeles_ladbs_permit_parcels.parquet`, 2,643,361 B, sha256 `8b024a4c8f9fe533803cc65d12be066c6969c30d35f7649cebdada7bf741c208`     |
| Contractor Parquet          | `los-angeles_ladbs_permit_contractors.parquet`, 1,366,649 B, sha256 `13d3d22a111d46b002274c8561b7211f433df5aec0d8a43c332d80146c3b178b` |
| Seed CSV                    | 2,428,433 rows, sha256 `b4c4be3d4c59c7cfd1501c2884edf62e89d49503f7fde176174ea39bd2520063` (byte-identical to the county run's seed)    |
| Build (local VM, 4 vCPU)    | 2 min 8 s wall, peak RSS 2.44 GB                                                                                                       |
| Determinism                 | three dry runs and the recorded build gave byte-identical Parquet files and seed                                                       |

**Radius counts** from (34.1990, -118.4870), older than 15 years, on the year built
(the rule of the county run) and on the effective roof year (section 14g):

| Radius   | Year built (county run) | Effective roof year | Dropped by a permit | Added by a permit |
| -------- | ----------------------- | ------------------- | ------------------- | ----------------- |
| 1 mile   | 5,114                   | 4,183               | 934                 | 3                 |
| 5 miles  | 143,389                 | 113,632             | 29,791              | 34                |
| 10 miles | 373,785                 | 309,117             | 64,802              | 134               |

"Added by a permit" are parcels without a year built that get a permit year before 2011.
The data API applies the effective roof year since it was redeployed on this run
(2026-11-13).

### 11e. Rebuild run (run 2026-11-12T14-00-51-383Z-bc7f18f2e9cf2)

A rebuild with no source changes of the permits run `2026-11-12T14-00-51-383Z`: the same
three caches, read only, and nothing downloaded. It adds `land_base_year` and
`ownership_base_year_10y_proxy` to the property table (section 15) and five contractor
identity columns to the contractor table (section 14l). Every earlier column of the four
tables keeps its type and values, and the row counts are the same. The run ID follows
the rule of section 14k.

| Measure                       | Value                                                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run kind                      | `run_kind` "rebuild", `rebuild_of` `2026-11-12T14-00-51-383Z`, `source_changes` "none"                                                                                                                                                                          |
| Build digest                  | `c7f18f2e9cf2ee2e6f8ef37eeb16290536f747b4c81889c370695f45a607832e`; the ID ends in `-b` and its first 12 hex characters                                                                                                                                         |
| Parcels                       | 2,428,433 (delta against the permits run: 0 added, 0 removed)                                                                                                                                                                                                   |
| Permits / links / contractors | 296,909 / 607,702 / 113,642, as in the permits run                                                                                                                                                                                                              |
| Schema changes                | property: `land_base_year`, `ownership_base_year_10y_proxy` added; permit_contractor: `contractor_identity_key`, `canonical_business_name`, `name_variant_count`, `identity_permit_count`, `contractor_identity_rule_version` added; nothing removed or retyped |
| Readiness                     | as the permits run: PASS, permit gate APPROVED_EXCEPTION; output sha256 = `la-preflight-pass-county-permits.json`                                                                                                                                               |
| Property Parquet              | `los-angeles_property_roll2026.parquet`, 73,876,727 B, sha256 `c9b8be08322b5c9dee0becde69ad764561e06298a8d8da9002cad015b1d983bf`                                                                                                                                |
| Permits Parquet               | unchanged: the permits run's bytes, sha256 `b70c417a9123a352f8914e1a259cc2f2ad878da7eb0ce932eefd89c569c1db12`                                                                                                                                                   |
| Permit-parcel Parquet         | unchanged: the permits run's bytes, sha256 `8b024a4c8f9fe533803cc65d12be066c6969c30d35f7649cebdada7bf741c208`                                                                                                                                                   |
| Contractor Parquet            | `los-angeles_ladbs_permit_contractors.parquet`, 1,981,418 B, sha256 `5506eba702ddb05efea35e25e13bdc99ff0322c3acd4dddea2fdd28d2fc54f5c`                                                                                                                          |
| Seed CSV                      | byte-identical to the permits run's, sha256 `b4c4be3d4c59c7cfd1501c2884edf62e89d49503f7fde176174ea39bd2520063`                                                                                                                                                  |
| Build (local VM, 4 vCPU)      | 1 min 59 s wall, peak RSS 2.46 GB                                                                                                                                                                                                                               |
| Determinism                   | three dry runs and the recorded build gave the same run ID and byte-identical Parquet files and seed                                                                                                                                                            |

- **How the build decides the run kind:** "rebuild" only when every input digest that the
  run manifests record equals the previous run's (the roll cache's summary, page manifest,
  download script copy and 2,429 page bodies; each LADBS cache's files and pages);
  otherwise "new data", with `rebuild_of` and `source_changes` null. It never comes from a
  flag that could disagree with the inputs.
- **History:** the run's history line adds `run_kind`, `rebuild_of`, `source_changes`,
  `build_digest` and `schema_changes` to the fields of the earlier lines. The three earlier
  lines have none of them, so they carry no run-kind label, and none is guessed for them.
  Those lines and every earlier `runs/` file are byte-identical before and after the
  build.
- **Served counts unchanged:** the radius counts of section 11d (effective roof year
  4,183 / 113,632 / 309,117 and year built 5,114 / 143,389 / 373,785 at 1 / 5 / 10 mi)
  and the 10,974 long-open roofing permits city-wide are the same on this run.
- **Upload:** the run's six objects (the four Parquet files, the run manifest and the run
  history) went to the data API's private bucket under
  `runs/2026-11-12T14-00-51-383Z-bc7f18f2e9cf2/`, each with a no-overwrite condition, and
  were read back with the same sha256. The earlier runs' objects are unchanged.

## 12. Publishable tables and lexicon names

File: `data/out/<run_id>/los-angeles_property_roll2026.parquet` for the county and
permits runs (`los-angeles_property_roll2026_slice.parquet` for the pilot), one row per
AIN. The permits run adds three permit tables (below).
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

**Permit tables (permits run).** Lexicon names from the same catalog where one fits:

| Table (file)                                                       | Lexicon names                                                                                                                                                                   | Not lexicon fields                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| permit (`los-angeles_ladbs_permits.parquet`)                       | `permit_number`, `application_received_date`, `permit_issue_date` (property_improvement); `unnormalized_address`, `postal_code` (address)                                       | `source_apn`, `source_permit_type`, `source_permit_sub_type`, `source_business_unit`, `source_status_desc` (raw LADBS values, not lexicon enum values); `status_date`, `permit_status_class`, `open_since`, `open_days`, `roof_r`, `roof_only`, `roofing_work`, `roof_coating_only`, `join_method`, `unjoined_cause`, `source_dataset`, `source_dataset_kind`, the rule versions and the `source_*` provenance columns                                                        |
| permit_parcel (`los-angeles_ladbs_permit_parcels.parquet`)         | `permit_number`, `parcel_identifier`                                                                                                                                            | `join_method`, `building_level`, `join_rule_version`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| permit_contractor (`los-angeles_ladbs_permit_contractors.parquet`) | `permit_number`, `permit_issue_date`, `license_identifier`, `license_expiration_date` (license); `city_name`, `state_code` (address); `is_owner_builder` (property_improvement) | `contractors_business_name` (the source name; the lexicon's company `name` would be ambiguous in a wide table), `source_license_type`, `license_class`, `license_class_name`, `license_class_note`, `license_class_rule_version`, the provenance columns and, since the rebuild run, the contractor identity columns `contractor_identity_key`, `canonical_business_name`, `name_variant_count`, `identity_permit_count` and `contractor_identity_rule_version` (section 14l) |

The property table adds `permit_data_available`, `effective_roof_year`,
`roof_year_permit_number` and `roof_year_rule_version`, and since the rebuild run
`land_base_year` and `ownership_base_year_10y_proxy` (section 15), none of them lexicon
fields.
`roof_age_basis` stays the one basis column: the year-built PROXY label, or a PERMIT label
where a permit sets the roof year (section 14g). The lexicon's permit entity is
`property_improvement`; its `improvement_status` and `improvement_type` enums are not
mapped from the LADBS values, which are kept raw.

**Columns are addressed by name, not by position.** In the rebuild run the two new
property columns sit right after `owner_unchanged_10y_proxy`, so every later property
column moved two places, with its values unchanged. The five contractor identity columns
follow the earlier contractor columns, whose positions are unchanged.

**Deliberately not used:**

- `sales_history.ownership_transfer_date`, because neither the recording date nor the
  land base year is proven to be a transfer.
- The `property_type` and `property_usage_type` enums, because no mapping from the LA
  use codes has been made yet.

**Personal data:** the build fails if any owner, mail, contact, phone or email column
appears in any published table, or if the permit work description does. The roll has no
owner fields, so there are no person entities and no private owner file. Contractor
business names and license numbers are published as LADBS publishes them (section 14h).

## 13. Files and rebuild steps (data is gitignored and never committed)

Code and config (committed):

- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (pnpm settings), `tsconfig.json`
- `config/la-pilot-run.json`, `config/la-county-run.json` (both now refused by the scope
  guard), `config/la-county-permits-run.json`
- `scripts/fetch-roll.mjs`: downloads the whole roll into a cache (gzipped raw pages,
  `manifest.jsonl`, `summary.json`)
- `scripts/ladbs-permits/fetch.mjs`, `scripts/ladbs-contractors/fetch.mjs` and
  `scripts/README.md`: download the LADBS permit and contractor caches (section 14c)
- `src/run-config.ts`, `src/scope-guard.ts`, `src/readiness.ts`, `src/fetch-slice.ts`,
  `src/raw-fields.ts`, `src/stage-raw.ts`, `src/stage-cache.ts`, `src/property-sql.ts`,
  `src/build-outputs.ts`, `src/run-history.ts`, `src/manifest-files.ts`,
  `src/query-radius.ts`
- Permits: `src/permit-fields.ts`, `src/socrata-cache.ts`, `src/stage-permits.ts`,
  `src/stage-contractors.ts`, `src/roof-flags.ts`, `src/address-normalize.ts`,
  `src/permit-join.ts`, `src/license-classes.ts`, `src/permit-status.ts`,
  `src/permit-sql.ts`, `src/contractor-identity.ts`
- Local IPFS artifacts: `src/ipfs-unixfs.ts`, `src/artifact-manifest.ts`,
  `src/publishable-docs.ts`, `src/publish-guard.ts`, `src/publish-scans.ts`,
  `src/build-ipfs-artifacts.ts`, `src/gateway-verify.ts`. Rebuild (local only; writes
  the ignored `data/ipfs/`): `node src/build-ipfs-artifacts.ts --all [--source <repo>]
[--out data/ipfs]`
- `test/*.test.ts` and the synthetic fixtures under `test/fixtures/`

Run metadata (no rows, no addresses):

- `runs/<run_id>/run_manifest.json`: file names, sizes, sha256, row counts, sources,
  readiness, roll year 2026, limitations including the 88 jurisdictions and the
  publication blocker. For the county run it also records the cache summary and manifest
  sha256, the download script's sha256 (the committed file and, separately, the copy that
  ran), and each page's request URL and body sha256, with paths relative to the cache.
- `runs/run_history.jsonl`: one line per run, with the delta against the previous run.
  A permits run's line also lists the three permit Parquet files with their sha256
  (`permit_files`); earlier lines have none. From the rebuild run on, a line also holds
  `run_kind`, `rebuild_of`, `source_changes`, `build_digest` and `schema_changes`
  (section 11e).
  Building a recorded run again from the same caches and code gives its ID again and adds
  no line; the same run ID with different files fails. Lines are appended in
  `finished_at` order (section 14k).

Data (gitignored under `data/`):

- `data/raw/los-angeles/roll-2026/<run_id>/` (pilot only): raw pages `page-NNNN.json`,
  `receipts.jsonl`, `fetch-summary.json`
- `data/work/<run_id>/`: the staging file `rows.ndjson` and the DuckDB file
- `data/out/<run_id>/`: the Parquet, a seed copy and the query result
- `data/seeds/los-angeles.csv`: the runtime seed

The roll cache sits outside the repository, in any directory passed to the scripts.

Rebuild the county run (Node >= 22.18, which runs TypeScript directly; pnpm 12.16.1
from the `packageManager` field, enabled with `corepack enable pnpm`). `KIT_DIR` is a
checkout of the soofi-xyz team kit at 71b8341: the build runs its readiness validator and
fails if the validator file's sha256 differs from that commit's.

```
pnpm install --frozen-lockfile
pnpm test
node src/scope-guard.ts config/la-county-run.json
node scripts/fetch-roll.mjs <roll-cache-dir>   # network: the whole roll, 2,429 pages at 1 request every 2 s or slower
KIT_DIR=<kit checkout at 71b8341> node src/build-outputs.ts <roll-cache-dir> config/la-county-run.json
node src/query-radius.ts --parquet data/out/<run_id>/los-angeles_property_roll2026.parquet [--lat=34.1990 --lon=-118.4870 --radius 5 --age 15]
```

Upload: the Parquet, the run manifest and the run history go to the data API's private
bucket under `runs/<run_id>/`. The bucket is read from the OracleLaDataApi stack output
at upload time; no bucket name is kept in the repository.

Rebuild the permits run or its rebuild (the three caches sit outside the repository; the
LADBS caches were written by earlier versions of `scripts/ladbs-permits/fetch.mjs` and
`scripts/ladbs-contractors/fetch.mjs`, whose differences `scripts/README.md` lists, and
the run manifest records their sha256):

```
node src/scope-guard.ts config/la-county-permits-run.json
KIT_DIR=<kit checkout at 71b8341> node src/build-outputs.ts <roll-cache-dir> config/la-county-permits-run.json \
  --permit-cache <ladbs-permits-cache-dir> --contractor-cache <ladbs-contractors-cache-dir> [--dry-run]
```

`--dry-run` builds everything under `data/work/<run_id>/dry-run/` and writes nothing under
`runs/`, `data/out/` or `data/seeds/`.

Rebuild the pilot (history):

```
node src/scope-guard.ts
node src/fetch-slice.ts                       # guard, count, paged download, receipts
KIT_DIR=<kit checkout at 71b8341> node src/build-outputs.ts data/raw/los-angeles/roll-2026/<run_id>
node src/query-radius.ts --parquet data/out/<run_id>/los-angeles_property_roll2026_slice.parquet [--lat=34.1990 --lon=-118.4870 --radius 5 --age 15]
```

`src/fetch-slice.ts` now requests only the fields the build reads (`src/raw-fields.ts`,
plus OBJECTID); the pilot's recorded pages were downloaded with every field.

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
seed (since the county run, the county seed).

Package manager: pnpm 12.16.1 (kit: pnpm workspaces), with one lockfile
(`pnpm-lock.yaml`), exact versions, a 14-day minimum release age and no allowed
install scripts (`pnpm-workspace.yaml`; `allowBuilds` denies the scripts of `fsevents`,
`esbuild` and `protobufjs`, whose postinstall only prints a warning). The manifest of run 2026-11-11T16-17-38-928Z is a tool record left as written; it lists `npm ci --ignore-scripts` as its install step. Install with `pnpm install --frozen-lockfile`.

Tests run on Vitest (kit testing guideline), with `vitest.config.ts` at the repo root. The runtime dependencies are
`@duckdb/node-api`, `yaml` and `ipfs-car` (local CIDs and CARs).

## 14. City of Los Angeles permits and contractors (increment 5)

### 14a. Sources, terms and attribution

| Source                                                                                                         | Rows (cache)              | Terms                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LADBS building permits, issued: `pi9x-tg5x` (2020-present), `dyxf-7hc4` (2010-2019), `e67z-kt2n` (before 2010) | 94,073 / 86,704 / 107,040 | The dataset metadata states no license; the data.lacity.org terms of use of May 2014 (https://data.lacity.org/terms-of-use) apply. The metadata's attribution field reads "TSB". |
| LADBS building permits, submitted: `gwh9-jnip`, `n3xg-rixm`, `b6ii-mhed`                                       | 3,484 / 3,431 / 2,177     | as above                                                                                                                                                                         |
| LADBS "roofing permits" contractor view `8guu-8f5m`                                                            | 113,661                   | Creative Commons Attribution 4.0 International (CC BY 4.0), attribution LADBS                                                                                                    |

- Attribution: **LADBS** (City of Los Angeles Department of Building and Safety), the
  owning department, for all seven sources.
- The permit cache holds the rows whose work description contains ROOF (the submitted
  sets also without an issue date), as SoQL pages; the contractor cache holds the whole
  view, with exactly its eight columns.
- Changes made to the contractor data (CC BY 4.0): 19 exact duplicate rows staged once;
  the license class normalized to the CSLB form with class columns added (section 14h);
  date-times converted to dates; city and state upper-cased; owner-builder and N/A rows given
  no license number. Business names and license numbers are otherwise as published.

### 14b. Staging and verification

`src/stage-permits.ts` and `src/stage-contractors.ts` check every cached page against its
cache manifest before staging a row: the plain page name, the gzip and JSON sha256 and
sizes, the row count, the request URL (the dataset's resource with the recorded query),
the query's filter and selected columns, contiguous paging, and the totals against the
manifest's expected and fetched counts and the cache summary. Every permit number appears
once. The staged rows keep only the listed fields (`src/permit-fields.ts`) plus their
provenance; coordinates, PIN, use codes, valuation and the other unused permit fields are
dropped. The derived roofing flag file in the permit cache is never read. The run manifest
records each cache file's sha256 and each page's request URL and digests, never the
cache files' contents.

### 14c. Work descriptions are not served

The permit work description (`work_desc`) is free text that holds people's names. A
counts-only scan of all 296,909 descriptions, printing no text, found:

- 100 rows with an addressing word (ATTN, Mr/Mrs/Ms, OWNER:, NAME:, CALL) followed
  directly by a common given name, 95 of them "ATTN <name>": `gwh9-jnip` 82, `pi9x-tg5x`
  11, `dyxf-7hc4` 3, `e67z-kt2n` 2, `n3xg-rixm` 2;
- 211 rows with an email address or a phone number with an area code (6 email, 205
  phone);
- 404 rows with a common given name anywhere as a whole word (some are street or place
  names).

So the description is read only to set the roofing flags (section 14e) and is in no
published table; a test checks every published table's columns and contents. The staged
copy stays in the ignored `data/work/` folder.

The permit fetch script (`scripts/ladbs-permits/fetch.mjs`) downloads `work_desc` into
the permit cache. It is used only to flag roofing work: the download's ROOF filter, the
script's own first flags and the build's roofing flags. The contractor fetch script
(`scripts/ladbs-contractors/fetch.mjs`) downloads the view's eight columns, which hold no
work description.

### 14d. Permit-to-parcel join (`src/permit-join.ts`, `src/address-normalize.ts`)

- **Direct:** the permit's APN has 10 digits and equals a parcel's AIN.
- **Address**, for direct misses only, on a full match: the house number (leading
  integer), the normalized street name and the 5-digit ZIP all equal; the pre-direction
  and the fraction (e.g. 1/2) must agree where both carry one. When the APN starts with 7
  digits (map book and page), candidates are narrowed to that book and page; this never
  replaces the street match. Street names: upper case, punctuation and unit designators
  removed, a fixed suffix table, text after the street's suffix cut.
- **Accepted:** exactly one parcel (`address`), or the units of one condo building, all
  at one address with a condominium use code (UseCode ending in C or E;
  `condo-building`). A condo permit attaches to every unit, marked `building_level`, and
  is counted once. Condo buildings appear unit by unit; the roof decision belongs to the
  owners' association.
- **No coordinate matching:** the nearest parcel center can be a neighbor's parcel.
  Anything else stays unjoined, with its cause; unjoined permits' parcels keep the
  year-built proxy.

| Stage          | All permits (296,909) | Share  | Joined so far | Roofing work (234,054) | Share  | Joined so far |
| -------------- | --------------------- | ------ | ------------- | ---------------------- | ------ | ------------- |
| direct         | 272,181               | 91.67% | 91.67%        | 220,139                | 94.05% | 94.05%        |
| address        | 7,705                 | 2.60%  | 94.27%        | 4,018                  | 1.72%  | 95.77%        |
| condo-building | 8,941                 | 3.01%  | 97.28%        | 6,559                  | 2.80%  | 98.57%        |
| unjoined       | 8,082                 | 2.72%  |               | 3,338                  | 1.43%  |               |

Condo buildings: 8,941 permits make 327,816 unit links to 67,892 distinct units.

Unjoined by cause (APN case / address case):

| APN case        | no-address-match | address-ambiguous | zip-or-direction-disagrees | book-page-disagrees | no-usable-address | Total |
| --------------- | ---------------- | ----------------- | -------------------------- | ------------------- | ----------------- | ----- |
| apn-not-in-roll | 3,586            | 512               | 513                        | 456                 | 380               | 5,447 |
| apn-masked      | 646              | 510               | 503                        | 320                 | 303               | 2,282 |
| apn-missing     | 59               | 9                 | 10                         | 0                   | 260               | 338   |
| apn-malformed   | 4                | 0                 | 2                          | 3                   | 6                 | 15    |
| Total           | 4,295            | 1,031             | 1,028                      | 779                 | 949               | 8,082 |

Of the no-address-match permits, most have their street in the same ZIP but no parcel
with that house number (renumbered or split lots).

**Permits on parcels outside the City of Los Angeles:** 60 permits join parcels whose
tax-rate-area city is not Los Angeles: direct 55, address 4, condo-building 1. They are
kept and counted (border, annexation or APN-typo cases).

### 14e. Roofing work (`src/roof-flags.ts`, rule version roof-flags-4)

The cache's own flags matched substrings: ROOFING inside SOUNDPROOFING, "RE ROOF" inside
ENTIRE ROOF, and every Express Permit. The build recomputes them:

- **Words:** a word is a run of the letters A-Z; underscore, digits and every other
  character separate words, and a word start is the start of the text or a non-letter.
- **Re-roof word:** a word starting with REROOF or RE-ROOF (REROOFING, REROOFWITH,
  REROOF99SQRS), or the two words RE ROOF(S/ED/ING). Letters before it (BATHREROOF,
  GRE-ROOF) make it no word start.
- **roof_r:** a re-roof word, ROOF COVER(S/ING/INGS), ROOFING, ROOF TILE(S), or COATING
  TO AN EXISTING ROOF; or ENTIRE ROOF(S), or ROOF SYSTEM (letters may follow SYSTEM), when
  the description also holds a word starting with REPLAC, REFRAM, REBUIL, RECONSTRUCT
  (each with or without a hyphen after RE), SHEATH or SHEATING, or the word NEW.
- **roof_only:** the cache's two start patterns ("RE-ROOF WITH CLASS A OR B", "REROOF
  WITH <n> SQRS"), or an Express Permit with a re-roof word or the word ROOF(S/ED/ING);
  ROOFTOP and ROOF TOP are not a roof word.
- **roofing_work** = roof_r or roof_only. SOUNDPROOF, WATERPROOF, FIREPROOF and
  DAMPPROOF (and their -ING forms) are never roofing.

| Group          | This run | Cache flags |
| -------------- | -------- | ----------- |
| roof_r only    | 10,767   | 13,824      |
| roof_only only | 20,740   | 21,489      |
| both           | 202,547  | 206,173     |
| neither        | 62,855   | 55,423      |

Roofing work: 234,054 permits (78.83%). Against the cache's flags, 7,493 permits moved to
"neither" (SOUNDPROOF 5,141; WATERPROOF 982; a cache term (ROOFING, RE ROOF, ROOF COVER, ...) only inside a
longer word 566; Express Permits without a roof word 319; FIREPROOF 306; RESTRUCTURE, RECONFIGURE or
RESTORE ROOF 115; ENTIRE ROOF without a qualifying word 45; Express Permits with only
ROOFTOP 19) and 61 moved to roofing work.

**Limitations:**

- Phrases left "neither" (rows whose text holds the phrase): ENTIRE ROOF 46 (one of them
  only as ENTIRE ROOFTOP or another longer word); ROOF SYSTEM 92, of which 8 hold it
  only as the end of WATERPROOF SYSTEM (3 of these also hold a replacement word, but
  WATERPROOF is not a roof word, so they stay "neither"); RESTRUCTURE ROOF 92; RECONFIGURE ROOF 18;
  RESTORE ROOF 10.
- Note: 38 permits are roofing work through ENTIRE ROOF or ROOF SYSTEM with the word NEW
  alone (no replacement, reframing or rebuilding word).
- Partial roof work described without a re-roof or roofing word (for example "replace
  roof over kitchen", "partial roof replacement", underlayment) is not counted: roughly
  1 in 10 "neither" permits, estimated from a seeded sample of 40.
- Partial repairs that do use a roofing word stay in roofing work.
- Coating only: 574 permits are roofing work only through COATING TO AN EXISTING ROOF.
  They stay in the permit table, but never set a roof year (368 of them are finaled).

### 14f. Status classes and open duration (`src/permit-status.ts`)

Every raw status maps to one class; an unknown status would be `unmapped` and counted.

| Class            | Permits | Statuses                                                                                                                    |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| open-issued      | 31,975  | Issued, Re-Activate Permit, Permit Extended, Insp Scheduled, Pre-Insp Required/Completed, Intent to Revoke                  |
| open-application | 6,687   | plan check and application stages (PC ..., Corrections Issued, Verifications in Progress, Submitted, Fees Due, ...)         |
| closed           | 255,747 | Permit Finaled, Permit Expired, Permit Closed, CofO/CofC Issued, CofO Corrected/Superseded, OK for CofC, Refund in Progress |
| unclear          | 2,500   | Quality Review Completed, CofO in Progress: neither open nor closed                                                         |
| unmapped         | 0       |                                                                                                                             |

- `open_since` is the issue date for open-issued and the submitted date for
  open-application; `open_days` counts from it to the reference date, never the build
  date. It is missing for 10 open-issued and 20 open-application permits (no such date).
- Only open-issued counts as open for long-open. The data API's long-open filter takes a
  minimum open duration in days, by default 1,826 days (5 × 365.25, rounded), adjustable,
  and an optional maximum, unset by default.
- Long-open counts roofing work only (`roofing_work`, §14e), in the long-open permit list
  and in the map's long-open highlight alike. A permit that is roofing work only through
  the coating phrase stays in, flagged `roof_coating_only`. A parcel's permit list still
  shows every permit, each tagged with `roofing_work`.
- In the default window (at least 1,826 days to the reference date 2026-11-12), 13,292
  open-issued permits joined to a parcel are long-open city-wide. The filter excludes the
  2,318 that are not roofing work and keeps 10,974. None of the 574 coating-only permits
  is among them.

### 14g. Effective roof year

- Per parcel: the later of the year built and the year of the status date of the latest
  roofing permit with status Permit Finaled linked to it (building-level links count for
  every unit). A permit that is roofing work only through the coating phrase never
  counts. A qualifying permit dated in a year before the year built is ignored and
  counted; so is one dated after the reference date (none in this run).
- `roof_age_basis` says which: the year-built PROXY label, or the PERMIT label;
  `roof_year_permit_number` names the permit.

| Basis                                      | Parcels   |
| ------------------------------------------ | --------- |
| permit                                     | 189,716   |
| year built (PROXY)                         | 2,017,258 |
| none (no year built, no qualifying permit) | 221,459   |

- 189,668 of the permit-based parcels are in the City of Los Angeles (23.53% of its
  805,901 parcels); 48 are outside it.
- 1,371 parcels without a year built get a roof year from a permit.
- Ignored qualifying permits dated in a year before the year built: 1,350, by join
  method: direct 1,124 (0.41% of 272,181 direct joins), address 203 (2.63% of 7,705),
  condo-building 23 (0.26% of 8,941).

### 14h. Contractor rows and license classes (`src/license-classes.ts`)

- 113,642 rows for 113,435 permits; 89,022 of those permits are in the permit table. The
  view has rows only for permits issued 2013-01-02 to 2023-05-19.
- Coverage window: from the rebuild run on, the run manifest records this window on the
  contractor source as `coverage` (field `permit_issue_date`, first 2013-01-02, last
  2023-05-19), read from the data. The permit sources and the roll source have no window
  (`coverage` null).
- The license class is normalized to the CSLB form: C plus one or two digits, or the
  digits alone, become C-n; D plus two digits become the limited specialty C-61/D-nn
  (D-51 Waterproofing and Weatherproofing, D-59 Hydroseed Spraying); A and B stay; ASB
  and HAZ are certifications, not classes. NA is an owner-builder placeholder (11,796
  rows, no license number, `is_owner_builder` true); N/A and empty values have no class.
  Values not in the table are `unmapped`: C93 and 2B, one row each.
- 11,825 rows have no license number (owner-builder and N/A rows).

### 14i. Permit coverage

`permit_data_available` is true for the 805,901 parcels (33.19%) whose tax-rate-area city
is the City of Los Angeles, and false for the other 1,622,532, which have no permit data
(section 6b). 279,900 parcels have at least one linked permit.

### 14j. Inspections dataset: considered, not ingested

The LADBS inspections dataset (`9w5z-rg2h`, CC0, refreshed weekly) records final
inspections for only about a third of the roofing permits; the permit status is the
more complete signal, so it is not ingested.

A one-off sample check compared the status date of "Permit Finaled" permits with their
last final inspection, for 2,000 sampled permits: 1,519 are finaled in the cache; 877 of
them have no final inspection in the dataset; 642 have both dates. Of those 642, the
status date equals the last final inspection for 288, is 1-7 days later for 348, 8-30
days later for 1, more than 30 days later for 2, and 1-7 days earlier for 3 (median +1
day). So 636 of 642 (99.1%) fall 0-7 days after the final inspection: the status date
behaves as the finalization date. This is a sample check, not a confirmation.

### 14k. Run ID and reference date

- The three runs recorded before the rebuild run have IDs made of a time alone. For the
  permits run it is the latest `generated_at` of the three caches (the contractor
  cache's, 2026-11-12T14:00:51.383Z), with ":" and "." replaced:
  `2026-11-12T14-00-51-383Z`. These IDs are never recomputed.
- From the rebuild run on, a run ID is `<T>-b<D>`:
  - `<T>` is that time: the latest `generated_at` of the input caches, in the same form;
  - `<D>` is the first 12 hex characters of the build digest, the sha256 over the sorted
    lines `output <role> <sha256>` for the four Parquet files and one line
    `manifest <sha256>` for the normalized run manifest;
  - normalized means: `generated_at` and `build_digest` left out, every occurrence of the
    run ID replaced by a fixed placeholder, and the recorded paths (`data/out/<ID>/`,
    `runs/<ID>/`) used also in a dry run;
  - the manifest lists every input cache file's sha256, so the inputs are in the digest
    through it.
- So the same caches built into the same bytes give the same ID, a dry run gives the ID
  of the recorded build, and any change to an output byte or to the manifest (a reworded
  limitation, for example) gives a new ID. The rebuild run shows it: three dry runs and
  the recorded build gave `2026-11-12T14-00-51-383Z-bc7f18f2e9cf2`.
- A build whose files equal those of one of the three earlier runs is that run, already
  recorded under its ID, and adds no history line. A run with a build digest is matched by
  its ID.
- History lines are appended in `finished_at` order: a line whose `finished_at` is not
  later than every recorded one is refused, so the last line is always the latest run.
  Nothing sorts run IDs, and every prefix test on a run ID uses a trailing slash, because
  a rebuild's ID starts with the ID of the run it rebuilds.
- The reference date for every derived duration (open days, the two 10-year ownership
  proxies, the roof-year cut-off) is the permit cache's `generated_at` date, 2026-11-12,
  never the build date. The same caches and code give byte-identical files.

### 14l. Contractor identity (`src/contractor-identity.ts`, rule version contractor-identity-1)

From the rebuild run on, each contractor row points to an identity: one identity per
license number. It is not verified against CSLB (below).

- **Key:** `contractor_identity_key` is the row's license number (`license_identifier`)
  as LADBS publishes it, trimmed, with no other normalization. All 8,240 license numbers
  are digits only (2 to 8 digits), and none would merge with another if upper-cased,
  reduced to letters and digits, or stripped of leading zeros, so no other normalization
  is needed. 101,817 rows carry a key.
- **Rows without a license number** get no key and are never merged: 11,825 rows (11,796
  owner-builder, 28 N/A, 1 other). Their other identity columns are null.
- **Canonical name:** `canonical_business_name` is the license's latest non-null business
  name, by the row's own `permit_issue_date`. A tie on that date goes to the name on most
  of the license's rows (this settled 4 licenses), then to the lowest name in byte order
  (5 licenses). The canonical name is always a name on one of that license's rows.
- **Name variants:** `name_variant_count` is the number of distinct non-null names
  (trimmed) on the license's rows. The variants are counted, never listed.
- **`identity_permit_count`:** the number of distinct permits on the license's rows in
  the contractor table.
- **`contractor_identity_rule_version`:** the rule version, `contractor-identity-1`, on
  every row, with or without a key.

| Measure                                        | Count                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Licenses (identities)                          | 8,240                                                                                                      |
| Licenses with more than one name               | 916 (at most 11 names); 913 if names are upper-cased with spaces collapsed, 877 on letters and digits only |
| Names under more than one license              | 77, kept as separate identities                                                                            |
| Licenses with no name on any row               | 41                                                                                                         |
| Canonical name settled by frequency / by bytes | 4 / 5                                                                                                      |

- A name shared by several licenses is not merged: a name alone does not show that two
  licenses are one business.
- Where a license has no name, its canonical name is null: the API returns null and no
  name is shown, never a guessed one.
- **Not verified against CSLB.** No CSLB lookup was made, so a license number is not
  checked to be valid, current or held by the business named on the permit. One license
  number is one identity across all the permit years; `license_expiration_date` is not
  used to split it.

## 15. Land base year and the three ownership bases

`land_base_year` is the roll's `Roll_LandBaseYear`: the land's base year under Prop 13,
the year of the last change in ownership or new construction that reassessed it.

- **Valid years:** 1975 (the first possible base year, the 1975 lien date) to the roll
  year, 2026. Zero, years before 1975 and years after the roll year are null: 10,964
  zero, 4 before 1975 and 1 after 2026. 2,417,464 parcels have a land base year.
- **The label is a fiscal year ending 30 June:** an event from July of one year to June of
  the next carries the later year. The roll shows it: among recordings since 2000 whose
  land base year is their recording year or the next, about 93% of those recorded from
  July to December carry the next year, and at most 0.2% of those recorded from January
  to June.
- **The 10-year cutoff:** `ownership_base_year_10y_proxy` is true when `land_base_year`
  is at most the latest label whose fiscal year ended (30 June) on or before the reference
  date minus 10 years: 2016 for the reference date 2026-11-12. Label 2017 (events from
  July 2016 to June 2017, mostly within the 10 years) is not counted; it holds 70,525
  parcels. The flag is null when `land_base_year` is null.

Parcels with no ownership change in 10 years, by basis (reference date 2026-11-12):

| Basis             | Rule                                                                     | County (2,428,433) | City of Los Angeles (805,901) |
| ----------------- | ------------------------------------------------------------------------ | ------------------ | ----------------------------- |
| recorded document | `owner_unchanged_10y_proxy`: last recording date on or before 2016-11-12 | 1,120,743          | 362,035                       |
| base year         | `ownership_base_year_10y_proxy`: land base year 2016 or earlier          | 1,659,534          | 538,722                       |
| both              | both flags true                                                          | 1,094,866          | 353,574                       |

What each basis gets wrong:

- **Recorded document:** any recorded document resets it, not only a sale. A refinance or
  a lien makes an owner who never changed look recent.
- **Base year:** transfers that do not reassess escape it. A transfer between spouses or
  from parent to child keeps the old base year, so a new owner can look unchanged. New
  construction also resets it.
- **Both:** the strictest. A parcel counts only when neither signal shows a change in the
  10 years.

All three are proxies from the County roll, not sales records: the roll has no sale date,
price or document type.

An earlier scoping count on the same cache, made before the rule was set, treated the 4
years before 1975 as valid. It found 1,659,538 parcels on the base-year basis and
1,094,869 on both. The build makes those 4 values null, so its counts are 4 and 3 lower
(the fourth parcel is not on the recorded-document basis).
