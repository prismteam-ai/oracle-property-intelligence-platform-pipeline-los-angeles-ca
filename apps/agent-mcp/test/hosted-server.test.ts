/**
 * The MCP server's hosted mode (server-options.ts): its options, the "mcp" client's token file (mode 0600, JSON
 * { "apiToken": ... }, refusals that name the path and mode and never the content), and the server answering
 * through the agent's HTTP adapter with that token, gaps included, over the SDK's in-memory transport and a fake
 * data API. Scratch files live under this test folder and are removed afterwards. No network.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  FAKE_API_URL,
  fakeDataApi,
} from "../../../packages/agent/test/fake-data-api.ts";
import {
  blockNetwork,
  fakeQueries,
} from "../../../packages/agent/test/helpers.ts";
import { createMcpServer } from "../src/create-server.ts";
import {
  McpTokenFileError,
  ServerUsageError,
  hostedQueries,
  parseServerArgs,
  readMcpTokenFile,
} from "../src/server-options.ts";

const SCRATCH = join(
  fileURLToPath(new URL("./", import.meta.url)),
  `.mcp-scratch-${process.pid}`,
);
const TOKEN = "CANARY-MCP-TOKEN-not-a-real-token";

beforeAll(() => {
  blockNetwork();
  mkdirSync(SCRATCH, { recursive: true });
});
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function tokenFile(name: string, content: string, mode = 0o600): string {
  const path = join(SCRATCH, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

const refusal = (fn: () => unknown): McpTokenFileError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(McpTokenFileError);
    return err as McpTokenFileError;
  }
  throw new Error("expected a refusal");
};

describe("options", () => {
  test("no option: local; both: hosted (the URL's origin)", () => {
    expect(parseServerArgs([])).toEqual({ mode: "local" });
    expect(
      parseServerArgs([
        "--api-url",
        "https://abc.execute-api.eu-north-1.amazonaws.com/",
        "--token-file",
        "<key-file>",
      ]),
    ).toEqual({
      mode: "hosted",
      apiUrl: "https://abc.execute-api.eu-north-1.amazonaws.com",
      tokenFile: "<key-file>",
    });
  });

  test("the token file's path is a required option with --api-url; the error names it", () => {
    expect(() => parseServerArgs(["--api-url", FAKE_API_URL])).toThrow(
      new ServerUsageError(
        "--token-file <path> is required with --api-url (the mcp client's token file, mode 0600)",
      ),
    );
    expect(() => parseServerArgs(["--token-file", "<key-file>"])).toThrow(
      /--api-url <data API URL> is required with --token-file/,
    );
    expect(() =>
      parseServerArgs(["--api-url", "http://x.test", "--token-file", "f"]),
    ).toThrow(/https/);
    expect(() => parseServerArgs(["--token", TOKEN])).toThrow(ServerUsageError);
  });
});

describe("the mcp client's token file", () => {
  test("mode 0600 and { apiToken }: the token", () => {
    const f = tokenFile(
      "ok.json",
      JSON.stringify({ apiToken: TOKEN, apiTokenSha256: "x" }),
    );
    expect(readMcpTokenFile(f)).toBe(TOKEN);
  });

  test("refused: another mode, missing, not JSON, no apiToken; never the content", () => {
    const loose = tokenFile(
      "loose.json",
      JSON.stringify({ apiToken: TOKEN }),
      0o644,
    );
    const e1 = refusal(() => readMcpTokenFile(loose));
    expect(e1).toMatchObject({ problem: "mode", mode: "0644", path: loose });
    expect(e1.message).toBe(
      `refusing to start the MCP server: the token file ${loose} has mode 0644; it must be exactly 0600 (chmod 600 ${loose}).`,
    );
    expect(
      refusal(() => readMcpTokenFile(join(SCRATCH, "none.json"))).problem,
    ).toBe("missing");
    const bad = tokenFile("bad.json", `{ ${TOKEN}`);
    const e2 = refusal(() => readMcpTokenFile(bad));
    expect(e2.problem).toBe("invalid-json");
    expect(e2.message).toContain('expected { "apiToken": "<token>" }');
    const other = tokenFile("other.json", JSON.stringify({ apiKey: TOKEN }));
    expect(refusal(() => readMcpTokenFile(other)).problem).toBe(
      "missing-api-key",
    );
    for (const e of [e1, e2]) expect(e.message).not.toContain("CANARY");
  });
});

describe("the server over the hosted data API", () => {
  async function connect(api: ReturnType<typeof fakeDataApi>) {
    const f = tokenFile("server.json", JSON.stringify({ apiToken: TOKEN }));
    const queries = hostedQueries(
      { apiUrl: FAKE_API_URL, tokenFile: f },
      { fetch: api.fetch },
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(queries);
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    return { client, server };
  }

  test("a tool call reads the data API with the token from the file", async () => {
    const api = fakeDataApi(fakeQueries().queries);
    const { client, server } = await connect(api);
    try {
      const res = await client.callTool({
        name: "long_open_permits",
        arguments: { lat: 34.2, lon: -118.45, radius_miles: 5 },
      });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(
        (res.content as Array<{ text: string }>)[0]!.text,
      ) as { result: { count: number } };
      expect(body.result.count).toBe(57);
      // The permits, their source and the circle's permit data (parcels.points).
      expect(api.requests.map((r) => r.route).sort()).toEqual([
        "explorer.sources",
        "parcels.points",
        "permits.longOpen",
      ]);
      for (const r of api.requests)
        expect(r.authorization).toBe(`Bearer ${TOKEN}`);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a route refused by the cap twice: the tool result is an error with the gap", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: (route) =>
        route === "permits.forParcel"
          ? { kind: "status", status: 503 }
          : { kind: "answer" },
    });
    const { client, server } = await connect(api);
    try {
      const res = await client.callTool({
        name: "parcel_permits",
        arguments: { parcel_id: "1000000001" },
      });
      expect(res.isError).toBe(true);
      const body = JSON.parse(
        (res.content as Array<{ text: string }>)[0]!.text,
      ) as { result: { error: string }; gaps: string[] };
      expect(body.result.error).toBe(
        "data API busy: permits.forParcel not read",
      );
      expect(body.gaps).toEqual(["data API busy: permits.forParcel not read"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
