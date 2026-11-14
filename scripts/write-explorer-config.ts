/**
 * Write <dist>/config.json for the deployed Explorer: the absolute data API URL (OracleLaDataApi output
 * `ApiUrl`), the agent API URL (OracleLaAgentApi output `AgentApiUrl`) and the Explorer's API token (from the
 * gitignored .secrets/explorer.json). The Explorer has no leads API URL and no map key. Prints nothing secret.
 * The stack outputs are read with the AWS CLI profile named in AWS_PROFILE; the script stops if it is unset.
 * When the OracleLaAgentApi stack does not exist, config.json has no agentApiUrl and the Explorer hides its
 * "Ask the agent" tab; any other failure to read it stops the script.
 * Usage: AWS_PROFILE=<profile> node scripts/write-explorer-config.ts apps/explorer/dist
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REGION = "eu-north-1";
/** An HTTP API's default endpoint in the stacks' region, as both outputs give it. */
export const API_URL =
  /^https:\/\/[a-z0-9]+\.execute-api\.eu-north-1\.amazonaws\.com$/;

/** Runs the AWS CLI with these arguments and returns its stdout (throws on a non-zero exit, stderr in the error). */
export type AwsCli = (args: string[]) => string;

export class StackMissingError extends Error {
  constructor(stack: string) {
    super(`stack ${stack} does not exist`);
    this.name = "StackMissingError";
  }
}

/** One output of a stack; StackMissingError when the stack does not exist. */
export function stackOutput(
  aws: AwsCli,
  profile: string,
  stack: string,
  key: string,
): string {
  let out: string;
  try {
    out = aws([
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      stack,
      "--profile",
      profile,
      "--region",
      REGION,
      "--query",
      `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`,
      "--output",
      "text",
    ]);
  } catch (err) {
    const stderr = String(
      (err as { stderr?: unknown }).stderr ?? (err as Error).message ?? "",
    );
    if (/Stack with id \S+ does not exist/.test(stderr))
      throw new StackMissingError(stack);
    throw err;
  }
  const value = out.trim();
  if (!API_URL.test(value))
    throw new Error(`unexpected ${stack} ${key} ${value}`);
  return value;
}

export interface ExplorerConfig {
  client: "explorer";
  apiUrl: string;
  apiToken: string;
  agentApiUrl?: string;
}

/** config.json's content: agentApiUrl only when the agent stack exists. */
export function explorerConfig(
  aws: AwsCli,
  profile: string,
  apiToken: string,
): ExplorerConfig {
  const apiUrl = stackOutput(aws, profile, "OracleLaDataApi", "ApiUrl");
  let agentApiUrl: string | undefined;
  try {
    agentApiUrl = stackOutput(aws, profile, "OracleLaAgentApi", "AgentApiUrl");
  } catch (err) {
    if (!(err instanceof StackMissingError)) throw err;
  }
  return {
    client: "explorer",
    apiUrl,
    apiToken,
    ...(agentApiUrl ? { agentApiUrl } : {}),
  };
}

const awsCli: AwsCli = (args) =>
  execFileSync("aws", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function main(argv: string[], env: NodeJS.ProcessEnv): void {
  const dist = argv[0];
  if (!dist) throw new Error("usage: write-explorer-config.ts <dist-dir>");
  if (!existsSync(join(dist, "index.html")))
    throw new Error(`${dist} has no index.html: build the Explorer first`);
  const profile = env.AWS_PROFILE;
  if (!profile)
    throw new Error(
      "AWS_PROFILE is not set: name the AWS CLI profile for the target account, e.g. AWS_PROFILE=<profile> node scripts/write-explorer-config.ts <dist-dir>",
    );
  const s = JSON.parse(
    readFileSync(new URL("../.secrets/explorer.json", import.meta.url), "utf8"),
  ) as { apiToken?: string };
  if (!s.apiToken) throw new Error(".secrets/explorer.json has no apiToken");
  const config = explorerConfig(awsCli, profile, s.apiToken);
  writeFileSync(join(dist, "config.json"), JSON.stringify(config));
  console.log(
    `wrote ${join(dist, "config.json")} (apiUrl ${config.apiUrl}; agentApiUrl ${config.agentApiUrl ?? "none: the Ask the agent tab is hidden"}; token not shown)`,
  );
}

// Run only as a script (the test imports the functions above).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2), process.env);
