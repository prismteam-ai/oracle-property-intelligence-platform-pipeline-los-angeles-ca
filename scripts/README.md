# LADBS fetch scripts

`ladbs-permits/fetch.mjs` and `ladbs-contractors/fetch.mjs` download the two City of Los Angeles (LADBS) raw caches
that the permit runs are built from: roofing-related building permits from six datasets, and the contractor rows of
roofing permits from the public view `8guu-8f5m`. Both read data.lacity.org's SoQL API without a token.

The build never downloads anything: it reads a cache folder and checks every page against the cache's
`manifest.json` (src/stage-permits.ts, src/stage-contractors.ts).

## Usage

```sh
node scripts/ladbs-permits/fetch.mjs <permit-cache-dir>              # pages + manifest.json
node scripts/ladbs-permits/fetch.mjs summarize <permit-cache-dir>    # summary.json + roofing_flagged.jsonl.gz

node scripts/ladbs-contractors/fetch.mjs <contractor-cache-dir>                              # pages + manifest.json
node scripts/ladbs-contractors/fetch.mjs summarize <contractor-cache-dir> <permit-cache-dir>  # summary.json
```

- The cache folder is required; both scripts refuse to run without it, or with their own folder. Nothing is
  written beside the scripts.
- The contractor `summarize` also needs the permit cache folder: it reads the permit script's
  `roofing_flagged.jsonl.gz` to count how many contractor rows join a permit.
- Requests: 1 s apart, a 120 s timeout each, up to 2 retries, then the script stops. User-Agent
  `oracle-la-pipeline-fetch`.
- Pages are ordered so that each row has one place: `ORDER BY permit_nbr, :id` (permits) and
  `ORDER BY pcis_permit, :id` (contractors), with `LIMIT`/`OFFSET` paging. Each page is gzipped and recorded in
  `manifest.json` with its request URL, query, row count, retrieval time, size and sha256 (JSON and gzip).
- Columns: every row's columns are checked against the requested columns before its page is written; any other
  column stops the run (`columns_checked: true` on each page entry).

## What they download

- Permits: the columns in `COLS`, for rows whose work description contains `ROOF` (submitted sets: only rows not
  yet issued).
- **`work_desc`:** the permit script downloads the permits' work description. It is free text and can contain
  people's names. It is used only to flag roofing work: the query filter and the `roof_r` / `roof_only` flags. The
  pipeline reads it only to set its own roofing flags and never serves it.
- Contractors: the eight columns in `ALLOWED` (business name, license number and type, license expiration date,
  contractor city and state, permit number and issue date), CC BY 4.0, attribution LADBS.

## The flags in `roofing_flagged.jsonl.gz`

`roof_r` and `roof_only` are the first probe's flags, kept as they were when the cache was made. They are not the
pipeline's roofing rule: the build computes its own flags from the pages (src/roof-flags.ts) and never reads
`roofing_flagged.jsonl.gz`.

## The caches in use were made by earlier versions

The permit and contractor caches of the recorded permit runs were made by earlier versions of these scripts:

| Script | sha256 of the version that made the cache | Recorded in |
| --- | --- | --- |
| permits | `49d8ea6375336ba494e0190e175be2f72e865f968dcc9d07d9bf44544efd63c0` | the run manifest's `permit_caches` (`fetch.mjs`) |
| contractors | `497d26841c4502a8a22fddc79e0abbd58bedb81862524b49ddfe319008f7d288` | the cache manifest's `fetch_script_sha256` and the run manifest |

The versions here differ from those:

1. The cache folder (and, for the contractor `summarize`, the permit cache folder) is a required argument.
2. Contractor manifest: `license_evidence` keeps the view page URL and the retrieval date only. Contractor
   `summary.json`: `permit_cache` is a file name, not an absolute path.
3. Contractor manifest and summary keys in American spelling (`license_stated`, `license_evidence`, `license`,
   `license_class_counts`). The existing cache keeps the earlier `licence_*` keys; the build reads none of them.
4. The permit script's header states what `work_desc` is and what it is used for.
5. The permit script checks every row's columns before writing a page and pages by `permit_nbr, :id`; both
   scripts have a 120 s request timeout.
6. `roof_r` and `roof_only` are labelled as the first probe's flags (comments, and `flag_note` in the permit
   `summary.json`); the flag code is unchanged.
7. The User-Agent is `oracle-la-pipeline-fetch`.

The build reads permit caches paged either way: `ORDER BY permit_nbr` (the existing cache) or
`ORDER BY permit_nbr, :id`, the same order on every page of a dataset (src/stage-permits.ts `PERMIT_PAGE_ORDERS`).
