// @vitest-environment jsdom
/**
 * The Explorer's tabs with and without the agent API in config.json, and the MCP tab. Mocks: ../src/config.ts and
 * @oracle-la/api-client (as App.test.tsx); the global fetch is a stub that records the agent API calls, so
 * nothing leaves the process.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TOOL_NAMES } from "../../../packages/agent/src/tools.ts";

const h = vi.hoisted(() => ({
  config: vi.fn(),
  clients: [] as Array<{ batch?: boolean }>,
  metaInfo: vi.fn(),
  runSummary: vi.fn(),
}));
vi.mock("../src/config.ts", () => ({ loadConfig: h.config }));
vi.mock("@oracle-la/api-client", () => ({
  createApiClient: (opts: { batch?: boolean }) => {
    h.clients.push(opts);
    return Object.assign(() => undefined, {
      meta: { info: { query: h.metaInfo } },
      explorer: {
        runSummary: { query: h.runSummary },
        sources: { query: vi.fn(async () => ({ sources: [] })) },
      },
    });
  },
}));

import { App } from "../src/App.tsx";

const BASE = {
  client: "explorer",
  apiUrl: "https://api.test",
  apiToken: "tok-never-shown-0123",
};
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const fetchStub = vi.fn(async (input: string | URL | Request) => {
  const u = new URL(String(input));
  if (u.pathname === "/agent/warm")
    return new Response('{"status":"warm"}', { status: 200 });
  throw new Error(`unexpected request ${u.pathname}`);
});

beforeEach(() => {
  vi.useFakeTimers();
  h.clients.length = 0;
  h.metaInfo.mockReset().mockResolvedValue({ api_version: "x" });
  h.runSummary.mockReset().mockReturnValue(new Promise(() => {}));
  fetchStub.mockClear();
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the agent tab and config.json", () => {
  test("without agentApiUrl the Ask the agent tab is hidden and nothing calls an agent API", async () => {
    h.config.mockResolvedValue({ ...BASE });
    render(<App />);
    await flush();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).not.toContain("Ask the agent");
    expect(tabs).toContain("MCP");
    expect(screen.queryByTestId("agent-form")).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(h.metaInfo).not.toHaveBeenCalled();
  });

  test("an empty agentApiUrl hides the tab too", async () => {
    h.config.mockResolvedValue({ ...BASE, agentApiUrl: "" });
    render(<App />);
    await flush();
    expect(screen.queryByRole("tab", { name: "Ask the agent" })).toBeNull();
  });

  test("with agentApiUrl the tab shows; opening it warms the agent and sends two unbatched data API requests", async () => {
    h.config.mockResolvedValue({
      ...BASE,
      agentApiUrl: "https://agent.test",
    });
    render(<App />);
    await flush();
    expect(fetchStub).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Ask the agent" }));
    await flush();
    expect(fetchStub.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://agent.test/agent/warm",
    ]);
    expect(h.metaInfo).toHaveBeenCalledTimes(2);
    // The warm-up's data client sends one HTTP request per call.
    expect(h.clients.some((c) => c.batch === false)).toBe(true);
    // Another tab hides the panel but keeps it (and its conversation) mounted.
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(screen.getByTestId("agent-form").closest("[hidden]")).not.toBeNull();
  });

  test("the MCP tab lists the server's tools with name, description and input schema", async () => {
    h.config.mockResolvedValue({ ...BASE });
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(
      screen.getAllByTestId("mcp-tool-name").map((n) => n.textContent),
    ).toEqual(TOOL_NAMES);
    expect(screen.getAllByTestId("mcp-tool-schema")).toHaveLength(
      TOOL_NAMES.length,
    );
    expect(screen.getByTestId("mcp-connect").textContent).toContain(
      "--api-url https://api.test --token-file <token-file>",
    );
    // The site's token is never shown.
    expect(document.body.textContent).not.toContain(BASE.apiToken);
  });
});
