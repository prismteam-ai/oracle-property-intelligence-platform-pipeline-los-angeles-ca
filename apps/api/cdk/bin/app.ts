/** Pipeline data API CDK app: account guards (alerts, budget) and the private DuckDB data API. */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import * as cdk from "aws-cdk-lib";
import { type ClientsFile, parseClients } from "../lib/clients.ts";
import { DataApiStack, type PermitFileEnv } from "../lib/data-api-stack.ts";
import { GuardsStack } from "../lib/guards-stack.ts";

const repoRoot = new URL("../../../../", import.meta.url).pathname;
// The AWS account comes from the CDK CLI (the credentials in use), never from source.
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account)
  throw new Error(
    "CDK_DEFAULT_ACCOUNT is not set: run this app through the CDK CLI with credentials for the target account",
  );
const env = { account, region: "eu-north-1" };
const clientsFile = parseClients(
  JSON.parse(
    readFileSync(new URL("../clients.json", import.meta.url), "utf8"),
  ) as ClientsFile,
);
const clients = clientsFile.clients;
// Token hashes per client: gitignored, never in tracked files or outputs.
const hashes = JSON.parse(
  readFileSync(`${repoRoot}.secrets/api-clients.json`, "utf8"),
) as Record<string, { tokenSha256: string }>;
const apiClients = clients.map((c) => {
  const h = hashes[c.name]?.tokenSha256;
  if (!h || !/^[0-9a-f]{64}$/.test(h))
    throw new Error(
      `missing token hash for API client "${c.name}" in .secrets/api-clients.json`,
    );
  return { ...c, tokenSha256: h };
});
const history = readFileSync(`${repoRoot}runs/run_history.jsonl`, "utf8")
  .trim()
  .split("\n")
  .map(
    (l) =>
      JSON.parse(l) as {
        run_id: string;
        parquet_sha256: string;
        parquet_path: string;
        permit_files?: Array<{ role: string; path: string; sha256: string }>;
      },
  );
const latest = history.at(-1)!;
// The API serves a permit run: the latest row must list its permit Parquet files (each keeps its file name
// under runs/<run_id>/ in the bucket, as the property Parquet does).
if (!latest.permit_files?.length)
  throw new Error(
    `the latest run in runs/run_history.jsonl (${latest.run_id}) has no permit_files; the data API serves a permit run`,
  );
const permitFiles: PermitFileEnv[] = latest.permit_files.map((f) => ({
  role: f.role,
  file: basename(f.path),
  sha256: f.sha256,
}));

const app = new cdk.App();
// The alert address lives only in the gitignored .secrets/alerts.json (never in source or tracked files).
const alertsFile = `${repoRoot}.secrets/alerts.json`;
const alertEmail = existsSync(alertsFile)
  ? (JSON.parse(readFileSync(alertsFile, "utf8")) as { alertEmail?: string })
      .alertEmail
  : undefined;
new GuardsStack(app, "OracleLaGuards", { env, alertEmail });
new DataApiStack(app, "OracleLaDataApi", {
  env,
  repoRoot,
  runId: latest.run_id,
  parquetSha256: latest.parquet_sha256,
  // The run's Parquet keeps its file name under runs/<run_id>/ in the bucket.
  parquetFile: basename(latest.parquet_path),
  permitFiles,
  clients: apiClients,
  amplifyAppIdParameter: clientsFile.amplifyAppIdParameter,
});
for (const s of app.node.children)
  if (s instanceof cdk.Stack)
    cdk.Tags.of(s).add("project_name", "oracle-la-pipeline");
