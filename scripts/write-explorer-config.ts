/**
 * Write <dist>/config.json for the deployed Explorer: the absolute data API URL (OracleLaDataApi output
 * `ApiUrl`) and the Explorer's API token (from the gitignored .secrets/explorer.json). The Explorer has no
 * leads API URL and no map key. Prints nothing secret. The stack output is read with the AWS CLI profile
 * named in AWS_PROFILE; the script stops if it is unset.
 * Usage: AWS_PROFILE=<profile> node scripts/write-explorer-config.ts apps/explorer/dist
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2];
if (!dist) throw new Error("usage: write-explorer-config.ts <dist-dir>");
if (!existsSync(join(dist, "index.html")))
  throw new Error(`${dist} has no index.html: build the Explorer first`);
const profile = process.env.AWS_PROFILE;
if (!profile)
  throw new Error(
    "AWS_PROFILE is not set: name the AWS CLI profile for the target account, e.g. AWS_PROFILE=<profile> node scripts/write-explorer-config.ts <dist-dir>",
  );
const s = JSON.parse(
  readFileSync(new URL("../.secrets/explorer.json", import.meta.url), "utf8"),
) as { apiToken?: string };
if (!s.apiToken) throw new Error(".secrets/explorer.json has no apiToken");
const apiUrl = execFileSync(
  "aws",
  [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    "OracleLaDataApi",
    "--profile",
    profile,
    "--region",
    "eu-north-1",
    "--query",
    "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue",
    "--output",
    "text",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
if (
  !/^https:\/\/[a-z0-9]+\.execute-api\.eu-north-1\.amazonaws\.com$/.test(apiUrl)
)
  throw new Error(`unexpected ApiUrl ${apiUrl}`);
writeFileSync(
  join(dist, "config.json"),
  JSON.stringify({ client: "explorer", apiUrl, apiToken: s.apiToken }),
);
console.log(
  `wrote ${join(dist, "config.json")} (apiUrl ${apiUrl}; token not shown)`,
);
