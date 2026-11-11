# Los Angeles County, CA: findings (increment 1, local parcel pilot)

Status: discovery and readiness preflight are done. The slice download has not
started because it is waiting for approval stop (a).
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
chose Option A, a scoped exception. The draft below is **not active** until the user
approves it. Evidence of the blocked gate: `docs/evidence/la-preflight-blocked.json`.

### 6a. DRAFT permit-gate exception (pending user approval, not yet in the YAML)

Proposed entry for `approved_exceptions` in `docs/los-angeles-sources.yaml`:

```yaml
approved_exceptions:
  - gate: permit
    reason: >-
      Increment 1 only: parcels only, City of Los Angeles, ZIP codes 91405, 91406 and
      91411, LA County Assessor roll 2026. No permits are harvested in this increment.
      The 88 jurisdictions without a classified permit source are not yet covered and
      are listed by name in docs/los-angeles-county-findings.md (section 6b) and in
      run_manifest.json limitations. This exception expires when permits are added
      (piece 4); the readiness check is then re-run without it.
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
    expires: piece 4 (permit ingestion) - remove this entry and re-run the preflight
    approved_by: <user, date - filled on approval>
```

How the validator reads it: `_approved()` in the kit's `validate-county-readiness.py`
matches any `approved_exceptions` item with `gate: permit` and a non-empty `reason`. The
permit gate then reports `APPROVED_EXCEPTION`, and overall becomes PASS (exit 0) because
the other gates are PASS or NOT_APPLICABLE. The validator **ignores** `scope`, `expires`
and the other extra keys. It does not enforce scope or expiry, and it would also pass a
full-county preflight while the entry is present. Enforcement is therefore procedural:
the entry is removed at piece 4. Enforcing it automatically would need a kit validator
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
