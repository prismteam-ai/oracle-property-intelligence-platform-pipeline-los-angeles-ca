/** CDK app for the hosted agent: OracleLaAgentApi (the agent Lambda, its HTTP API and its alarms). */
import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import {
  type ClientsFile,
  parseClients,
} from "../../../api/cdk/lib/clients.ts";
import { AgentApiStack } from "../lib/agent-api-stack.ts";

const repoRoot = new URL("../../../../", import.meta.url).pathname;
// The AWS account comes from the CDK CLI (the credentials in use), never from source.
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account)
  throw new Error(
    "CDK_DEFAULT_ACCOUNT is not set: run this app through the CDK CLI with credentials for the target account",
  );
const app = new cdk.App();
// OracleLaDataApi publishes its URL only as the stack output ApiUrl (no export, no SSM parameter), so it is
// passed at synth: -c dataApiUrl=<that output>. It is not kept in a tracked file.
const dataApiUrl: unknown = app.node.tryGetContext("dataApiUrl");
if (typeof dataApiUrl !== "string" || dataApiUrl === "")
  throw new Error(
    "context dataApiUrl is not set: pass -c dataApiUrl=<the ApiUrl output of OracleLaDataApi>",
  );
// The same client list as the data API: the CORS origins of the two browser clients the agent serves.
const clientsFile = parseClients(
  JSON.parse(
    readFileSync(`${repoRoot}apps/api/cdk/clients.json`, "utf8"),
  ) as ClientsFile,
);
const stack = new AgentApiStack(app, "OracleLaAgentApi", {
  env: { account, region: "eu-north-1" },
  repoRoot,
  dataApiUrl,
  clients: clientsFile.clients,
  amplifyAppIdParameter: clientsFile.amplifyAppIdParameter,
});
cdk.Tags.of(stack).add("project_name", "oracle-la-pipeline");
