/**
 * Local stdio MCP server over the latest run in this checkout (`pnpm --filter @oracle-la/agent-mcp mcp`).
 * ORACLE_REPO_DIR may point at another checkout that has the run's data/ files. stdout carries the protocol only;
 * messages go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./create-server.ts";
import { openLocalData } from "./local-data.ts";

try {
  const data = await openLocalData({ repoRoot: process.env.ORACLE_REPO_DIR });
  const server = createMcpServer(data.queries);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `oracle-la-agent MCP server on stdio, run ${data.runId}\n`,
  );
} catch (err) {
  process.stderr.write(
    `oracle-la-agent MCP server failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
}
