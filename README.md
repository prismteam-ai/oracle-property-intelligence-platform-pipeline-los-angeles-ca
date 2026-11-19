# Oracle Property Intelligence Platform Pipeline - Los Angeles County, CA

## Context

This repository is the **data gathering and ingestion pipeline** that supplies the [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm). The CRM helps roofing companies explore properties in their service area, identify aging roofs and open roofing permits, and turn those signals into leads. This pipeline story covers collecting, loading, reconciling, and exposing the underlying property and permit datasets; the CRM UI/workflow itself is out of scope here.

The Oracle ingestion pipeline has been started, but the full **Los Angeles County, CA** dataset has not been completely uploaded, reconciled, or demonstrated. The infrastructure must be designed so Oracle does not carry ongoing infrastructure cost by default. For this candidate exercise, the candidate acts as both Oracle and builder: they are responsible for completing the pipeline and proving the low-cost infrastructure approach.

The pipeline must be continuous and incremental (ongoing ingestion of new and changed records over time) and must publish eligible data artifacts to Elephant IPFS (the Elephant protocol’s decentralized storage layer, following Lexicon / elephant-cli / Filebase+IPNS conventions used by the Elephant oracle skills).

Published artifacts must remain independently retrievable from the public IPFS network after the candidate’s local environment, demo session, and any single pinning vendor are gone. **Content identifiers (CIDs) are the durable identity of each artifact.** A vendor HTTP gateway URL is a convenience locator, not the artifact.

In addition to standard property intelligence, the pipeline must surface signals relevant to **roofing lead generation**, including roof age, open roofing permits (especially long-open permits), contractor identity, BBB rating scores where available, ownership/contact fields where available, and accurate property coordinates for radius-based search.

## Description

Complete the Oracle pipeline by loading all available Los Angeles County, CA property, permit, ownership, business, contractor, location, and public-source data into an MCP-ready database. Use IPFS and DuckDB to minimize Oracle-hosted infrastructure costs while enabling UI and agent access to answer property intelligence questions that support the roofing CRM—especially aged-roof and open-permit lead discovery within a map radius.

The pipeline must demonstrate that data is ingested on an ongoing basis (not a one-shot bulk load): support incremental / windowed refreshes, preserve run history with record deltas and timestamps, and re-publish updated artifacts to Elephant IPFS as **new immutable CIDs** (do not mutate a previously published CID).

## Acceptance Criteria

### Geography & coverage
- Target **Los Angeles County, CA** as the default and primary county for ingestion and demos.

### Data loading
- Run the Oracle pipeline until all available county data is uploaded.
- Load available property records into the database.
- Load available permit records into the database, with emphasis on **roofing-related permits**.
- Preserve permit status, open/close dates (or equivalent), and duration-open signals so long-open permits can be identified.
- Load available ownership records into the database.
- Load available contractor records into the database.
- Load available BBB / contractor rating scores where publicly available.
- Load available business records into the database.
- Load available location and coordinate data into the database (required for GPS/pin-drop radius queries in the CRM).
- Capture roof age or best-available proxies (e.g., year built, last roofing permit/completion date) so properties with roofs older than a configurable threshold (default suggestion: **15 years**) can be queried.
- Reconcile duplicate entities across all uploaded datasets.
- Preserve source provenance for uploaded records.
- Design and implement the pipeline as continuous / incremental:
  - Support ongoing ingestion of new and changed records (scheduled or on-demand refreshes, change detection or bounded windows, idempotent steps).
  - Maintain a visible history of pipeline runs (timestamps, source list, record counts, deltas, any source limitations).
  - Demonstrate that data continues to be ingested and published over time (multiple runs or simulated ongoing updates).

### Infrastructure & access
- Optimize pipeline performance where feasible.
- Identify slow source sites or constrained data sources.
- Document pipeline speed limitations and source constraints.
- Design the infrastructure so Oracle does not carry ongoing infrastructure cost by default.
- Use IPFS for decentralized storage of eligible dataset artifacts.
- Use DuckDB for local or portable analytical querying.
- Structure the database to support MCP access.
- Enable agent access to query the database.
- Provide a UI for exploring the uploaded data.

### IPFS publication
- Treat IPFS **CIDs** as the durable identity of published artifacts. Do not treat a vendor-specific HTTP URL as the source of truth.
- Prefer **CIDv1** (base32) for every published object.
- Keep published bytes **retrievable from the public IPFS network**, not only from a private node, authenticated gateway, vendor dashboard, or laptop that is running during the demo.
- Publish a machine-readable **artifact manifest** (JSON) for each pipeline run. Include every eligible object (query table, coverage, indexes, sample extracts, and any directory roots) with at least:
  - `cid`
  - logical `name` / path
  - `size` in bytes
  - IPFS codec (`file` vs `directory`)
  - content digest (e.g. SHA-256 of the raw bytes, or equivalent)
  - optional provider `origins` (multiaddrs) if a candidate-operated node is still serving the blocks
- If IPNS is used, record both the IPNS name and the **resolved CID** for that run. IPNS is a pointer; the CID is the snapshot.
- On incremental republish, keep prior CIDs immutable. New data produces a new CID. Run history must retain previous CIDs.
- For directory artifacts, also publish a **CAR** of the DAG rooted at that CID so the snapshot can be imported by any IPFS node without re-encoding.
- Demonstrate that each listed CID can be fetched from **at least two independent public gateways** that this environment does not operate (for example `https://ipfs.io/ipfs/<cid>` and `https://dweb.link/ipfs/<cid>`), and that the retrieved bytes match the manifest size/digest.
- Include the artifact manifest (and CARs, if any) in the repository or demo packet so a third party can fetch the dataset by CID after the candidate environment is gone.

### Roofing CRM–supporting queries
- Support radius-based property identification using coordinates (around a GPS point or map pin).
- Support questions about properties with roofs older than 15 years (or a configurable age threshold).
- Support questions about properties with **open roofing permits**, including those that have remained open for many years.
- Support returning permit details with contractor name and BBB rating score where available.
- Support questions about properties that have not exchanged ownership in more than 10 years.
- Support questions about properties with regional (or out-of-area) owners.
- Return source-backed answers where source data is available.

### Demonstration
- Demonstrate the uploaded dataset through the UI.
- Demonstrate the uploaded dataset through an agent query aligned to roofing lead discovery.
- Demonstrate that Oracle can operate without carrying the infrastructure cost.
- Demonstrate public, CID-addressed IPFS publication using the artifact manifest and independent gateway retrieval (not a private-only locator).
- Confirm the candidate fulfilled both Oracle and builder responsibilities for this milestone.
- Pass the demo using real uploaded Los Angeles County records.

## Demo Transcript
- Presenter: “I will demonstrate that the Oracle pipeline has loaded the available dataset for Los Angeles County, California, that the data is queryable through DuckDB, that eligible artifacts are stored on IPFS as content-addressed snapshots, and that both the UI and agent can answer property intelligence questions that support roofing lead generation.”
- Presenter: “First, I am opening the pipeline run summary.”
  - Expected Result: The system displays the completed pipeline run, source list, county coverage, record counts, timestamps, and any documented source limitations.
- Presenter: “Show the total uploaded records by source.”
  - Expected Result: The system shows uploaded property, permit, ownership, contractor (with BBB rating where available), business, and coordinate records with collection timestamps and provenance.
- Presenter: “Now I am opening the DuckDB-backed query layer.”
  - Expected Result: The system confirms that the loaded data is available for structured querying without requiring Oracle-hosted database infrastructure.
- Presenter: “Show the published artifact manifest for this run.”
  - Expected Result: A JSON (or equivalent) listing every eligible artifact with CID, size, logical name, codec, and digest. Gateway URLs, if shown, are derived from those CIDs. An IPNS name, if used, is shown together with the resolved CID.
- Presenter: “Retrieve one published artifact by CID from a public gateway that this environment does not operate, then again from a second independent public gateway.”
  - Expected Result: Both fetches succeed and the bytes match the manifest size/digest. Serving the object only from a private, local, or authenticated gateway is a fail.
- Presenter: “Show that a later incremental publish produced a new CID without mutating the previous one.”
  - Expected Result: The prior CID still resolves; the new run has a distinct CID; IPNS (if used) now points at the new CID; both CIDs appear in run history. A CAR is available for any directory root.
- Presenter: “Using the UI, show properties within a sample radius that have roofs older than 15 years.”
  - Expected Result: Matching properties are returned with roof-age basis, coordinates, and source provenance.
- Presenter: “Show properties in that area with open roofing permits, prioritizing permits that have remained open for many years, including contractor and BBB rating where available.”
  - Expected Result: Results include permit status/open duration, contractor identity, BBB score when present, and clear source backing.
- Presenter: “Now I am asking the same type of questions through the agent.”
  - Agent Prompt: “Which properties in Los Angeles County within five miles of [city xyz] have roofs older than 15 years?”
    - Expected Result: The agent returns matching properties, explains the reasoning, and includes source-backed evidence.
  - Agent Prompt: “Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?”
    - Expected Result: The agent returns a filtered list with permit age/open duration, contractor details, BBB rating when available, and clearly identifies any assumptions or missing data.
- Presenter: “Finally, I will show that the system is MCP-ready.”
  - Expected Result: The system demonstrates an MCP-ready interface or documented MCP-compatible query structure that agents and the roofing CRM can use without changing the data model.

## Out of Scope
- Roofing CRM UI, map pin/GPS interaction design, and lead outreach workflows (covered in [roofing-crm](https://github.com/prismteam-ai/roofing-crm)).
- Live outbound messaging to property owners.

## Reference
- [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm)
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills)

## Candidate submission: how to run and deploy

How to build the data, deploy the stacks across both repositories, run the tests, publish to IPFS and tear everything down is in [docs/runbook.md](docs/runbook.md). Where the work departs from the team kit, and why, is in [docs/kit-deviations.md](docs/kit-deviations.md). The access model and its known limits are in [docs/access-rules.md](docs/access-rules.md), and the labels used in commits and docs in [docs/glossary.md](docs/glossary.md). Results, counts and source limits are in [docs/los-angeles-county-findings.md](docs/los-angeles-county-findings.md), and sizes and costs in [docs/metrics.md](docs/metrics.md).

Names used below: LADBS is the City of Los Angeles Department of Building and Safety, whose open data gives the permits and the contractor rows; CSLB is the California Contractors State License Board; an AIN is the County Assessor's 10-digit parcel number. A run is one build of the data, recorded in `runs/`; the served run is the run the hosted data API serves; a rebuild is a run built again from the same downloads, which is not new data.

Delivered: all 2,428,433 Los Angeles County parcels of the assessor's roll 2026, and the City of Los Angeles permits that mention roofing (297,169, of which 234,287 are classed as roofing work), joined to their parcels by parcel number or a full address match (8,083 left unjoined), with their status, open duration and long-open signal. With them come the contractor rows LADBS publishes for permits issued 2013-01-02 to 2023-05-19 (113,642 rows; one identity per license number, 8,240 in all, not verified against CSLB) and three County-roll proxies for an owner unchanged in 10 years, each with its weakness.

They are built with DuckDB into Parquet files, with run history and source provenance, and served by a private, token-protected data API that the Roofing CRM, the Explorer (this repository's site for browsing the data) and the agent use. The Explorer app is hosted as a second branch of the CRM's Amplify app; its URL is the OracleLaExplorerWeb `Origin` output. The hosted agent answers from both sites ("Ask the agent") by tool calls over the data API, with the records it read cited, and the local MCP server serves the same tools. The latest eval round (17 Nov 2026, 25 prompts, three runs each, Sonnet 5.5, on the served run, with the agent code the hosted agent runs) passed 75 of 75, with nine listed warnings: wording or placement in an answer is a warning, also when the wording is wrong; a wrong fact fails only where one of the eval's fifteen checks tests it against the tool calls, the tool results or the answer's structured fields ([docs/runbook.md](docs/runbook.md) section 6). The Explorer page's footer, once the "Ask the agent" tab has been opened, and `GET /agent/warm` (with the site's token) show the commit of the agent code the hosted agent runs.

Published to IPFS on 18 Nov 2026 for runs `2026-11-12T14-00-51-383Z-bc7f18f2e9cf2` and `2026-11-17T00-55-12-521Z-b1f1fbb377948`: the County roll extract, a 5-mile sample of it, and per run a coverage summary and an artifact manifest, pinned at Filebase and fetched with matching size and SHA-256 from ipfs.aleph.cloud and gateway.pinata.cloud. Not published: permit rows (the City building-permit sets state no license) and contractor rows (the contractor view is CC BY 4.0 but is held back: some of its business names may be personal names, and a publication cannot be withdrawn). Both Parquet objects are a cut of 11 columns (parcel number, parcel center, roll year, year built, tax-rate-area city and five provenance columns): no address, no roof year from permits and no ownership field, so `src/query-radius.ts` cannot read them; any DuckDB can (`read_parquet`). The 5-mile sample (151,748 parcels) exists so that the demo's fetch and query run in seconds. The two Parquet objects and their CARs are not in the repository; their identifiers are in each run's artifact manifest and in `src/publish-named-objects.ts`. The files are pinned at one service (Filebase), on its free plan, at $0; a second copy at another service is a next step. How it was built, uploaded, checked and recorded, and the recorded texts written before it that stay unchanged, are in [docs/runbook.md](docs/runbook.md) section 9.

Not done: permits outside the City of Los Angeles (the other 88 jurisdictions keep their permits in separate systems and are not loaded, coverage traded for time; the City holds 805,901 of the 2,428,433 parcels, about a third), BBB ratings (no source is loaded: BBB's site terms do not allow aggregation or republication, and its API needs an approved registration), business records (no registry is loaded), a refresh on a schedule (one command fetches fresh City permits and builds a run, on demand by design), and a second pinning service for the publication (the services checked pin existing content only on paid plans or short trials). Owner names, mailing addresses and contact details are not collected: the open roll has none, and the secured County service that has them is not used, by choice. So regional or out-of-area owners cannot be found. Idle, the deployed stacks cost about one cent a month: S3 and Amplify storage, which the AWS free tier does not cover, while the 9 alarms and up to 8 custom metrics fall within it; without the free tier, $0.91 idle (9 alarms) and $3.31 in a month when all 8 custom metrics receive data (15 Nov 2026 list prices). Everything but storage and alarms is pay-per-request, watched by a $5 monthly budget with alerts, and the agent's model spend by two alarms and a $50 monthly limit set at the model provider. The bill for 1-19 Nov 2026 (19 Nov partial), as Cost Explorer estimated it on 19 Nov 2026 at 14:48 UTC, was $0.390 of gross usage, offset by credits.

The hosted sites: both sit behind basic auth, and their addresses and credentials are not in the repository: the two site addresses are given in the pull request, and the passwords and the token privately. On 18 Nov 2026 the deployed stacks run as follows: the data API runs the code of commit 5647bde and serves run `2026-11-17T00-55-12-521Z-b1f1fbb377948`; the Explorer is built from 5647bde and its page shows a1ade35, the last commit that changed its sources; the agent API runs ebdcf61. The Roofing CRM's site runs CRM commit b5f7b14 and its leads API 284cfba. That day each hosted suite passed in full on a rerun: Explorer 24 of 24 on its second run (the first stopped at test 11), CRM 51 of 51 on its third, started after the data API was warmed (the first two stopped at tests 37 and 28). The cause of those stops is not proven ([docs/runbook.md](docs/runbook.md) section 6, with their limits).

Next steps, not built: place names for districts such as "downtown" (the agent says it does not know them); a publish step in the app, with review and approval; the publications file served through the data API (the Explorer bundles `runs/publications.jsonl` at build); a hosted MCP endpoint (the MCP server is local); and the density view on the CRM map.

### Demo transcript: where each step is

| Step | Status | Where |
| --- | --- | --- |
| Opening the pipeline run summary | delivered | Explorer "Run summary": the served run, its counts, coverage, generated time and source limitations, and the Run history of the six runs, with Permits and Permit-to-parcel links per run (empty for the two runs before permits were loaded) and the Published (identifier) column. The source list is one tab over, on "Sources & pages" |
| Total uploaded records by source | partial | Explorer "Sources & pages": the roll, the permits and the contractor view, each with records, pages, retrieval times and query URL. No source for ownership, business or BBB records; coordinates are on the roll rows. "Records" shows each source's rows with their provenance; its search filters by the start of a parcel or permit number and counts the matches (on the served run: 1 match for 2004001003 and 24 for 2004001) |
| The DuckDB-backed query layer | delivered | The Explorer header ("DuckDB over the private run output, through SQL views"); the data API runs DuckDB over the served run's Parquet files (`apps/api/src/db.ts`). Locally, `node src/query-radius.ts --parquet data/out/<run_id>/los-angeles_property_roll2026.parquet` (after `pnpm install` and a local build of a permit run, [docs/runbook.md](docs/runbook.md) section 4) |
| The published artifact manifest for this run | delivered | Explorer "Run summary", Run history, "Published (identifier)": the manifest's CID, the date and two gateway links derived from the CID (ipfs.aleph.cloud and gateway.pinata.cloud, the first two gateways of `src/gateways.ts`); the file is `runs/<run_id>/publication/artifact-manifest.json` |
| Retrieve one artifact by CID from two independent public gateways | delivered | Either link of that cell (the manifest itself), or `https://ipfs.aleph.cloud/ipfs/<cid>` and `https://gateway.pinata.cloud/ipfs/<cid>` for any file the manifest lists, compared with its `size` and `sha256`. The folder entry's `size` and `sha256` are those of its CAR, which a gateway returns with `?format=car`. The gateway check does this for every object ([docs/runbook.md](docs/runbook.md) section 9). A first fetch can take minutes. ipfs.io and dweb.link refuse non-browser requests |
| A later publish with a new CID | partial | Two lines in `runs/publications.jsonl` and two rows of the Run history with their own manifest CIDs; a `directory.car` per run. Both runs were published the same day, and their Parquet objects are the same bytes |
| Properties within a radius with roofs older than 15 years | delivered | Explorer "Radius query": basis, latitude and longitude per row; a row opens its record with its source. The CRM shows them on a map |
| Open roofing permits in that area, longest open first | partial | Explorer "Long-open permits": days open, status, "Show contractors", BBB "not available", source |
| The two agent prompts | delivered | Explorer "Ask the agent"; eval prompts `a1-readme-108-van-nuys` and `a2-readme-110-follow-up` |
| MCP-ready | delivered | Explorer "MCP" (tools, schemas, a live example); [apps/agent-mcp/README.md](apps/agent-mcp/README.md) ("MCP server") |

### Acceptance criteria: status

Status is one of delivered, partial, not done, not used, or not collected by choice. Explorer views are its tabs ("Run summary", "Sources & pages", "Records", "Radius query", "Long-open permits", "Ask the agent", "MCP", "Coming next"); findings are [docs/los-angeles-county-findings.md](docs/los-angeles-county-findings.md).

**Geography & coverage**

| Criterion | Status | Details, and where to see it |
| --- | --- | --- |
| Target **Los Angeles County, CA** as the default and primary county for ingestion and demos. | delivered | Explorer "Run summary"; the CRM opens on the county |

**Data loading**

| Criterion | Status | Details, and where to see it |
| --- | --- | --- |
| Run the Oracle pipeline until all available county data is uploaded. | partial | Missing: permits of the 88 jurisdictions outside the City of Los Angeles (not loaded), BBB ratings and business records. Explorer "Run summary" (limitations) and "Sources & pages"; findings section 6b |
| Load available property records into the database. | delivered | 2,428,433 parcels, roll 2026. Explorer "Sources & pages", "Records" |
| Load available permit records into the database, with emphasis on **roofing-related permits**. | partial | City of Los Angeles only (805,901 of 2,428,433 parcels, about a third; LADBS, 297,169 permits whose work description contains ROOF, 234,287 of them classed as roofing work). Explorer "Sources & pages"; findings sections 14 and 11f |
| Preserve permit status, open/close dates (or equivalent), and duration-open signals so long-open permits can be identified. | delivered | For the City of Los Angeles permits: status class, issue and status dates (the status date stands for the close date), open days. Open means issued and not finaled, expired or closed (status class open-issued); application-stage permits never count as open: they show in the parcel details and in the Explorer's "Records", not in the long-open list. The downloaded permit columns include no expiry date. Explorer "Long-open permits"; findings section 14f |
| Load available ownership records into the database. | partial | Only the roll's ownership-duration fields (last recording date, land base year); owner names, mailing addresses and contacts are not collected, by choice. Findings section 15 |
| Load available contractor records into the database. | partial | Only LADBS's contractor rows, for permits issued 2013-01-02 to 2023-05-19, not verified against CSLB. Explorer "Records" (contractor rows); findings sections 14h, 14l |
| Load available BBB / contractor rating scores where publicly available. | not done | No BBB source is loaded; screens and answers say BBB ratings are not available. Agent eval prompt `o-bbb-coverage` |
| Load available business records into the database. | not done | No business registry is loaded; contractor business names come only from the permits |
| Load available location and coordinate data into the database (required for GPS/pin-drop radius queries in the CRM). | delivered | Assessor parcel centers for 2,417,838 parcels; the 10,595 without coordinates never appear in radius results. Explorer "Radius query"; findings section 11b |
| Capture roof age or best-available proxies (e.g., year built, last roofing permit/completion date) so properties with roofs older than a configurable threshold (default suggestion: **15 years**) can be queried. | delivered | Effective roof year: the later of the year built and the latest finaled roofing permit, with its basis (PROXY or PERMIT); threshold set per query; no roof year for 221,458 parcels: 222,830 have no year built and 1,372 of them take one from a finaled roofing permit. Explorer "Radius query"; findings sections 14g, 11b and 11f |
| Reconcile duplicate entities across all uploaded datasets. | partial | One parcel per AIN, permits joined to parcels by a recorded method, one contractor identity per license number (names never merged); no reconciliation of owners or businesses across sources. Findings sections 14d, 14l |
| Preserve source provenance for uploaded records. | delivered | Each record keeps its source page file, request URL, retrieval time and page sha256. Explorer "Sources & pages", "Records" |
| Design and implement the pipeline as continuous / incremental: | partial | The three items below |
| Support ongoing ingestion of new and changed records (scheduled or on-demand refreshes, change detection or bounded windows, idempotent steps). | partial | One command, `scripts/permit-run.ts`, fetches fresh City permit caches, compares them with the previous run's (it stops on a row change over 1% or a new or missing column) and builds the run; on demand by design, with no schedule, and it stops after the local build: commit, upload and deploy are separate steps a person reviews. Rebuilds from the caches are idempotent (the same caches give the same run ID and no new history line), with a delta per run. Missing: a scheduled refresh. [docs/runbook.md](docs/runbook.md) sections 4 and 4b |
| Maintain a visible history of pipeline runs (timestamps, source list, record counts, deltas, any source limitations). | delivered | Six runs in `runs/run_history.jsonl`, each with its manifest and its delta to the run before; the delta counts parcels, and the permit counts are in the `row_counts` of the four permit runs' lines. Explorer "Run summary" (Run history: Permits and Permit-to-parcel links per run, and Published (identifier)) |
| Demonstrate that data continues to be ingested and published over time (multiple runs or simulated ongoing updates). | partial | Ingested over time: run `2026-11-17T00-55-12-521Z-bcb7d21c21fe7` is new data from a fresh City permit fetch, 260 more permits than the 12 Nov runs; the data API serves its rebuild `2026-11-17T00-55-12-521Z-b1f1fbb377948`, the same data with a reworded publication limitation. Published: two runs, both on 18 Nov 2026; not yet a publication of a later run after an earlier one. [docs/runbook.md](docs/runbook.md) sections 4, 7 and 9; findings sections 7 and 11f |

**Infrastructure & access**

| Criterion | Status | Details, and where to see it |
| --- | --- | --- |
| Optimize pipeline performance where feasible. | delivered | The roll is downloaded once into a cache; the county build takes about 2 minutes; the data API runs at 2,048 MB for a shorter cold start. [docs/metrics.md](docs/metrics.md); findings section 11 (build times; its cold start is the earlier 1,024 MB one) |
| Identify slow source sites or constrained data sources. | delivered | Findings section 1 (the roll at one request every 2 s or slower), section 6b (88 jurisdictions not loaded), section 14 |
| Document pipeline speed limitations and source constraints. | delivered | Findings sections 11, 14; [docs/metrics.md](docs/metrics.md) |
| Design the infrastructure so Oracle does not carry ongoing infrastructure cost by default. | delivered | About one cent a month idle: S3 and Amplify storage, which the free tier does not cover; without the free tier $0.91 idle (9 alarms) and $3.31 in a month when all 8 custom metrics receive data. [docs/metrics.md](docs/metrics.md) ("Idle cost per month", "How cost grows") |
| Use IPFS for decentralized storage of eligible dataset artifacts. | partial | For two runs the County roll extract, a 5-mile sample, a coverage summary and an artifact manifest are pinned at Filebase. Missing: permit rows (no license stated), contractor rows (held back: some business names may be personal names) and a second pinning service. Findings section 7; `runs/publications.jsonl`; [docs/runbook.md](docs/runbook.md) section 9 |
| Use DuckDB for local or portable analytical querying. | delivered | The build and the data API run DuckDB over the Parquet files; `node src/query-radius.ts --parquet data/out/<run_id>/los-angeles_property_roll2026.parquet` (after `pnpm install` and a local build of a permit run, [docs/runbook.md](docs/runbook.md) section 4) |
| Structure the database to support MCP access. | delivered | The local MCP server over the data API ([apps/agent-mcp/README.md](apps/agent-mcp/README.md), "MCP server"); Explorer "MCP" |
| Enable agent access to query the database. | delivered | The hosted agent in both sites; Explorer "Ask the agent" |
| Provide a UI for exploring the uploaded data. | delivered | The Explorer (OracleLaExplorerWeb `Origin` output) |

**IPFS publication**

| Criterion | Status | Details, and where to see it |
| --- | --- | --- |
| Treat IPFS **CIDs** as the durable identity of published artifacts. Do not treat a vendor-specific HTTP URL as the source of truth. | delivered | Each published run is recorded by its manifest CID and folder CID in `runs/publications.jsonl`; the Explorer's gateway links are derived from them. Explorer "Run summary" (Run history, "Published (identifier)") |
| Prefer **CIDv1** (base32) for every published object. | delivered | Every published object's CID is CIDv1 base32; `runs/<run_id>/publication/artifact-manifest.json` |
| Keep published bytes **retrievable from the public IPFS network**, not only from a private node, authenticated gateway, vendor dashboard, or laptop that is running during the demo. | partial | Pinned at Filebase; on 18 Nov 2026 the gateway check fetched every listed object from ipfs.aleph.cloud and gateway.pinata.cloud, neither run by the pinning service. Missing: a second pinning service (one service pins the files; a second copy at another service is a next step). Nothing re-checks later that the files stay pinned or retrievable; the check can be run again ([docs/runbook.md](docs/runbook.md) section 9) |
| Publish a machine-readable **artifact manifest** (JSON) for each pipeline run. Include every eligible object (query table, coverage, indexes, sample extracts, and any directory roots) with at least: `cid`; logical `name` / path; `size` in bytes; IPFS codec (`file` vs `directory`); content digest (e.g. SHA-256 of the raw bytes, or equivalent); optional provider `origins` (multiaddrs) if a candidate-operated node is still serving the blocks | partial | Published for two runs (`…bc7f18f2e9cf2` and `…b1f1fbb377948`): `artifact-manifest.json` lists the publish folder, `coverage.json` and the two Parquet objects, each with `cid`, `name`, `size`, `codec`, `ipld_codec` and `sha256`. No `origins`, no index object, and the query table is an 11-column roll extract: no address, no permit, no roof year from permits and no ownership field; the other four runs have no manifest |
| If IPNS is used, record both the IPNS name and the **resolved CID** for that run. IPNS is a pointer; the CID is the snapshot. | not used | No IPNS name is used; each run is recorded by its CIDs |
| On incremental republish, keep prior CIDs immutable. New data produces a new CID. Run history must retain previous CIDs. | partial | Two runs are recorded in `runs/publications.jsonl`, each with its own manifest and folder CID; the earlier line is unchanged. `runs/run_history.jsonl` holds no CID, and its `published` flag, written at build, reads false on every line. Both were published on 18 Nov 2026, and the two Parquet objects are the same bytes in both runs |
| For directory artifacts, also publish a **CAR** of the DAG rooted at that CID so the snapshot can be imported by any IPFS node without re-encoding. | delivered | `runs/<run_id>/publication/directory.car`: the CAR of the run's publish folder, rooted at the folder's CID, as uploaded |
| Demonstrate that each listed CID can be fetched from **at least two independent public gateways** that this environment does not operate (for example `https://ipfs.io/ipfs/<cid>` and `https://dweb.link/ipfs/<cid>`), and that the retrieved bytes match the manifest size/digest. | delivered | On 18 Nov 2026 the gateway check passed for both runs: every listed object matched by size and SHA-256 on ipfs.aleph.cloud and gateway.pinata.cloud (ipfs.io and dweb.link have refused non-browser requests since 21 Sep 2026). The proof files are not in the repository. What the repository holds: the two lines of `runs/publications.jsonl`, which `scripts/record-publication.ts` appends only for a passing proof of the same run and CIDs; the check can be run again ([docs/runbook.md](docs/runbook.md) section 9) |
| Include the artifact manifest (and CARs, if any) in the repository or demo packet so a third party can fetch the dataset by CID after the candidate environment is gone. | partial | `runs/<run_id>/publication/` holds the artifact manifest, its CAR, the publish folder and its CAR for each published run: from the repository alone the manifest, the folder and `coverage.json` can be restored under their CIDs. Missing: the two Parquet objects (32,775,616 and 1,878,244 bytes) and their CARs are in neither the repository nor a demo packet, and the build that made them is not in the repository. They are fetched by the CIDs the manifest lists, for as long as the one pinning service or another node holds them |

**Roofing CRM–supporting queries**

| Criterion | Status | Details, and where to see it |
| --- | --- | --- |
| Support radius-based property identification using coordinates (around a GPS point or map pin). | delivered | Explorer "Radius query"; the CRM; the agent's `search_aged_roofs` |
| Support questions about properties with roofs older than 15 years (or a configurable age threshold). | delivered | Explorer "Radius query"; agent eval prompts `a1-readme-108-van-nuys`, `c-two-miles-forty-years` |
| Support questions about properties with **open roofing permits**, including those that have remained open for many years. | partial | City of Los Angeles permits only. Explorer "Long-open permits"; agent eval prompt `a2-readme-110-follow-up` |
| Support returning permit details with contractor name and BBB rating score where available. | partial | Contractor name and license only for permits issued 2013-01-02 to 2023-05-19; BBB ratings not available. CRM parcel details; Explorer "Records" |
| Support questions about properties that have not exchanged ownership in more than 10 years. | partial | Answered by three County-roll proxies (recorded document, land base year, both), each with its weakness; the roll has no sale date. Agent eval prompt `n-ownership-unchanged-van-nuys`; findings section 15 |
| Support questions about properties with regional (or out-of-area) owners. | not collected by choice | It needs owner mailing addresses: the open roll has none, and the secured County service that has them is not used. Findings section 1 |
| Return source-backed answers where source data is available. | delivered | Every answer that reads data lists the records it read; Explorer "Ask the agent" (Sources) |

**Demonstration**

| Criterion | Status | Details, and where to see it |
| --- | --- | --- |
| Demonstrate the uploaded dataset through the UI. | delivered | The Explorer and the CRM |
| Demonstrate the uploaded dataset through an agent query aligned to roofing lead discovery. | delivered | "Ask the agent" in both sites; the latest eval round: 75 of 75, with nine listed warnings ([docs/runbook.md](docs/runbook.md) section 6) |
| Demonstrate that Oracle can operate without carrying the infrastructure cost. | delivered | [docs/metrics.md](docs/metrics.md) ("Idle cost per month") |
| Demonstrate public, CID-addressed IPFS publication using the artifact manifest and independent gateway retrieval (not a private-only locator). | delivered | `runs/publications.jsonl`, the artifact manifests under `runs/<run_id>/publication/`, and the gateway check of 18 Nov 2026, which can be run again ([docs/runbook.md](docs/runbook.md) section 9; findings section 7) |
| Confirm the candidate fulfilled both Oracle and builder responsibilities for this milestone. | partial | The data was built and served, and the apps and stacks built and deployed; the Oracle's IPFS publication covers the County roll only, at one pinning service |
| Pass the demo using real uploaded Los Angeles County records. | delivered | The demo runs on real records: the hosted data API serves run `2026-11-17T00-55-12-521Z-b1f1fbb377948` (since 17 Nov 2026). What it cannot show in full is in the demo table above: records by source for ownership, business and BBB, a BBB score, and a later publication after an earlier one |
