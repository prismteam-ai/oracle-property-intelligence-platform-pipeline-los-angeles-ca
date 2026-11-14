/**
 * The stdio MCP server (`pnpm --filter @oracle-la/agent-mcp mcp`, or `node src/server.ts`):
 * - `--api-url <data API URL> --token-file <path>`: over the hosted data API with the "mcp" client's token
 *   (server-options.ts); no run files are needed on this machine.
 * - no option: over the latest run in this checkout; ORACLE_REPO_DIR may point at another checkout that has the
 *   run's data/ files.
 * stdout carries the protocol only; messages go to stderr. A usage error exits 2, a refusal to start exits 1.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./create-server.ts";
import { openLocalData } from "./local-data.ts";
import {
  SERVER_USAGE,
  ServerUsageError,
  hostedQueries,
  parseServerArgs,
} from "./server-options.ts";

try {
  const options = parseServerArgs(process.argv.slice(2));
  if (options.mode === "hosted") {
    const server = createMcpServer(hostedQueries(options));
    await server.connect(new StdioServerTransport());
    process.stderr.write(
      `oracle-la-agent MCP server on stdio, data API ${options.apiUrl}\n`,
    );
  } else {
    const data = await openLocalData({ repoRoot: process.env.ORACLE_REPO_DIR });
    const server = createMcpServer(data.queries);
    await server.connect(new StdioServerTransport());
    process.stderr.write(
      `oracle-la-agent MCP server on stdio, run ${data.runId}\n`,
    );
  }
} catch (err) {
  if (err instanceof ServerUsageError) {
    process.stderr.write(`${err.message}\n${SERVER_USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(
      `oracle-la-agent MCP server failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
