// @vitest-environment jsdom
/**
 * The "Ask the agent" tab, on
 * jsdom with fake timers (Date included). The agent API is the Explorer's real client (createAgentApi) over a fake
 * fetch: nothing leaves the process, and no request ever reaches a real /agent/answer.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ANSWERED,
  DUMMY_SIGNATURE_1,
  FOLLOW_UP,
  QUESTION_1,
  QUESTION_2,
  REFUSED,
  STANDING_GAPS,
  STOPPED,
} from "../e2e/agent-fixtures.ts";
import {
  ANSWER_TIMEOUT_MS,
  commitFrom,
  createAgentApi,
  type AnswerResponse,
} from "../src/agent-api.ts";
import { AskAgent, NOTICE } from "../src/AskAgent.tsx";
import { dateOnly } from "../src/dates.ts";
import { Markdown } from "../src/markdown.tsx";
import { HOLD_MAX_MS, REWARM_AFTER_MS } from "../src/warmup.ts";

const AGENT_URL = "https://agent.test";

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Reply =
  | { status: number; body: unknown }
  | Promise<{ status: number; body: unknown }>
  | "hang";

/**
 * The fake agent API: /agent/warm answers 200 unless the test holds it; /agent/answer replies from the queue.
 * Every request is recorded (method, path, body, authorization).
 */
function fakeAgent() {
  const requests: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
    authorization?: string;
  }> = [];
  const answers: Reply[] = [];
  let warm: () => Promise<{ status: number; body: unknown }> = async () => ({
    status: 200,
    body: { status: "warm" },
  });
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: headers.authorization,
      });
      expect(url.origin).toBe(AGENT_URL);
      let r: { status: number; body: unknown };
      if (url.pathname === "/agent/warm") r = await warm();
      else if (url.pathname === "/agent/answer") {
        const next = answers.shift();
        if (next === undefined) throw new Error("no answer queued");
        if (next === "hang")
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          );
        r = await next;
      } else throw new Error(`unexpected ${url.pathname}`);
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return {
    api: createAgentApi({ agentApiUrl: AGENT_URL, apiToken: "t", fetch }),
    requests,
    answers,
    answerRequests: () => requests.filter((r) => r.path === "/agent/answer"),
    warmRequests: () => requests.filter((r) => r.path === "/agent/warm"),
    holdWarm: (p: () => Promise<{ status: number; body: unknown }>) => {
      warm = p;
    },
    answerWith: (a: AnswerResponse) => answers.push({ status: 200, body: a }),
  };
}

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

let agent: ReturnType<typeof fakeAgent>;
let warmData: ReturnType<typeof vi.fn<() => Promise<unknown>>>;

function renderTab(active = true) {
  return render(
    <AskAgent agent={agent.api} warmData={warmData} active={active} />,
  );
}
const box = () =>
  screen.getByRole("textbox", { name: /question/i }) as HTMLTextAreaElement;
const send = () => screen.getByTestId("agent-send") as HTMLButtonElement;
const newConv = () => screen.getByTestId("agent-new") as HTMLButtonElement;
async function ask(q: string) {
  fireEvent.change(box(), { target: { value: q } });
  fireEvent.click(send());
  await flush();
}
/** Opens the tab and lets the warm-up answer. */
async function openWarm() {
  const r = renderTab();
  await flush();
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  agent = fakeAgent();
  warmData = vi.fn(async () => ({ api_version: "test" }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Ask the agent: warm-up and held questions", () => {
  test("opening the tab sends GET /agent/warm and two data API requests at once, with the Explorer's token", async () => {
    const data = [deferred<unknown>(), deferred<unknown>()];
    warmData.mockImplementation(
      () => data[warmData.mock.calls.length - 1]!.promise,
    );
    const w = deferred<{ status: number; body: unknown }>();
    agent.holdWarm(() => w.promise);
    renderTab();
    // All three are out before any has answered.
    expect(warmData).toHaveBeenCalledTimes(2);
    expect(agent.warmRequests()).toEqual([
      {
        method: "GET",
        path: "/agent/warm",
        body: undefined,
        authorization: "Bearer t",
      },
    ]);
    data[0]!.resolve({});
    data[1]!.resolve({});
    w.resolve({ status: 200, body: { status: "warm" } });
    await flush();
    expect(agent.answerRequests()).toEqual([]);
  });

  test("GET /agent/warm's commit is read when it is a commit (short or full hash, -dirty, unbundled), never otherwise", async () => {
    for (const c of ["f965598", "f965598-dirty", "unbundled", "a".repeat(40)])
      expect(commitFrom({ status: "warm", commit: c })).toBe(c);
    for (const body of [
      { status: "warm" },
      { status: "warm", commit: "" },
      { status: "warm", commit: "F965598" },
      { status: "warm", commit: "f96559" },
      { status: "warm", commit: "<b>x</b>" },
      { status: "warm", commit: 1234567 },
      null,
      "f965598",
    ])
      expect(commitFrom(body)).toBeUndefined();
    agent.holdWarm(async () => ({
      status: 200,
      body: { status: "warm", commit: "f965598" },
    }));
    expect(await agent.api.warm()).toEqual({ status: 200, commit: "f965598" });
    agent.holdWarm(async () => ({ status: 200, body: { status: "warm" } }));
    expect(await agent.api.warm()).toEqual({ status: 200 });
    // A refusal is an answer too (the warm-up is released by it), with no commit.
    agent.holdWarm(async () => ({
      status: 503,
      body: { error: "agent not configured", commit: "f965598" },
    }));
    expect(await agent.api.warm()).toEqual({ status: 503 });
  });

  test("a hidden tab does not warm up; opening it does", async () => {
    const r = renderTab(false);
    await flush();
    expect(warmData).not.toHaveBeenCalled();
    expect(agent.warmRequests()).toHaveLength(0);
    r.rerender(<AskAgent agent={agent.api} warmData={warmData} active />);
    await flush();
    expect(warmData).toHaveBeenCalledTimes(2);
    expect(agent.warmRequests()).toHaveLength(1);
  });

  test("a question asked before both warm-ups answered is held with a visible waking-up status and sent when both answer", async () => {
    const data = [deferred<unknown>(), deferred<unknown>()];
    warmData.mockImplementation(
      () => data[warmData.mock.calls.length - 1]!.promise,
    );
    const w = deferred<{ status: number; body: unknown }>();
    agent.holdWarm(() => w.promise);
    agent.answerWith(ANSWERED);
    renderTab();
    await ask(QUESTION_1);
    expect(screen.getByTestId("agent-status").dataset.state).toBe("waking");
    expect(screen.getByTestId("agent-status").textContent).toMatch(
      /waking up/i,
    );
    // A held question is pending: Send is disabled.
    expect(send().disabled).toBe(true);
    w.resolve({ status: 200, body: { status: "warm" } });
    data[0]!.resolve({});
    await flush();
    // The agent and one data request answered: still held.
    expect(agent.answerRequests()).toHaveLength(0);
    data[1]!.resolve({});
    await flush();
    expect(agent.answerRequests()).toHaveLength(1);
    expect(agent.answerRequests()[0]!.body).toEqual({ question: QUESTION_1 });
    expect(screen.getByTestId("agent-answer").dataset.status).toBe("answered");
  });

  test("a held question is sent after 20 s when the warm-ups have not answered", async () => {
    warmData.mockImplementation(() => new Promise(() => {}));
    agent.holdWarm(() => new Promise(() => {}));
    agent.answerWith(ANSWERED);
    renderTab();
    await ask(QUESTION_1);
    await wait(HOLD_MAX_MS - 1);
    expect(agent.answerRequests()).toHaveLength(0);
    expect(screen.getByTestId("agent-status").dataset.state).toBe("waking");
    await wait(1);
    expect(agent.answerRequests()).toHaveLength(1);
  });

  test("a warm-up that failed still releases the question (any answer counts) and leaves the data warm-up stale", async () => {
    warmData.mockRejectedValue(new Error("HTTP 503"));
    agent.holdWarm(async () => ({
      status: 503,
      body: { error: "agent not configured" },
    }));
    agent.answerWith(ANSWERED);
    agent.answerWith(FOLLOW_UP);
    await openWarm();
    await ask(QUESTION_1);
    expect(agent.answerRequests()).toHaveLength(1);
    // No data API response yet: the next question warms up again first.
    await ask(QUESTION_2);
    expect(agent.warmRequests()).toHaveLength(3);
    expect(warmData).toHaveBeenCalledTimes(6);
  });

  test("re-warm: a question sent more than 4 minutes after the last data API response runs the warm-up again and is held the same way", async () => {
    agent.answerWith(ANSWERED);
    agent.answerWith(FOLLOW_UP);
    await openWarm();
    expect(warmData).toHaveBeenCalledTimes(2);
    // Within 4 minutes: sent at once, no warm-up.
    await wait(REWARM_AFTER_MS - 1_000);
    await ask(QUESTION_1);
    expect(agent.answerRequests()).toHaveLength(1);
    expect(warmData).toHaveBeenCalledTimes(2);
    expect(agent.warmRequests()).toHaveLength(1);
    // Past 4 minutes since the last data response: warm-up again, the question held until it answers.
    await wait(2_000);
    const data = [deferred<unknown>(), deferred<unknown>()];
    warmData.mockImplementation(
      () => data[warmData.mock.calls.length - 3]!.promise,
    );
    await ask(QUESTION_2);
    expect(warmData).toHaveBeenCalledTimes(4);
    expect(agent.warmRequests()).toHaveLength(2);
    expect(screen.getByTestId("agent-status").dataset.state).toBe("waking");
    expect(agent.answerRequests()).toHaveLength(1);
    data[0]!.resolve({});
    data[1]!.resolve({});
    await flush();
    expect(agent.answerRequests()).toHaveLength(2);
  });

  test("re-warm hold also ends at 20 s", async () => {
    agent.answerWith(ANSWERED);
    await openWarm();
    await wait(REWARM_AFTER_MS + 1);
    warmData.mockImplementation(() => new Promise(() => {}));
    await ask(QUESTION_1);
    expect(warmData).toHaveBeenCalledTimes(4);
    await wait(HOLD_MAX_MS - 1);
    expect(agent.answerRequests()).toHaveLength(0);
    await wait(1);
    expect(agent.answerRequests()).toHaveLength(1);
  });
});

describe("Ask the agent: sending and statuses", () => {
  test("the notice under the box says the questions in this conversation, the center when you enter one, and the data are sent to Anthropic", async () => {
    await openWarm();
    expect(screen.getByTestId("agent-notice").textContent).toBe(NOTICE);
    expect(NOTICE).toMatch(
      /questions in this conversation, the center when you enter one, and the data the agent reads are sent to Anthropic to answer them\./,
    );
  });

  test("Send and New conversation are disabled from the click until the answer, a stop or an error (the warm-up hold included), and enabled whenever nothing is pending", async () => {
    const w = deferred<{ status: number; body: unknown }>();
    agent.holdWarm(() => w.promise);
    const a = deferred<{ status: number; body: unknown }>();
    const failed = deferred<{ status: number; body: unknown }>();
    const stopped = deferred<{ status: number; body: unknown }>();
    agent.answers.push(a.promise, failed.promise, stopped.promise);
    renderTab();
    const enabled = () => [send().disabled, newConv().disabled];
    expect(enabled()).toEqual([false, false]);
    // An empty box or an invalid center is refused in the panel: nothing is pending, Send stays enabled.
    await ask("");
    expect(screen.getByTestId("agent-message").textContent).toBe(
      "Type a question first.",
    );
    expect(enabled()).toEqual([false, false]);
    await ask(QUESTION_1);
    expect(screen.getByTestId("agent-status").dataset.state).toBe("waking");
    expect(enabled()).toEqual([true, true]);
    w.resolve({ status: 200, body: {} });
    await flush();
    expect(screen.getByTestId("agent-status").dataset.state).toBe("working");
    expect(enabled()).toEqual([true, true]);
    a.resolve({ status: 200, body: ANSWERED });
    await flush();
    expect(enabled()).toEqual([false, false]);
    // An error ends the pending question too.
    await ask(QUESTION_2);
    expect(enabled()).toEqual([true, true]);
    failed.resolve({ status: 500, body: { error: "internal error" } });
    await flush();
    expect(screen.getByTestId("agent-message")).toBeTruthy();
    expect(enabled()).toEqual([false, false]);
    // And a stop.
    fireEvent.click(send());
    await flush();
    expect(enabled()).toEqual([true, true]);
    stopped.resolve({ status: 200, body: STOPPED });
    await flush();
    expect(screen.getByTestId("agent-message").textContent).toContain(
      "stopped before it was complete",
    );
    expect(enabled()).toEqual([false, false]);
  });

  test("while waiting for the answer a working status shows; it goes when the answer is in", async () => {
    const a = deferred<{ status: number; body: unknown }>();
    agent.answers.push(a.promise);
    await openWarm();
    await ask(QUESTION_1);
    expect(screen.getByTestId("agent-status").dataset.state).toBe("working");
    expect(screen.getByTestId("agent-status").textContent).toMatch(/working/i);
    a.resolve({ status: 200, body: ANSWERED });
    await flush();
    expect(screen.queryByTestId("agent-status")).toBeNull();
    expect(box().value).toBe("");
  });

  test("while an answer is pending a second submit (Send is disabled; the form submitted otherwise) sends nothing and the new question stays in the box", async () => {
    const a = deferred<{ status: number; body: unknown }>();
    agent.answers.push(a.promise);
    await openWarm();
    await ask(QUESTION_1);
    fireEvent.change(box(), { target: { value: QUESTION_2 } });
    expect(send().disabled).toBe(true);
    fireEvent.click(send());
    fireEvent.submit(screen.getByTestId("agent-form"));
    await flush();
    expect(agent.answerRequests()).toHaveLength(1);
    expect(screen.queryByTestId("agent-message")).toBeNull();
    expect(box().value).toBe(QUESTION_2);
    a.resolve({ status: 200, body: ANSWERED });
    await flush();
    // The box kept the newer question, and Send is enabled for it.
    expect(box().value).toBe(QUESTION_2);
    expect(send().disabled).toBe(false);
  });

  test("a stopped answer shows a plain message and keeps the question; the conversation is unchanged", async () => {
    agent.answerWith(STOPPED);
    agent.answerWith(ANSWERED);
    await openWarm();
    await ask(QUESTION_1);
    const msg = screen.getByTestId("agent-message").textContent!;
    expect(msg).toContain("stopped before it was complete (time_budget)");
    expect(msg).toContain(STOPPED.text);
    expect(box().value).toBe(QUESTION_1);
    expect(screen.queryByTestId("agent-answer")).toBeNull();
    // Sent again: no history from the stopped answer.
    fireEvent.click(send());
    await flush();
    expect(agent.answerRequests()[1]!.body).toEqual({ question: QUESTION_1 });
    expect(screen.queryByTestId("agent-message")).toBeNull();
  });

  test.each([
    [
      500,
      { error: "internal error" },
      /not available right now \(HTTP 500: internal error\)/,
    ],
    [
      503,
      { error: "agent not configured" },
      /not available right now \(HTTP 503: agent not configured\)/,
    ],
    [
      502,
      { message: "Internal Server Error" },
      /not available right now \(HTTP 502/,
    ],
    [
      504,
      { message: "Gateway Timeout" },
      /did not answer in time \(gateway timeout, HTTP 504\)/,
    ],
  ])(
    "HTTP %i shows a plain message and keeps the question in the box",
    async (status, body, re) => {
      agent.answers.push({ status, body });
      await openWarm();
      await ask(QUESTION_1);
      expect(screen.getByTestId("agent-message").textContent).toMatch(re);
      expect(screen.getByTestId("agent-message").textContent).toContain(
        "Your question is still in the box",
      );
      expect(box().value).toBe(QUESTION_1);
      expect(screen.queryByTestId("agent-answer")).toBeNull();
      expect(screen.queryByTestId("agent-status")).toBeNull();
    },
  );

  test("no answer within the client timeout is a gateway timeout; the question stays", async () => {
    agent.answers.push("hang");
    await openWarm();
    await ask(QUESTION_1);
    await wait(ANSWER_TIMEOUT_MS - 1);
    expect(screen.getByTestId("agent-status").dataset.state).toBe("working");
    await wait(1);
    expect(screen.getByTestId("agent-message").textContent).toMatch(
      /did not answer in time \(gateway timeout\)/,
    );
    expect(box().value).toBe(QUESTION_1);
  });

  test("a refused answer is shown as a normal message, not an error", async () => {
    agent.answerWith(REFUSED);
    await openWarm();
    await ask("Who owns 2218022020?");
    const a = screen.getByTestId("agent-answer");
    expect(a.dataset.status).toBe("refused");
    expect(a.closest(".error")).toBeNull();
    expect(screen.getByTestId("agent-text").textContent).toBe(REFUSED.text);
    expect(screen.queryByTestId("agent-message")).toBeNull();
    expect(box().value).toBe("");
    // Gaps stay visible on a refusal.
    expect(
      within(a).getByTestId("agent-standing-gaps").querySelectorAll("li"),
    ).toHaveLength(STANDING_GAPS.length);
  });

  test("the center from the latitude and longitude fields is sent; one field alone is refused in the panel", async () => {
    agent.answerWith(ANSWERED);
    await openWarm();
    fireEvent.change(screen.getByRole("textbox", { name: "Latitude" }), {
      target: { value: "34.2" },
    });
    await ask("Roofs older than 20 years within 2 miles?");
    expect(agent.answerRequests()).toHaveLength(0);
    expect(screen.getByTestId("agent-message").textContent).toBe(
      "Enter both latitude and longitude, or neither.",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Longitude" }), {
      target: { value: "-118.45" },
    });
    fireEvent.click(send());
    await flush();
    expect(agent.answerRequests()[0]!.body).toEqual({
      question: "Roofs older than 20 years within 2 miles?",
      center: { lat: 34.2, lon: -118.45, label: "coordinates entered" },
    });
  });

  test.each([
    ["Latitude", "34.20155", { lat: 34.20155, lon: -118.45 }],
    ["Longitude", "-118.45361", { lat: 34.2, lon: -118.45361 }],
  ] as const)(
    "%s: cleared and retyped, it shows what was typed and the question sends it",
    async (name, typed, sent) => {
      agent.answerWith(ANSWERED);
      await openWarm();
      const lat = screen.getByRole("textbox", { name: "Latitude" });
      const lon = screen.getByRole("textbox", { name: "Longitude" });
      fireEvent.change(lat, { target: { value: "34.2" } });
      fireEvent.change(lon, { target: { value: "-118.45" } });
      const el = (name === "Latitude" ? lat : lon) as HTMLInputElement;
      fireEvent.change(el, { target: { value: "" } });
      expect(el.value).toBe("");
      fireEvent.change(el, { target: { value: el.value + typed } });
      expect(el.value).toBe(typed);
      await ask("Roofs older than 20 years within 2 miles?");
      expect(agent.answerRequests()[0]!.body).toMatchObject({
        center: { ...sent, label: "coordinates entered" },
      });
    },
  );

  test("a center field that is not a plain number in range is refused in the panel; nothing is sent", async () => {
    await openWarm();
    const lat = screen.getByRole("textbox", { name: "Latitude" });
    const lon = screen.getByRole("textbox", { name: "Longitude" });
    for (const [la, lo, message] of [
      ["1e1", "-118.45", "Latitude must be a number from -90 to 90."],
      ["91", "-118.45", "Latitude must be a number from -90 to 90."],
      ["34.2", "0x10", "Longitude must be a number from -180 to 180."],
      ["34.2", "-118,45", "Longitude must be a number from -180 to 180."],
    ] as const) {
      fireEvent.change(lat, { target: { value: la } });
      fireEvent.change(lon, { target: { value: lo } });
      await ask("Roofs older than 20 years within 2 miles?");
      expect(screen.getByTestId("agent-message").textContent).toBe(message);
    }
    expect(agent.answerRequests()).toHaveLength(0);
  });
});

describe("Ask the agent: conversation", () => {
  test("a follow-up sends the history, session and signature of the previous answer, from component state only", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    agent.answerWith(ANSWERED);
    agent.answerWith(FOLLOW_UP);
    await openWarm();
    await ask(QUESTION_1);
    expect(
      screen.getByRole("textbox", { name: /follow-up question/i }),
    ).toBeTruthy();
    await ask(QUESTION_2);
    expect(agent.answerRequests()[1]!.body).toEqual({
      question: QUESTION_2,
      history: ANSWERED.history,
      session: ANSWERED.session,
      signature: DUMMY_SIGNATURE_1,
    });
    expect(screen.getAllByTestId("agent-turn")).toHaveLength(2);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });

  test("a refused answer continues the conversation from what the server signed", async () => {
    agent.answerWith(ANSWERED);
    agent.answerWith({
      ...REFUSED,
      history: ANSWERED.history,
      session: ANSWERED.session,
      signature: "sig-r",
    });
    agent.answerWith(FOLLOW_UP);
    await openWarm();
    await ask(QUESTION_1);
    await ask("Who owns it?");
    await ask(QUESTION_2);
    expect(agent.answerRequests()[2]!.body).toMatchObject({
      signature: "sig-r",
      history: ANSWERED.history,
    });
  });

  test("New conversation clears the answers and the next question goes without history", async () => {
    agent.answerWith(ANSWERED);
    agent.answerWith(FOLLOW_UP);
    await openWarm();
    await ask(QUESTION_1);
    fireEvent.click(screen.getByTestId("agent-new"));
    expect(screen.queryByTestId("agent-turn")).toBeNull();
    await ask(QUESTION_2);
    expect(agent.answerRequests()[1]!.body).toEqual({ question: QUESTION_2 });
  });

  test("New conversation also clears the center fields: the next question goes without a center", async () => {
    agent.answerWith(ANSWERED);
    agent.answerWith(FOLLOW_UP);
    await openWarm();
    const lat = screen.getByRole("textbox", { name: "Latitude" });
    const lon = screen.getByRole("textbox", { name: "Longitude" });
    fireEvent.change(lat, { target: { value: "34.2" } });
    fireEvent.change(lon, { target: { value: "-118.45" } });
    await ask(QUESTION_1);
    expect(agent.answerRequests()[0]!.body).toMatchObject({
      center: { lat: 34.2, lon: -118.45 },
    });
    fireEvent.click(screen.getByTestId("agent-new"));
    expect((lat as HTMLInputElement).value).toBe("");
    expect((lon as HTMLInputElement).value).toBe("");
    await ask(QUESTION_2);
    expect(agent.answerRequests()[1]!.body).toEqual({ question: QUESTION_2 });
  });

  test("New conversation is disabled while a question is pending: the answer arrives and is kept", async () => {
    const a = deferred<{ status: number; body: unknown }>();
    agent.answers.push(a.promise);
    await openWarm();
    await ask(QUESTION_1);
    expect(newConv().disabled).toBe(true);
    fireEvent.click(newConv());
    a.resolve({ status: 200, body: ANSWERED });
    await flush();
    expect(screen.getAllByTestId("agent-turn")).toHaveLength(1);
    expect(newConv().disabled).toBe(false);
  });
});

describe("Ask the agent: rendering", () => {
  test("text as markdown, How I got this collapsed, Sources by kind, Gaps answer-first then Always true, unverified IDs flagged", async () => {
    agent.answerWith(ANSWERED);
    await openWarm();
    await ask(QUESTION_1);
    const a = screen.getByTestId("agent-answer");
    const text = within(a).getByTestId("agent-text");
    expect(text.querySelector("strong")!.textContent).toBe(
      "115,373 parcels within 5 miles of Van Nuys have roofs older than 15 years.",
    );
    expect(
      [...text.querySelectorAll("tbody tr")].map((r) => r.textContent),
    ).toEqual(["22180220202002PERMIT", "22180220392006PROXY"]);
    // Unverified IDs flagged where they appear, and listed.
    const marks = within(a).getAllByTestId("unverified-id");
    expect(marks.map((m) => m.textContent)).toEqual([
      "2218099999 (unverified)",
    ]);
    expect(within(a).getByTestId("agent-unverified").textContent).toContain(
      "2218099999",
    );
    // How I got this: collapsed, with reasoning and assumptions.
    const how = within(a).getByTestId("agent-how") as HTMLDetailsElement;
    expect(how.open).toBe(false);
    expect(how.querySelector("summary")!.textContent).toBe("How I got this");
    expect(how.textContent).toContain(ANSWERED.reasoning);
    expect(how.textContent).toContain(ANSWERED.assumptions[0]);
    // Sources: collapsible, closed, the count in the summary; grouped by kind, each row ID, source, license,
    // attribution, collected at (a date).
    const sources = within(a).getByTestId(
      "agent-sources-details",
    ) as HTMLDetailsElement;
    expect(sources.open).toBe(false);
    expect(sources.querySelector("summary")!.textContent).toBe(
      `Sources (${ANSWERED.records.length})`,
    );
    const tables = within(a).getAllByTestId("agent-sources");
    expect(tables.map((t) => t.dataset.kind)).toEqual([
      "parcel",
      "permit",
      "contractor",
    ]);
    expect(
      [...tables[0]!.querySelectorAll("th")].map((th) => th.textContent),
    ).toEqual(["ID", "Source", "License", "Attribution", "Collected at"]);
    const cells = (t: HTMLElement) =>
      [...t.querySelectorAll("tbody td")].map((td) => td.textContent);
    const [parcel, permit] = ANSWERED.records;
    expect(cells(tables[0]!)).toEqual([
      parcel!.id,
      parcel!.source_name,
      "—",
      "—",
      "2026-11-12",
    ]);
    expect(cells(tables[1]!)).toEqual([
      permit!.id,
      permit!.source_name,
      permit!.license,
      permit!.attribution,
      "2026-11-12",
    ]);
    // Gaps: collapsible and open.
    const gapsBox = within(a).getByTestId(
      "agent-gaps-details",
    ) as HTMLDetailsElement;
    expect(gapsBox.open).toBe(true);
    expect(gapsBox.querySelector("summary")!.textContent).toBe("Gaps");
    // Gaps: this answer's first, the standing ones under "Always true".
    expect(
      [...within(a).getByTestId("agent-gaps").querySelectorAll("li")].map(
        (l) => l.textContent,
      ),
    ).toEqual(ANSWERED.gaps.slice(STANDING_GAPS.length));
    expect(
      [
        ...within(a).getByTestId("agent-standing-gaps").querySelectorAll("li"),
      ].map((l) => l.textContent),
    ).toEqual(STANDING_GAPS);
    expect(within(a).getByText("Always true")).toBeTruthy();
  });

  test("dates as YYYY-MM-DD: a timestamp shows its date; a range within one day shows that date once", () => {
    expect(dateOnly("2026-11-12T00:26:18.151Z")).toBe("2026-11-12");
    expect(
      dateOnly("2026-11-12T13:10:47.174Z to 2026-11-12T13:14:48.715Z"),
    ).toBe("2026-11-12");
    expect(
      dateOnly("2026-11-12T23:10:47.174Z to 2026-11-13T00:14:48.715Z"),
    ).toBe("2026-11-12 to 2026-11-13");
    expect(dateOnly("2015-06-01")).toBe("2015-06-01");
    expect(dateOnly("not a date")).toBe("not a date");
  });

  test("markdown is rendered without raw HTML; only http(s) links become links", () => {
    const { container } = render(
      <Markdown
        text={
          '# Head\n\nA <b>bold</b> <img src=x onerror="alert(1)"> and <script>alert(1)</script>.\n\n- [ok](https://example.com) and [bad](javascript:alert(1))\n- `code`'
        }
      />,
    );
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    const links = [...container.querySelectorAll("a")];
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "https://example.com",
    ]);
    expect(container.textContent).toContain("[bad](javascript:alert(1))");
    expect(container.querySelector("h3")!.textContent).toBe("Head");
    expect(container.querySelector("code")!.textContent).toBe("code");
  });
});
