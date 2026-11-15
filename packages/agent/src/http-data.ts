/**
 * The HTTP DataQueries adapter: the tools' data read from the hosted data API through @oracle-la/api-client (tRPC
 * over GET), with the caller's own bearer token forwarded (hosting plan revision 1 §1, revision 2 §1). One adapter
 * serves one answer (the hosted agent builds one per request) or one MCP server process.
 *
 * The data API runs with reserved concurrency 5. The boundary follows the kit's external-dependency rule
 * (apply-engineering-guidelines/rules/external-dependency-boundaries.md): a synchronous call is allowed for an
 * interactive caller only with a strict client timeout (5 s at most), a bulkhead and a fallback ("Synchronous
 * Exception Criteria"), and transient failures are retried with exponential backoff and full jitter, never the
 * non-retriable ones ("Retries with Exponential Backoff and Jitter"):
 * - bulkhead: at most MAX_IN_FLIGHT (2) data API calls in flight per adapter; further calls wait for a slot. Two
 *   answers in parallel (the agent's reserved concurrency) hold at most 4 of the data API's 5.
 * - timeout: each attempt (response headers and body) has CALL_TIMEOUT_MS (5,000 ms) at most, cut to what is left
 *   of the answer's deadline when one is given. An attempt given up here may still run in the data API until it
 *   ends (a cold start takes 8–12 s), holding one of its 5 slots meanwhile; the bulkhead counts this side only.
 * - first call: the adapter's first data call (the hosted agent's explorer.sources read, before the first model call)
 *   has FIRST_CALL_TIMEOUT_MS (10,000 ms) per attempt instead, its retry too; the deadline still cuts it. It is the
 *   call most likely to meet a cold data API environment (5.4–6.2 s measured at 2,048 MB), which a 5 s attempt cut
 *   twice. A documented exception to the 5 s default for this one call; every other call keeps 5 s. In the MCP
 *   server (one adapter per process) it is the process's first call. Its timeout gap names its 10 s.
 * - retry: an attempt refused by the cap (HTTP 429 or 503), another transient status (500, 502, 504) or a timeout
 *   is retried once, after a full-jitter wait of random × min(RETRY_CAP_MS, RETRY_BASE_MS × 2) = 0–500 ms, and only
 *   if the deadline leaves time for it. Any other status (400, 401, 403, 404, ...) is not retried.
 * - fallback: when the retry fails too, the call throws DataApiUnavailableError. runTool turns it into a failed
 *   tool result with the gap "data API busy: <route> not read" (or its timeout / error / time-budget wording);
 *   search_aged_roofs lists a parcel whose parcels.detail was not read with that gap, never a silent null.
 * The route list is the tools' (permit-api.ts DataQueries). explorer.sources returns the sources only: a page list
 * the data API may still send is dropped here, so it can never reach a tool result or the model.
 */
import { createApiClient } from "@oracle-la/api-client";
import type { DataQueries } from "./permit-api.ts";

/** Data API calls in flight at once per adapter (hosting plan revision 2 §1). */
export const MAX_IN_FLIGHT = 2;
/** Longest one attempt may take, headers and body (the kit's synchronous exception: 5 s at most). */
export const CALL_TIMEOUT_MS = 5_000;
/**
 * Longest one attempt of the adapter's first call may take (and its retry's). Worst case against the hosted answer's
 * 25 s budget (AGENT_TIME_BUDGET_MS): 10 s + a 0–500 ms jitter wait + 10 s = 20.5 s on the data side, leaving about
 * 25 − 20.5 − 1.5 (agent.ts TIME_RESERVE_MS) = 3 s for the model calls (5 s + 0.5 + 5 s left 13 s before). The budget
 * logic is unchanged: each attempt is cut to the deadline, the retry starts only if the deadline leaves time for its
 * wait, and the agent checks what is left before each model call (stopped_by "time_budget" when nothing is).
 */
export const FIRST_CALL_TIMEOUT_MS = 10_000;
/** Full-jitter backoff before the one retry: random × min(RETRY_CAP_MS, RETRY_BASE_MS × 2^1) = 0–500 ms. */
export const RETRY_BASE_MS = 250;
export const RETRY_CAP_MS = 2_000;
/** Attempts per call: the first and one retry. */
export const MAX_ATTEMPTS = 2;
/** Statuses refused by the data API's cap (API Gateway throttling or the function's reserved concurrency). */
export const BUSY_STATUSES: ReadonlySet<number> = new Set([429, 503]);
/** Other transient statuses, retried the same way (the kit's retry rule names 429, 500, 502, 503 and 504). */
export const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  ...BUSY_STATUSES,
  500,
  502,
  504,
]);

export type UnavailableReason = "busy" | "timeout" | "error" | "time_budget";

/** A data API call that was not read after its retry (or not started: no time left in the answer). */
export class DataApiUnavailableError extends Error {
  readonly route: string;
  readonly reason: UnavailableReason;
  /** The last HTTP status, when there was a response. */
  readonly status: number | null;
  constructor(
    route: string,
    reason: UnavailableReason,
    status: number | null = null,
    /** The call's per-attempt limit, named by the timeout gap: CALL_TIMEOUT_MS, or FIRST_CALL_TIMEOUT_MS. */
    timeoutMs: number = CALL_TIMEOUT_MS,
  ) {
    super(unavailableGap(route, reason, status, timeoutMs));
    this.name = "DataApiUnavailableError";
    this.route = route;
    this.reason = reason;
    this.status = status;
  }
  /** The gap the answer states. */
  get gap(): string {
    return this.message;
  }
}

/** The gap text of a call not read: "data API busy: <route> not read" and the other reasons' wording. */
export function unavailableGap(
  route: string,
  reason: UnavailableReason,
  status: number | null = null,
  timeoutMs: number = CALL_TIMEOUT_MS,
): string {
  switch (reason) {
    case "busy":
      return `data API busy: ${route} not read`;
    case "timeout":
      return `data API timeout: ${route} not read (no answer within ${timeoutMs / 1000} s, twice)`;
    case "error":
      return `data API error${status !== null ? ` ${status}` : ""}: ${route} not read`;
    case "time_budget":
      return `data API not called: ${route} not read (the answer's time budget ran out)`;
  }
}

/** The DataApiUnavailableError in an error's cause chain (tRPC wraps what fetch throws), or null. */
export function unavailableIn(err: unknown): DataApiUnavailableError | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof DataApiUnavailableError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** A counting semaphore: at most `size` holders; the rest wait in order. */
class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];
  constructor(size: number) {
    this.free = size;
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }
}

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpDataQueriesOptions {
  /** The data API's base URL (https://<id>.execute-api.<region>.amazonaws.com). */
  apiUrl: string;
  /** The bearer token: the caller's own (hosted agent) or the "mcp" client's (MCP server). Kept in memory only. */
  apiToken: string;
  /** Epoch ms after which no call starts; each attempt's timeout is cut to it (the answer's deadline). */
  deadline?: number;
  now?: () => number;
  /** The fetch under the adapter (default the global fetch; tests pass a fake data API). */
  fetch?: Fetch;
  /** Uniform [0, 1) for the jitter (default Math.random). */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default MAX_IN_FLIGHT; at least 1. */
  maxInFlight?: number;
  /** Default CALL_TIMEOUT_MS; never more than it. */
  callTimeoutMs?: number;
  /** The first call's: default FIRST_CALL_TIMEOUT_MS; never more than it. */
  firstCallTimeoutMs?: number;
}

/** "parcels.detail" from ".../trpc/parcels.detail?input=..." (the route as the gap names it). */
function routeOf(input: string | URL | Request): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const i = url.pathname.lastIndexOf("/trpc/");
  return i >= 0
    ? decodeURIComponent(url.pathname.slice(i + "/trpc/".length))
    : url.pathname;
}

class AttemptTimeout extends Error {}

/**
 * The fetch the tRPC client uses: bulkhead, per-attempt timeout over headers and body, one retry with full jitter
 * on a transient status or a timeout, then DataApiUnavailableError. Exported for the tests.
 */
export function guardedFetch(opts: HttpDataQueriesOptions): {
  fetch: Fetch;
  /** The most calls that were in flight at once (for the tests and the in-flight report). */
  peak: () => number;
} {
  const inner: Fetch = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const callTimeout = Math.min(
    opts.callTimeoutMs ?? CALL_TIMEOUT_MS,
    CALL_TIMEOUT_MS,
  );
  const firstCallTimeout = Math.min(
    opts.firstCallTimeoutMs ?? FIRST_CALL_TIMEOUT_MS,
    FIRST_CALL_TIMEOUT_MS,
  );
  /** Calls made so far: the first one (by call order, not by finish) gets the first call's limit. */
  let calls = 0;
  const slots = new Slots(Math.max(1, opts.maxInFlight ?? MAX_IN_FLIGHT));
  let inFlight = 0;
  let peak = 0;
  const left = () =>
    opts.deadline === undefined ? Infinity : opts.deadline - now();

  /** One attempt: the response with its body read inside the timeout, or "timeout". */
  async function attempt(
    input: string | URL | Request,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<Response | "timeout"> {
    const ac = new AbortController();
    const outer = init?.signal;
    const onAbort = () => ac.abort(outer?.reason);
    outer?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(new AttemptTimeout()), timeoutMs);
    try {
      const res = await inner(input, { ...init, signal: ac.signal });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (err) {
      if (ac.signal.reason instanceof AttemptTimeout) return "timeout";
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  const fetch: Fetch = async (input, init) => {
    const route = routeOf(input);
    const first = calls++ === 0;
    const limit = first ? firstCallTimeout : callTimeout;
    // The limit the gap names: the nominal one, whatever a test shortens the attempts to.
    const nominal = first ? FIRST_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS;
    await slots.acquire();
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      for (let n = 1; ; n++) {
        const timeoutMs = Math.min(limit, left());
        if (timeoutMs <= 0)
          throw new DataApiUnavailableError(route, "time_budget");
        const res = await attempt(input, init, timeoutMs);
        if (res !== "timeout" && !TRANSIENT_STATUSES.has(res.status))
          return res;
        const status = res === "timeout" ? null : res.status;
        const reason: UnavailableReason =
          res === "timeout"
            ? "timeout"
            : BUSY_STATUSES.has(res.status)
              ? "busy"
              : "error";
        // Full jitter: a uniform wait from 0 to min(cap, base × 2^n) ms.
        const wait = random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** n);
        if (n >= MAX_ATTEMPTS || left() - wait <= 0)
          throw new DataApiUnavailableError(route, reason, status, nominal);
        await sleep(wait);
      }
    } finally {
      inFlight--;
      slots.release();
    }
  };
  return { fetch, peak: () => peak };
}

/** The tools' DataQueries over the hosted data API. */
export function httpDataQueries(opts: HttpDataQueriesOptions): DataQueries & {
  /** The most data API calls this adapter had in flight at once. */
  peakInFlight: () => number;
} {
  const guarded = guardedFetch(opts);
  const api = createApiClient({
    apiUrl: opts.apiUrl,
    apiToken: opts.apiToken,
    batch: false,
    fetch: guarded.fetch,
  });
  /** A tRPC error that wraps DataApiUnavailableError is rethrown as that error (its gap names the route). */
  const call = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      throw unavailableIn(err) ?? err;
    }
  };
  return {
    parcels: {
      search: (input) => call(api.parcels.search.query(input)),
      detail: (input) => call(api.parcels.detail.query(input)),
      points: (input) => call(api.parcels.points.query(input)),
    },
    explorer: {
      runSummary: () => call(api.explorer.runSummary.query()),
      // The sources only (names, URLs, terms, license, attribution, counts, windows); never a page list.
      sources: async () => {
        const res = await call(api.explorer.sources.query());
        return { sources: res.sources };
      },
    },
    permits: {
      longOpen: (input) => call(api.permits.longOpen.query(input)),
      forParcel: (input) => call(api.permits.forParcel.query(input)),
    },
    places: {
      resolve: (input) => call(api.places.resolve.query(input)),
    },
    peakInFlight: guarded.peak,
  };
}
