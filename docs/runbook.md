# Runbook: build, deploy, test and tear down (pipeline repository)

This repository holds the data pipeline (the county build), the hosted data API (stacks OracleLaGuards and
OracleLaDataApi), the hosted agent (stack OracleLaAgentApi, `apps/agent-api`) with its local MCP server and eval
(`apps/agent-mcp`), and the Explorer app (stack OracleLaExplorerWeb). The Explorer is hosted as a second
branch, `explorer`, of the CRM's Amplify app, because the account allows one Amplify app
([kit-deviations.md](kit-deviations.md), row 16). The Roofing CRM lives in the CRM repository
(roofing-crm); its `docs/runbook.md` covers the CRM stacks. The two runbooks describe one deploy order,
written from the code: every step names the file that makes it necessary. Section 9 covers the IPFS publication
of recorded runs: its build, the gateway check and the record step.

Related: [kit-deviations.md](kit-deviations.md), [access-rules.md](access-rules.md),
[glossary.md](glossary.md), [metrics.md](metrics.md) and the findings
[los-angeles-county-findings.md](los-angeles-county-findings.md).

## 1. Prerequisites

- Node.js 22.18 or later (`package.json` `engines`), which runs the TypeScript files directly.
- pnpm 12.16.1 from the `packageManager` field: `corepack enable pnpm`, then `pnpm install --frozen-lockfile`.
- The AWS CDK CLI comes from the workspace (`aws-cdk` 2.1146.1 in `apps/api/package.json`,
  `apps/agent-api/package.json` and `apps/explorer/package.json`); run it as `pnpm exec cdk` from `apps/api`
  for the data API stacks, from `apps/agent-api` for OracleLaAgentApi and from `apps/explorer` for
  OracleLaExplorerWeb. No global install is needed.
- The AWS CLI v2, recent enough for `aws s3api put-object --if-none-match` (the run upload), with a profile
  for the target account. Every command below takes `--profile <your profile>`; you can set `AWS_PROFILE`
  instead. The region is fixed in code to eu-north-1 (`apps/api/cdk/bin/app.ts` (`env`)).
- The CDK app reads the account from `CDK_DEFAULT_ACCOUNT`, which the CDK CLI sets from the profile; it
  fails if it is unset (`apps/api/cdk/bin/app.ts` (`account`)). The account must be bootstrapped once, from
  `apps/api` and after `.secrets/api-clients.json` exists (section 2), because the CDK CLI synthesizes the app
  for this command too: `pnpm exec cdk bootstrap aws://<account id>/eu-north-1 --profile <your profile>`.
- Every `cdk` command synthesizes the whole app of its folder, `diff` and `destroy` included. For
  OracleLaExplorerWeb that means `.secrets/explorer.json` and a built `apps/explorer/dist` must exist, even to
  destroy the stack (`apps/explorer/cdk/bin/app.ts`).
- Telemetry off, in every shell that runs these tools:

  ```
  export CDK_DISABLE_CLI_TELEMETRY=true TURBO_TELEMETRY_DISABLED=1
  ```

- For the county build only: Python 3 and a checkout of the soofi-xyz team kit at commit 71b8341 (`KIT_DIR`).
  The build runs the kit's readiness validator and fails if that file's sha256 differs from the commit's.

Deploys keep CDK's default approval: run `pnpm exec cdk diff <stack> --profile <your profile>` first, read
its security-changes table, and answer the prompt `cdk deploy` shows when permissions change. The prompt
covers only the top-level stack: the IAM changes of OracleLaExplorerWeb and RoofingCrmWeb are all in their
nested Amplify asset-deployment provider stack, so `cdk deploy` creates them without asking. Read the diff's
table first. Never pass `--require-approval never`.

A redeploy of an API stack (OracleLaDataApi or OracleLaAgentApi) goes ahead with the default approval when its
fresh `cdk diff` changes only the code asset and shows no security-changes table. A prompt from `cdk deploy`, or
any other change in the diff, is reviewed before deploying.

## 2. Secrets (gitignored `.secrets/`, never committed or printed)

| File                        | Created by                | Holds                                                                                                                                                                                                                                                                               | Read by                                                                                                                                                                                                        |
| --------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.secrets/explorer.json`    | `node scripts/secrets.ts` | Explorer basic-auth user and password, its API token and the token's sha256                                                                                                                                                                                                         | `apps/explorer/cdk/bin/app.ts` (`secrets`: the branch's basic auth); `scripts/write-explorer-config.ts` (`apiToken` in the Explorer's `config.json`); the Explorer suite's `EXPLORER_USER` and `EXPLORER_PASS` |
| `.secrets/api-clients.json` | by hand                   | `{ "crm": { "tokenSha256": "<apiTokenSha256 from the CRM repo's .secrets/crm.json>" }, "explorer": { "tokenSha256": "<apiTokenSha256 from .secrets/explorer.json>" }, "mcp": { "tokenSha256": "<sha256 of the mcp token>" } }`: one entry per client in `apps/api/cdk/clients.json` | `apps/api/cdk/bin/app.ts` (`hashes`, `apiClients`); the deploy fails if a client has no hash                                                                                                                   |
| `.secrets/alerts.json`      | by hand, optional         | `{ "alertEmail": "<the alert address>" }`                                                                                                                                                                                                                                           | `apps/api/cdk/bin/app.ts` (`alertsFile`, `alertEmail`); without it the alert topic has no email subscription                                                                                                   |

- The CRM's token is created in the CRM repository (`scripts/secrets.ts` there writes `.secrets/crm.json`,
  with `apiToken` and `apiTokenSha256`). Only the sha256 crosses into this repository. The Explorer's token
  is created here, in `.secrets/explorer.json`; copy its `apiTokenSha256` into the `explorer` entry by hand,
  without printing it. OracleLaDataApi stores each hash as an SSM parameter under
  `/oracle-la/api/clients/<client>/token-sha256`, and the token authorizer compares hashes
  (`apps/api/src/authorizer.ts`).
- The `mcp` client is the local MCP server's (`apps/agent-mcp`), never a browser: create its token yourself and
  keep it in a key file of your choice, `{ "apiToken": "<token>" }` with mode `0600`
  (`apps/agent-mcp/src/server-options.ts`); only its sha256 goes in `.secrets/api-clients.json`. It reaches the
  data routes only: the agent API serves `crm` and `explorer` and refuses any other client with 403
  (`apps/agent-api/cdk/lib/agent-api-stack.ts` (`AGENT_API_CLIENTS`)).
- The alert address subscribes by email to the alert topic. Its owner must confirm the subscription once.
- The CRM's map key and its `config.json` are covered in the CRM runbook.

### The agent's two secrets (SSM SecureStrings, placed by hand)

The agent reads two values from SSM Parameter Store on first use (`apps/agent-api/src/secrets.ts`). The stack
knows only their names and may read only these two (`apps/agent-api/cdk/lib/agent-api-stack.ts`
(`KEY_PARAMETER_NAME`, `HISTORY_SECRET_PARAMETER_NAME`, the `ssm:GetParameter` statement)):

| Parameter                                 | Holds                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `/oracle-la/agent/anthropic-api-key`      | The Anthropic API key used only by the hosted agent (its own key in the workspace) |
| `/oracle-la/agent/history-signing-secret` | A random secret that signs the conversation history the browser holds              |

Create both in the AWS Console (Systems Manager, Parameter Store) before deploying OracleLaAgentApi: type
SecureString, tier Standard, KMS key `alias/aws/ssm` (the AWS-managed key). Type the values in the console
only: they never go through a command line, a file or the build machine, and CloudFormation cannot create a
SecureString ([kit-deviations.md](kit-deviations.md), row 30). The signing secret is
its own value, not derived from the API key. Without either, the agent answers 503 "agent not configured"
(`apps/agent-api/src/handler.ts` (`NOT_CONFIGURED`)). Set the Anthropic workspace's monthly spend limit
($20) in the Anthropic Console; no payment method is attached, so the credit balance is the final stop.

## 3. Deploy order across both repositories

Each stack's inputs come from the stacks before it. This is the order for an empty account. Pipeline steps
are run here (`apps/api` for the data API stacks, `apps/explorer` for the Explorer); CRM steps are in the
CRM repository's `docs/runbook.md`. RoofingCrmWeb is deployed twice: first to create the Amplify app and
publish its ID, which the data API and the Explorer read; then again with the site's `config.json`, which
needs the data API, the leads API and the agent API.

| #   | Step                                                                                                                                                                                                                                                          | Repo     | Needs (and where that comes from)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm exec cdk deploy OracleLaGuards --profile <your profile>`                                                                                                                                                                                                | pipeline | `.secrets/api-clients.json` with every client's hash (the CDK app reads it on every synth, for this stack too, so create the CRM's token in the CRM repository first), and optionally `.secrets/alerts.json`. The synth also reads `runs/run_history.jsonl` and, since `apps/api/cdk/bin/app.ts` constructs both of its stacks, builds the DuckDB layer with `pnpm`, as in step 3. Creates the alert topic `oracle-la-alerts`, the SSM parameter `/oracle-la/alerts/topic-arn` (`guards-stack.ts` (`GuardsStack`, parameter `AlertTopicArn`)) and the $5 monthly budget.                                                                                                                                                                                                                                                                                                                                                           |
| 2   | Build the CRM site, then deploy RoofingCrmWeb (first deploy, without `config.json`)                                                                                                                                                                           | CRM      | `.secrets/crm.json`. Creates the Amplify app `roofing-crm` with its `main` branch and publishes the app ID as the SSM parameter `/roofing-crm/web/app-id` (CRM `apps/crm/cdk/lib/crm-web-stack.ts` (`APP_ID_PARAM`)). Outputs `Origin`. Until step 10 the site loads but shows a `config.json` error. Not exercised: this first deploy without `config.json` has not been run. RoofingCrmWeb synthesizes from a site without `config.json` (checked 13 Nov 2026); it has not been deployed this way.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3   | `pnpm exec cdk deploy OracleLaDataApi --profile <your profile>`                                                                                                                                                                                               | pipeline | The alert topic from step 1, read from SSM (`data-api-stack.ts` (`DataApiStack`, the alert topic read from `ALERT_TOPIC_PARAM`)). `apps/api/cdk/clients.json`: each browser client's origin is a branch of the Amplify app named by `amplifyAppIdParameter`, `/roofing-crm/web/app-id` from step 2, read at deploy time (`apps/api/cdk/lib/clients.ts` (`clientOrigin`), `data-api-stack.ts` (`DataApiStack`, `HttpApi` `corsPreflight`)). `.secrets/api-clients.json` (token hashes). The latest line of `runs/run_history.jsonl` (`bin/app.ts` (`history`, `latest` and the `DataApiStack` props)): run ID, Parquet sha256 and file name. Synth builds the DuckDB layer with `pnpm` (`data-api-stack.ts` (`DataApiStack`, the `layer` run before `DuckDbLayer`)). Outputs `ApiUrl`, `DataBucket` and `DataPrefix`, and writes `/oracle-la/api/authorizer-arn` (`data-api-stack.ts` (`DataApiStack`, parameter `AuthorizerArn`)). |
| 4   | Upload the run's files (section 5)                                                                                                                                                                                                                            | pipeline | The `DataBucket` output of step 3. The API reads the files on its first request after a cold start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 5   | Place the agent's two SecureStrings by hand (section 2)                                                                                                                                                                                                       | pipeline | Nothing from the stacks. OracleLaAgentApi deploys without them, but the agent answers 503 until both exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | From `apps/agent-api`: `pnpm exec cdk deploy OracleLaAgentApi -c dataApiUrl=<ApiUrl output of OracleLaDataApi> --profile <your profile>`                                                                                                                      | pipeline | The data API's URL as context: OracleLaDataApi publishes it only as its `ApiUrl` output, so pass `-c dataApiUrl=…` on every synth, diff and deploy of this stack (`apps/agent-api/cdk/bin/app.ts` (`dataApiUrl`)). `/oracle-la/api/authorizer-arn` from step 3 (the shared authorizer, with its own invoke permission), `/oracle-la/alerts/topic-arn` from step 1 (three alarms) and `/roofing-crm/web/app-id` from step 2 (CORS for the `crm` and `explorer` clients' branches, `main` and `explorer`), all read at deploy time (`apps/agent-api/cdk/lib/agent-api-stack.ts` (`AgentApiStack`)). Outputs `AgentApiUrl`.                                                                                                                                                                                                                                                                                                           |
| 7   | Deploy RoofingCrmMapKey with `-c alertTopicParam=/oracle-la/alerts/topic-arn`                                                                                                                                                                                 | CRM      | `Origin` of step 2 (cross-stack reference) and the SSM parameter of step 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | Deploy RoofingCrmLeads                                                                                                                                                                                                                                        | CRM      | `/oracle-la/api/authorizer-arn` from step 3 and `/oracle-la/alerts/topic-arn` from step 1 (both read from SSM), and `Origin` of step 2. It creates its own permission to invoke this repository's authorizer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 9   | From the CRM repository root: `AWS_PROFILE=<your profile> node scripts/write-config.ts apps/crm/dist`                                                                                                                                                         | CRM      | The `ApiUrl` output of OracleLaDataApi, the `LeadsApiUrl` output of RoofingCrmLeads and the `AgentApiUrl` output of OracleLaAgentApi, read with the AWS CLI. The token and map key come from `.secrets/crm.json`. Without the OracleLaAgentApi stack, `config.json` has no `agentApiUrl` and the CRM hides its "Ask the agent" section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 10  | Deploy RoofingCrmWeb again                                                                                                                                                                                                                                    | CRM      | The site with its `config.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 11  | `pnpm build --force` (the Explorer bundle also reads `runs/publications.jsonl` and the commit, which the build cache does not track), then from this repository's root: `AWS_PROFILE=<your profile> node scripts/write-explorer-config.ts apps/explorer/dist` | pipeline | The `ApiUrl` output of OracleLaDataApi and the `AgentApiUrl` output of OracleLaAgentApi, read with the AWS CLI, and `apiToken` from `.secrets/explorer.json` (`scripts/write-explorer-config.ts`). Writes `apps/explorer/dist/config.json`, with no leads API URL and no map key. Without the OracleLaAgentApi stack it has no `agentApiUrl` and the Explorer hides its "Ask the agent" tab; any other failure to read the output stops the script.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 12  | From `apps/explorer`: `pnpm exec cdk deploy OracleLaExplorerWeb --profile <your profile>`                                                                                                                                                                     | pipeline | The site with its `config.json` (the `siteDir` default, `apps/explorer/cdk/bin/app.ts`), the basic-auth values from `.secrets/explorer.json`, and `/roofing-crm/web/app-id` from step 2, read at deploy time: `apps/explorer/cdk.json` sets `hostAppIdParameter` to it, so the stack creates only the `explorer` branch on that app (`apps/explorer/cdk/lib/explorer-web-stack.ts` (`ExplorerWebStack`)). Outputs `HostAppId` and `Origin`. With `-c hostAppIdParameter=` (empty), the stack creates its own Amplify app instead.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 13  | Run both hosted suites (section 6)                                                                                                                                                                                                                            | both     | The Explorer and the CRM share the Amplify app's settings. Run the Explorer suite only after step 12: its test 6 expects the "Published (identifier)" cells of this checkout's `runs/publications.jsonl` (`apps/explorer/e2e/explorer.spec.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

For a new county run on an existing deployment, only steps 4 and 3 repeat, in that order. Upload the new
run under `runs/<new run id>/`, then deploy OracleLaDataApi, which points `RUN_ID`, `PARQUET_SHA256`,
`PARQUET_FILE`, `PERMIT_FILES` and `DATA_PREFIX` at it. The CRM, the Explorer and the agent need no deploy for
new data. A new line in `runs/publications.jsonl` is different: the Explorer bundles that file at build
(`apps/explorer/src/publications.ts`, a Vite `?raw` import), so it needs steps 11 and 12 again.

When a change spans the API and the sites, deploy OracleLaDataApi first, then OracleLaAgentApi, then the sites
(steps 9-12): the old sites keep working against the new API, except a view that reads a changed route. A
page already open keeps the bundle it loaded until it is reloaded. On
14 Nov 2026 the Explorer's Sources view was broken between the OracleLaDataApi deploy (the page list moved to
`explorer.sourcePages`) and the OracleLaExplorerWeb deploy that reads it.

Rollback: deploy the stack again from the earlier commit, in a clean worktree with a frozen install, with the
same diff check. Run objects are never overwritten (section 5), so an earlier data API deploy finds its run's
files where it left them.

On an existing deployment, a new CRM Amplify app (a new app ID) needs no tracked-file change: RoofingCrmWeb
updates `/roofing-crm/web/app-id`, then OracleLaDataApi (CORS), OracleLaAgentApi (CORS) and OracleLaExplorerWeb
(CloudFormation recreates the branch on the new app) are deployed again, in that order.

Not exercised: the app ID has not changed since the Explorer branch was added, so this path, including CloudFormation recreating the branch on the new app, has not been run.

After any RoofingCrmWeb change, run both hosted suites, not only the CRM's. The app-level settings that
RoofingCrmWeb owns (the single-page rewrite rule, basic auth off at app level, the service role) apply to
the Explorer branch too.

## 4. Rebuild the data from the three caches

The file list and the build commands are in `docs/los-angeles-county-findings.md` section 13. The build reads three
caches outside the repository (the roll cache and the two LADBS caches, permits and contractors) and the latest
recorded run's Parquet files in `data/out/`. The full sequence, with the LADBS downloads, is:

```
pnpm install --frozen-lockfile
node src/scope-guard.ts config/la-county-permits-run.json
node scripts/fetch-roll.mjs <roll-cache-dir>        # network: the whole roll, 2,429 pages, one request every 2 s or slower (at least 81 minutes)
node scripts/ladbs-permits/fetch.mjs <ladbs-permits-cache-dir>         # network: see scripts/README.md
node scripts/ladbs-permits/fetch.mjs summarize <ladbs-permits-cache-dir>
node scripts/ladbs-contractors/fetch.mjs <ladbs-contractors-cache-dir> --license-read-at <time>
node scripts/ladbs-contractors/fetch.mjs summarize <ladbs-contractors-cache-dir> <ladbs-permits-cache-dir>
cp scripts/ladbs-permits/fetch.mjs <ladbs-permits-cache-dir>/
cp scripts/ladbs-contractors/fetch.mjs <ladbs-contractors-cache-dir>/
KIT_DIR=<kit checkout at 71b8341> node src/build-outputs.ts <roll-cache-dir> config/la-county-permits-run.json \
  --permit-cache <ladbs-permits-cache-dir> --contractor-cache <ladbs-contractors-cache-dir> --dry-run
```

- The build compares itself with the latest line of `runs/run_history.jsonl`: that run's Parquet files (the
  property Parquet and, for a permit run, the three permit Parquet files) must be in `data/out/<its run_id>/` with
  their recorded sha256 (`src/build-outputs.ts` (`recordedFile`, `relationTo`)). Without them the build stops, a
  dry run too. Building the latest run again also needs the files of the run before it. `data/` is not in the
  repository, so a fresh clone cannot build from the caches alone.
- The build hashes each LADBS cache's `fetch.mjs`, so copy `scripts/ladbs-permits/fetch.mjs` and
  `scripts/ladbs-contractors/fetch.mjs` into their caches after the downloads (`scripts/permit-run.ts`, section 4b,
  does this). Without them the build stops with a missing-file error.
- Review first: `--dry-run` builds the same files and computes the same run ID under
  `data/work/<run_id>/dry-run/`, and writes nothing under `runs/`, `data/out/` or `data/seeds/`. Read its run
  manifest (counts, joins, coverage, limitations) before the recorded build, which is the same command without
  `--dry-run`.
- The build verifies every cached page against its cache manifest, writes `data/out/<run_id>/` (gitignored)
  and `runs/<run_id>/run_manifest.json`, and appends one line to `runs/run_history.jsonl`. The recorded build
  also rewrites `data/seeds/los-angeles.csv`, by design; its digest is checked.
- `runs/` and `docs/evidence/` are tool records: commit what the tools wrote, never edit them by hand.
- The run ID is `<T>-b<D>` (findings section 14k). `<T>` is the latest `generated_at` of the input caches; `<D>` is the
  first 12 hex characters of the build digest, a sha256 over the four Parquet files' sha256 and the normalized
  run manifest's. So the latest recorded run, built again from the same caches and code, gets its ID again and
  adds no history line, and a dry run gives the recorded build's ID; any change to an output byte (a reworded
  limitation included) gives a new ID. An earlier recorded run built again would compare itself with the latest
  history line, not with the run before it, so its manifest and ID would differ (inferred from
  `src/build-outputs.ts` (`relationTo`); not run). The three runs before the 12 Nov rebuild run have IDs of a time
  alone and are never recomputed.
- A run is a rebuild (`run_kind` "rebuild", `rebuild_of` the earlier run, `source_changes` "none") only when
  every input digest equals the previous run's; otherwise it is "new data". The 12 Nov rebuild run
  `2026-11-12T14-00-51-383Z-bc7f18f2e9cf2` rebuilt the permits run from the same caches. A second rebuild,
  `2026-11-17T00-55-12-521Z-b1f1fbb377948`, rebuilt the 17 Nov run from the same caches after the run manifest's
  publication limitation was reworded. A rebuild run is not new data: it does not show ingestion over time. The
  three earlier history lines carry no run kind.
- Six runs are recorded (`runs/run_history.jsonl`): the pilot `2026-11-11T16-17-38-928Z`, the county run
  `2026-11-12T01-44-04-047Z`, the permits run `2026-11-12T14-00-51-383Z`, the 12 Nov rebuild run
  `2026-11-12T14-00-51-383Z-bc7f18f2e9cf2` (built 14 Nov), `2026-11-17T00-55-12-521Z-bcb7d21c21fe7`, new data from
  a fresh LADBS fetch (section 4b) with 260 more permits, and its rebuild `2026-11-17T00-55-12-521Z-b1f1fbb377948`
  (the same four Parquet files; the run manifest's publication limitation was reworded), which the data API serves.
- The history's `delta` counts parcels only: the 17 Nov new-data line reads added 0, removed 0, and its 260 new
  permits show in `row_counts` and in the Explorer's run history (Permits, Permit-to-parcel links).
- History lines are appended in `finished_at` order; a line not later than every recorded one is refused.
- Read the Parquet columns by name, never by position: the 12 Nov rebuild run added `land_base_year` and
  `ownership_base_year_10y_proxy` after `owner_unchanged_10y_proxy`, so every later property column moved two
  places, with its values unchanged (findings section 12).
- The 12 Nov rebuild run took 1 min 59 s and a peak of 2.46 GB of memory on 4 vCPUs; the 17 Nov run's real build
  1 min 57 s and 2.43 GB (`/usr/bin/time -v`). It also needs about 4 GB of disk under `data/work/` (3.78 GB for
  the 17 Nov build).
- The increment-1 and increment-4 run configs (`config/la-pilot-run.json`, `config/la-county-run.json`) no
  longer pass the scope guard: their permit-gate exceptions have expired (findings section 6a).

## 4b. A new permit run (fresh LADBS caches)

One command downloads both LADBS caches into new folders, summarizes them, compares them with the previous
run's caches, copies the fetch scripts in and builds the run. It runs on demand, by design: nothing schedules
it. It stops after the local build: it never commits, uploads or deploys, and each of those is a separate step a
person reviews.

```
KIT_DIR=<kit checkout at 71b8341> node scripts/permit-run.ts --roll-cache <roll-cache-dir> \
  --cache-root <folder for the new caches> --license-read-at <when the contractor view's license was read> \
  --previous <previous permit cache> <previous contractor cache>          # dry run only
# the same with --real: data/out/<run_id>/, runs/<run_id>/run_manifest.json, one line in runs/run_history.jsonl
```

- It stops before the build when a cache's rows differ from the previous one's by more than 1%
  (`--max-change-pct`) or a column is new or missing.
- `--from-caches <permit cache> <contractor cache>` rebuilds from caches on disk without any download;
  `--reuse-contractor-cache <dir>` downloads the permits only. A cache on disk is never written to.
- `--plan` prints the steps without running any. After a real build it prints the separate next steps: check,
  commit `runs/`, upload (section 5), deploy (section 3).

## 5. Upload a run (no-overwrite)

A run has six objects under `runs/<run_id>/` in the data API's bucket: the property Parquet, the three permit
Parquet files, the run manifest and the run history. The API stack reads the permit files from the latest
history line's `permit_files` (`apps/api/cdk/bin/app.ts`) and refuses a latest line without them. On an existing
deployment, upload all six objects before deploying OracleLaDataApi: the first cold start after the deploy reads
them. On an empty account the bucket exists only after the first deploy, so the upload follows it (steps 3 and 4
of section 3). Read the bucket name from the stack output when you upload; no
bucket name is kept in the repository.

```
RUN=<run_id>
BUCKET=$(aws cloudformation describe-stacks --stack-name OracleLaDataApi --region eu-north-1 \
  --profile <your profile> --query "Stacks[0].Outputs[?OutputKey=='DataBucket'].OutputValue" --output text)
put() { aws s3api put-object --bucket "$BUCKET" --key "runs/$RUN/$1" --body "$2" --if-none-match '*' \
  --region eu-north-1 --profile <your profile>; }
for f in los-angeles_property_roll2026 los-angeles_ladbs_permits los-angeles_ladbs_permit_parcels \
  los-angeles_ladbs_permit_contractors; do put "$f.parquet" "data/out/$RUN/$f.parquet"; done
put run_manifest.json "runs/$RUN/run_manifest.json"
put run_history.jsonl runs/run_history.jsonl
```

- `--if-none-match '*'` refuses to overwrite an existing object (`PreconditionFailed`), so an uploaded run
  never changes. This upload is for the data API; the IPFS publication is section 9.
- The file names must match the base names of `parquet_path` and the `permit_files` paths in the run's history
  line. The API reads them from `PARQUET_FILE` and `PERMIT_FILES` and checks every sha256 on each cold start.
- List the prefix before and after, and read each object back and compare its sha256 with the run's history
  line (`parquet_sha256`, `permit_files[].sha256`, `manifest_sha256`).

## 6. Tests

- Unit and synthetic tests (Vitest), formatting, lint and types:

  ```
  pnpm test
  pnpm run typecheck && pnpm run lint && pnpm run format
  ```

  Without `data/`, the real-data checks in `apps/api/test/routers.test.ts` and
  `apps/agent-mcp/test/real-data.test.ts` are skipped; a banner from `apps/api/test/routers.test.ts` says how
  many of its checks were skipped and why (27), and the 21 of `real-data.test.ts` show only in Vitest's skipped
  count. On
  18 Nov 2026, at commit 5647bde: 1,333 tests, 1,285 passed, 0 failed and 48 skipped without `data/`; the 48 are
  those two files' tests (27 and 21), which run when the served run's files are in `data/`. The CRM repository's,
  at b5f7b14: 173 of 173.

- With the latest run's Parquet in `data/out/<run_id>/`, make missing data a failure instead of a skip:

  ```
  REQUIRE_REAL_DATA=1 pnpm test
  ```

- Hosted suites (Playwright) take their inputs only from the environment, never from `.secrets/`: the site
  URL and its basic-auth user and password. The API token comes from the hosted `config.json`.
  - The CRM suite runs in the CRM repository (`CRM_URL`, `CRM_USER`, `CRM_PASS`); see its runbook.
  - The Explorer suite runs from `apps/explorer`. Its only inputs are `EXPLORER_URL` (the OracleLaExplorerWeb
    `Origin` output), `EXPLORER_USER` and `EXPLORER_PASS` (the basic-auth values in `.secrets/explorer.json`):

    ```
    pnpm exec playwright install chromium     # once: downloads the browser
    EXPLORER_URL=<Origin output> EXPLORER_USER=<basic-auth user> EXPLORER_PASS=<basic-auth password> pnpm exec playwright test
    ```

    Tests run in order and stop at the first failure; `PW_SERIAL=0` runs them independently. Traces and
    screenshots are kept for failed tests.

  - Before the hosted suites, warm the data API to three instances: send three `explorer.sources` requests at
    once, with the site's API token, and repeat until each answers in about 1 s. No tracked script does this.
    The reason: when "Ask the agent" opens, the page's warm-up sends two data API requests while the page's own
    request can still be in flight, so three can arrive together. Tests that wait 5 s for a mocked answer are
    shorter than the page's hold of a question, up to 20 s by design (`HOLD_MAX_MS` in
    `apps/explorer/src/warmup.ts`), and a data API instance that starts cold took 6.6 to 6.9 s per request, a warm
    one about 1 s (measured 18 Nov 2026). This is not changed.
  - On 18 Nov 2026, against the deployed code (data API 5647bde, the Explorer built at 5647bde, whose page shows
    a1ade35, the last commit that changed its sources, the agent ebdcf61 and the CRM b5f7b14), the Explorer suite
    passed 24 of 24 on its second run; the first stopped at test 11 while the page was still waking the data API
    (14 passed, 9 not run). The CRM suite passed 51 of 51 on its third run, started straight after warming the
    data API to three instances. Its first run stopped at test 37 at tablet width (44 passed, 6 not run; no cold
    start was seen), its second at test 28 (36 passed, 14 not run). During the waits of the Explorer's test 11
    and the CRM's test 28 a new data API instance was starting cold. The cause of the three stops is not proven.
  - Run the Explorer suite from the commit that was deployed: it reads this checkout's `runs/publications.jsonl`
    (test 6) and `packages/agent/src/tools.ts` (the tool names). Build and deploy from a clean checkout: the
    Explorer build and the agent synth append "-dirty" to the commit they stamp when their source paths have
    uncommitted changes, and test 15b fails on a "-dirty" Explorer commit.

  - No test sends a request to `/agent/answer`: that would be a model call. The "Ask the agent" tests mock it
    with recorded-shape answers, and a catch-all aborts and fails any request to it that no mock answered
    (`apps/explorer/e2e/explorer.spec.ts`). The panel may call the real `GET /agent/warm` and the data API.
  - Rule for hosted checks: send at most 4 data API requests at once (the data API's reserved concurrency is 5;
    its stage throttle is 10 requests a second with a burst of 20, `apps/api/cdk/lib/data-api-stack.ts`).

- The agent eval runs the agent against a real model on the prompts in `apps/agent-mcp/eval/prompts.json` and
  checks every answer. It calls a paid API, so it is not part of `pnpm test`: run it by hand, with a spend
  limit. How to run it is in [apps/agent-mcp/README.md](../apps/agent-mcp/README.md) ("Eval"): the command and
  its options, `--key-file` (required with `--provider anthropic`: the path of the key file, which must have mode
  `0600`; there is no default path, and the key is never an argument or an environment variable), `--repo` (the
  checkout that has the run's `data/` files), `--out` (outside any checkout), `--max-usd`, the outputs and the
  exit codes. The demo model is Sonnet 5.5 (`--model sonnet-5.5`) with effort low (`AGENT_EFFORT`, default `low`)
  and no thinking parameter:

  ```
  node apps/agent-mcp/scripts/eval-demo.ts --provider anthropic --model sonnet-5.5 --key-file <key-file> \
    --repo <checkout> --out <folder outside any checkout> --runs 3 --max-usd 5
  ```

  The prompts file has twenty-five prompts; a round runs each three times, 75 answers. A check fails an answer
  only on what the tool calls, the tool results or the answer's structured fields verify; a check that only tests
  how the prose words or places something gives a listed warning, never a failure. A wrong statement in the prose
  that none of the fifteen checks covers is not caught (`apps/agent-mcp/src/eval/checks.ts` (`CHECK_NAMES`)). The
  latest round, on 17 Nov 2026 with the served run's data (`2026-11-17T00-55-12-521Z-b1f1fbb377948`) and the
  agent code at commit ebdcf61, the code the hosted agent runs, passed 75 of 75 ($0.8835), with nine listed warnings, all on
  wording or placement. The last round on the earlier twenty-one prompts (17 Nov 2026, 63 answers) passed 62 of 63 as run
  ($0.7901) and 63 of 63 when re-checked after the `stated_counts` check was corrected (commit fcd573b).

## 7. The hosted agent: live checks and how to stop it

- A question to the hosted agent is a model call and spends money: the live checks are run by hand, from the
  two sites' "Ask the agent" panels. Measured costs are in [metrics.md](metrics.md) ("Agent").
- The agent's log line records counts, timings and the spend estimate of each answer, never the question's
  words (`apps/agent-api/src/log.ts`).
- The Explorer page's footer, once the "Ask the agent" tab has been opened, and `GET /agent/warm` (with the
  site's token) show the commit of the agent code the hosted agent runs, computed at build time from the agent's
  own source paths.
- Counts to compare each answer with (the Explorer's screens at the same center, radius and threshold; the CRM's "Long-open roofing permits" list also applies the roof-age threshold and shows 1,945 permits there at 15 years), on the served run
  `2026-11-17T00-55-12-521Z-b1f1fbb377948`, at the agent's Van Nuys center (34.20155, -118.45361), 5 miles:
  115,169 parcels with roofs older than 15 years, and 2,317 long-open roofing permits (at least 1,826 days), of
  which 2,047 were issued within the contractor window, 2013-01-02 to 2023-05-19 (at most 5,067 days open at the run's reference date, 2026-11-17). On
  the 12 Nov rebuild run they were 115,373, 2,309 and 2,039.
- Why 204 fewer aged roofs: 46 roofing permits went from Issued to Permit Finaled in the City's 2020-to-present
  permit set (refreshed 16 Nov 2026, 17:07 UTC), which set 204 parcels' roof year to 2026; two building-level
  apartment permits, 26016-90000-20031 and 26016-90000-20027 (finaled 10 Nov 2026), cover 160 of them. Across
  the City the run has 260 more permits (297,169), 608,168 permit-parcel links (607,702 before), 280,056 parcels
  with permits (279,900 before) and no parcel added or removed.
- The CRM at 34.20008, -118.48111, 1 mile, on the 12 Nov rebuild run (browser check of 15 Nov 2026): 3,948
  parcels with roofs older than 15 years, 144 of them marked with a long-open roofing permit. On the served run
  the same rule gives 3,946 and 144 (counted on its Parquet files).
- To stop the agent at once, do either or both:
  - revoke the hosted agent's key in the Anthropic Console: its model calls are then refused, so no answer can
    spend (nothing else uses that key);
  - set the function's reserved concurrency to 0, which refuses every request to the agent API:

    ```
    aws lambda put-function-concurrency --function-name <OracleLaAgentApi's AgentApi function> \
      --reserved-concurrent-executions 0 --region eu-north-1 --profile <your profile>
    ```

    This is a change outside CDK. Set it back with the same command and `--reserved-concurrent-executions 2`
    (the stack's value, `apps/agent-api/cdk/lib/agent-api-stack.ts` (`AgentApiStack`,
    `reservedConcurrentExecutions`)); a deploy that does not change the function may leave it at 0. This stop and
    its reset have not been run.
- A new key: create it in the Anthropic Console and replace the value of `/oracle-la/agent/anthropic-api-key` in
  the AWS Console. Each execution environment reads the value once and keeps it in memory for its life
  (`apps/agent-api/src/secrets.ts`), so environments started before the change keep the old key until Lambda
  retires them; revoke the old key so that they fail instead of answering with it.

## 8. Teardown (reverse order, across both repositories)

| #   | Stack               | Repo     | Why this order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OracleLaExplorerWeb | pipeline | From `apps/explorer`: `pnpm exec cdk destroy OracleLaExplorerWeb --profile <your profile>`. It deletes the `explorer` branch. First, because destroying RoofingCrmWeb deletes the Amplify app with every branch on it, the Explorer's included, and would leave this stack holding a branch that no longer exists.                                                                                                                                                                                                                                                                                                                                       |
| 2   | OracleLaAgentApi    | pipeline | From `apps/agent-api`: `pnpm exec cdk destroy OracleLaAgentApi -c dataApiUrl=<ApiUrl output> --profile <your profile>`. It removes the agent function, its HTTP API, its log group, its three alarms and its permission on the shared authorizer. Before OracleLaDataApi, because that permission sits on the authorizer function, whose ARN is read from SSM at deploy time: CloudFormation shows no dependency that would stop you. Then delete the two SecureStrings (`aws ssm delete-parameter --name <parameter> --region eu-north-1 --profile <your profile>`, once for each; it needs only the name) and revoke the key in the Anthropic Console. |
| 3   | RoofingCrmLeads     | CRM      | It imports RoofingCrmWeb's origin and holds the permission on this repository's authorizer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4   | RoofingCrmMapKey    | CRM      | It imports RoofingCrmWeb's origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | RoofingCrmWeb       | CRM      | Its `Origin` export is no longer imported, and no branch of another stack is left on its app. It also deletes `/roofing-crm/web/app-id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | OracleLaDataApi     | pipeline | `pnpm exec cdk destroy OracleLaDataApi --profile <your profile>`. The bucket is created with `autoDeleteObjects` (`data-api-stack.ts` (`DataApiStack`, bucket `Data`)), so its objects are deleted with it.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7   | OracleLaGuards      | pipeline | `pnpm exec cdk destroy OracleLaGuards --profile <your profile>`. Last, because the stacks above read its alert-topic parameter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The leads table survives step 3 on purpose: it is RETAIN with deletion protection. It is deleted separately,
as described in the CRM runbook.

If the CRM is torn down while this repository's stacks stay, destroy OracleLaExplorerWeb first. Without
`/roofing-crm/web/app-id`, the next OracleLaDataApi deploy fails before changing anything: either deploy
RoofingCrmWeb again (a new app ID; then deploy OracleLaDataApi, OracleLaAgentApi and OracleLaExplorerWeb again),
or remove the `amplifyBranch` clients from `apps/api/cdk/clients.json`. OracleLaAgentApi needs both browser
clients, so without them it is destroyed first.

Not exercised: destroying OracleLaExplorerWeb after its Amplify app is gone has not been run. CloudFormation is expected to find the branch already deleted and finish, but this is untested.

## 9. Publication to IPFS

"Publication" and "published" in this repository mean the IPFS publication only. Two runs are published: the
12 Nov rebuild run `2026-11-12T14-00-51-383Z-bc7f18f2e9cf2` and the served run
`2026-11-17T00-55-12-521Z-b1f1fbb377948`, both on 18 Nov 2026 (`runs/publications.jsonl`). What is published:

- once, two Parquet objects of the County roll: the roll extract (`los-angeles-roll2026-county.parquet`, every
  parcel of the 2026 roll) and a 5-mile sample of it (`los-angeles-roll2026-sample-5mi.parquet`, the 151,748
  parcels within 5 miles of 34.20155, -118.45361). The sample exists so that the demo's fetch and query run in
  seconds;
- per run, the publish folder, which holds one file, `coverage.json` (counts, the sample's circle and row count,
  and the two sources with their download times, page digests and terms-of-use addresses), and the run's artifact
  manifest, which lists the folder, `coverage.json` and the two Parquet objects, each with `cid`, `name`, `size`,
  `codec`, `ipld_codec` and `sha256`.

Only County roll data is published. No permit or contractor row is: the City's building-permit sets state no
license, and the contractor view, though CC BY 4.0, is held back, because some of its business names may be
personal names and a publication cannot be withdrawn. One pinning service pins the files, on its free plan, at
$0 (confirmed 18 Nov 2026); a second copy at another service is a next step, not built. Nothing re-checks later
that the files stay pinned or retrievable: the gateway check below is run by hand.

`runs/<run_id>/publication/` holds, per published run, the artifact manifest (`artifact-manifest.json`) and its
CAR, the publish folder (`publish/`) and its CAR (`directory.car`), and the build record (`directory.json`: the
folder's CID, its file, its CAR's size and SHA-256, the manifest's CID and CAR, and the publish guard's result).
The two Parquet objects and their CARs are not in the repository. Their identifiers (name, size, SHA-256 and
CID) are in each artifact manifest and in `src/publish-named-objects.ts`; the build that made the two files is
not in the repository either.

### Build

The publication of recorded runs is built locally, with no IPFS node and no network:

```
node src/build-ipfs-artifacts.ts --config config/la-county-permits-run.json \
  --object <los-angeles-roll2026-county.parquet> --object <los-angeles-roll2026-sample-5mi.parquet> \
  [--source <folder with runs/ and data/out/>] [--out data/ipfs] <run_id> ...
```

- It reads each run's `runs/<run_id>/run_manifest.json` and, in `data/out/<run_id>/`, its property Parquet and
  its permits Parquet, and checks their size, SHA-256 and row counts against the run manifest. These are the files
  of the run's own build: keep them (section 4 builds only the latest recorded run again under its ID). The two
  `--object` files are given files: the publish guard passes a Parquet file only when its name, size and SHA-256
  are those in `src/publish-named-objects.ts`.
- Per run it writes, under `<out>/runs/<run_id>/`, the publish folder, `directory.car`, `artifact-manifest.json`,
  `artifact-manifest.car` and `directory.json`; once, under `<out>/objects/`, each Parquet object and its CAR,
  and `<out>/objects.json`. A rebuild gives identical bytes, and so the same CIDs.
- It exits 1 when the guard refuses anything or a scan of the JSON files hits.
- A run that is to be published has the five entries of `<out>/runs/<run_id>/` copied by hand to
  `runs/<run_id>/publication/` and committed: the folder the gateway check and the record step read. The six CARs
  to upload are `<out>/objects/<name>.car` for the two Parquet objects and, per run, `directory.car` and
  `artifact-manifest.car`.

### Upload (by a person, from their own terminal)

Nothing in the repository uploads. The upload is done by hand to an S3-compatible pinning service that imports
CAR files:

- Upload the six CARs, never the plain files, so that the service keeps the CIDs. Each CAR goes up as one single
  request, never a multipart upload, with the service's CAR import.
- Go in dependency order: the two Parquet CARs (the sample first), then the two folder CARs, then the two
  manifest CARs, so that a manifest is public only after everything it lists is up.
- After each upload, compare the CID the service reports with the expected one: the Parquet objects' in
  `src/publish-named-objects.ts`, the folder's `directory_cid` and the manifest's `artifact_manifest.cid` in the
  run's `directory.json`. On any other answer, delete that object and stop.
- Before the folder CARs go up, fetch both Parquet files from the two counted gateways (below) and compare size
  and SHA-256, so the large files are known to be retrievable before anything that lists them is public.
- Recent AWS CLI versions add CRC checksums to every upload by default, which an S3-compatible service may not
  accept: set the CLI's request checksum calculation and response checksum validation to `when_required` for the
  pinning service's credentials, and keep those credentials apart from the AWS ones.

On 18 Nov 2026 the six CARs were uploaded to Filebase, 13:12-13:19 UTC, and every reported CID was the expected
one.

### Gateway check

From the repository root, for each run (the proof folder is a folder of your choice, outside the repository):

```
node src/gateway-verify.ts runs/<run_id>/publication <proof folder> --pinned-by <the pinning operator>
```

- It fetches by GET, from every gateway of the list in `src/gateways.ts`, in path form
  (`https://<host>/ipfs/<cid>`): the artifact manifest by its CID, every file it lists by its CID, and the folder
  twice, as the gateway's own CAR of it and as its files by path, rebuilt into a CAR; and it compares size and
  SHA-256 with the manifest.
- Which gateways count: those whose operator does not pin the content. A pinning operator's gateway reads from
  that service's own storage and shows only that the vendor holds the bytes, so its answers are reported and never
  counted (`--pinned-by`, required). The default list is ipfs.aleph.cloud (Aleph.im), gateway.pinata.cloud
  (Pinata) and ipfs.filebase.io (Filebase); with `--pinned-by Filebase`, ipfs.aleph.cloud and
  gateway.pinata.cloud count. ipfs.io and dweb.link, the gateways the assignment gives as examples, answer
  non-browser requests with HTTP 429 (that access was retired on 21 Sep 2026) and are not listed.
- Who pins and who runs each gateway are declared, never checked: the pinning operator by the person running the
  check (`--pinned-by`), the gateway operators by `src/gateways.ts`, `--gateway` or `IPFS_GATEWAYS`. With one
  pinning operator, the default list leaves two counted operators, so one failing gateway fails the check.
- It passes (PASS, exit 0) only when the manifest, every listed file and the folder (both ways) match on
  gateways of at least two counted operators, and no gateway returns other bytes for the folder's file. FAIL
  exits 1, a refused setup 2; INCOMPLETE (exit 3, `--skip-manifest-fetch`) is never a pass.
- Another list comes through `--gateway host=Operator` (repeatable) or `IPFS_GATEWAYS`; every gateway must
  declare its operator, https only, with no loopback, private or link-local address in the host. It does not
  resolve host names, so a name that resolves to a local address is not caught. A replaced list is stated in the
  verdict line and the proof.
- Each answer may take 60 s plus 1 s per 131,072 bytes of its expected size; a failed or mismatching answer is
  fetched again, up to 5 attempts, after 15, 30, 60 and 120 s. A first fetch of a cold object can take minutes:
  on 18 Nov 2026 one small file needed 4 attempts on one gateway: 184 s of fetching and, with the waits, about
  289 s.
- It writes `gateway-check-<run_id>.json` and `.txt` in the proof folder, with the verdict line first and every
  gateway's result for every object.

On 18 Nov 2026 the check passed for both runs (13:26-13:34 UTC, `--pinned-by Filebase`, the default list):
every object matched on ipfs.aleph.cloud and gateway.pinata.cloud. The proof files of that day are not in the
repository; anyone can run the check again with the command above.

### Record

A run whose check passed is recorded from the repository root:

```
node scripts/record-publication.ts --proof <proof folder>/gateway-check-<run_id>.json \
  <run_id> <manifest CID> <folder CID> [published_at]
```

- It requires a passing proof for the same run: it refuses a missing or unreadable proof, one that is not a
  PASS, did not fetch the manifest, was made with the test-only local gateways or names no pinning operator, and
  one that names another run ID, manifest CID or folder CID.
- It also refuses a run that is not in `runs/run_history.jsonl` or is already recorded, a manifest or folder CID
  other than those in `runs/<run_id>/publication/directory.json`, a CID that is not CIDv1 base32, and a
  `published_at` that is not a UTC date or time (without it, the current time). It writes nothing when it refuses.
- It records a run once: there is no path for a correction or for a second pinning service, and a line holds
  only the run ID, the two CIDs and `published_at` (no service, gateway, uploader or proof digest).
- It appends one line to `runs/publications.jsonl`, checks that only that line was added, prints it and never
  commits. The Explorer bundles the file at build, so the line shows in "Run summary" ("Published (identifier)")
  only after steps 11 and 12 of section 3, and then the hosted Explorer suite.

### Recorded texts that stay as they are

`runs/` holds tool records, which are never edited. Some were written before the publication and stay:

- The 12 Nov rebuild run's manifest says that its data files are not published and that republication rights
  are not confirmed. It was published on 18 Nov 2026 with that text in its manifest; the served run's manifest
  states the roll's terms of use instead.
- Every line of `runs/run_history.jsonl` says `"published": false`. The flag is written at build and never
  changes; whether a run is published is in `runs/publications.jsonl`.
- The run manifests' file roles call the property and permit tables "publishable … (publish only after user
  approval and rights check)". The wording dates from before the terms were read and the build still writes it
  (`src/build-outputs.ts`); only the roll extract was approved.
- The history's `delta` counts parcels only (section 4).

A manifest records what was true when its run was built.
