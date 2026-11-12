# Metrics and alarms (Oracle LA data API and Roofing CRM)

This file is the local stand-in for the kit's metric registry (non-negotiable 6: metrics registered
in Spring Oaks' Lexicon `cloudwatch-metrics.json` and shown on the Main Dashboard). Those repositories
are not reachable from a candidate account; this list is the registry until they are. No dashboard.

Budget: CloudWatch always-free allowance, which Free plan accounts keep
(https://aws.amazon.com/cloudwatch/pricing/, Free tier): "10 Metrics (of Custom Metrics and Detailed
Monitoring Metrics)" and "Alarms 10 Alarm metrics (only applicable to Standard resolution alarms that
list metrics directly and don't use a Metrics Insights query)". Limits for these stacks: fewer than 10
custom metrics and fewer than 10 alarm metrics in total, across both repos.

## Custom metrics (Powertools Metrics, EMF, namespaces `OracleLa` and `RoofingCrm`) — 7 of 10

| #   | Metric                | Unit         | Dimensions                   | Emitted by        | Meaning                                                                                        |
| --- | --------------------- | ------------ | ---------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `ColdStart`           | Count        | service=oracle-la-api        | API Lambda        | A cold start (Powertools `captureColdStartMetric`).                                            |
| 2   | `DataLoadMs`          | Milliseconds | service=oracle-la-api        | API Lambda        | Cold-start time to copy the run files from S3, verify the Parquet sha256 and create the views. |
| 3   | `PointsResponseBytes` | Bytes        | service=oracle-la-api        | API Lambda        | Size of each `parcels.points` response (guard: 3 MB; Lambda limit 6 MB).                       |
| 4   | `ColdStart`           | Count        | service=oracle-la-authorizer | Authorizer Lambda | A cold start.                                                                                  |
| 5   | `AuthDenied`          | Count        | service=oracle-la-authorizer | Authorizer Lambda | A request with a wrong or missing-Bearer token reached the authorizer and was denied (403).    |
| 6   | `LeadWritten`         | Count        | service=roofing-crm-leads    | Leads Lambda      | A lead was created, updated or deleted (namespace `RoofingCrm`, stack RoofingCrmLeads, crm).   |
| 7   | `LeadWriteFailed`     | Count        | service=roofing-crm-leads    | Leads Lambda      | A lead write failed for a reason other than validation or a conflict (namespace `RoofingCrm`). |

AWS-vended metrics used by alarms (AWS/Lambda, AWS/ApiGateway, AWS/Location) are basic monitoring
metrics and are not custom metrics.

## Alarms (standard resolution, one metric each) — 6 of 10

All alarms notify the SNS topic `oracle-la-alerts` (stack OracleLaGuards; email subscription after
the user confirms the address). Replacement for non-negotiable 7 (PagerDuty), which a candidate
account cannot reach: CloudWatch alarm → SNS email. Failures are never swallowed: handlers return 5xx
and log through Powertools.

| #   | Alarm                            | Metric                                                                                 | Condition                                                            | Stack (repo)               |
| --- | -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| 1   | `oracle-la-api-lambda-errors`    | AWS/Lambda Errors (API function), Sum, 5 min                                           | >= 1                                                                 | OracleLaDataApi (pipeline) |
| 2   | `oracle-la-api-lambda-throttles` | AWS/Lambda Throttles (API function), Sum, 5 min                                        | >= 1 (reserved concurrency 5 reached)                                | OracleLaDataApi (pipeline) |
| 3   | `oracle-la-authorizer-errors`    | AWS/Lambda Errors (authorizer), Sum, 5 min                                             | >= 1                                                                 | OracleLaDataApi (pipeline) |
| 4   | `oracle-la-http-api-5xx`         | AWS/ApiGateway 5xx (ApiId, Stage=$default), Sum, 5 min                                 | >= 1                                                                 | OracleLaDataApi (pipeline) |
| 5   | `roofing-crm-map-tiles-per-day`  | AWS/Location CallCount (ApiKeyName=roofing-crm-map, OperationName=GetTile), Sum, 1 day | > 5,000 tiles/day (= $0.20/day at $0.04 per 1,000 tiles, eu-north-1) | RoofingCrmMapKey (crm)     |
| 6   | `roofing-crm-leads-http-api-5xx` | AWS/ApiGateway 5xx (leads ApiId, Stage=$default), Sum, 5 min                           | >= 1                                                                 | RoofingCrmLeads (crm)      |

Missing data is treated as not breaching (idle stacks stay OK).

The leads Lambda emits no ColdStart metric and has no Lambda Errors alarm (increment 3, to stay within the
allowance); its failures surface as `LeadWriteFailed` and the leads HTTP API 5xx alarm.

Verified after deploy (2026-11-11): `aws cloudwatch list-metrics --namespace OracleLa` lists exactly the
5 `OracleLa` metric/dimension sets (rows 1-5); rows 6-7 are verified after the RoofingCrmLeads deploy.

## County run: sizes, cold start and cost (increment 4)

Run `2026-11-12T01-44-04-047Z`, all of Los Angeles County (2,428,433 parcels, roll 2026). Measured on
2026-11-12; the build and the local figures are in `docs/los-angeles-county-findings.md` §11b-§11c.

### Sizes

| File in the bucket (`runs/<run_id>/`)   | Size                          |
| --------------------------------------- | ----------------------------- |
| `los-angeles_property_roll2026.parquet` | 69,021,603 B (69 MB)          |
| `run_manifest.json`                     | 1,604,126 B (1.6 MB)          |
| `run_history.jsonl`                     | about 2 KB (one line per run) |

The pilot run's files stay in the bucket next to them (Parquet 601,850 B, manifest 15,678 B). Everything
in the bucket is about 71 MB (0.066 GB).

### Cold start and warm latency (hosted data API, Lambda 1,024 MB, x86_64)

| Measure                                            | Value                      |
| -------------------------------------------------- | -------------------------- |
| Init (runtime and handler)                         | 0.6 s                      |
| Data load (`DataLoadMs`): S3 stream, sha256, views | 6.4 s (6,356 ms)           |
| First request, in the function                     | 6,446 ms (billed 7,045 ms) |
| First request, at the client                       | about 8.8 s                |
| Warm requests, in the function                     | 3-6 ms                     |
| Peak memory                                        | 298 MB of 1,024 MB         |
| Full `parcels.points` response (25,000 points)     | 819,810 B (about 0.82 MB)  |

The cold start streams each run file from S3 to `/tmp` and computes the Parquet's sha256 on the stream
(`apps/api/src/db.ts`); the 69 MB file is never held in memory as a whole. Memory, timeout (15 s) and
ephemeral storage (512 MB) are unchanged.

### Monthly cost (eu-north-1, on-demand list prices)

Prices from the AWS price list files for eu-north-1 (S3 published 2026-11-09, data transfer 2026-11-11,
Lambda 2026-11-11, API Gateway 2026-10-13):

| Item                              | Price                                 | County run                                                                             |
| --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| S3 storage                        | $0.023 per GB-month (first 50 TB)     | 0.066 GB: about $0.0015 a month                                                        |
| S3 GET                            | $0.004 per 10,000                     | 3 GETs per cold start: $0.0000012                                                      |
| S3 PUT                            | $0.005 per 1,000                      | 3 PUTs per uploaded run: $0.000015                                                     |
| Data transfer out to the internet | $0.09 per GB (first 10 TB)            | $0.0000687 per full points response (0.82 MB); **about 14,550 full responses cost $1** |
| Lambda duration (x86)             | $0.0000166667 per GB-second           | one cold start: 7.045 GB-s = $0.000117; a warm request: about $0.0000001               |
| Lambda requests                   | $0.20 per million                     | $0.0000002 per request                                                                 |
| HTTP API requests                 | $1.06 per million (first 300 million) | $0.00000106 per request                                                                |

The Lambda price list also lists a compute free tier of 400,000 GB-seconds and 1,000,000 requests a
month, which covers about 56,000 cold starts. With no traffic the standing cost is the S3 storage, well
under one cent a month. Egress is the item that grows with use: the full points response dominates it.

### Against the guards

- The $5 monthly cost budget (OracleLaGuards, credits excluded) and its three notifications to the alert
  topic are unchanged: actual spend above 20% ($1), forecast above 100%, actual above 100% ($5)
  (`apps/api/cdk/lib/guards-stack.ts`).
- Custom metrics stay at 7 of 10 and alarms at 6 of 10 (tables above). The county run adds no metric and
  no alarm; `PointsResponseBytes` and `DataLoadMs` now report the county sizes.
- Known gap: the budget custom resource's log group keeps 14 days (`RetentionDays.TWO_WEEKS`,
  `apps/api/cdk/lib/guards-stack.ts:119`), against the kit's 90 days on all log groups
  (`apply-engineering-guidelines/rules/observability-logging-tracing.md:27` at kit commit 71b8341). It is
  documented, not changed: changing it would modify the OracleLaGuards stack.
