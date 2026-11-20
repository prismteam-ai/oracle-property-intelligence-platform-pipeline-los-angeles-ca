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
  /** explorer.sources calls, by whether their client batches. */
  sources: vi.fn((batch: boolean) => {
    void batch;
    return Promise.resolve({ sources: [] });
  }),
  warmBody: '{"status":"warm","commit":"f965598"}',
}));
vi.mock("../src/config.ts", () => ({ loadConfig: h.config }));
vi.mock("@oracle-la/api-client", () => ({
  createApiClient: (opts: { batch?: boolean }) => {
    h.clients.push(opts);
    return Object.assign(() => undefined, {
      meta: { info: { query: h.metaInfo } },
      explorer: {
        runSummary: { query: h.runSummary },
        sources: { query: () => h.sources(opts.batch !== false) },
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
    return new Response(h.warmBody, { status: 200 });
  throw new Error(`unexpected request ${u.pathname}`);
});

beforeEach(() => {
  vi.useFakeTimers();
  h.clients.length = 0;
  h.metaInfo.mockReset().mockResolvedValue({ api_version: "x" });
  h.sources.mockClear();
  h.warmBody = '{"status":"warm","commit":"f965598"}';
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
    // The Explorer's own commit only (run from source here: "unbundled"); no agent commit.
    expect(screen.getByTestId("commits").textContent).toBe(
      "Explorer commit unbundled",
    );
    expect(screen.queryByTestId("agent-commit")).toBeNull();
  });

  test("an empty agentApiUrl hides the tab too", async () => {
    h.config.mockResolvedValue({ ...BASE, agentApiUrl: "" });
    render(<App />);
    await flush();
    expect(screen.queryByRole("tab", { name: "Ask the agent" })).toBeNull();
  });

  test("with agentApiUrl the tab shows; opening it warms the agent and sends two unbatched explorer.sources requests", async () => {
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
    // The warm-up's two data requests: explorer.sources (slow enough to overlap), each one HTTP request.
    expect(h.sources.mock.calls).toEqual([[false], [false]]);
    expect(h.metaInfo).not.toHaveBeenCalled();
    expect(h.clients.some((c) => c.batch === false)).toBe(true);
    // Another tab hides the panel but keeps it (and its conversation) mounted.
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(screen.getByTestId("agent-form").closest("[hidden]")).not.toBeNull();
  });

  test("the page shows the Explorer's commit and the agent's as GET /agent/warm reports it; not reported when absent", async () => {
    h.config.mockResolvedValue({
      ...BASE,
      agentApiUrl: "https://agent.test",
    });
    h.warmBody = '{"status":"warm"}';
    render(<App />);
    await flush();
    expect(screen.getByTestId("explorer-commit").textContent).toBe("unbundled");
    // Before the first warm-up the agent has not been asked.
    expect(screen.getByTestId("agent-commit").textContent).toBe(
      "not checked yet (the Ask the agent tab checks it)",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Ask the agent" }));
    await flush();
    expect(screen.getByTestId("agent-commit").textContent).toBe("not reported");
    // The commit is shown on every tab once reported.
    cleanup();
    h.warmBody = '{"status":"warm","commit":"f965598"}';
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Ask the agent" }));
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(screen.getByTestId("commits").textContent).toBe(
      "Explorer commit unbundled · Agent commit f965598",
    );
    // No data API commit and no environment value on the page.
    expect(screen.getByTestId("commits").textContent).not.toMatch(/data api/i);
  });

  test("a warm-up that gets no response reports no agent commit", async () => {
    h.config.mockResolvedValue({
      ...BASE,
      agentApiUrl: "https://agent.test",
    });
    fetchStub.mockImplementationOnce(async () => {
      throw new TypeError("network");
    });
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Ask the agent" }));
    await flush();
    expect(screen.getByTestId("agent-commit").textContent).toBe("not reported");
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
    // The live example's arguments, centered on the agent's Van Nuys.
    expect(
      JSON.parse(screen.getByTestId("mcp-example-args").textContent!),
    ).toEqual({
      name: "search_aged_roofs",
      arguments: {
        lat: 34.20155,
        lon: -118.45361,
        radius_miles: 5,
        threshold_years: 15,
        limit: 5,
      },
    });
    // The site's token is never shown.
    expect(document.body.textContent).not.toContain(BASE.apiToken);
  });
});
