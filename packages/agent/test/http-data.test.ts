/**
 * The HTTP DataQueries adapter (http-data.ts) against a fake data API speaking tRPC's GET format: parity with the
 * in-process queries on every route, the forwarded bearer token, one call in flight at a time, the one retry with
 * full jitter on a refused (429/503) or transient call or a timeout, the gap when the retry fails too, the 5 s
 * attempt cap, the first call's 10 s attempts (a cold data API environment), the answer's deadline, and that no page list reaches a tool result or the model. No network.
 */
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { runAgent } from "../src/agent.ts";
import {
  CALL_TIMEOUT_MS,
  DataApiUnavailableError,
  FIRST_CALL_TIMEOUT_MS,
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
    const points = {
      lat: 34.2,
      lon: -118.45,
      radius_miles: 1,
      threshold_years: 15,
      min_open_days: 1826,
    };
    expect(await q.parcels.points(points)).toEqual(
      await direct.parcels.points(points),
    );
    expect(api.requests.map((r) => r.route)).toEqual([
      "parcels.search",
      "parcels.detail",
      "explorer.runSummary",
      "explorer.sources",
      "permits.longOpen",
      "permits.forParcel",
      "places.resolve",
      "parcels.points",
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

describe("one data API call in flight per adapter", () => {
  test(`${MAX_IN_FLIGHT} in flight at most, also when a tool fans out (search_aged_roofs reads each parcel's detail)`, async () => {
    const api = fakeDataApi(fakeQueries().queries, { delayMs: 20 });
    const { q } = adapter(api);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        q.parcels.detail({ parcel_id: FAKE_PARCELS[i % 3]! }),
      ),
    );
    expect(MAX_IN_FLIGHT).toBe(1);
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
    expect(api2.peak()).toBe(1);
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
      behaviour: (r) =>
        r === "explorer.runSummary" ? { kind: "hang" } : { kind: "answer" },
    });
    const { q, waits } = adapter(api, { callTimeoutMs: 20 });
    // The first call (answered) has the first call's limit; runSummary is a later call.
    await q.explorer.sources();
    const err = await q.explorer.runSummary().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataApiUnavailableError);
    expect((err as DataApiUnavailableError).reason).toBe("timeout");
    expect((err as DataApiUnavailableError).gap).toBe(
      "data API timeout: explorer.runSummary not read (no answer within 5 s, twice)",
    );
    expect(api.requests).toHaveLength(3);
    expect(waits).toHaveLength(1);
  });

  test("a timeout then an answer: the data", async () => {
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: (_r, n) => (n === 1 ? { kind: "hang" } : { kind: "answer" }),
    });
    const res = await adapter(api, {
      callTimeoutMs: 20,
      firstCallTimeoutMs: 20,
    }).q.explorer.runSummary();
    expect(res.run.run_id).toBe("run-1");
  });

  test(`the attempt timeout is ${CALL_TIMEOUT_MS} ms at most, the first call's ${FIRST_CALL_TIMEOUT_MS} ms, whatever is asked (fake timers)`, async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: () => ({ kind: "hang" }),
    });
    const g = guardedFetch({
      apiUrl: FAKE_API_URL,
      apiToken: TOKEN,
      fetch: api.fetch,
      callTimeoutMs: 60_000,
      firstCallTimeoutMs: 60_000,
      sleep: async () => {},
    });
    const first = g
      .fetch(`${FAKE_API_URL}/trpc/explorer.sources`)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FIRST_CALL_TIMEOUT_MS - 1);
    expect(api.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(FIRST_CALL_TIMEOUT_MS);
    expect(await first).toBeInstanceOf(DataApiUnavailableError);

    const p = g
      .fetch(`${FAKE_API_URL}/trpc/explorer.runSummary`)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
    expect(api.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.requests).toHaveLength(4);
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
    expect(unavailableGap("parcels.search", "timeout")).toBe(
      "data API timeout: parcels.search not read (no answer within 5 s, twice)",
    );
    expect(
      unavailableGap(
        "explorer.sources",
        "timeout",
        null,
        FIRST_CALL_TIMEOUT_MS,
      ),
    ).toBe(
      "data API timeout: explorer.sources not read (no answer within 10 s, twice)",
    );
    expect(unavailableGap("parcels.search", "busy")).toBe(
      "data API busy: parcels.search not read",
    );
    expect(unavailableGap("parcels.search", "error", 502)).toBe(
      "data API error 502: parcels.search not read",
    );
  });
});

describe("a timeout the answer's deadline ends: the gap says how many attempts were made and that the time budget ended the call", () => {
  /** runSummary's attempts never answer; the first call (explorer.sources) is answered at once. */
  const hangs = () =>
    fakeDataApi(fakeQueries().queries, {
      behaviour: (r) =>
        r === "explorer.runSummary" ? { kind: "hang" } : { kind: "answer" },
    });
  const budgetGap = (attempts: string) =>
    `data API timeout: explorer.runSummary not read (${attempts} made; the answer's time budget ended the call)`;
  /** runSummary's error after `ms` of fake time, with the answer's deadline `deadlineMs` after the start. */
  async function timedOut(
    deadlineMs: number,
    ms: number,
    random = 0,
  ): Promise<{ err: unknown; requests: number; waits: number[] }> {
    vi.useFakeTimers();
    const api = hangs();
    const { q, waits } = adapter(api, {
      deadline: Date.now() + deadlineMs,
      now: () => Date.now(),
      random: () => random,
    });
    await q.explorer.sources();
    const p = q.explorer.runSummary().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(ms);
    return { err: await p, requests: api.requests.length, waits };
  }

  test("an attempt the deadline cuts short (3 s of 5 s): 1 attempt made, not 'twice'", async () => {
    const { err, requests } = await timedOut(3_000, 3_000);
    expect(err).toBeInstanceOf(DataApiUnavailableError);
    expect(err).toMatchObject({
      reason: "timeout",
      gap: budgetGap("1 attempt"),
    });
    expect(requests).toBe(2);
  });

  test("a full 5 s attempt with no time left for the retry: 1 attempt made", async () => {
    const { err, requests, waits } = await timedOut(
      CALL_TIMEOUT_MS,
      CALL_TIMEOUT_MS,
      0.5,
    );
    expect(err).toMatchObject({
      reason: "timeout",
      gap: budgetGap("1 attempt"),
    });
    expect(requests).toBe(2);
    expect(waits).toEqual([]);
  });

  test("a full 5 s attempt, then a retry the deadline cuts short (3 s): 2 attempts made", async () => {
    const { err, requests, waits } = await timedOut(8_000, 8_000);
    expect(err).toMatchObject({
      reason: "timeout",
      gap: budgetGap("2 attempts"),
    });
    expect(requests).toBe(3);
    expect(waits).toEqual([0]);
  });

  test("two full attempts within the deadline: 'no answer within 5 s, twice', as before", async () => {
    const { err } = await timedOut(20_000, 2 * CALL_TIMEOUT_MS);
    expect(err).toMatchObject({
      reason: "timeout",
      gap: "data API timeout: explorer.runSummary not read (no answer within 5 s, twice)",
    });
  });

  test("a busy answer, then the wait for the retry uses up the deadline: that answer's gap, not 'not called'", async () => {
    let t = 0;
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: busyFirst("explorer.runSummary"),
    });
    const q = httpDataQueries({
      apiUrl: FAKE_API_URL,
      apiToken: TOKEN,
      fetch: api.fetch,
      deadline: 260,
      now: () => t,
      random: () => 0.5,
      sleep: async () => void (t = 300),
    });
    const err = await q.explorer.runSummary().catch((e: unknown) => e);
    expect(err).toMatchObject({
      reason: "busy",
      gap: "data API busy: explorer.runSummary not read",
    });
    expect(api.requests).toHaveLength(1);
  });

  test("the gap wording with the attempts made", () => {
    expect(
      unavailableGap("parcels.search", "timeout", null, CALL_TIMEOUT_MS, 1),
    ).toBe(
      "data API timeout: parcels.search not read (1 attempt made; the answer's time budget ended the call)",
    );
    expect(
      unavailableGap("parcels.search", "timeout", null, CALL_TIMEOUT_MS, 2),
    ).toBe(
      "data API timeout: parcels.search not read (2 attempts made; the answer's time budget ended the call)",
    );
  });
});

describe("the first data call: 10 s per attempt (a cold data API environment), every other call 5 s", () => {
  /** A route's attempts as the fake data API takes them: `ms` each (answered after it unless aborted first). */
  const slow =
    (ms: Record<string, number[]>) =>
    (route: string, n: number): Behaviour => {
      const d = ms[route]?.[n - 1];
      return d === undefined ? { kind: "answer" } : { kind: "slow", ms: d };
    };

  test("a 6 s first call is answered within its 10 s attempt: no retry, no gap", async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: slow({ "explorer.sources": [6_000, 6_000] }),
    });
    const { q, waits } = adapter(api);
    let done = false;
    const p = q.explorer.sources().finally(() => (done = true));
    await vi.advanceTimersByTimeAsync(5_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).sources).toHaveLength(3);
    expect(api.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("a later 6 s call still times out at 5 s and is retried (5 s again)", async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: slow({ "explorer.runSummary": [6_000] }),
    });
    const { q, waits } = adapter(api, { random: () => 0 });
    await q.explorer.sources();
    const p = q.explorer.runSummary();
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
    expect(api.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.requests.map((r) => r.route)).toEqual([
      "explorer.sources",
      "explorer.runSummary",
      "explorer.runSummary",
    ]);
    expect((await p).run.run_id).toBe("run-1");
    expect(waits).toEqual([0]);
  });

  test("a later call slow twice: 'no answer within 5 s, twice'", async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: slow({ "explorer.runSummary": [6_000, 6_000] }),
    });
    const { q } = adapter(api);
    await q.explorer.sources();
    const p = q.explorer.runSummary().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2 * CALL_TIMEOUT_MS);
    expect((await p) as DataApiUnavailableError).toMatchObject({
      reason: "timeout",
      gap: "data API timeout: explorer.runSummary not read (no answer within 5 s, twice)",
    });
  });

  test("the first call's retry has 10 s too; a first call slow twice states its 10 s", async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: slow({ "explorer.sources": [11_000, 11_000] }),
    });
    const { q, waits } = adapter(api, { random: () => 0.5 });
    const p = q.explorer.sources().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FIRST_CALL_TIMEOUT_MS - 1);
    expect(api.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.requests).toHaveLength(2);
    expect(waits).toEqual([250]);
    await vi.advanceTimersByTimeAsync(FIRST_CALL_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(api.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p) as DataApiUnavailableError).toMatchObject({
      reason: "timeout",
      gap: "data API timeout: explorer.sources not read (no answer within 10 s, twice)",
    });
  });

  test("a first call slow then answered on its retry: the data", async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: slow({ "explorer.sources": [12_000, 6_000] }),
    });
    const p = adapter(api).q.explorer.sources();
    await vi.advanceTimersByTimeAsync(FIRST_CALL_TIMEOUT_MS + 6_000);
    expect((await p).sources).toHaveLength(3);
    expect(api.requests).toHaveLength(2);
  });

  test("the first call by call order: of two calls started together only the first has 10 s", async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: slow({
        "explorer.sources": [6_000],
        "explorer.runSummary": [6_000],
      }),
    });
    const { q } = adapter(api);
    const a = q.explorer.sources();
    const b = q.explorer.runSummary();
    // The second waits for the one slot (6 s), then its first attempt is cut at 5 s and its retry is read.
    await vi.advanceTimersByTimeAsync(6_000 + CALL_TIMEOUT_MS);
    expect((await a).sources).toHaveLength(3);
    expect((await b).run.run_id).toBe("run-1");
    expect(api.requests.map((r) => r.route)).toEqual([
      "explorer.sources",
      "explorer.runSummary",
      "explorer.runSummary",
    ]);
  });

  test("the answer's deadline still cuts the first call's attempt; no retry when nothing is left", async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: slow({ "explorer.sources": [6_000, 6_000] }),
    });
    const { q, waits } = adapter(api, {
      deadline: Date.now() + 3_000,
      random: () => 0,
    });
    const p = q.explorer.sources().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await p) as DataApiUnavailableError).toMatchObject({
      reason: "timeout",
    });
    expect(api.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("runAgent: a 6 s cold explorer.sources before the first model call is read; the contractor window is the run's", async () => {
    vi.useFakeTimers();
    const api = fakeDataApi(fakeQueries().queries, {
      behaviour: slow({ "explorer.sources": [6_000, 6_000] }),
    });
    const script = () => [
      toolReply([{ name: "run_summary", input: {} }]),
      textReply("The run's sources are listed."),
    ];
    const model = new ScriptedModel(script());
    const p = runAgent(
      { question: "Which sources does the run use?" },
      { model, queries: adapter(api).q, settings: SETTINGS },
    );
    await vi.advanceTimersByTimeAsync(6_000);
    const a = await p;
    expect(a.status).toBe("answered");
    expect(a.gaps.join("\n")).not.toContain("could not be read");
    // The system prompt names the run's window exactly as with the in-process queries (no fallback end).
    const direct = new ScriptedModel(script());
    await runAgent(
      { question: "Which sources does the run use?" },
      { model: direct, queries: fakeQueries().queries, settings: SETTINGS },
    );
    expect(model.requests[0]!.params.system).toEqual(
      direct.requests[0]!.params.system,
    );
    expect(
      api.requests.filter((r) => r.route === "explorer.sources"),
    ).toHaveLength(1);
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
