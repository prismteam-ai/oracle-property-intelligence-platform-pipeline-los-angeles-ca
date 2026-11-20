/**
 * The MCP server: the agent's tools over any DataQueries. Bindings checked against the installed
 * @modelcontextprotocol/sdk 1.32.2 (dist/esm/server/mcp.d.ts: McpServer(serverInfo, options),
 * registerTool(name, { description, inputSchema }, cb); inputSchema accepts a zod v4 object).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  STANDARD_GAPS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  runTool,
  toolSchemas,
  type DataQueries,
} from "@oracle-la/agent";

export const SERVER_INFO = {
  name: "oracle-la-agent",
  version: "0.1.0",
} as const;

export const SERVER_INSTRUCTIONS = [
  "Tools over the Oracle LA data: parcels, roof age (assessor year-built proxy unless PERMIT), City of Los Angeles permits (long-open: roofing work only) with contractor businesses, place names resolved from the run's own parcels, and the run's sources.",
  "Durations are in days: N years = Math.round(N × 365.25); the default long-open minimum is 1,826 days.",
  "No people data: owners, residents and contact details are neither collected nor served.",
  "Every result lists the records it cites (source name and collection time; permits and contractor rows cite their source once, from the run's sources) and its gaps.",
  `Standing gaps: ${STANDARD_GAPS.join(" ")}`,
].join("\n");

/** One MCP tool per agent tool; results are JSON text { result, records, gaps }. */
export function createMcpServer(queries: DataQueries): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
  });
  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: toolSchemas[name] },
      async (args: unknown) => {
        const o = await runTool(name, args, queries);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                result: o.content,
                records: o.records,
                gaps: o.gaps,
              }),
            },
          ],
          ...(o.ok ? {} : { isError: true }),
        };
      },
    );
  }
  return server;
}
