# Runbook: build, deploy, test and tear down (pipeline repository)

This repository holds the data pipeline (the county build), the hosted data API (stacks OracleLaGuards and
OracleLaDataApi) and the Explorer app (code only, not deployed). The Roofing CRM lives in the CRM repository
(roofing-crm); its `docs/runbook.md` covers the CRM stacks. The two runbooks describe one deploy order,
written from the code: every step names the file that makes it necessary.

Related: [kit-deviations.md](kit-deviations.md), [access-rules.md](access-rules.md),
[glossary.md](glossary.md), [metrics.md](metrics.md) and the findings
[los-angeles-county-findings.md](los-angeles-county-findings.md).

## 1. Prerequisites

- Node.js 22.18 or later (`package.json` `engines`), which runs the TypeScript files directly.
- pnpm 12.16.1 from the `packageManager` field: `corepack enable pnpm`, then `pnpm install --frozen-lockfile`.
- The AWS CDK CLI comes from the workspace (`aws-cdk` 2.1146.1 in `apps/api/package.json`); run it as
  `pnpm exec cdk` from `apps/api`. No global install is needed.
- The AWS CLI v2, recent enough for `aws s3api put-object --if-none-match` (the run upload), with a profile
  for the target account. Every command below takes `--profile <your profile>`; you can set `AWS_PROFILE`
  instead. The region is fixed in code to eu-north-1 (`apps/api/cdk/bin/app.ts:14`).
- The CDK app reads the account from `CDK_DEFAULT_ACCOUNT`, which the CDK CLI sets from the profile; it
  fails if it is unset (`apps/api/cdk/bin/app.ts:9-13`). The account must be bootstrapped once:
  `pnpm exec cdk bootstrap aws://<account id>/eu-north-1 --profile <your profile>`.
- Telemetry off, in every shell that runs these tools:

  ```
  export CDK_DISABLE_CLI_TELEMETRY=true TURBO_TELEMETRY_DISABLED=1
  ```

- For the county build only: Python 3 and a checkout of the soofi-xyz team kit at commit 71b8341 (`KIT_DIR`).
  The build runs the kit's readiness validator and fails if that file's sha256 differs from the commit's.

Deploys keep CDK's default approval: run `pnpm exec cdk diff <stack> --profile <your profile>` first, read
its security-changes table, and answer the prompt `cdk deploy` shows when permissions change.

## 2. Secrets (gitignored `.secrets/`, never committed or printed)

| File                        | Created by                | Holds                                                                                                                                         | Read by                                                                               |
| --------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `.secrets/explorer.json`    | `node scripts/secrets.ts` | Explorer basic-auth user and password, its API token and the token's sha256                                                                   | `apps/explorer/cdk/bin/app.ts` (Explorer, not deployed)                               |
| `.secrets/api-clients.json` | by hand                   | `{ "crm": { "tokenSha256": "<apiTokenSha256 from the CRM repo's .secrets/crm.json>" } }`: one entry per client in `apps/api/cdk/clients.json` | `apps/api/cdk/bin/app.ts:22-33`; the deploy fails if a client has no hash             |
| `.secrets/alerts.json`      | by hand, optional         | `{ "alertEmail": "<the alert address>" }`                                                                                                     | `apps/api/cdk/bin/app.ts:50-54`; without it the alert topic has no email subscription |

- The CRM's token is created in the CRM repository (`scripts/secrets.ts` there writes `.secrets/crm.json`,
  with `apiToken` and `apiTokenSha256`). Only the sha256 crosses into this repository. OracleLaDataApi
  stores it as an SSM parameter under `/oracle-la/api/clients/<client>/token-sha256`, and the token
  authorizer compares hashes (`apps/api/src/authorizer.ts`).
- The alert address subscribes by email to the alert topic. Its owner must confirm the subscription once.
- The CRM's map key and its `config.json` are covered in the CRM runbook.

## 3. Deploy order across both repositories

Each stack's inputs come from the stacks before it. Pipeline steps are run here (`apps/api`); CRM steps
are in the CRM repository's `docs/runbook.md`.

| #   | Step                                                                                                                                  | Repo     | Needs (and where that comes from)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `pnpm exec cdk deploy OracleLaGuards --profile <your profile>`                                                                        | pipeline | Optional `.secrets/alerts.json`. Creates the alert topic `oracle-la-alerts`, the SSM parameter `/oracle-la/alerts/topic-arn` (`guards-stack.ts:62-65`) and the $5 monthly budget.                                                                                                                                                                                                                                                                                                                |
| 2   | `pnpm exec cdk deploy OracleLaDataApi --profile <your profile>`                                                                       | pipeline | The alert topic from step 1, read from SSM (`data-api-stack.ts:186`). `apps/api/cdk/clients.json` (CORS origins, `data-api-stack.ts:161`) and `.secrets/api-clients.json` (token hashes). The latest line of `runs/run_history.jsonl` (`bin/app.ts:35-62`): run ID, Parquet sha256 and file name. Synth builds the DuckDB layer with `pnpm` (`data-api-stack.ts:64`). Outputs `ApiUrl`, `DataBucket` and `DataPrefix`, and writes `/oracle-la/api/authorizer-arn` (`data-api-stack.ts:147-151`). |
| 3   | Upload the run's files (section 5)                                                                                                    | pipeline | The `DataBucket` output of step 2. The API reads the files on its first request after a cold start.                                                                                                                                                                                                                                                                                                                                                                                              |
| 4   | Build the CRM site, then deploy RoofingCrmWeb                                                                                         | CRM      | `.secrets/crm.json`. Outputs `Origin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | Deploy RoofingCrmMapKey with `-c alertTopicParam=/oracle-la/alerts/topic-arn`                                                         | CRM      | `Origin` of step 4 (cross-stack reference) and the SSM parameter of step 1.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | Set the `crm` entry's `origin` in `apps/api/cdk/clients.json` to the RoofingCrmWeb `Origin` output, then deploy OracleLaDataApi again | pipeline | Only when the origin changed (a new Amplify app). The data API's CORS then allows the CRM site. This is a tracked file: commit the change.                                                                                                                                                                                                                                                                                                                                                       |
| 7   | Deploy RoofingCrmLeads                                                                                                                | CRM      | `/oracle-la/api/authorizer-arn` from step 2 and `/oracle-la/alerts/topic-arn` from step 1 (both read from SSM), and `Origin` of step 4. It creates its own permission to invoke this repository's authorizer.                                                                                                                                                                                                                                                                                    |
| 8   | `node scripts/write-config.ts apps/crm/dist`                                                                                          | CRM      | The `ApiUrl` output of OracleLaDataApi and the `LeadsApiUrl` output of RoofingCrmLeads, read with the AWS CLI. The token and map key come from `.secrets/crm.json`.                                                                                                                                                                                                                                                                                                                              |
| 9   | Deploy RoofingCrmWeb again                                                                                                            | CRM      | The site with its `config.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

For a new county run on an existing deployment, only steps 3 and 2 repeat, in that order. Upload the new
run under `runs/<new run id>/`, then deploy OracleLaDataApi, which points `RUN_ID`, `PARQUET_SHA256`,
`PARQUET_FILE` and `DATA_PREFIX` at it. The CRM needs no deploy for new data.

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
  - The Explorer suite (`apps/explorer/e2e/`, inputs `EXPLORER_URL`, `EXPLORER_USER`, `EXPLORER_PASS`) needs
    the Explorer deployed, which it is not.

## 7. Teardown (reverse order, across both repositories)

| #   | Stack            | Repo     | Why this order                                                                                                                                                                 |
| --- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | RoofingCrmLeads  | CRM      | It imports RoofingCrmWeb's origin and holds the permission on this repository's authorizer.                                                                                    |
| 2   | RoofingCrmMapKey | CRM      | It imports RoofingCrmWeb's origin.                                                                                                                                             |
| 3   | RoofingCrmWeb    | CRM      | Its `Origin` export is no longer imported.                                                                                                                                     |
| 4   | OracleLaDataApi  | pipeline | `pnpm exec cdk destroy OracleLaDataApi --profile <your profile>`. The bucket is created with `autoDeleteObjects` (`data-api-stack.ts:59`), so its objects are deleted with it. |
| 5   | OracleLaGuards   | pipeline | `pnpm exec cdk destroy OracleLaGuards --profile <your profile>`. Last, because the stacks above read its alert-topic parameter.                                                |

The leads table survives step 1 on purpose: it is RETAIN with deletion protection. It is deleted separately,
as described in the CRM runbook.
