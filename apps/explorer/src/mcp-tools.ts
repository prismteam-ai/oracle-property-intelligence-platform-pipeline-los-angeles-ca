/**
 * The MCP tab's data: the tools exactly as the local stdio MCP server registers them
 * (apps/agent-mcp/src/create-server.ts: one tool per TOOL_NAMES entry, description TOOL_DESCRIPTIONS[name], input
 * schema toolSchemas[name]), imported from the agent's own tool definitions, and one live example run through the
 * same tool code over the hosted data API (httpDataQueries, the adapter the hosted MCP server mode uses), shown in
 * the MCP tool-result shape the server returns.
 */
import {
  httpDataQueries,
  type HttpDataQueriesOptions,
} from "../../../packages/agent/src/http-data.ts";
import {
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  runTool,
  toolSchemas,
  type ToolName,
} from "../../../packages/agent/src/tools.ts";

/** The server's name (create-server.ts SERVER_INFO.name; checked equal by the Explorer's unit test). */
export const MCP_SERVER_NAME = "oracle-la-agent";

export interface McpToolListing {
  name: ToolName;
  description: string;
  /** The input JSON Schema an MCP client receives in tools/list. */
  inputSchema: Record<string, unknown>;
}

/**
 * The input JSON Schema of one tool as the MCP SDK 1.32.2 lists it in tools/list (server/mcp.js and
 * zod-json-schema-compat.js: zod v4's toJSONSchema with target draft-7 and the input side). The schema's own
 * toJSONSchema is used: zod is the agent package's dependency, not the Explorer's.
 */
export function mcpInputSchema(name: ToolName): Record<string, unknown> {
  return toolSchemas[name].toJSONSchema({
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
}

export function mcpTools(): McpToolListing[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: mcpInputSchema(name),
  }));
}

/**
 * The live example: the radius query (roofs older than 15 years within 5 miles of Van Nuys), five parcels. The center
 * is the agent's Van Nuys center, as places.resolve gives it (the median of the postal city's parcels).
 */
export const EXAMPLE = {
  tool: "search_aged_roofs" as const,
  arguments: {
    lat: 34.20155,
    lon: -118.45361,
    radius_miles: 5,
    threshold_years: 15,
    limit: 5,
  },
};

/** A tools/call result as the server returns it: JSON text { result, records, gaps }; isError when the tool failed. */
export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

/** Runs a tool through the agent's tool code over the given queries and wraps it as the MCP server does. */
export async function callTool(
  name: ToolName,
  args: unknown,
  queries: Parameters<typeof runTool>[2],
): Promise<McpToolResult> {
  const o = await runTool(name, args, queries);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          result: o.content,
          records: o.records,
          gaps: o.gaps,
        }),
      },
    ],
    ...(o.ok ? {} : { isError: true as const }),
  };
}

/**
 * The example over the hosted data API with the Explorer's token, through the same adapter as the MCP server's
 * hosted mode (at most 1 data API call in flight, one retry, a gap when a route is not read).
 */
export function runExample(cfg: {
  apiUrl: string;
  apiToken: string;
  /** Default the global fetch; tests pass a fake data API. */
  fetch?: HttpDataQueriesOptions["fetch"];
}): Promise<McpToolResult> {
  return callTool(
    EXAMPLE.tool,
    EXAMPLE.arguments,
    httpDataQueries({
      apiUrl: cfg.apiUrl,
      apiToken: cfg.apiToken,
      ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    }),
  );
}
