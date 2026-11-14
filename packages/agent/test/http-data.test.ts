/**
 * The HTTP DataQueries adapter (http-data.ts) against a fake data API speaking tRPC's GET format: parity with the
 * in-process queries on every route, the forwarded bearer token, at most 2 calls in flight, the one retry with
 * full jitter on a refused (429/503) or transient call or a timeout, the gap when the retry fails too, the 5 s
 * attempt cap, the answer's deadline, and that no page list reaches a tool result or the model. No network.
 */
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { runAgent } from "../src/agent.ts";
import {
  CALL_TIMEOUT_MS,
  DataApiUnavailableError,
  MAX_IN_FLIGHT,
  guardedFetch,
  httpDataQueries,
  unavailableGap,
  type HttpDataQueriesOptions,
} from "../src/http-data.ts";
import { onceSources } from "../src/permit-api.ts";
import {
  ScriptedModel,
  textReply,
  toolReply,
} from "../src/testing/scripted-model.ts";
import { runTool } from "../src/tools.ts";
import { FAKE_API_URL, fakeDataApi, type Behaviour } from "./fake-data-api.ts";
import {
  FAKE_PARCELS,
  SETTINGS,
  VAN_NUYS,
  blockNetwork,
  fakeQueries,
} from "./helpers.ts";

beforeAll(blockNetwork);
afterEach(() => {
  vi.useRealTimers();
});

const TOKEN = "test-bearer-token-not-secret";

/** The adapter over a fake data API; sleeps are recorded and immediate. */
function adapter(
  api: ReturnType<typeof fakeDataApi>,
  opts: Partial<HttpDataQueriesOptions> = {},
) {
  const waits: number[] = [];
  const q = httpDataQueries({
    apiUrl: FAKE_API_URL,
    apiToken: TOKEN,
    fetch: api.fetch,
    sleep: async (ms) => void waits.push(ms),
    ...opts,
  });
  return { q, waits };
}

const busyFirst =
  (route: string, status = 503, times = 1) =>
  (r: string, n: number): Behaviour =>
    r === route && n <= times ? { kind: "status", status } : { kind: "answer" };

describe("parity and the request", () => {
  test("every route the tools read returns what the in-process queries return; the caller's bearer token is forwarded", async () => {
    const direct = fakeQueries().queries;
    const api = fakeDataApi(fakeQueries().queries);
    const { q } = adapter(api);
    const search = {
      lat: 34.2,
      lon: -118.45,
      radius_miles: 5,
      threshold_years: 15,
      offset: 0,
      limit: 3,
    };
    expect(await q.parcels.search(search)).toEqual(
      await direct.parcels.search(search),
    );
    expect(await q.parcels.detail({ parcel_id: FAKE_PARCELS[0]! })).toEqual(
      await direct.parcels.detail({ parcel_id: FAKE_PARCELS[0]! }),
    );
    expect(await q.explorer.runSummary()).toEqual(
      await direct.explorer.runSummary(),
    );
    expect(await q.explorer.sources()).toEqual({
      sources: (await direct.explorer.sources()).sources,
    });
    const lo = {
      lat: 34.2,
      lon: -118.45,
      radius_miles: 5,
      min_open_days: 1826,
      sort: "open_days" as const,
      offset: 0,
      limit: 10,
    };
    expect(await q.permits.longOpen(lo)).toEqual(
      await direct.permits.longOpen(lo),
    );
    expect(await q.permits.forParcel({ parcel_id: FAKE_PARCELS[0]! })).toEqual(
      await direct.permits.forParcel({ parcel_id: FAKE_PARCELS[0]! }),
    );
    expect(await q.places.resolve({ name: "Van Nuys" })).toEqual(
      await direct.places.resolve({ name: "Van Nuys" }),
    );
    expect(api.requests.map((r) => r.route)).toEqual([
      "parcels.search",
      "parcels.detail",
      "explorer.runSummary",
      "explorer.sources",
      "permits.longOpen",
      "permits.forParcel",
      "places.resolve",
    ]);
    // One HTTP request per call (no batching), each with the caller's own token.
    for (const r of api.requests)
      expect(r.authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.requests[0]!.input).toEqual(search);
  });

  test("a status the cap does not explain (400, 401, 403, 404) is not retried and is not a gap", async () => {
    for (const status of [400, 401, 403, 404]) {
      const api = fakeDataApi(fakeQueries().queries, {
        behaviour: () => ({ kind: "status", status, body: "{}" }),
      });
      const { q, waits } = adapter(api);
      const err = await q.parcels
        .detail({ parcel_id: FAKE_PARCELS[0]! })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(DataApiUnavailableError);
      expect(api.requests).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  });
});

describe("at most 2 data API calls in flight per adapter", () => {
  test(`${MAX_IN_FLIGHT} in flight at most, also when a tool fans out (search_aged_roofs reads each parcel's detail)`, async () => {
    const api = fakeDataApi(fakeQueries().queries, { delayMs: 20 });
    const { q } = adapter(api);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        q.parcels.detail({ parcel_id: FAKE_PARCELS[i % 3]! }),
      ),
    );
    expect(api.peak()).toBe(MAX_IN_FLIGHT);
    expect(q.peakInFlight()).toBe(MAX_IN_FLIGHT);
    const api2 = fakeDataApi(fakeQueries().queries, { delayMs: 20 });
    const { q: q2 } = adapter(api2);
    const o = await runTool(
      "search_aged_roofs",
      { lat: 34.2, lon: -118.45, radius_miles: 5, limit: 3 },
      q2,
    );
    expect(o.ok).toBe(true);
    expect(
      api2.requests.filter((r) => r.route === "parcels.detail"),
    ).toHaveLength(3);
    expect(api2.peak()).toBe(2);
  });
});

describe("a call refused by the cap: one retry with full jitter, then a gap", () => {
  test.each([503, 429])(
    "HTTP %i once: retried after a wait in [0, 500) ms; the result is the data",
    async (status) => {
      const api = fakeDataApi(fakeQueries().queries, {
        behaviour: busyFirst("parcels.search", status),
      });
      const { q, waits } = adapter(api, { random: () => 0.999 });
      const res = await q.parcels.search({ lat: 34.2, lon: -118.45 });
      expect(res.count).toBe(42);
      expect(api.requests.map((r) => r.route)).toEqual([
        "parcels.search",
        "parcels.search",
      ]);
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThanOrEqual(0);
      expect(waits[0]).toBeLessThan(500);
      expect(waits[0]).toBeCloseTo(0.999 * 500);
    },
  );

  test("the wait is full jitter: random × 500 ms (0 with random 0)", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: busyFirst("parcels.search"),
    });
    const { q, waits } = adapter(api, { random: () => 0 });
    await q.parcels.search({ lat: 34.2, lon: -118.45 });
    expect(waits).toEqual([0]);
  });

  test("refused twice: DataApiUnavailableError busy; the tool fails with the gap 'data API busy: <route> not read', never an empty result", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: busyFirst("permits.longOpen", 503, 2),
    });
    const { q } = adapter(api);
    const err = await q.permits
      .longOpen({ lat: 34.2, lon: -118.45 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataApiUnavailableError);
    expect((err as DataApiUnavailableError).gap).toBe(
      "data API busy: permits.longOpen not read",
    );

    const api2 = fakeDataApi(fakeQueries().queries, {
      behaviour: busyFirst("permits.longOpen", 429, 2),
    });
    const o = await runTool(
      "long_open_permits",
      { lat: 34.2, lon: -118.45 },
      adapter(api2).q,
    );
    expect(o).toMatchObject({
      ok: false,
      error: "data API busy: permits.longOpen not read",
      content: { error: "data API busy: permits.longOpen not read" },
      gaps: ["data API busy: permits.longOpen not read"],
      records: [],
    });
    expect(
      api2.requests.filter((r) => r.route === "permits.longOpen"),
    ).toHaveLength(2);
  });

  test("other transient statuses (500, 502, 504) are retried once too; then 'data API error <status>'", async () => {
    for (const status of [500, 502, 504]) {
      const api = fakeDataApi(fakeQueries().queries, {
        behaviour: busyFirst("parcels.detail", status, 2),
      });
      const err = await adapter(api)
        .q.parcels.detail({ parcel_id: FAKE_PARCELS[0]! })
        .catch((e: unknown) => e);
      expect((err as DataApiUnavailableError).gap).toBe(
        `data API error ${status}: parcels.detail not read`,
      );
      expect(api.requests).toHaveLength(2);
    }
  });

  test("search_aged_roofs: a parcel whose parcels.detail was refused twice is listed, with the reason, never a silent null", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: (route, n) =>
        route === "parcels.detail" && n <= 2
          ? { kind: "status", status: 503 }
          : { kind: "answer" },
    });
    const o = await runTool(
      "search_aged_roofs",
      { lat: 34.2, lon: -118.45, radius_miles: 5, limit: 3 },
      adapter(api, { maxInFlight: 1 }).q,
    );
    expect(o.ok).toBe(true);
    const items = (o.content as { items: Array<Record<string, unknown>> })
      .items;
    // With one slot the first detail's two attempts are the refused ones; the other two parcels read fine.
    expect(items[0]).toMatchObject({
      parcel_id: FAKE_PARCELS[0],
      citation: null,
      citation_not_read: "data API busy: parcels.detail not read",
    });
    expect(items[1]!.citation).not.toBeNull();
    expect(items[1]).not.toHaveProperty("citation_not_read");
    expect(o.gaps).toContain(
      `data API busy: parcels.detail not read for parcel ${FAKE_PARCELS[0]}; it is listed without a citation.`,
    );
    expect(o.records.map((r) => r.id)).toEqual(FAKE_PARCELS.slice(1));
  });

  test("search_aged_roofs: another detail failure is stated with its route and message", async () => {
    const { queries } = fakeQueries();
    const failing = {
      ...queries,
      parcels: {
        ...queries.parcels,
        detail: () => Promise.reject(new Error("NOT_FOUND")),
      },
    };
    const o = await runTool(
      "search_aged_roofs",
      { lat: 34.2, lon: -118.45, limit: 1 },
      failing,
    );
    expect(o.gaps).toContain(
      `parcels.detail failed (NOT_FOUND) for parcel ${FAKE_PARCELS[0]}; it is listed without a citation.`,
    );
  });

  test("an answer states the gap: the agent's gaps list carries it and the model sees the error", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: busyFirst("permits.longOpen", 503, 2),
    });
    const model = new ScriptedModel([
      toolReply([
        {
          name: "long_open_permits",
          input: { lat: VAN_NUYS.lat, lon: VAN_NUYS.lon },
        },
      ]),
      textReply("The permit data could not be read: the data API was busy."),
    ]);
    const a = await runAgent(
      { question: "Which permits near here are long open?", center: VAN_NUYS },
      { model, queries: adapter(api).q, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    expect(a.gaps).toContain("data API busy: permits.longOpen not read");
    expect(JSON.stringify(model.requests[1]!.params.messages)).toContain(
      "data API busy: permits.longOpen not read",
    );
  });
});

describe("timeouts and the answer's deadline", () => {
  test("an attempt that does not answer within the timeout is retried once; then 'data API timeout'", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: () => ({ kind: "hang" }),
    });
    const { q, waits } = adapter(api, { callTimeoutMs: 20 });
    const err = await q.explorer.runSummary().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataApiUnavailableError);
    expect((err as DataApiUnavailableError).reason).toBe("timeout");
    expect((err as DataApiUnavailableError).gap).toBe(
      "data API timeout: explorer.runSummary not read (no answer within 5 s, twice)",
    );
    expect(api.requests).toHaveLength(2);
    expect(waits).toHaveLength(1);
  });

  test("a timeout then an answer: the data", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: (_r, n) => (n === 1 ? { kind: "hang" } : { kind: "answer" }),
    });
    const res = await adapter(api, {
      callTimeoutMs: 20,
    }).q.explorer.runSummary();
    expect(res.run.run_id).toBe("run-1");
  });

  test(`the attempt timeout is ${CALL_TIMEOUT_MS} ms at most, whatever is asked (fake timers)`, async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: () => ({ kind: "hang" }),
    });
    const g = guardedFetch({
      apiUrl: FAKE_API_URL,
      apiToken: TOKEN,
      fetch: api.fetch,
      callTimeoutMs: 60_000,
      sleep: async () => {},
    });
    const p = g
      .fetch(`${FAKE_API_URL}/trpc/explorer.runSummary`)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
    expect(api.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
    expect(await p).toBeInstanceOf(DataApiUnavailableError);
  });

  test("past the deadline no call starts ('time budget'); a deadline too close for the wait gives no retry", async () => {
    let t = 1_000;
    const api = fakeDataApi(fakeQueries().queries);
    const late = adapter(api, { deadline: 1_000, now: () => t }).q;
    const err = await late.explorer.runSummary().catch((e: unknown) => e);
    expect((err as DataApiUnavailableError).gap).toBe(
      "data API not called: explorer.runSummary not read (the answer's time budget ran out)",
    );
    expect(api.requests).toHaveLength(0);

    const api2 = fakeDataApi(fakeQueries().queries, {
      behaviour: busyFirst("explorer.runSummary"),
    });
    t = 0;
    const close = adapter(api2, {
      deadline: 100,
      now: () => t,
      random: () => 0.5,
    });
    const err2 = await close.q.explorer.runSummary().catch((e: unknown) => e);
    expect((err2 as DataApiUnavailableError).reason).toBe("busy");
    expect(api2.requests).toHaveLength(1);
    expect(close.waits).toEqual([]);
  });

  test("the gap wordings", () => {
    expect(unavailableGap("parcels.search", "busy")).toBe(
      "data API busy: parcels.search not read",
    );
    expect(unavailableGap("parcels.search", "error", 502)).toBe(
      "data API error 502: parcels.search not read",
    );
  });
});

describe("explorer.sources: the sources only, never a page list", () => {
  const CANARY = "CANARY-PAGE-FILE-0001.json";
  const pages = [
    {
      source_kind: "parcel",
      source_name: "LA County Assessor Roll",
      source_page_file: CANARY,
      source_request_url: "https://example.test/CANARY-PAGE-URL",
      source_retrieved_at: "2026-11-11T16:17:40.932Z",
      source_page_sha256: "CANARY-PAGE-SHA",
      record_count: 3,
    },
  ];

  test("a page list the data API still sends is dropped by the adapter", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      extra: { "explorer.sources": { pages } },
    });
    const src = await adapter(api).q.explorer.sources();
    expect(Object.keys(src)).toEqual(["sources"]);
    expect(JSON.stringify(src)).not.toContain("CANARY");
  });

  test("no page entry reaches any tool result, run_summary included, or the model's requests", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      extra: { "explorer.sources": { pages } },
    });
    const q = adapter(api).q;
    const outcomes = await Promise.all([
      runTool("run_summary", {}, q),
      runTool("long_open_permits", { lat: 34.2, lon: -118.45 }, q),
      runTool("parcel_permits", { parcel_id: FAKE_PARCELS[0] }, q),
      runTool("parcel_detail", { parcel_id: FAKE_PARCELS[0] }, q),
      runTool("search_aged_roofs", { lat: 34.2, lon: -118.45, limit: 3 }, q),
    ]);
    for (const o of outcomes) {
      expect(o.ok).toBe(true);
      expect(JSON.stringify(o)).not.toContain("CANARY");
    }
    // run_summary states each source once with its page count, not its pages.
    const rs = outcomes[0]!.content as {
      sources: Array<Record<string, unknown>>;
    };
    expect(rs.sources.every((s) => typeof s.page_count === "number")).toBe(
      true,
    );
    expect(rs.sources.every((s) => !("pages" in s))).toBe(true);

    const model = new ScriptedModel([
      toolReply([{ name: "run_summary", input: {} }]),
      textReply("The run's sources are listed."),
    ]);
    const a = await runAgent(
      { question: "Which sources does the run use?" },
      { model, queries: q, settings: SETTINGS },
    );
    expect(JSON.stringify(a)).not.toContain("CANARY");
    expect(JSON.stringify(model.requests)).not.toContain("CANARY");
  });

  test("onceSources keeps a read for the answer, but not a failed one", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: busyFirst("explorer.sources", 503, 2),
    });
    const q = onceSources(adapter(api).q);
    await expect(q.explorer.sources()).rejects.toBeInstanceOf(
      DataApiUnavailableError,
    );
    const ok = await q.explorer.sources();
    expect(ok.sources).toHaveLength(3);
    await q.explorer.sources();
    expect(
      api.requests.filter((r) => r.route === "explorer.sources"),
    ).toHaveLength(3);
  });
});
