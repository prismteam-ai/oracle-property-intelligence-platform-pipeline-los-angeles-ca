/**
 * A fake data API for the HTTP adapter's tests: a fetch that answers tRPC v11 GET requests
 * (`<base>/trpc/<route>?input=<JSON>`, body `{ "result": { "data": ... } }`) from in-process DataQueries (the
 * fakes of helpers.ts), records each request and its bearer token, can refuse or delay calls, and counts the
 * requests in flight. No network.
 */
import type { DataQueries } from "../src/permit-api.ts";

export const FAKE_API_URL = "https://data-api.example.test";

export interface FakeRequest {
  route: string;
  input: unknown;
  authorization: string | null;
}

/**
 * What to do with one attempt of a route: answer, refuse with a status, hang until aborted, or answer after `ms`
 * unless aborted first (a cold data API environment; with fake timers the wait is on the fake clock).
 */
export type Behaviour =
  | { kind: "answer" }
  | { kind: "status"; status: number; body?: string }
  | { kind: "hang" }
  | { kind: "slow"; ms: number };

export interface FakeDataApi {
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  requests: FakeRequest[];
  /** The most requests in flight at once. */
  peak: () => number;
}

/**
 * `behaviour(route, attempt)` decides each request (attempt counts from 1 per route); default: answer.
 * `delayMs` holds every answer that long (real time), so overlapping calls overlap. `extra` adds fields to a route's
 * answer (e.g. a page list on explorer.sources, as the data API served it before the paged route).
 */
export function fakeDataApi(
  queries: DataQueries,
  opts: {
    behaviour?: (route: string, attempt: number) => Behaviour;
    delayMs?: number;
    extra?: Record<string, Record<string, unknown>>;
  } = {},
): FakeDataApi {
  const requests: FakeRequest[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  const handlers: Record<string, (input: never) => Promise<unknown>> = {
    "parcels.search": (i) => queries.parcels.search(i),
    "parcels.detail": (i) => queries.parcels.detail(i),
    "parcels.points": (i) => queries.parcels.points(i),
    "explorer.runSummary": () => queries.explorer.runSummary(),
    "explorer.sources": () => queries.explorer.sources(),
    "permits.longOpen": (i) => queries.permits.longOpen(i),
    "permits.forParcel": (i) => queries.permits.forParcel(i),
    "places.resolve": (i) => queries.places.resolve(i),
  };
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== FAKE_API_URL)
      throw new Error(`fake data API: unexpected origin ${url.origin}`);
    const route = url.pathname.replace(/^\/trpc\//, "");
    const raw = url.searchParams.get("input");
    const body = raw === null ? undefined : (JSON.parse(raw) as unknown);
    const headers = new Headers(init?.headers);
    requests.push({
      route,
      input: body,
      authorization: headers.get("authorization"),
    });
    const n = (attempts.get(route) ?? 0) + 1;
    attempts.set(route, n);
    const b = opts.behaviour?.(route, n) ?? { kind: "answer" };
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      if (b.kind === "hang")
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      if (b.kind === "slow")
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal;
          const timer = setTimeout(resolve, b.ms);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (b.kind === "status")
        return new Response(b.body ?? '{"message":"Service Unavailable"}', {
          status: b.status,
          headers: { "content-type": "application/json" },
        });
      const handle = handlers[route];
      if (!handle)
        return new Response(
          JSON.stringify({
            error: {
              message: `No procedure found on path "${route}"`,
              code: -32004,
              data: { code: "NOT_FOUND", httpStatus: 404, path: route },
            },
          }),
          { status: 404 },
        );
      const data = {
        ...((await handle(body as never)) as Record<string, unknown>),
        ...(opts.extra?.[route] ?? {}),
      };
      return new Response(JSON.stringify({ result: { data } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } finally {
      inFlight--;
    }
  };
  return { fetch, requests, peak: () => peak };
}
