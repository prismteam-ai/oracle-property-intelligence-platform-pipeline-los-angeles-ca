/**
 * Synth checks for OracleLaAgentApi (offline: dummy account 123456789012, no AWS call, no secret read). The main
 * synth bundles the handler with esbuild so the bundle itself is checked; the CDK app (bin/app.ts) is run as a
 * child process with bundling skipped, for its account and context checks and the tag.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type ClientEntry,
  type ClientsFile,
  parseClients,
} from "../../api/cdk/lib/clients.ts";
import {
  AGENT_API_CLIENTS,
  AgentApiStack,
  HISTORY_SECRET_PARAMETER_NAME,
  KEY_PARAMETER_NAME,
} from "../cdk/lib/agent-api-stack.ts";
import { AGENT_CLIENTS } from "../src/handler.ts";

const ACCOUNT = "123456789012";
const env = { account: ACCOUNT, region: "eu-north-1" };
const repoRoot = new URL("../../../", import.meta.url).pathname;
const appDir = new URL("../", import.meta.url).pathname;
const DATA_API_URL = "https://abcde12345.execute-api.eu-north-1.amazonaws.com";
const clientsFile = parseClients(
  JSON.parse(
    readFileSync(`${repoRoot}apps/api/cdk/clients.json`, "utf8"),
  ) as ClientsFile,
);
const APP_ID_PARAM = clientsFile.amplifyAppIdParameter!;
const AUTHORIZER_PARAM = "/oracle-la/api/authorizer-arn";
const TOPIC_PARAM = "/oracle-la/alerts/topic-arn";
const PARAMETER_ARNS = [
  `arn:aws:ssm:eu-north-1:${ACCOUNT}:parameter/oracle-la/agent/anthropic-api-key`,
  `arn:aws:ssm:eu-north-1:${ACCOUNT}:parameter/oracle-la/agent/history-signing-secret`,
];

interface Res {
  Type: string;
  Properties: Record<string, unknown>;
  DeletionPolicy?: string;
}
const resources = (t: Template, type: string) =>
  Object.values(t.findResources(type)) as Res[];
const only = (t: Template, type: string) => {
  const r = resources(t, type);
  expect(r).toHaveLength(1);
  return r[0]!;
};
const logicalId = (t: Template, type: string) => {
  const ids = Object.keys(t.findResources(type));
  expect(ids).toHaveLength(1);
  return ids[0]!;
};
/** The CloudFormation parameter (an SSM parameter type) whose default is the given SSM name. */
const paramFor = (t: Template, ssmName: string) => {
  const entry = Object.entries(
    t.toJSON().Parameters as Record<string, { Type: string; Default?: string }>,
  ).find(([, p]) => p.Default === ssmName);
  expect(entry, ssmName).toBeDefined();
  expect(entry![1].Type).toBe("AWS::SSM::Parameter::Value<String>");
  return entry![0];
};

const newStack = (
  app: cdk.App,
  over: { dataApiUrl?: string; clients?: ClientEntry[] } = {},
) =>
  new AgentApiStack(app, "OracleLaAgentApi", {
    env,
    repoRoot,
    dataApiUrl: over.dataApiUrl ?? DATA_API_URL,
    clients: over.clients ?? clientsFile.clients,
    amplifyAppIdParameter: APP_ID_PARAM,
  });
const noBundling = () =>
  new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });

describe("OracleLaAgentApi", () => {
  let outdir: string;
  let stack: AgentApiStack;
  let t: Template;
  beforeAll(() => {
    // CDK bundles with `pnpm exec -- esbuild` in the repo root; a deploy (`pnpm exec cdk` in apps/agent-api) has
    // this app's node_modules/.bin on PATH, and so does this synth.
    process.env.PATH = `${appDir}node_modules/.bin${delimiter}${process.env.PATH ?? ""}`;
    outdir = mkdtempSync(join(tmpdir(), "agent-api-synth-"));
    stack = newStack(new cdk.App({ outdir })); // bundles the handler (esbuild)
    t = Template.fromStack(stack);
  }, 120_000);
  afterAll(() => rmSync(outdir, { recursive: true, force: true }));

  test("resources: one function, its role and policy, log group, HTTP API, two routes, one authorizer, three permissions, three alarms", () => {
    const counts: Record<string, number> = {};
    for (const r of Object.values(t.toJSON().Resources as Record<string, Res>))
      counts[r.Type] = (counts[r.Type] ?? 0) + 1;
    expect(counts).toEqual({
      "AWS::IAM::Role": 1,
      "AWS::IAM::Policy": 1,
      "AWS::Lambda::Function": 1,
      "AWS::Logs::LogGroup": 1,
      "AWS::ApiGatewayV2::Api": 1,
      "AWS::ApiGatewayV2::Stage": 1,
      "AWS::ApiGatewayV2::Integration": 1,
      "AWS::ApiGatewayV2::Route": 2,
      "AWS::ApiGatewayV2::Authorizer": 1,
      "AWS::Lambda::Permission": 3,
      "AWS::CloudWatch::Alarm": 3,
    });
    t.hasOutput("AgentApiUrl", {});
  });

  test("function: Node 22, arm64, 512 MB, 29 s, reserved concurrency 2, active tracing, no layer", () => {
    const fn = only(t, "AWS::Lambda::Function").Properties;
    expect(fn.Runtime).toBe("nodejs22.x");
    expect(fn.Architectures).toEqual(["arm64"]);
    expect(fn.MemorySize).toBe(512);
    expect(fn.Timeout).toBe(29);
    expect(fn.ReservedConcurrentExecutions).toBe(2);
    expect(fn.TracingConfig).toEqual({ Mode: "Active" });
    expect(fn.Handler).toBe("index.handler");
    expect(fn.Layers).toBeUndefined();
    expect(fn.LoggingConfig).toEqual({
      LogGroup: { Ref: logicalId(t, "AWS::Logs::LogGroup") },
    });
  });

  test("environment: names and settings only, no secret, no key value, no dynamic reference", () => {
    const vars = (
      only(t, "AWS::Lambda::Function").Properties.Environment as {
        Variables: Record<string, unknown>;
      }
    ).Variables;
    expect(vars).toEqual({
      DATA_API_URL,
      KEY_PARAMETER_NAME: "/oracle-la/agent/anthropic-api-key",
      HISTORY_SECRET_PARAMETER_NAME: "/oracle-la/agent/history-signing-secret",
      AGENT_PROVIDER: "anthropic",
      AGENT_MODEL: "sonnet-5.5",
      AGENT_EFFORT: "low",
      AGENT_MAX_TOOL_TURNS: "5",
      AGENT_MAX_TOKENS: "80000",
      AGENT_MAX_OUTPUT_TOKENS: "2048",
      AGENT_TIME_BUDGET_MS: "25000",
      POWERTOOLS_SERVICE_NAME: "oracle-la-agent",
      POWERTOOLS_METRICS_NAMESPACE: "OracleLa",
      NODE_OPTIONS: "--enable-source-maps",
    });
    // A name like a key or secret (a whole word of the name; AGENT_MAX_TOKENS counts model tokens) is one of the
    // two *_PARAMETER_NAME variables, and holds only an SSM parameter name under /oracle-la/agent/.
    const secretLike = Object.keys(vars).filter((n) =>
      /(^|_)(API_KEY|KEY|SECRET|TOKEN|PASS|PASSWORD|CREDENTIALS?|AUTH|AUTHORIZATION)(_|$)/.test(
        n,
      ),
    );
    expect(secretLike).toEqual([
      "KEY_PARAMETER_NAME",
      "HISTORY_SECRET_PARAMETER_NAME",
    ]);
    for (const [name, value] of Object.entries(vars)) {
      expect(typeof value, name).toBe("string"); // literal: no token, no reference
      const v = value as string;
      if (secretLike.includes(name))
        expect(v).toMatch(/^\/oracle-la\/agent\/[a-z-]+$/);
      expect(v).not.toMatch(/sk-ant|\{\{resolve:/);
      expect(v).not.toMatch(/[A-Za-z0-9+=_-]{32,}/); // no key-shaped run (32+ base64 or hex characters)
    }
  });

  test("no SecretValue, no secure parameter, no Secrets Manager; only plain SSM parameter types read at deploy", () => {
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toMatch(/\{\{resolve:/);
    expect(json).not.toMatch(/SecretsManager|ssm-secure|SecureString/);
    const params = t.toJSON().Parameters as Record<
      string,
      { Type: string; Default?: string }
    >;
    expect(
      Object.entries(params)
        .filter(([k]) => k !== "BootstrapVersion")
        .map(([, p]) => p)
        .map((p) => [p.Default, p.Type])
        .sort(),
    ).toEqual(
      [APP_ID_PARAM, AUTHORIZER_PARAM, TOPIC_PARAM]
        .sort()
        .map((d) => [d, "AWS::SSM::Parameter::Value<String>"]),
    );
    const source = readFileSync(`${appDir}cdk/lib/agent-api-stack.ts`, "utf8");
    expect(source).not.toMatch(/SecretValue|\.secrets|readFileSync/);
  });

  test("role: basic execution and X-Ray, and exactly ssm:GetParameter on the two parameter ARNs", () => {
    const role = only(t, "AWS::IAM::Role").Properties;
    expect(role.ManagedPolicyArns).toEqual([
      {
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            ":iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        ],
      },
    ]);
    expect(role.AssumeRolePolicyDocument).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
        },
      ],
    });
    const policy = only(t, "AWS::IAM::Policy").Properties as {
      PolicyDocument: { Statement: unknown[] };
      Roles: unknown[];
    };
    expect(policy.Roles).toEqual([{ Ref: logicalId(t, "AWS::IAM::Role") }]);
    expect(policy.PolicyDocument.Statement).toEqual([
      {
        Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
        Effect: "Allow",
        Resource: "*",
      },
      {
        Action: "ssm:GetParameter",
        Effect: "Allow",
        Resource: PARAMETER_ARNS,
      },
    ]);
    expect([KEY_PARAMETER_NAME, HISTORY_SECRET_PARAMETER_NAME]).toEqual([
      "/oracle-la/agent/anthropic-api-key",
      "/oracle-la/agent/history-signing-secret",
    ]);
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toMatch(
      /kms:|s3:|bedrock|GetParametersByPath|GetParameters"|ssm:\*/i,
    );
  });

  test("log group: 90 days, removed with the stack", () => {
    const lg = only(t, "AWS::Logs::LogGroup");
    expect(lg.Properties.RetentionInDays).toBe(90);
    expect(lg.DeletionPolicy).toBe("Delete");
  });

  test("HTTP API: CORS for the CRM and Explorer branch origins only, POST/GET/OPTIONS; $default stage throttled 1/2", () => {
    expect(AGENT_API_CLIENTS).toEqual([...AGENT_CLIENTS].sort());
    const appId = paramFor(t, APP_ID_PARAM);
    const origin = (branch: string) => ({
      "Fn::Join": [
        "",
        [`https://${branch}.`, { Ref: appId }, ".amplifyapp.com"],
      ],
    });
    const branchOf = (name: string) =>
      clientsFile.clients.find((c) => c.name === name)!.amplifyBranch!;
    const apiRes = only(t, "AWS::ApiGatewayV2::Api").Properties;
    expect(apiRes.Name).toBe("oracle-la-agent-api");
    expect(apiRes.ProtocolType).toBe("HTTP");
    expect(apiRes.CorsConfiguration).toEqual({
      AllowOrigins: [origin(branchOf("crm")), origin(branchOf("explorer"))],
      AllowMethods: ["POST", "GET", "OPTIONS"],
      AllowHeaders: ["authorization", "content-type"],
      MaxAge: 600,
    });
    const stage = only(t, "AWS::ApiGatewayV2::Stage").Properties;
    expect(stage.StageName).toBe("$default");
    expect(stage.AutoDeploy).toBe(true);
    expect(stage.DefaultRouteSettings).toEqual({
      ThrottlingRateLimit: 1,
      ThrottlingBurstLimit: 2,
    });
  });

  test("routes: POST /agent/answer and GET /agent/warm, both behind the shared authorizer (cache 300 s)", () => {
    const authId = logicalId(t, "AWS::ApiGatewayV2::Authorizer");
    const routes = resources(t, "AWS::ApiGatewayV2::Route").map(
      (r) => r.Properties,
    );
    expect(routes.map((r) => r.RouteKey).sort()).toEqual([
      "GET /agent/warm",
      "POST /agent/answer",
    ]);
    for (const r of routes) {
      expect(r.AuthorizationType).toBe("CUSTOM");
      expect(r.AuthorizerId).toEqual({ Ref: authId });
    }
    const auth = only(t, "AWS::ApiGatewayV2::Authorizer").Properties;
    expect(auth).toMatchObject({
      AuthorizerType: "REQUEST",
      AuthorizerPayloadFormatVersion: "2.0",
      EnableSimpleResponses: true,
      AuthorizerResultTtlInSeconds: 300,
      IdentitySource: ["$request.header.Authorization"],
    });
    // The authorizer is the data API's, by ARN from SSM.
    expect(JSON.stringify(auth.AuthorizerUri)).toContain(
      JSON.stringify({ Ref: paramFor(t, AUTHORIZER_PARAM) }),
    );
  });

  test("permissions: the shared authorizer's scoped to this API's authorizers; the agent function's scoped to this API's two routes", () => {
    const apiId = logicalId(t, "AWS::ApiGatewayV2::Api");
    const fnId = logicalId(t, "AWS::Lambda::Function");
    const perms = resources(t, "AWS::Lambda::Permission").map(
      (p) => p.Properties,
    );
    for (const p of perms) {
      expect(p.Action).toBe("lambda:InvokeFunction");
      expect(p.Principal).toBe("apigateway.amazonaws.com");
    }
    const execArn = (suffix: string) => ({
      "Fn::Join": [
        "",
        [
          "arn:",
          { Ref: "AWS::Partition" },
          `:execute-api:eu-north-1:${ACCOUNT}:`,
          { Ref: apiId },
          suffix,
        ],
      ],
    });
    const [authPerm, ...fnPerms] = [
      ...perms.filter((p) =>
        JSON.stringify(p.SourceArn).includes("/authorizers/"),
      ),
      ...perms.filter(
        (p) => !JSON.stringify(p.SourceArn).includes("/authorizers/"),
      ),
    ];
    expect(fnPerms).toHaveLength(2);
    expect(authPerm!.FunctionName).toEqual({
      Ref: paramFor(t, AUTHORIZER_PARAM),
    });
    const authArn = authPerm!.SourceArn as {
      "Fn::Join": [string, unknown[]];
    };
    expect(authArn["Fn::Join"][1].slice(0, 4)).toEqual(
      execArn("")["Fn::Join"][1].slice(0, 4),
    );
    expect(authArn["Fn::Join"][1].slice(4)).toEqual([
      "/authorizers/",
      { Ref: logicalId(t, "AWS::ApiGatewayV2::Authorizer") },
    ]);
    for (const p of fnPerms)
      expect(p.FunctionName).toEqual({ "Fn::GetAtt": [fnId, "Arn"] });
    expect(fnPerms.map((p) => p.SourceArn)).toEqual(
      expect.arrayContaining([
        execArn("/*/*/agent/answer"),
        execArn("/*/*/agent/warm"),
      ]),
    );
    expect(
      Annotations.fromStack(stack).findWarning(
        "*",
        Match.stringLikeRegexp("[Pp]ermission"),
      ),
    ).toEqual([]);
  });

  test("alarms: 5xx >= 1 in 5 min, and AgentAnswerUsd (service dimension) Sum over 1 day > 2 and over 5 min >= 1; all to the alert topic", () => {
    const topic = { Ref: paramFor(t, TOPIC_PARAM) };
    const alarms = Object.fromEntries(
      resources(t, "AWS::CloudWatch::Alarm").map((a) => [
        a.Properties.AlarmName,
        a.Properties,
      ]),
    );
    expect(Object.keys(alarms).sort()).toEqual([
      "oracle-la-agent-http-api-5xx",
      "oracle-la-agent-usd-burst",
      "oracle-la-agent-usd-per-day",
    ]);
    expect(alarms["oracle-la-agent-http-api-5xx"]).toMatchObject({
      Namespace: "AWS/ApiGateway",
      MetricName: "5xx",
      Dimensions: [
        {
          Name: "ApiId",
          Value: { Ref: logicalId(t, "AWS::ApiGatewayV2::Api") },
        },
        { Name: "Stage", Value: "$default" },
      ],
      Statistic: "Sum",
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [topic],
    });
    expect(alarms["oracle-la-agent-usd-per-day"]).toMatchObject({
      Namespace: "OracleLa",
      MetricName: "AgentAnswerUsd",
      Dimensions: [{ Name: "service", Value: "oracle-la-agent" }],
      Statistic: "Sum",
      Period: 86_400,
      EvaluationPeriods: 1,
      Threshold: 2,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [topic],
    });
    expect(alarms["oracle-la-agent-usd-burst"]).toMatchObject({
      Namespace: "OracleLa",
      MetricName: "AgentAnswerUsd",
      Dimensions: [{ Name: "service", Value: "oracle-la-agent" }],
      Statistic: "Sum",
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [topic],
    });
  });

  test("bundle: the handler alone, without @duckdb (no DuckDB code or module in the asset)", () => {
    const code = only(t, "AWS::Lambda::Function").Properties.Code as {
      S3Key: string;
    };
    const dir = join(outdir, `asset.${code.S3Key.replace(/\.zip$/, "")}`);
    expect(readdirSync(dir).sort()).toEqual(["index.js", "index.js.map"]);
    const js = readFileSync(join(dir, "index.js"), "utf8");
    const map = JSON.parse(readFileSync(join(dir, "index.js.map"), "utf8")) as {
      sources: string[];
    };
    expect(js).not.toMatch(/@duckdb|duckdb\.node|DuckDBInstance/);
    expect(map.sources.filter((s) => /duckdb/i.test(s))).toEqual([]);
    expect(
      map.sources.some((s) => s.endsWith("apps/agent-api/src/handler.ts")),
    ).toBe(true);
  });
});

describe("OracleLaAgentApi props", () => {
  test("a data API URL that is not an execute-api URL in eu-north-1 is refused", () => {
    for (const bad of [
      "",
      "http://abcde12345.execute-api.eu-north-1.amazonaws.com",
      "https://abcde12345.execute-api.us-east-1.amazonaws.com",
      `${DATA_API_URL}/trpc`,
      "https://example.com",
    ])
      expect(() => newStack(noBundling(), { dataApiUrl: bad })).toThrow(
        /dataApiUrl/,
      );
  });

  test("crm and explorer must both be browser clients in clients.json", () => {
    expect(() =>
      newStack(noBundling(), {
        clients: clientsFile.clients.filter((c) => c.name !== "explorer"),
      }),
    ).toThrow(/"explorer"/);
    expect(() =>
      newStack(noBundling(), {
        clients: [
          { name: "crm", browser: false },
          { name: "explorer", amplifyBranch: "explorer" },
        ],
      }),
    ).toThrow(/"crm"/);
  });
});

describe("CDK app (bin/app.ts)", () => {
  const run = (envOver: Record<string, string>) => {
    const out = mkdtempSync(join(tmpdir(), "agent-api-app-"));
    try {
      execFileSync(process.execPath, ["cdk/bin/app.ts"], {
        cwd: appDir,
        env: {
          PATH: process.env.PATH,
          CDK_OUTDIR: out,
          ...envOver,
        },
        stdio: "pipe",
      });
      return JSON.parse(
        readFileSync(join(out, "OracleLaAgentApi.template.json"), "utf8"),
      ) as {
        Resources: Record<string, Res & { Properties: { Tags?: unknown } }>;
      };
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  };
  const context = (c: Record<string, unknown>) =>
    JSON.stringify({ "aws:cdk:bundling-stacks": [], ...c });

  test("fails clearly without CDK_DEFAULT_ACCOUNT or without the dataApiUrl context", () => {
    expect(() =>
      run({ CDK_CONTEXT_JSON: context({ dataApiUrl: DATA_API_URL }) }),
    ).toThrow(/CDK_DEFAULT_ACCOUNT is not set/);
    expect(() =>
      run({ CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_CONTEXT_JSON: context({}) }),
    ).toThrow(/context dataApiUrl is not set/);
  }, 60_000);

  test("synthesizes OracleLaAgentApi in eu-north-1 with the project_name tag", () => {
    const tpl = run({
      CDK_DEFAULT_ACCOUNT: ACCOUNT,
      CDK_CONTEXT_JSON: context({ dataApiUrl: DATA_API_URL }),
    });
    const fn = Object.values(tpl.Resources).find(
      (r) => r.Type === "AWS::Lambda::Function",
    )!;
    expect(fn.Properties.Tags).toEqual([
      { Key: "project_name", Value: "oracle-la-pipeline" },
    ]);
    expect(JSON.stringify(tpl)).toContain(
      ":execute-api:eu-north-1:123456789012:",
    );
  }, 60_000);
});
