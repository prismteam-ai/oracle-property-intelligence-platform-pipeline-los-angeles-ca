# Metrics and alarms (Oracle LA data API and Roofing CRM)

This file is the local stand-in for the kit's metric registry (`apply-engineering-guidelines/SKILL.md`,
"Non-Negotiables" (item 6): every metric registered in the kit owner's Lexicon and shown on its Main Dashboard;
`docs/kit-deviations.md`, row 3). Those repositories are not reachable from a candidate
account; this list is the registry until they are. No dashboard.

Budget: CloudWatch always-free allowance, which applies on both AWS plans
(https://aws.amazon.com/cloudwatch/pricing/, Free tier): "10 Metrics (of Custom Metrics and Detailed
Monitoring Metrics)" and "Alarms 10 Alarm metrics (only applicable to Standard resolution alarms that
list metrics directly and don't use a Metrics Insights query)". Limits for these stacks: fewer than 10
custom metrics and fewer than 10 alarm metrics in total, across both repos.

## Custom metrics (Powertools Metrics, EMF, namespaces `OracleLa` and `RoofingCrm`) — 8 of 10

| #   | Metric                | Unit         | Dimensions                   | Emitted by        | Meaning                                                                                                    |
| --- | --------------------- | ------------ | ---------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | `ColdStart`           | Count        | service=oracle-la-api        | API Lambda        | A cold start (Powertools `captureColdStartMetric`).                                                        |
| 2   | `DataLoadMs`          | Milliseconds | service=oracle-la-api        | API Lambda        | Cold-start time to copy the run files from S3, verify the four Parquet files' sha256 and create the views. |
| 3   | `PointsResponseBytes` | Bytes        | service=oracle-la-api        | API Lambda        | Size of each `parcels.points` response (guard: 3 MB; Lambda limit 6 MB).                                   |
| 4   | `ColdStart`           | Count        | service=oracle-la-authorizer | Authorizer Lambda | A cold start.                                                                                              |
| 5   | `AuthDenied`          | Count        | service=oracle-la-authorizer | Authorizer Lambda | A request with a wrong or missing-Bearer token reached the authorizer and was denied (403).                |
| 6   | `LeadWritten`         | Count        | service=roofing-crm-leads    | Leads Lambda      | A lead was created, updated or deleted (namespace `RoofingCrm`, stack RoofingCrmLeads, crm).               |
| 7   | `LeadWriteFailed`     | Count        | service=roofing-crm-leads    | Leads Lambda      | A lead write failed for a reason other than validation or a conflict (namespace `RoofingCrm`).             |
| 8   | `AgentAnswerUsd`      | None         | service=oracle-la-agent      | Agent Lambda      | The estimated model spend of one answer, in US dollars (stack OracleLaAgentApi, pipeline).                 |

AWS-vended metrics used by alarms (AWS/Lambda, AWS/ApiGateway, AWS/Location) are basic monitoring
metrics and are not custom metrics.

## Alarms (standard resolution, one metric each) — 9 of 10

All alarms notify the SNS topic `oracle-la-alerts` (stack OracleLaGuards; email subscription after
the user confirms the address). Replacement for the kit's PagerDuty rule (`docs/kit-deviations.md`, row 2),
which a candidate account cannot reach: CloudWatch alarm → SNS email. Failures are never swallowed: handlers return 5xx
and log through Powertools.

| #   | Alarm                            | Metric                                                                                 | Condition                                                            | Stack (repo)                |
| --- | -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------- |
| 1   | `oracle-la-api-lambda-errors`    | AWS/Lambda Errors (API function), Sum, 5 min                                           | >= 1                                                                 | OracleLaDataApi (pipeline)  |
| 2   | `oracle-la-api-lambda-throttles` | AWS/Lambda Throttles (API function), Sum, 5 min                                        | >= 1 (reserved concurrency 5 reached)                                | OracleLaDataApi (pipeline)  |
| 3   | `oracle-la-authorizer-errors`    | AWS/Lambda Errors (authorizer), Sum, 5 min                                             | >= 1                                                                 | OracleLaDataApi (pipeline)  |
| 4   | `oracle-la-http-api-5xx`         | AWS/ApiGateway 5xx (ApiId, Stage=$default), Sum, 5 min                                 | >= 1                                                                 | OracleLaDataApi (pipeline)  |
| 5   | `roofing-crm-map-tiles-per-day`  | AWS/Location CallCount (ApiKeyName=roofing-crm-map, OperationName=GetTile), Sum, 1 day | > 5,000 tiles/day (= $0.20/day at $0.04 per 1,000 tiles, eu-north-1) | RoofingCrmMapKey (crm)      |
| 6   | `roofing-crm-leads-http-api-5xx` | AWS/ApiGateway 5xx (leads ApiId, Stage=$default), Sum, 5 min                           | >= 1                                                                 | RoofingCrmLeads (crm)       |
| 7   | `oracle-la-agent-http-api-5xx`   | AWS/ApiGateway 5xx (agent ApiId, Stage=$default), Sum, 5 min                           | >= 1                                                                 | OracleLaAgentApi (pipeline) |
| 8   | `oracle-la-agent-usd-per-day`    | OracleLa AgentAnswerUsd (service=oracle-la-agent), Sum, 1 day                          | > $2 in a UTC day                                                    | OracleLaAgentApi (pipeline) |
| 9   | `oracle-la-agent-usd-burst`      | OracleLa AgentAnswerUsd (service=oracle-la-agent), Sum, 5 min                          | >= $1 within 5 minutes                                               | OracleLaAgentApi (pipeline) |

Missing data is treated as not breaching (idle stacks stay OK).

The leads Lambda emits no ColdStart metric and has no Lambda Errors alarm (increment 3, to stay within the
allowance); its failures surface as `LeadWriteFailed` and the leads HTTP API 5xx alarm.

The agent Lambda emits only `AgentAnswerUsd`, and has no ColdStart metric and no Lambda Errors alarm, for the
same reason; its failures surface as the agent HTTP API 5xx alarm. The two spend alarms watch the same metric:
the daily one is evaluated after the UTC day closes, so it fires up to about 24 hours after the spend passes $2;
the burst one fires within about 10 minutes of $1 spent in one 5-minute period
(`apps/agent-api/cdk/lib/agent-api-stack.ts` (`AgentApiStack`, alarms `UsdPerDay` and `UsdBurst`)). Both estimate
the spend from the token counts and list prices; the Anthropic workspace's own monthly limit ($20) is separate
(section "Agent" below).

Verified after deploy (2026-11-11): `aws cloudwatch list-metrics --namespace OracleLa` lists exactly the
5 `OracleLa` metric/dimension sets (rows 1-5). Rows 6 and 8 were seen on 15 Nov (below); row 7 has not been,
because it has never been emitted.

Checked on 2026-11-15: the account's custom metrics are rows 1-6 and 8. `LeadWriteFailed` (row 7) has never
been emitted, so CloudWatch does not list it. The 9 alarms above are the account's only alarms; counted again on
2026-11-17 (`aws cloudwatch describe-alarms`): 9.

## Sizes, start-up and cost (increment 5)

The data API has served run `2026-11-17T00-55-12-521Z-b1f1fbb377948` since the evening of 17 Nov 2026 (deployed
17:52 UTC): a rebuild, with no source changes and the same four Parquet files, of
`2026-11-17T00-55-12-521Z-bcb7d21c21fe7`, the new-data run from a fresh LADBS fetch that was served from 07:52 UTC
that day. Both hold all of Los Angeles County (2,428,433 parcels, roll 2026) and the City of Los Angeles roofing
permits (297,169 permits, 608,168 permit-parcel links, 113,642 contractor rows of 113,661 fetched, 19 of them exact
duplicates), as their history lines in `runs/run_history.jsonl` record. The served run's six objects come to about
86.5 MB (four Parquet files 84.8 MB, the run manifest 1.6 MB and the run history; file sizes on 17 Nov).

The sizes below are those of the 12 Nov rebuild run, `2026-11-12T14-00-51-383Z-bc7f18f2e9cf2`, a rebuild with no
source changes of the permits run `2026-11-12T14-00-51-383Z` (296,909 permits, 607,702 permit-parcel links,
113,642 contractor rows). The build and its figures are in `docs/los-angeles-county-findings.md` sections
11d-11e, the two 17 Nov runs' in section 11f; the increment-4 county run's are in sections 11b-11c.

### Sizes

The run's six objects in the bucket, all under `runs/<run_id>/` (the run history is uploaded there as a copy of
`runs/run_history.jsonl`):

| Object                                         | Size                     |
| ---------------------------------------------- | ------------------------ |
| `los-angeles_property_roll2026.parquet`        | 73,876,727 B (73.9 MB)   |
| `los-angeles_ladbs_permits.parquet`            | 6,314,075 B (6.3 MB)     |
| `los-angeles_ladbs_permit_parcels.parquet`     | 2,643,361 B (2.6 MB)     |
| `los-angeles_ladbs_permit_contractors.parquet` | 1,981,418 B (2.0 MB)     |
| `run_manifest.json`                            | 1,631,753 B (1.6 MB)     |
| `run_history.jsonl`                            | 6,878 B (one line a run) |

The three earlier runs' objects stay next to them. On 15 Nov 2026 the bucket held 18 objects of four runs,
241,472,956 B (0.2249 GB of 2^30 bytes); the six objects of each of the two 17 Nov runs, about 86.5 MB a run,
were uploaded after that.

### Data API: cold start and responses (Lambda 2,048 MB, x86_64)

| Measure                                                                                                   | Value                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Unwarmed cold starts, 14 Nov 2026 (five simultaneous first requests after one deploy): time at the client | 5,929-8,994 ms (median 6,738 ms)                                                                      |
| Same five requests: init (runtime and handler)                                                            | 538-716 ms                                                                                            |
| Same five requests: data load (`DataLoadMs`: S3 stream, sha256, views)                                    | 2,860-4,427 ms                                                                                        |
| Same five requests: init plus handler duration                                                            | 4,043-7,041 ms (median 5,140 ms)                                                                      |
| Same five requests: Max Memory Used                                                                       | 323-435 MB of 2,048 MB                                                                                |
| Cold start after the deploy of 14 Nov 2026, 20:56 UTC                                                     | 6.07 s at the client, init 725 ms, handler duration 3,886 ms, 326 MB                                  |
| First request after the first 17 Nov 2026 deploy (07:52 UTC)                                              | 7.1 s at the client; init 597.41 ms; handler duration 4,361.42 ms (mostly the data load); 325 MB used |
| The first 7 calls after that deploy                                                                       | Max Memory Used at most 590 MB of 2,048 MB                                                            |
| Pass rule                                                                                                 | every measured cold start at most 10.0 s at the client: all passed                                    |
| `explorer.sources` response                                                                               | 2,396 B (1,446,871 B before the page list moved to `explorer.sourcePages`)                            |
| `/tmp`                                                                                                    | 86.5 MB of 512 MB                                                                                     |

- 2,048 MB because Lambda allocates CPU in proportion to memory, which shortens the cold-start copy and load
  (`apps/api/cdk/lib/data-api-stack.ts` (`DataApiStack`, function `Api`)). Timeout (15 s), ephemeral storage
  (512 MB) and reserved concurrency (5) are unchanged.
- The cold start streams each run file from S3 to `/tmp` and checks the four Parquet files' sha256 on the stream
  (`apps/api/src/db.ts`); no file is held in memory as a whole.
- On 14 Nov two cold data API environments took 5.4 and 6.2 s at the function (init plus handler duration), more
  than the agent's 5 s per attempt; the five cold starts of 14 Nov in the table above took 4.0-7.0 s by the same
  sum (median 5.1 s; Lambda's REPORT lines of the five simultaneous first requests after that day's deploy). So the
  first data call of an answer gets 10 s per attempt and every later one 5 s, with one retry each
  (`packages/agent/src/http-data.ts` (`FIRST_CALL_TIMEOUT_MS`, `CALL_TIMEOUT_MS`, `MAX_ATTEMPTS`);
  `docs/kit-deviations.md`, row 28). A later call can still land on a cold environment: on 15 Nov one
  `parcels.detail` attempt of the Explorer's MCP tab example was cut at 4.95 s, and its retry answered in 154 ms.
  The panels' warm-up, which warms two data API environments (`docs/access-rules.md`, "The warm-up"), is the
  only cover for that case. Each answer makes one data call at a time (`MAX_IN_FLIGHT`), so one warm environment
  serves it.

### Agent (OracleLaAgentApi, Lambda 512 MB, arm64)

| Measure                                                                           | Value                                                                                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Init (Lambda Init Duration, 16 Nov 2026)                                          | 416.79-987.15 ms; 781.59 ms after the 11:05 UTC deploy                                                                           |
| Timeout / answer budget                                                           | 29 s (under the HTTP API's 30 s) / 25 s (`AGENT_TIME_BUDGET_MS`)                                                                 |
| Answers at a time                                                                 | 2 (reserved concurrency 2; stage throttle rate 1, burst 2)                                                                       |
| Measured answer cost (Sonnet 5.5, 15 Nov)                                         | $0.043 a first question, $0.097 a follow-up, $0.011 a refusal for no tool call, $0 a refusal by the people guard (no model call) |
| Browser checks of 15 Nov (both sites)                                             | about $0.30 in all                                                                                                               |
| Hosted answers, 16 Nov 2026, 13:44-14:05 UTC                                      | 11.3-20.3 s each                                                                                                                 |
| Hosted answers, 16 Nov 2026, 22:54-23:12 UTC (the night of 16-17 Nov, local time) | 11.5-18.0 s each (Explorer 4, CRM 1)                                                                                             |
| Eval answers, round of agent commit ebdcf61, 17 Nov 2026 (local data, no HTTP)    | 1.6-10.5 s each, median 6.4 s (the 66 answers that called the model)                                                             |

- The eval (`apps/agent-mcp`, `eval/prompts.json`) has 25 prompts. Its round of 17 Nov 2026 ran locally, on the
  agent code the hosted agent runs (commit ebdcf61) and on the files of the served run, and passed 75 of 75 answers
  (three runs of the 25 prompts) with nine wording warnings. Wording or placement is a warning, also when the wording is wrong; a wrong fact fails only where one of the eval's fifteen checks tests it against the tool calls, the tool results or the answer's structured fields (`apps/agent-mcp/src/eval/checks.ts`).
- The answer's caps (2,000 characters in, 2,048 output tokens per model call, 80,000 tokens, five tool
  rounds, 25 s) are in `docs/access-rules.md` ("The hosted agent").
- Spend guards: the two alarms above ($2 in a UTC day; $1 within 5 minutes) and the Anthropic workspace's
  monthly limit of $20. The workspace limit is set in the Anthropic Console and may lag, so the final stop is
  the credit balance: no payment method is attached.

### Idle cost per month (eu-north-1 list prices, 15 Nov 2026)

Unit: AWS bills storage per GB-month with 1 GB = 2^30 = 1,073,741,824 bytes; S3, Amplify Hosting and log
storage below use that unit. Sizes are as listed on 15 Nov.

Prices (AWS price-list files for eu-north-1): CloudWatch (published 2026-11-04) alarm $0.10 per alarm metric
month (standard resolution), custom metric $0.30 per metric-month (first 10,000), log storage $0.028 per
GB-month; S3 Standard (2026-11-09) $0.023 per GB-month; Amplify Hosting storage (2026-09-11) $0.023 per GB;
DynamoDB (2026-11-11) storage first 25 GB-month free then $0.269, point-in-time recovery $0.21 per GB-month.

Free tier: the always-free allowances only (CloudWatch 10 alarm metrics, 10 custom metrics, 5 GB of logs;
DynamoDB 25 GB of storage), every month. S3 and Amplify storage are not among the always-free allowances, so
both are counted at list price. AWS's free-tier page, fetched 15 Nov 2026:

- "Always free 30+ AWS services are always free within monthly usage limits on both the Free and Paid plans."
  (https://aws.amazon.com/free/)

Custom metrics are billed for the hours they receive data: with no traffic they cost nothing; the 'busy month'
column assumes each of the 8 custom metrics the code defines receives data all month (7 existed in CloudWatch
on 15 Nov 2026; `LeadWriteFailed` has never received data).

| Stack                                     | Alarms | Custom metrics | S3 bytes    | Amplify bytes | Log bytes | Alarms $ | Metrics $ (busy month) | S3 $     | Amplify $  | Logs $     | No free tier, idle $ | No free tier, busy $ | Notes                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------ | -------------- | ----------- | ------------- | --------- | -------- | ---------------------- | -------- | ---------- | ---------- | -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OracleLaGuards                            | 0      | 0              | 0           | 0             | 3,361     | 0.00     | 0.00                   | 0.000000 | 0.00000000 | 0.00000009 | 0.0000               | 0.0000               | SNS topic, the $5 budget (one budget), budget custom resource; no standing charge                                                                                                                                                       |
| OracleLaDataApi                           | 4      | 5              | 241,472,956 | 0             | 907,289   | 0.40     | 1.50                   | 0.005172 | 0.00000000 | 0.00002366 | 0.4052               | 1.9052               | data bucket 18 objects (four runs); metrics ColdStart x2, DataLoadMs, PointsResponseBytes, AuthDenied                                                                                                                                   |
| OracleLaExplorerWeb                       | 0      | 0              | 0           | 404,551       | 51,363    | 0.00     | 0.00                   | 0.000000 | 0.00000867 | 0.00000134 | 0.0000               | 0.0000               | site 404,551 B on Amplify Hosting                                                                                                                                                                                                       |
| OracleLaAgentApi                          | 3      | 1              | 0           | 0             | 11,224    | 0.30     | 0.30                   | 0.000000 | 0.00000000 | 0.00000029 | 0.3000               | 0.6000               | alarms usd-per-day, usd-burst, http-api-5xx; metric AgentAnswerUsd; 2 SecureStrings (standard tier, no charge)                                                                                                                          |
| RoofingCrmWeb                             | 0      | 0              | 0           | 2,054,042     | 151,618   | 0.00     | 0.00                   | 0.000000 | 0.00004400 | 0.00000395 | 0.0000               | 0.0000               | site 2,054,042 B on Amplify Hosting                                                                                                                                                                                                     |
| RoofingCrmLeads                           | 1      | 2              | 0           | 0             | 230,582   | 0.10     | 0.60                   | 0.000000 | 0.00000000 | 0.00000601 | 0.1000               | 0.7000               | DynamoDB on demand, 0 B, 0 items (read 2026-11-15 ~10:45Z); point-in-time recovery on: 0 B x $0.21 per GB-month = $0; metrics LeadWritten and LeadWriteFailed (LeadWriteFailed has never received data, so CloudWatch does not list it) |
| RoofingCrmMapKey                          | 1      | 0              | 0           | 0             | 0         | 0.10     | 0.00                   | 0.000000 | 0.00000000 | 0.00000000 | 0.1000               | 0.1000               | Amazon Location API key (no charge for the key itself)                                                                                                                                                                                  |
| CDK assets bucket (bootstrap, all stacks) | 0      | 0              | 172,630,766 | 0             | 0         | 0.00     | 0.00                   | 0.003698 | 0.00000000 | 0.00000000 | 0.0037               | 0.0037               | 102 objects (Lambda bundles, layer, site zips)                                                                                                                                                                                          |
| **Total**                                 | 9      | 8              | 414,103,722 | 2,458,593     | 1,355,437 | 0.90     | 2.40                   | 0.008870 | 0.00005266 | 0.00003535 | **0.9090**           | **3.3090**           |                                                                                                                                                                                                                                         |

The arithmetic, without the free tier:

- Alarms: 9 x $0.10 = $0.90.
- Custom metrics: $0 idle; 8 x $0.30 = $2.40 in a busy month, counting all 8 the code defines (`LeadWriteFailed`
  included, though it has never received data).
- Logs: 1,355,437 B / 2^30 = 0.001262 GB x $0.028 = $0.000035.
- S3 and Amplify: as below, $0.0089 and $0.000053.
- Total: $0.90 + $0.0089 + $0.000053 + $0.000035 = **$0.9090 idle**, **$3.3090** in a busy month.

With the free tier: alarms 9 of 10, custom metrics 8 of 10, logs far under 5 GB and DynamoDB 0 B are free; S3
and Amplify storage remain:

- S3: 414,103,722 B / 2^30 = 0.3857 GB x $0.023 = $0.0089 (data bucket 0.2249 GB = $0.0052; CDK assets bucket
  0.1608 GB = $0.0037)
- Amplify: 2,458,593 B / 2^30 = 0.002290 GB x $0.023 = $0.000053
- **Idle with the free tier: $0.0089 a month** (about one cent). Without it: $0.9090 idle (the nine alarms are
  $0.90), $3.3090 in a month where all 8 custom metrics receive data.

Not charged while idle: Lambda (no invocations), API Gateway (per request), SSM standard parameters, the
SecureStrings' AWS-managed key, the Location API key, SNS, the one budget, DynamoDB point-in-time recovery
at 0 B. The Anthropic workspace limit ($20 a month) is separate and spent only by answers.

Checked again on 17 Nov 2026: 9 alarms (`describe-alarms`), up to 8 custom metrics, and 9 standard SSM parameters
(7 String, 2 SecureString; no charge), so the fixed figures above stand. The code defines the same 9 alarms and 8
custom metrics: alarms 1-4 in `apps/api/cdk/lib/data-api-stack.ts` (`DataApiStack`, through one helper), 7-9 in
`apps/agent-api/cdk/lib/agent-api-stack.ts` (`Http5xx`, `UsdPerDay`, `UsdBurst`), and 5-6 in the CRM repository
(`apps/crm/cdk/lib/crm-map-key-stack.ts`, `crm-leads-stack.ts`); metrics 1-3 in `apps/api/src/handler.ts` and
`apps/api/src/routers/parcels.ts`, 4-5 in `apps/api/src/authorizer.ts`, 8 in `apps/agent-api/src/handler.ts`, and
6-7 in the CRM's `apps/leads-api/src/router.ts`. No other stack adds an alarm or a custom metric.

The two runs uploaded on 17 Nov added about 173 MB to the data bucket (86.5 MB each; a rebuild is uploaded whole,
the same Parquet bytes again): $0.0037 a month at the S3 Standard list price, which the free tier does not cover.
With them the idle cost with the free tier is about $0.013 a month; the CDK assets bucket has not been measured
again since 15 Nov.

The account's bill for 1-16 Nov 2026, as Cost Explorer estimated it on 17 Nov (the period 2026-11-01 to 2026-11-17,
whose end date Cost Explorer does not include), is $0.215 of gross usage, all of it
offset by credits (net $0.00). The gross figure is the one to read: credits run out, and every service showed $0.00
net, so the net bill gives no unit cost.

### Per-request prices

| Item                              | Price                                             | Example                                             |
| --------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| S3 GET                            | $0.004 per 10,000 (S3, 2026-11-09)                | one GET per run object on a cold start              |
| Data transfer out to the internet | $0.09 per GB, first 10 TB (2026-11-11)            | a `parcels.points` response of 919,635 B: $0.000077 |
| Lambda duration, x86 (data API)   | $0.0000166667 per GB-second (2026-11-11)          | 2,048 MB: $0.0000333 a second                       |
| Lambda duration, arm64 (agent)    | $0.0000133334 per GB-second (2026-11-11)          | 512 MB for 25 s: $0.00017                           |
| Lambda requests                   | $0.20 per million                                 | $0.0000002 a request                                |
| HTTP API requests                 | $1.06 per million, first 300 million (2026-10-13) | $0.00000106 a request                               |

The Lambda price list also lists a compute free tier of 400,000 GB-seconds and 1,000,000 requests a month.

### How cost grows

From the measured unit costs of 17 Nov 2026: list prices for eu-north-1 (the same price-list files as above),
CloudWatch metrics for 3-17 Nov 2026 (14 days) and the eval rounds' token counts. In US dollars, without the free
tier unless a line says otherwise.

- **More data.** Each uploaded run adds its objects to the data bucket and keeps them (runs are never
  overwritten): the served run's six objects are about 86.5 MB, $0.0019 a month (S3 Standard $0.023 per
  GB-month); a rebuild is uploaded whole, so it costs the same. Other storage per GB-month: CloudWatch Logs $0.028; DynamoDB $0 up to 25 GB, then $0.269, and
  point-in-time recovery $0.21; Amplify Hosting $0.023.
- **More users.** Every 1,000 data API requests cost **$0.0143**: the API Lambda $0.0132 (2,048 MB, x86, mean
  529 ms, cold starts included), the authorizer $0.00005 and the API Gateway charge $0.00106, which is included.
  Measured over the 14 days: 5,931 API Gateway requests, 4,381 handler invocations (2,319.0 s) and 504 authorizer
  invocations (64.2 s at 256 MB, arm64), $0.0848 in all at list prices, divided by the 5,931 requests. A response
  over 512 KB counts as several API Gateway requests. The Lambda free tier (1 million requests and 400,000
  GB-seconds a month) is not applied. Not included: CloudWatch Logs ingestion, X-Ray traces and data transfer
  out.
- **More agent questions.** Every 1,000 answers cost **$14.29** of model spend with a warm prompt cache (about
  $0.014 an answer), plus $0.014 of Lambda and $0.001 of API Gateway; **$32.93** with a cold cache (one cold answer
  measured, $0.03293); **$37.33** if nothing were cached. A refusal by the people guard costs $0 (no model call); a
  refusal the model writes cost $0.0013-0.0015 in the eval and $0.011 in the hosted check of 15 Nov. Measured on
  the 21-prompt eval round of 17 Nov 2026 on run `2026-11-17T00-55-12-521Z-bcb7d21c21fe7`: 53 warm answers, mean
  3,504 input, 11,998 cache-read and 608 output tokens, $0.01429 each (the two rounds before it: $0.01430 and
  $0.01487), at the model's list prices in `packages/agent/src/models.ts`; Lambda from 207 hosted invocations,
  mean 2,085 ms at 512 MB, arm64. The later 25-prompt round, run locally on the agent code the hosted agent runs
  (commit ebdcf61) and on the served run's files, gives $13.09 per 1,000 warm answers (65 answers, $0.01309 each),
  $32.73 per 1,000 at the cost of its one cold answer ($0.03273) and $36.02 with nothing cached. These are means
  over the eval's prompts, which include refusals and short answers; the two README demo questions cost about
  $0.020 and $0.040 warm in the 25-prompt round. The model spend is billed by Anthropic, not AWS.
- **More frequent refreshes.** One refresh (17 Nov 2026) downloaded 271.4 MB of JSON in 20 requests in 1 min
  32 s, at no charge (the City's public data API, read anonymously); the dry and real builds took 2 min 00 s and
  1 min 57 s, at a peak of 2.44 and 2.43 GB, on the local machine, with no AWS cost; locally it keeps 52.3 MB of
  caches, 333.7 MB in `data/out/` (248.8 MB of it the seed CSV) and 3.78 GB of build scratch. Hosted, each
  uploaded run adds about 86.5 MB ($0.0019 a month) and keeps it, so a weekly refresh adds about $0.008 a month
  for every month of runs kept, and a daily one about $0.06. Every refresh so far was started by hand; a schedule
  (the two LADBS fetches, the build and the upload, run on a timer) is a next step and is not built.
- **Fixed costs** (they do not grow with use): 9 alarms x $0.10 = **$0.90** a month ($0 within the free tier's
  10); up to 8 custom metrics x $0.30 = **$2.40** in a month when every metric receives data, $0 with no traffic,
  $0 within the free tier's 10; 9 standard SSM parameters, $0.
- **IPFS pinning.** The six published CARs (34,662,270 B, 34.7 MB) are pinned at Filebase, outside AWS, on the
  account that uploaded them on 18 Nov 2026. That account is on Filebase's free plan (5 GB of storage at $0 on
  Filebase's pricing page as read on 13 Nov 2026), so pinning costs $0 a month, as Mario Ferraro confirmed on
  18 Nov 2026. The files are pinned at one service; a second copy at another service is a next step. The
  publication adds nothing to the AWS bill.
- **The bill so far.** 1-16 Nov 2026: $0.215 of gross usage, offset by credits to $0.00 net (Cost Explorer's
  estimate, 17 Nov).

### Against the guards

- The $5 monthly cost budget (OracleLaGuards, credits excluded) and its three notifications to the alert
  topic are unchanged: actual spend above 20% ($1), forecast above 100%, actual above 100% ($5)
  (`apps/api/cdk/lib/guards-stack.ts`). It covers AWS only; the agent's model spend is the Anthropic
  workspace's (section "Agent").
- Custom metrics stay at 8 of 10 and alarms at 9 of 10 (tables above), across both repositories.
- Known gap: the budget custom resource's log group keeps 14 days (`RetentionDays.TWO_WEEKS`,
  `apps/api/cdk/lib/guards-stack.ts` (`GuardsStack`, log group `BudgetCustomResourceLogs`)), against the kit's 90 days on all log groups
  (`apply-engineering-guidelines/rules/observability-logging-tracing.md`, "Logging Standards", at kit commit 71b8341). It is
  documented, not changed: changing it would modify the OracleLaGuards stack. Other log groups also have no
  retention setting, so they never expire: those of the Amplify asset-deployment provider's functions
  (`docs/kit-deviations.md`, row 18) and that of the data bucket's auto-delete custom resource
  (`autoDeleteObjects`, `apps/api/cdk/lib/data-api-stack.ts` (`DataApiStack`, bucket `Data`)), which Lambda
  creates on first use.
