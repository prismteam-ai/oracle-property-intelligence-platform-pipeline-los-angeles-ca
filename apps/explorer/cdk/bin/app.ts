import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import { ExplorerWebStack } from "../lib/explorer-web-stack.ts";

const root = new URL("../../../../", import.meta.url).pathname;
const secrets = JSON.parse(
  readFileSync(`${root}.secrets/explorer.json`, "utf8"),
);
// The AWS account comes from the CDK CLI (the credentials in use), never from source.
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account)
  throw new Error(
    "CDK_DEFAULT_ACCOUNT is not set: run this app through the CDK CLI with credentials for the target account",
  );
const app = new cdk.App();
// Host mode (cdk.json context): the SSM parameter naming the host Amplify app. An empty value
// (-c hostAppIdParameter=) gives the Explorer its own app.
const hostAppIdParameter: string | undefined =
  app.node.tryGetContext("hostAppIdParameter") || undefined;
if (
  hostAppIdParameter !== undefined &&
  !/^\/[\w./-]+$/.test(hostAppIdParameter)
)
  throw new Error(
    `hostAppIdParameter must be an SSM parameter name, got "${hostAppIdParameter}"`,
  );
const stack = new ExplorerWebStack(app, "OracleLaExplorerWeb", {
  env: { account, region: "eu-north-1" },
  siteDir: app.node.tryGetContext("siteDir") ?? `${root}apps/explorer/dist`,
  basicUser: secrets.basicUser,
  basicPass: secrets.basicPass,
  hostAppIdParameter,
});
cdk.Tags.of(stack).add("project_name", "oracle-la-pipeline");
