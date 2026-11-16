/**
 * A stop part-way through a tool round (alakazam review, finding 2): the history the answer returns (and the agent
 * API signs) must stay valid for the Messages API, with every tool_use answered, and truthful: a call that did not
 * run gets an is_error result saying so and why, and the answer lists it as a gap. Each follow-up model step is
 * validatingStep, which fails a request the Messages API would reject (400 invalid_request_error).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, test } from "vitest";
import { NOT_RUN_PREFIX, runAgent, type AgentAnswer } from "../src/agent.ts";
import type { DataQueries } from "../src/permit-api.ts";
import {
  ScriptedModel,
  textReply,
  toolReply,
} from "../src/testing/scripted-model.ts";
import {
  FAKE_PARCELS,
  SETTINGS,
  blockNetwork,
  fakeClock,
  fakeQueries,
  toolPairingProblems,
  validatingStep,
} from "./helpers.ts";

beforeAll(blockNetwork);

const TIME_NOT_RUN = `${NOT_RUN_PREFIX} (time_budget): the answer's time budget ran out.`;
const QUESTION = "What run is served, and what is parcel 1000000001?";
const TWO_CALLS = [
  { name: "run_summary", input: {} },
  { name: "parcel_detail", input: { parcel_id: FAKE_PARCELS[0]! } },
];

/** Fake queries where a call of the given read takes `ms` on the fake clock. */
function slow(
  clock: ReturnType<typeof fakeClock>,
  ms: number,
  which: "runSummary" | "detail",
): DataQueries {
  const { queries } = fakeQueries();
  return which === "runSummary"
    ? {
        ...queries,
        explorer: {
          ...queries.explorer,
          runSummary: async () => {
            clock.advance(ms);
            return queries.explorer.runSummary();
          },
        },
      }
    : {
        ...queries,
        parcels: {
          ...queries.parcels,
          detail: async (i) => {
            clock.advance(ms);
            return queries.parcels.detail(i);
          },
        },
      };
}

/** The tool results of the answer's last message: [tool_use_id order, text, is_error]. */
function lastResults(a: AgentAnswer): Array<[string, boolean]> {
  const last = a.history.at(-1)!;
  expect(last.role).toBe("user");
  return (last.content as Anthropic.ToolResultBlockParam[]).map((b) => [
    String(b.content).startsWith(NOT_RUN_PREFIX)
      ? String(b.content)
      : "(the tool's result)",
    b.is_error === true,
  ]);
}

/**
 * A follow-up question with the answer's history: each model step checks the conversation as the API does. With
 * `call`, the model reads run_summary first (needed when no tool ran in the conversation: the no-tool-call rule).
 */
async function followUp(a: AgentAnswer, call = false): Promise<AgentAnswer> {
  const model = new ScriptedModel([
    ...(call
      ? [validatingStep(toolReply([{ name: "run_summary", input: {} }]))]
      : []),
    validatingStep(textReply("The run is run-1.")),
  ]);
  return runAgent(
    { question: "Which run was that?", history: a.history },
    { model, queries: fakeQueries().queries, settings: SETTINGS },
  );
}

describe("a time-budget stop at each point of a tool round", () => {
  test("before any call of the round: both calls answered as not run, both listed as gaps; a follow-up is answered", async () => {
    const clock = fakeClock();
    const model = new ScriptedModel([
      () => {
        clock.advance(24_000);
        return toolReply(TWO_CALLS);
      },
    ]);
    const { queries, calls } = fakeQueries();
    const a = await runAgent(
      { question: QUESTION },
      { model, queries, settings: SETTINGS, now: clock.now },
    );
    expect(a).toMatchObject({ status: "stopped", stopped_by: "time_budget" });
    expect(a.usage.tool_calls).toBe(0);
    expect(calls.map((c) => c.fn)).toEqual(["explorer.sources"]);
    expect(toolPairingProblems(a.history)).toEqual([]);
    expect(lastResults(a)).toEqual([
      [TIME_NOT_RUN, true],
      [TIME_NOT_RUN, true],
    ]);
    expect(a.gaps).toContain(
      "run_summary was not run: the answer's time budget ran out.",
    );
    expect(a.gaps).toContain(
      "parcel_detail was not run: the answer's time budget ran out.",
    );
    // No tool ran in this conversation, so the follow-up's model reads a tool before it answers.
    const b = await followUp(a, true);
    expect(b).toMatchObject({ status: "answered", text: "The run is run-1." });
  });

  test("between the two calls: the first call's result, then the second answered as not run in the same message; only the second is a gap; a follow-up is answered", async () => {
    const clock = fakeClock();
    const model = new ScriptedModel([toolReply(TWO_CALLS)]);
    const a = await runAgent(
      { question: QUESTION },
      {
        model,
        queries: slow(clock, 24_000, "runSummary"),
        settings: SETTINGS,
        now: clock.now,
      },
    );
    expect(a).toMatchObject({ status: "stopped", stopped_by: "time_budget" });
    expect(a.usage.tool_calls).toBe(1);
    expect(toolPairingProblems(a.history)).toEqual([]);
    // One user message after the round: its results in the order of the calls.
    expect(a.history).toHaveLength(3);
    expect(lastResults(a)).toEqual([
      ["(the tool's result)", false],
      [TIME_NOT_RUN, true],
    ]);
    const ids = (a.history[1]!.content as Anthropic.ToolUseBlockParam[]).map(
      (b) => b.id,
    );
    expect(
      (a.history[2]!.content as Anthropic.ToolResultBlockParam[]).map(
        (b) => b.tool_use_id,
      ),
    ).toEqual(ids);
    expect(a.gaps).toContain(
      "parcel_detail was not run: the answer's time budget ran out.",
    );
    expect(a.gaps.some((g) => g.startsWith("run_summary was not run"))).toBe(
      false,
    );
    const b = await followUp(a);
    expect(b.stopped_by).toBeUndefined();
    expect(b).toMatchObject({ status: "answered", text: "The run is run-1." });
  });

  test("after the last call, before the next model call: every call ran, no not-run result or gap; a follow-up is answered", async () => {
    const clock = fakeClock();
    const model = new ScriptedModel([
      toolReply(TWO_CALLS),
      textReply("never reached"),
    ]);
    const a = await runAgent(
      { question: QUESTION },
      {
        model,
        queries: slow(clock, 24_000, "detail"),
        settings: SETTINGS,
        now: clock.now,
      },
    );
    expect(a).toMatchObject({ status: "stopped", stopped_by: "time_budget" });
    expect(model.requests).toHaveLength(1);
    expect(a.usage.tool_calls).toBe(2);
    expect(toolPairingProblems(a.history)).toEqual([]);
    expect(lastResults(a)).toEqual([
      ["(the tool's result)", false],
      ["(the tool's result)", false],
    ]);
    expect(a.gaps.some((g) => g.includes("was not run"))).toBe(false);
    const b = await followUp(a);
    expect(b).toMatchObject({ status: "answered", text: "The run is run-1." });
  });

  test("two calls of one tool not run: one gap with the count", async () => {
    const clock = fakeClock();
    const model = new ScriptedModel([
      toolReply([
        { name: "run_summary", input: {} },
        { name: "parcel_detail", input: { parcel_id: FAKE_PARCELS[0]! } },
        { name: "parcel_detail", input: { parcel_id: FAKE_PARCELS[1]! } },
      ]),
    ]);
    const a = await runAgent(
      { question: QUESTION },
      {
        model,
        queries: slow(clock, 24_000, "runSummary"),
        settings: SETTINGS,
        now: clock.now,
      },
    );
    expect(toolPairingProblems(a.history)).toEqual([]);
    expect(lastResults(a)).toEqual([
      ["(the tool's result)", false],
      [TIME_NOT_RUN, true],
      [TIME_NOT_RUN, true],
    ]);
    expect(a.gaps).toContain(
      "2 parcel_detail calls were not run: the answer's time budget ran out.",
    );
  });
});

describe("other stops with tool calls asked for", () => {
  test("the tool-call limit: the last round's calls answered as not run with its reason, listed as gaps; a follow-up is answered", async () => {
    const model = new ScriptedModel([
      toolReply([{ name: "run_summary", input: {} }]),
      toolReply([{ name: "run_summary", input: {} }]),
    ]);
    const a = await runAgent(
      { question: QUESTION },
      {
        model,
        queries: fakeQueries().queries,
        settings: { ...SETTINGS, maxToolTurns: 1 },
      },
    );
    expect(a).toMatchObject({
      status: "stopped",
      stopped_by: "max_tool_turns",
    });
    expect(toolPairingProblems(a.history)).toEqual([]);
    expect(lastResults(a)).toEqual([
      [
        `${NOT_RUN_PREFIX} (max_tool_turns): the answer's tool-call limit was reached.`,
        true,
      ],
    ]);
    expect(a.gaps).toContain(
      "run_summary was not run: the answer's tool-call limit was reached.",
    );
    const b = await followUp(a);
    expect(b).toMatchObject({ status: "answered", text: "The run is run-1." });
  });
});
