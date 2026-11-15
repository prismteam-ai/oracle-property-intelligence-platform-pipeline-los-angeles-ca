/**
 * OracleLaAgentApi: the hosted agent. One Lambda (apps/agent-api/src/handler.ts, no DuckDB), its own HTTP API
 * behind the data API's shared token authorizer (imported by ARN from SSM, as RoofingCrmLeads does), and three
 * alarms on the existing alert topic. The function reads the Anthropic key and the history signing secret
 * itself, on first use, from two SecureStrings placed by hand; this stack only knows their names and grants
 * ssm:GetParameter on exactly those two ARNs. No secret value is read, created or passed here.
 */
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
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { type ClientEntry, corsOrigins } from "../../../api/cdk/lib/clients.ts";
import {
  AUTHORIZER_ARN_PARAM,
  METRICS_NAMESPACE,
} from "../../../api/cdk/lib/data-api-stack.ts";
import { ALERT_TOPIC_PARAM } from "../../../api/cdk/lib/guards-stack.ts";

/** The SecureStrings the function reads (placed by hand; names only here). */
export const KEY_PARAMETER_NAME = "/oracle-la/agent/anthropic-api-key";
export const HISTORY_SECRET_PARAMETER_NAME =
  "/oracle-la/agent/history-signing-secret";
export const SERVICE_NAME = "oracle-la-agent";
/** The clients the agent serves (the handler refuses any other with 403); both are browser clients. */
export const AGENT_API_CLIENTS = ["crm", "explorer"] as const;
/** Estimated model spend per UTC day above which the alarm fires. */
export const USD_PER_DAY_THRESHOLD = 2;
/** Estimated model spend within one 5-minute period at or above which the burst alarm fires. */
export const USD_BURST_THRESHOLD = 1;
/** The data API's URL as OracleLaDataApi outputs it (`ApiUrl`, the HTTP API's default endpoint). */
const DATA_API_URL =
  /^https:\/\/[a-z0-9]+\.execute-api\.eu-north-1\.amazonaws\.com$/;

export interface AgentApiStackProps extends cdk.StackProps {
  /** Repository root (for bundling the handler). */
  repoRoot: string;
  /** OracleLaDataApi's `ApiUrl` output: the data API the agent's tools call with the caller's own token. */
  dataApiUrl: string;
  /** The data API's clients (apps/api/cdk/clients.json); the CORS origins are those of AGENT_API_CLIENTS. */
  clients: ClientEntry[];
  /** SSM parameter with the Amplify app ID for clients given as `amplifyBranch` (read at deploy time). */
  amplifyAppIdParameter?: string;
}

export class AgentApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentApiStackProps) {
    super(scope, id, props);
    if (!DATA_API_URL.test(props.dataApiUrl))
      throw new Error(
        `dataApiUrl must be OracleLaDataApi's ApiUrl output (https://<api id>.execute-api.eu-north-1.amazonaws.com), got "${props.dataApiUrl}"`,
      );
    const clients = AGENT_API_CLIENTS.map((name) => {
      const c = props.clients.find((e) => e.name === name);
      if (!c || c.browser === false)
        throw new Error(
          `the agent API serves "${name}": it must be a browser client in clients.json`,
        );
      return c;
    });

    const fn = new nodejs.NodejsFunction(this, "AgentApi", {
      entry: `${props.repoRoot}apps/agent-api/src/handler.ts`,
      handler: "handler",
      projectRoot: props.repoRoot,
      depsLockFilePath: `${props.repoRoot}pnpm-lock.yaml`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, // no native module (no DuckDB layer)
      memorySize: 512, // network-bound: model and data API calls, JSON of ~100 KB at most per answer
      // Under the HTTP API's 30 s integration limit; the answer's own budget is AGENT_TIME_BUDGET_MS (25 s).
      timeout: cdk.Duration.seconds(29),
      reservedConcurrentExecutions: 2, // at most 2 answers at once
      tracing: lambda.Tracing.ACTIVE,
      logGroup: new logs.LogGroup(this, "AgentApiLogs", {
        retention: logs.RetentionDays.THREE_MONTHS, // 90 days (kit: apply-engineering-guidelines/rules/observability-logging-tracing.md, "Logging Standards")
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      // Names and settings only: the two *_PARAMETER_NAME values are SSM parameter names, not secrets.
      environment: {
        DATA_API_URL: props.dataApiUrl,
        KEY_PARAMETER_NAME,
        HISTORY_SECRET_PARAMETER_NAME,
        AGENT_PROVIDER: "anthropic",
        AGENT_MODEL: "sonnet-5.5",
        AGENT_EFFORT: "low",
        AGENT_MAX_TOOL_TURNS: "5",
        AGENT_MAX_TOKENS: "80000",
        AGENT_MAX_OUTPUT_TOKENS: "2048",
        AGENT_TIME_BUDGET_MS: "25000",
        POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
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
    // GetParameter (with decryption, aws/ssm key) on the two parameters only: no path read, no other parameter.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [KEY_PARAMETER_NAME, HISTORY_SECRET_PARAMETER_NAME].map(
          (name) =>
            `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`,
        ),
      }),
    );

    // The data API's token authorizer (one token store for every API). sameEnvironment: the ARN is a
    // deploy-time token, so CDK cannot infer the account; without it no invoke permission is created.
    const sharedAuthorizer = lambda.Function.fromFunctionAttributes(
      this,
      "SharedAuthorizer",
      {
        functionArn: ssm.StringParameter.valueForStringParameter(
          this,
          AUTHORIZER_ARN_PARAM,
        ),
        sameEnvironment: true,
      },
    );
    const authorizer = new HttpLambdaAuthorizer(
      "TokenAuthorizer",
      sharedAuthorizer,
      {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        identitySource: ["$request.header.Authorization"],
        resultsCacheTtl: cdk.Duration.minutes(5),
      },
    );

    // Branch clients: the Amplify app ID comes from SSM at deploy time (published by the CRM's RoofingCrmWeb).
    const hostAppId = props.amplifyAppIdParameter
      ? ssm.StringParameter.valueForStringParameter(
          this,
          props.amplifyAppIdParameter,
        )
      : undefined;
    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "oracle-la-agent-api",
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: corsOrigins(clients, hostAppId),
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        maxAge: cdk.Duration.minutes(10),
      },
    });
    api.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 1, burstLimit: 2 },
    });
    const integration = new HttpLambdaIntegration("AgentIntegration", fn);
    api.addRoutes({
      path: "/agent/answer",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer,
    });
    api.addRoutes({
      path: "/agent/warm",
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer,
    });

    // Alarms on the existing alert topic (CloudWatch always-free: 10 standard alarms; 9 of 10 after this stack).
    const topic = sns.Topic.fromTopicArn(
      this,
      "Alerts",
      ssm.StringParameter.valueForStringParameter(this, ALERT_TOPIC_PARAM),
    );
    new cloudwatch.Alarm(this, "Http5xx", {
      alarmName: "oracle-la-agent-http-api-5xx",
      alarmDescription: "Agent HTTP API returned 5xx",
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "5xx",
        dimensionsMap: { ApiId: api.apiId, Stage: "$default" },
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new actions.SnsAction(topic));
    // AgentAnswerUsd: the handler's estimated spend per answer (Powertools Metrics, default "service" dimension).
    const answerUsd = (period: cdk.Duration) =>
      new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName: "AgentAnswerUsd",
        dimensionsMap: { service: SERVICE_NAME },
        statistic: "Sum",
        period,
      });
    // A 1-day period is evaluated after the UTC day closes, so the alarm fires up to ~24 h after spend passes $2.
    new cloudwatch.Alarm(this, "UsdPerDay", {
      alarmName: "oracle-la-agent-usd-per-day",
      alarmDescription: `Agent estimated model spend over $${USD_PER_DAY_THRESHOLD} in a UTC day`,
      metric: answerUsd(cdk.Duration.days(1)),
      threshold: USD_PER_DAY_THRESHOLD,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new actions.SnsAction(topic));
    // Burst: $1 or more within one 5-minute period. The period is evaluated after it closes, plus CloudWatch's
    // evaluation delay, so the alarm fires within about 10 minutes of the spend.
    new cloudwatch.Alarm(this, "UsdBurst", {
      alarmName: "oracle-la-agent-usd-burst",
      alarmDescription: `Agent estimated model spend of $${USD_BURST_THRESHOLD} or more within 5 minutes`,
      metric: answerUsd(cdk.Duration.minutes(5)),
      threshold: USD_BURST_THRESHOLD,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new actions.SnsAction(topic));

    new cdk.CfnOutput(this, "AgentApiUrl", { value: api.apiEndpoint });
  }
}
