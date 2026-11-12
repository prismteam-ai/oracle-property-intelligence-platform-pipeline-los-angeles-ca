import { execFileSync } from "node:child_process";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { ALERT_TOPIC_PARAM } from "./guards-stack.ts";

export const TOKEN_HASH_PATH = "/oracle-la/api/clients/";
export const METRICS_NAMESPACE = "OracleLa";
/** SSM parameter holding the token authorizer's ARN (read by the CRM leads stack). */
export const AUTHORIZER_ARN_PARAM = "/oracle-la/api/authorizer-arn";

export interface DataApiStackProps extends cdk.StackProps {
  repoRoot: string;
  runId: string;
  parquetSha256: string;
  /** One entry per frontend: drives CORS origins and the token-hash SSM parameter the authorizer reads. */
  clients: Array<{ name: string; origin: string; tokenSha256: string }>;
}

/** Private data bucket, DuckDB API Lambda (layer built with a frozen pnpm deploy), token authorizer, HTTP API, alarms. */
export class DataApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataApiStackProps) {
    super(scope, id, props);
    const apiDir = `${props.repoRoot}apps/api/`;
    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      projectRoot: props.repoRoot,
      depsLockFilePath: `${props.repoRoot}pnpm-lock.yaml`,
      tracing: lambda.Tracing.ACTIVE,
    };
    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.THREE_MONTHS, // 90 days (kit: observability-logging-tracing.md:27)
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    const bucket = new s3.Bucket(this, "Data", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // DuckDB native module: frozen `pnpm deploy` under the repo's supply-chain policy, shipped as a layer
    // (never NodejsFunction nodeModules, whose install is not frozen). A test compares it with pnpm-lock.yaml.
    execFileSync("pnpm", ["--filter", "@oracle-la/api", "run", "layer"], {
      cwd: props.repoRoot,
      stdio: "inherit",
    });
    const duckdbLayer = new lambda.LayerVersion(this, "DuckDbLayer", {
      code: lambda.Code.fromAsset(`${apiDir}build/duckdb-layer`),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      compatibleArchitectures: [lambda.Architecture.X86_64],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      description:
        "@duckdb/node-api 2.0.0-r.1 (linux-x64 glibc) from pnpm deploy --frozen-lockfile",
    });

    const apiFn = new nodejs.NodejsFunction(this, "Api", {
      ...common,
      entry: `${apiDir}src/handler.ts`,
      architecture: lambda.Architecture.X86_64, // matches the linux-x64 glibc DuckDB binding built on this x86_64 host
      memorySize: 1024,
      timeout: cdk.Duration.seconds(15),
      reservedConcurrentExecutions: 5,
      layers: [duckdbLayer],
      logGroup: logGroup("Api"),
      environment: {
        DATA_BUCKET: bucket.bucketName,
        DATA_PREFIX: `runs/${props.runId}/`,
        RUN_ID: props.runId,
        PARQUET_SHA256: props.parquetSha256,
        POWERTOOLS_SERVICE_NAME: "oracle-la-api",
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        externalModules: ["@duckdb/node-api"],
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: "node22",
      },
    });
    bucket.grantRead(apiFn, "runs/*");

    const authFn = new nodejs.NodejsFunction(this, "Authorizer", {
      ...common,
      entry: `${apiDir}src/authorizer.ts`,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      logGroup: logGroup("Authorizer"),
      environment: {
        TOKEN_HASH_PATH,
        POWERTOOLS_SERVICE_NAME: "oracle-la-authorizer",
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        bundleAwsSDK: true,
        minify: true,
        sourceMap: true,
        target: "node22",
      },
    });
    authFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParametersByPath"],
        // GetParametersByPath is authorized against the path exactly as requested ("/oracle-la/api/clients/").
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${TOKEN_HASH_PATH}`,
        ],
      }),
    );

    for (const c of props.clients) {
      new ssm.StringParameter(this, `TokenHash-${c.name}`, {
        parameterName: `${TOKEN_HASH_PATH}${c.name}/token-sha256`,
        stringValue: c.tokenSha256,
        description: `SHA-256 of the ${c.name} API token`,
      });
    }
    // The CRM leads API (RoofingCrmLeads, crm repo) imports this authorizer by ARN; it creates its own
    // invoke permission, scoped to its own authorizer ARN.
    new ssm.StringParameter(this, "AuthorizerArn", {
      parameterName: AUTHORIZER_ARN_PARAM,
      stringValue: authFn.functionArn,
      description: "Shared token authorizer, used by the CRM leads API",
    });
    const authorizer = new HttpLambdaAuthorizer("TokenAuthorizer", authFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ["$request.header.Authorization"],
      resultsCacheTtl: cdk.Duration.minutes(5),
    });
    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "oracle-la-data-api",
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: props.clients.map((c) => c.origin),
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        maxAge: cdk.Duration.minutes(10),
      },
    });
    api.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
    });
    api.addRoutes({
      path: "/trpc/{proxy+}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("ApiIntegration", apiFn),
      authorizer,
    });

    // Alarms (CloudWatch always-free: 10 standard alarms; listed in docs/metrics.md).
    const topic = sns.Topic.fromTopicArn(
      this,
      "Alerts",
      ssm.StringParameter.valueForStringParameter(this, ALERT_TOPIC_PARAM),
    );
    const alarm = (
      id: string,
      name: string,
      metric: cloudwatch.IMetric,
      description: string,
    ) =>
      new cloudwatch.Alarm(this, id, {
        alarmName: name,
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new actions.SnsAction(topic));
    alarm(
      "ApiErrors",
      "oracle-la-api-lambda-errors",
      apiFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
      "API Lambda threw (any error in 5 min)",
    );
    alarm(
      "ApiThrottles",
      "oracle-la-api-lambda-throttles",
      apiFn.metricThrottles({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      "API Lambda throttled (reserved concurrency 5 reached)",
    );
    alarm(
      "AuthErrors",
      "oracle-la-authorizer-errors",
      authFn.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      "Authorizer Lambda threw",
    );
    alarm(
      "Api5xx",
      "oracle-la-http-api-5xx",
      new cloudwatch.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "5xx",
        dimensionsMap: { ApiId: api.apiId, Stage: "$default" },
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
      }),
      "HTTP API returned 5xx",
    );

    new cdk.CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new cdk.CfnOutput(this, "DataBucket", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "DataPrefix", { value: `runs/${props.runId}/` });
  }
}
