/**
 * The MCP tab against the real MCP server (apps/agent-mcp create-server.ts) over the SDK's in-memory transport:
 * the tools the tab lists are the server's tools/list (name, description, input schema, equal as JSON values), and the
 * live example's result is what the server's tools/call returns for the same arguments over the same data API.
 * The data API is the agent package's fake (no network). The MCP SDK is the agent-mcp app's dependency, so its
 * client and transport are imported from that app's node_modules (the Explorer does not depend on the SDK).
 */
import { beforeEach, describe, expect, test } from "vitest";
import { Client } from "../../agent-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../../agent-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import {
  SERVER_INFO,
  createMcpServer,
} from "../../agent-mcp/src/create-server.ts";
import { httpDataQueries } from "../../../packages/agent/src/http-data.ts";
import type { DataQueries } from "../../../packages/agent/src/permit-api.ts";
import {
  FAKE_API_URL,
  fakeDataApi,
} from "../../../packages/agent/test/fake-data-api.ts";
import {
  blockNetwork,
  fakeQueries,
} from "../../../packages/agent/test/helpers.ts";
import {
  EXAMPLE,
  MCP_SERVER_NAME,
  mcpTools,
  runExample,
} from "../src/mcp-tools.ts";

const TOKEN = "explorer-token-for-tests";

async function connect(queries: DataQueries) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(queries);
  await server.connect(serverSide);
  const client = new Client({ name: "explorer-test", version: "0.0.0" });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(() => blockNetwork());

describe("the MCP tab and the MCP server", () => {
  test("the server's name is the one the tab shows", () => {
    expect(MCP_SERVER_NAME).toBe(SERVER_INFO.name);
  });

  test("the tab lists exactly the server's tools/list: name, description and input schema", async () => {
    const { client, close } = await connect(fakeQueries().queries);
    try {
      const listed = (await client.listTools()).tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      // Equal as JSON values (the SDK puts $schema first; key order carries no meaning).
      expect(mcpTools()).toEqual(listed);
    } finally {
      await close();
    }
  });

  test("the live example is the radius query, and its result is the server's tools/call result over the same data API", async () => {
    expect(EXAMPLE.tool).toBe("search_aged_roofs");
    const api = fakeDataApi(fakeQueries().queries);
    const tab = await runExample({
      apiUrl: FAKE_API_URL,
      apiToken: TOKEN,
      fetch: api.fetch,
    });
    const tabRequests = api.requests.length;
    expect(tabRequests).toBeGreaterThan(0);
    for (const r of api.requests)
      expect(r.authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.requests.map((r) => r.route)).toContain("parcels.search");

    const { client, close } = await connect(
      httpDataQueries({
        apiUrl: FAKE_API_URL,
        apiToken: TOKEN,
        fetch: api.fetch,
      }),
    );
    try {
      const server = await client.callTool({
        name: EXAMPLE.tool,
        arguments: EXAMPLE.arguments,
      });
      expect(tab).toEqual(server);
      expect(tab.isError).toBeUndefined();
      const body = JSON.parse(tab.content[0]!.text) as {
        result: { count: number; items: unknown[] };
        records: unknown[];
        gaps: string[];
      };
      expect(Object.keys(body)).toEqual(["result", "records", "gaps"]);
      expect(body.result.items.length).toBeLessThanOrEqual(
        EXAMPLE.arguments.limit,
      );
    } finally {
      await close();
    }
    // At most 2 data API requests in flight (the adapter's bulkhead), as the server's hosted mode.
    expect(api.peak()).toBeLessThanOrEqual(2);
  });

  test("a data API that refuses: the example's result is an error with the gap, as the server's", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: () => ({ kind: "status", status: 503 }),
    });
    const tab = await runExample({
      apiUrl: FAKE_API_URL,
      apiToken: TOKEN,
      fetch: api.fetch,
    });
    expect(tab.isError).toBe(true);
    const body = JSON.parse(tab.content[0]!.text) as { gaps: string[] };
    expect(body.gaps).toEqual(["data API busy: parcels.search not read"]);
  });
});
