# Metrics and alarms (Oracle LA data API and Roofing CRM)

This file is the local stand-in for the kit's metric registry (non-negotiable 6: metrics registered
in Spring Oaks' Lexicon `cloudwatch-metrics.json` and shown on the Main Dashboard). Those repositories
are not reachable from a candidate account; this list is the registry until they are. No dashboard.

Budget: CloudWatch always-free allowance, which Free plan accounts keep
(https://aws.amazon.com/cloudwatch/pricing/, Free tier): "10 Metrics (of Custom Metrics and Detailed
Monitoring Metrics)" and "Alarms 10 Alarm metrics (only applicable to Standard resolution alarms that
list metrics directly and don't use a Metrics Insights query)". Limits for these stacks: fewer than 10
custom metrics and fewer than 10 alarm metrics in total, across both repos.

## Custom metrics (Powertools Metrics, EMF, namespace `OracleLa`) — 5 of 10

| #   | Metric                | Unit         | Dimensions                   | Emitted by        | Meaning                                                                                        |
| --- | --------------------- | ------------ | ---------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `ColdStart`           | Count        | service=oracle-la-api        | API Lambda        | A cold start (Powertools `captureColdStartMetric`).                                            |
| 2   | `DataLoadMs`          | Milliseconds | service=oracle-la-api        | API Lambda        | Cold-start time to copy the run files from S3, verify the Parquet sha256 and create the views. |
| 3   | `PointsResponseBytes` | Bytes        | service=oracle-la-api        | API Lambda        | Size of each `parcels.points` response (guard: 3 MB; Lambda limit 6 MB).                       |
| 4   | `ColdStart`           | Count        | service=oracle-la-authorizer | Authorizer Lambda | A cold start.                                                                                  |
| 5   | `AuthDenied`          | Count        | service=oracle-la-authorizer | Authorizer Lambda | A request with a wrong or missing-Bearer token reached the authorizer and was denied (403).    |

AWS-vended metrics used by alarms (AWS/Lambda, AWS/ApiGateway, AWS/Location) are basic monitoring
metrics and are not custom metrics.

## Alarms (standard resolution, one metric each) — 5 of 10

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

Missing data is treated as not breaching (idle stacks stay OK).

Verified after deploy (2026-11-11): `aws cloudwatch list-metrics --namespace OracleLa` lists exactly these
5 metric/dimension sets.
