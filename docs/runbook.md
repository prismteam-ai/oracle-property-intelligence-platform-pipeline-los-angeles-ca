# Runbook: build, deploy, test and tear down (pipeline repository)

This repository holds the data pipeline (the county build), the hosted data API (stacks OracleLaGuards and
OracleLaDataApi) and the Explorer app (stack OracleLaExplorerWeb). The Explorer is hosted as a second
branch, `explorer`, of the CRM's Amplify app, because the account allows one Amplify app
([kit-deviations.md](kit-deviations.md), row 16). The Roofing CRM lives in the CRM repository
(roofing-crm); its `docs/runbook.md` covers the CRM stacks. The two runbooks describe one deploy order,
written from the code: every step names the file that makes it necessary.

Related: [kit-deviations.md](kit-deviations.md), [access-rules.md](access-rules.md),
[glossary.md](glossary.md), [metrics.md](metrics.md) and the findings
[los-angeles-county-findings.md](los-angeles-county-findings.md).

## 1. Prerequisites

- Node.js 22.18 or later (`package.json` `engines`), which runs the TypeScript files directly.
- pnpm 12.16.1 from the `packageManager` field: `corepack enable pnpm`, then `pnpm install --frozen-lockfile`.
- The AWS CDK CLI comes from the workspace (`aws-cdk` 2.1146.1 in `apps/api/package.json` and
  `apps/explorer/package.json`); run it as `pnpm exec cdk` from `apps/api` for the data API stacks and
  from `apps/explorer` for OracleLaExplorerWeb. No global install is needed.
- The AWS CLI v2, recent enough for `aws s3api put-object --if-none-match` (the run upload), with a profile
  for the target account. Every command below takes `--profile <your profile>`; you can set `AWS_PROFILE`
  instead. The region is fixed in code to eu-north-1 (`apps/api/cdk/bin/app.ts` (`env`)).
- The CDK app reads the account from `CDK_DEFAULT_ACCOUNT`, which the CDK CLI sets from the profile; it
  fails if it is unset (`apps/api/cdk/bin/app.ts` (`account`)). The account must be bootstrapped once:
  `pnpm exec cdk bootstrap aws://<account id>/eu-north-1 --profile <your profile>`.
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
table first.

## 2. Secrets (gitignored `.secrets/`, never committed or printed)

| File                        | Created by                | Holds                                                                                                                                                                                                                        | Read by                                                                                                                                                                                                        |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.secrets/explorer.json`    | `node scripts/secrets.ts` | Explorer basic-auth user and password, its API token and the token's sha256                                                                                                                                                  | `apps/explorer/cdk/bin/app.ts` (`secrets`: the branch's basic auth); `scripts/write-explorer-config.ts` (`apiToken` in the Explorer's `config.json`); the Explorer suite's `EXPLORER_USER` and `EXPLORER_PASS` |
| `.secrets/api-clients.json` | by hand                   | `{ "crm": { "tokenSha256": "<apiTokenSha256 from the CRM repo's .secrets/crm.json>" }, "explorer": { "tokenSha256": "<apiTokenSha256 from .secrets/explorer.json>" } }`: one entry per client in `apps/api/cdk/clients.json` | `apps/api/cdk/bin/app.ts` (`hashes`, `apiClients`); the deploy fails if a client has no hash                                                                                                                   |
| `.secrets/alerts.json`      | by hand, optional         | `{ "alertEmail": "<the alert address>" }`                                                                                                                                                                                    | `apps/api/cdk/bin/app.ts` (`alertsFile`, `alertEmail`); without it the alert topic has no email subscription                                                                                                   |

- The CRM's token is created in the CRM repository (`scripts/secrets.ts` there writes `.secrets/crm.json`,
  with `apiToken` and `apiTokenSha256`). Only the sha256 crosses into this repository. The Explorer's token
  is created here, in `.secrets/explorer.json`; copy its `apiTokenSha256` into the `explorer` entry by hand,
  without printing it. OracleLaDataApi stores each hash as an SSM parameter under
  `/oracle-la/api/clients/<client>/token-sha256`, and the token authorizer compares hashes
  (`apps/api/src/authorizer.ts`).
- The alert address subscribes by email to the alert topic. Its owner must confirm the subscription once.
- The CRM's map key and its `config.json` are covered in the CRM runbook.

## 3. Deploy order across both repositories

Each stack's inputs come from the stacks before it. This is the order for an empty account. Pipeline steps
are run here (`apps/api` for the data API stacks, `apps/explorer` for the Explorer); CRM steps are in the
CRM repository's `docs/runbook.md`. RoofingCrmWeb is deployed twice: first to create the Amplify app and
publish its ID, which the data API and the Explorer read; then again with the site's `config.json`, which
needs the data API and the leads API.

| #   | Step                                                                                                                                  | Repo     | Needs (and where that comes from)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm exec cdk deploy OracleLaGuards --profile <your profile>`                                                                        | pipeline | Optional `.secrets/alerts.json`. Creates the alert topic `oracle-la-alerts`, the SSM parameter `/oracle-la/alerts/topic-arn` (`guards-stack.ts` (`GuardsStack`, parameter `AlertTopicArn`)) and the $5 monthly budget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | Build the CRM site, then deploy RoofingCrmWeb (first deploy, without `config.json`)                                                   | CRM      | `.secrets/crm.json`. Creates the Amplify app `roofing-crm` with its `main` branch and publishes the app ID as the SSM parameter `/roofing-crm/web/app-id` (CRM `apps/crm/cdk/lib/crm-web-stack.ts` (`APP_ID_PARAM`)). Outputs `Origin`. Until step 8 the site loads but shows a `config.json` error. Not exercised: this first deploy without `config.json` has not been run. RoofingCrmWeb synthesizes from a site without `config.json` (checked 13 Nov 2026); it has not been deployed this way.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3   | `pnpm exec cdk deploy OracleLaDataApi --profile <your profile>`                                                                       | pipeline | The alert topic from step 1, read from SSM (`data-api-stack.ts` (`DataApiStack`, the alert topic read from `ALERT_TOPIC_PARAM`)). `apps/api/cdk/clients.json`: each client's origin is a branch of the Amplify app named by `amplifyAppIdParameter`, `/roofing-crm/web/app-id` from step 2, read at deploy time (`apps/api/cdk/lib/clients.ts` (`clientOrigin`), `data-api-stack.ts` (`DataApiStack`, `HttpApi` `corsPreflight`)). `.secrets/api-clients.json` (token hashes). The latest line of `runs/run_history.jsonl` (`bin/app.ts` (`history`, `latest` and the `DataApiStack` props)): run ID, Parquet sha256 and file name. Synth builds the DuckDB layer with `pnpm` (`data-api-stack.ts` (`DataApiStack`, the `layer` run before `DuckDbLayer`)). Outputs `ApiUrl`, `DataBucket` and `DataPrefix`, and writes `/oracle-la/api/authorizer-arn` (`data-api-stack.ts` (`DataApiStack`, parameter `AuthorizerArn`)). |
| 4   | Upload the run's files (section 5)                                                                                                    | pipeline | The `DataBucket` output of step 3. The API reads the files on its first request after a cold start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 5   | Deploy RoofingCrmMapKey with `-c alertTopicParam=/oracle-la/alerts/topic-arn`                                                         | CRM      | `Origin` of step 2 (cross-stack reference) and the SSM parameter of step 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6   | Deploy RoofingCrmLeads                                                                                                                | CRM      | `/oracle-la/api/authorizer-arn` from step 3 and `/oracle-la/alerts/topic-arn` from step 1 (both read from SSM), and `Origin` of step 2. It creates its own permission to invoke this repository's authorizer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7   | From the CRM repository root: `AWS_PROFILE=<your profile> node scripts/write-config.ts apps/crm/dist`                                 | CRM      | The `ApiUrl` output of OracleLaDataApi and the `LeadsApiUrl` output of RoofingCrmLeads, read with the AWS CLI. The token and map key come from `.secrets/crm.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | Deploy RoofingCrmWeb again                                                                                                            | CRM      | The site with its `config.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 9   | `pnpm build`, then from this repository's root: `AWS_PROFILE=<your profile> node scripts/write-explorer-config.ts apps/explorer/dist` | pipeline | The `ApiUrl` output of OracleLaDataApi, read with the AWS CLI, and `apiToken` from `.secrets/explorer.json` (`scripts/write-explorer-config.ts`). Writes `apps/explorer/dist/config.json`, with no leads API URL and no map key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | From `apps/explorer`: `pnpm exec cdk deploy OracleLaExplorerWeb --profile <your profile>`                                             | pipeline | The site with its `config.json` (the `siteDir` default, `apps/explorer/cdk/bin/app.ts`), the basic-auth values from `.secrets/explorer.json`, and `/roofing-crm/web/app-id` from step 2, read at deploy time: `apps/explorer/cdk.json` sets `hostAppIdParameter` to it, so the stack creates only the `explorer` branch on that app (`apps/explorer/cdk/lib/explorer-web-stack.ts` (`ExplorerWebStack`)). Outputs `HostAppId` and `Origin`. With `-c hostAppIdParameter=` (empty), the stack creates its own Amplify app instead.                                                                                                                                                                                                                                                                                                                                                                                          |
| 11  | Run both hosted suites (section 6)                                                                                                    | both     | The Explorer and the CRM share the Amplify app's settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

For a new county run on an existing deployment, only steps 4 and 3 repeat, in that order. Upload the new
run under `runs/<new run id>/`, then deploy OracleLaDataApi, which points `RUN_ID`, `PARQUET_SHA256`,
`PARQUET_FILE` and `DATA_PREFIX` at it. The CRM and the Explorer need no deploy for new data.

On an existing deployment, a new CRM Amplify app (a new app ID) needs no tracked-file change: RoofingCrmWeb
updates `/roofing-crm/web/app-id`, then OracleLaDataApi (CORS) and OracleLaExplorerWeb (CloudFormation
recreates the branch on the new app) are deployed again, in that order.

Not exercised: the app ID has not changed since the Explorer branch was added, so this path, including CloudFormation recreating the branch on the new app, has not been run.

After any RoofingCrmWeb change, run both hosted suites, not only the CRM's. The app-level settings that
RoofingCrmWeb owns (the single-page rewrite rule, basic auth off at app level, the service role) apply to
the Explorer branch too.

## 4. Rebuild the data from the roll cache

The commands and file list are in `docs/los-angeles-county-findings.md` §13. In short:

```
pnpm install --frozen-lockfile
node src/scope-guard.ts config/la-county-run.json
node scripts/fetch-roll.mjs <roll-cache-dir>        # network: the whole roll, 2,429 pages, one request every 2 s or slower
KIT_DIR=<kit checkout at 71b8341> node src/build-outputs.ts <roll-cache-dir> config/la-county-run.json
```

- The build verifies every cached page against the cache manifest, writes `data/out/<run_id>/` (gitignored)
  and `runs/<run_id>/run_manifest.json`, and appends one line to `runs/run_history.jsonl`.
- `runs/` and `docs/evidence/` are tool records: commit what the tools wrote, never edit them by hand.
- Rebuilding a recorded run with the same Parquet adds no history line; the same run ID with a different
  Parquet fails.
- The county build took about 2 minutes and 2.2 GB of memory on 4 vCPUs. It also needs about 3 GB of disk
  under `data/work/`.

## 5. Upload a run (no-overwrite)

Three objects go under `runs/<run_id>/` in the data API's bucket. Read the bucket name from the stack
output when you upload; no bucket name is kept in the repository.

```
RUN=<run_id>
BUCKET=$(aws cloudformation describe-stacks --stack-name OracleLaDataApi --region eu-north-1 \
  --profile <your profile> --query "Stacks[0].Outputs[?OutputKey=='DataBucket'].OutputValue" --output text)
put() { aws s3api put-object --bucket "$BUCKET" --key "runs/$RUN/$1" --body "$2" --if-none-match '*' \
  --region eu-north-1 --profile <your profile>; }
put los-angeles_property_roll2026.parquet "data/out/$RUN/los-angeles_property_roll2026.parquet"
put run_manifest.json "runs/$RUN/run_manifest.json"
put run_history.jsonl runs/run_history.jsonl
```

- `--if-none-match '*'` refuses to overwrite an existing object (`PreconditionFailed`), so a published run
  never changes.
- The file name must match the base name of `parquet_path` in the run's history line. The API reads it from
  `PARQUET_FILE` and checks the sha256 on every cold start.

## 6. Tests

- Unit and synthetic tests (Vitest), formatting, lint and types:

  ```
  pnpm test
  pnpm run typecheck && pnpm run lint && pnpm run format
  ```

  Without `data/`, the real-data checks in `apps/api/test/routers.test.ts` are skipped, and a banner says how
  many were skipped and why.

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

- The agent eval runs the agent against a real model on the ten prompts in `apps/agent-mcp/eval/prompts.json`
  and checks every answer. It calls a paid API, so it is not part of `pnpm test`: run it by hand, with a spend
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

## 7. Teardown (reverse order, across both repositories)

| #   | Stack               | Repo     | Why this order                                                                                                                                                                                                                                                                                                     |
| --- | ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | OracleLaExplorerWeb | pipeline | From `apps/explorer`: `pnpm exec cdk destroy OracleLaExplorerWeb --profile <your profile>`. It deletes the `explorer` branch. First, because destroying RoofingCrmWeb deletes the Amplify app with every branch on it, the Explorer's included, and would leave this stack holding a branch that no longer exists. |
| 2   | RoofingCrmLeads     | CRM      | It imports RoofingCrmWeb's origin and holds the permission on this repository's authorizer.                                                                                                                                                                                                                        |
| 3   | RoofingCrmMapKey    | CRM      | It imports RoofingCrmWeb's origin.                                                                                                                                                                                                                                                                                 |
| 4   | RoofingCrmWeb       | CRM      | Its `Origin` export is no longer imported, and no branch of another stack is left on its app. It also deletes `/roofing-crm/web/app-id`.                                                                                                                                                                           |
| 5   | OracleLaDataApi     | pipeline | `pnpm exec cdk destroy OracleLaDataApi --profile <your profile>`. The bucket is created with `autoDeleteObjects` (`data-api-stack.ts` (`DataApiStack`, bucket `Data`)), so its objects are deleted with it.                                                                                                        |
| 6   | OracleLaGuards      | pipeline | `pnpm exec cdk destroy OracleLaGuards --profile <your profile>`. Last, because the stacks above read its alert-topic parameter.                                                                                                                                                                                    |

The leads table survives step 2 on purpose: it is RETAIN with deletion protection. It is deleted separately,
as described in the CRM runbook.

If the CRM is torn down while this repository's stacks stay, destroy OracleLaExplorerWeb first. Without
`/roofing-crm/web/app-id`, the next OracleLaDataApi deploy fails before changing anything: either deploy
RoofingCrmWeb again (a new app ID; then deploy OracleLaDataApi and OracleLaExplorerWeb again), or remove the
`amplifyBranch` clients from `apps/api/cdk/clients.json`.

Not exercised: destroying OracleLaExplorerWeb after its Amplify app is gone has not been run. CloudFormation is expected to find the branch already deleted and finish, but this is untested.
