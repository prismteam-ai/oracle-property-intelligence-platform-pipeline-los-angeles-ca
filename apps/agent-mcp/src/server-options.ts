/**
 * How the stdio MCP server gets its data:
 * - hosted: `--api-url <data API URL> --token-file <path>`: the tools read the hosted data API through the agent's
 *   HTTP adapter (at most 2 calls in flight, one retry, gaps), with the "mcp" API client's own token. The token
 *   comes from a key file the caller names (no default path, no environment variable; the token is never an
 *   argument): JSON { "apiToken": "<token>" }, a regular file with mode exactly 0600, checked like the Anthropic
 *   key file (key-file.ts); a refusal names the path, the mode and the reason, never the content.
 * - local (no option): the latest run of ORACLE_REPO_DIR (default this checkout), in process (local-data.ts).
 */
import { parseArgs } from "node:util";
import {
  httpDataQueries,
  readSecretField,
  SecretFileError,
  type DataQueries,
  type HttpDataQueriesOptions,
  type KeyFileProblem,
} from "@oracle-la/agent";

export const SERVER_USAGE =
  "usage: node src/server.ts [--api-url <data API URL> --token-file <path of the mcp client's token file>]";

export class ServerUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerUsageError";
  }
}

/** Refusal to start the hosted mode: the token file's path, problem and mode; never its content. */
export class McpTokenFileError extends SecretFileError {
  constructor(
    path: string,
    problem: KeyFileProblem,
    detail: string,
    mode: string | null,
  ) {
    super(
      `refusing to start the MCP server: the token file ${path} ${detail}`,
      path,
      problem,
      mode,
    );
    this.name = "McpTokenFileError";
  }
}

export type ServerOptions =
  { mode: "local" } | { mode: "hosted"; apiUrl: string; tokenFile: string };

/** Parse the server's arguments (strict); throws ServerUsageError naming the missing or wrong option. */
export function parseServerArgs(argv: readonly string[]): ServerOptions {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        "api-url": { type: "string" },
        "token-file": { type: "string" },
      },
    }));
  } catch (err) {
    throw new ServerUsageError(
      err instanceof Error ? err.message : String(err),
    );
  }
  const apiUrl = values["api-url"];
  const tokenFile = values["token-file"];
  if (apiUrl === undefined && tokenFile === undefined) return { mode: "local" };
  if (!apiUrl)
    throw new ServerUsageError(
      "--api-url <data API URL> is required with --token-file",
    );
  if (!tokenFile)
    throw new ServerUsageError(
      "--token-file <path> is required with --api-url (the mcp client's token file, mode 0600)",
    );
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new ServerUsageError(`--api-url is not a URL (got ${apiUrl})`);
  }
  if (url.protocol !== "https:")
    throw new ServerUsageError("--api-url must be an https URL");
  return { mode: "hosted", apiUrl: url.origin, tokenFile };
}

/** The "mcp" client's token from its file (see the header comment); McpTokenFileError when refused. */
export function readMcpTokenFile(path: string): string {
  return readSecretField(
    path,
    "apiToken",
    '{ "apiToken": "<token>" }',
    (problem, detail, mode) =>
      new McpTokenFileError(path, problem, detail, mode),
  );
}

/** The hosted mode's queries: the HTTP adapter with the token read from its file. */
export function hostedQueries(
  opts: { apiUrl: string; tokenFile: string },
  extra: Pick<HttpDataQueriesOptions, "fetch"> = {},
): DataQueries {
  return httpDataQueries({
    apiUrl: opts.apiUrl,
    apiToken: readMcpTokenFile(opts.tokenFile),
    ...extra,
  });
}
