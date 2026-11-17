/**
 * The eval's value_sources expectation and check: prompts s1 and s2, the expectation on the prompts whose question
 * names the radius (verified against the agent's own rule), and check value_sources' fail and warning paths.
 */
import {
  questionMiles,
  valueSources,
  type AgentAnswer,
  type ValueSources,
} from "@oracle-la/agent";
import { describe, expect, test } from "vitest";
import {
  callsDefault,
  checkValueSources,
  milesText,
  type ToolCallRecord,
} from "../src/eval/checks.ts";
import {
  DEFAULT_PROMPTS_FILE,
  loadPrompts,
  promptsFileSchema,
} from "../src/eval/prompts.ts";

const prompts = loadPrompts(DEFAULT_PROMPTS_FILE);
const byId = (id: string) => {
  const p = prompts.find((x) => x.id === id || x.id.startsWith(`${id}-`));
  if (!p) throw new Error(`no prompt ${id}`);
  return p;
};
const PIN = { lat: 34.20008, lon: -118.48111, label: "map pin" };

describe("prompts s1 and s2; the value_sources expectation", () => {
  test("s1: a radius the question names over the screen's; s2: the screen's radius, not the default", () => {
    const s1 = byId("s1");
    const s2 = byId("s2");
    expect(s1.question).toBe(
      "Which properties within three miles of here have roofs older than 20 years?",
    );
    expect(s1.request).toEqual({
      center: PIN,
      screen: { radius_miles: 1, threshold_years: 15 },
    });
    expect(s1.expected).toEqual({
      tools: ["search_aged_roofs"],
      forbidden_tools: ["resolve_place"],
      tool_inputs: {
        search_aged_roofs: { radius_miles: 3, threshold_years: 20 },
      },
      gaps: [],
      refused: false,
      value_sources: { radius: "question", threshold: "question" },
      place: { outcome: "request_center" },
    });
    expect(s2.question).toBe(
      "Which properties around this pin have old roofs?",
    );
    expect(s2.request).toEqual({
      center: PIN,
      screen: { radius_miles: 2, threshold_years: 20 },
    });
    expect(s2.expected).toMatchObject({
      tool_inputs: {
        search_aged_roofs: { radius_miles: 2, threshold_years: 20 },
      },
      value_sources: { radius: "screen", threshold: "screen" },
      place: { outcome: "request_center" },
    });
    expect(s1.group).not.toBe(s2.group);
  });

  test("set on a1, b, c, d, d2, h, n, p, s1 and s2 only; each verified against the agent's rule for the search the prompt expects", () => {
    const withExpectation = prompts
      .filter((p) => p.expected.value_sources)
      .map((p) => p.id.split("-")[0]);
    expect(withExpectation).toEqual([
      "a1",
      "b",
      "c",
      "d",
      "d2",
      "h",
      "n",
      "p",
      "s1",
      "s2",
    ]);
    for (const p of prompts.filter((x) => x.expected.value_sources)) {
      const want = p.expected.value_sources!;
      const tool = p.expected.tools.find(
        (t) => t === "search_aged_roofs" || t === "long_open_permits",
      )!;
      const inputs = (p.expected.tool_inputs?.[tool] ?? {}) as Record<
        string,
        number
      >;
      // The radius: the prompt's tool_inputs, else the distance its question names (h).
      const radius = inputs.radius_miles ?? questionMiles(p.question)[0]!;
      const center = p.request?.center ?? { lat: 34.2, lon: -118.45 };
      const got: ValueSources = valueSources(
        {
          question: p.question,
          ...(p.request?.screen ? { screen: p.request.screen } : {}),
          ...(p.request?.center ? { center: p.request.center } : {}),
          places: p.request?.center ? [] : [center],
        },
        {
          lat: center.lat,
          lon: center.lon,
          radius_miles: radius,
          ...(tool === "search_aged_roofs"
            ? { threshold_years: inputs.threshold_years ?? 15 }
            : {}),
        },
      );
      expect([p.id, got.radius.source]).toEqual([p.id, want.radius]);
      if (want.threshold !== undefined)
        expect([p.id, got.threshold?.source]).toEqual([p.id, want.threshold]);
    }
    // n names no roof age ("10 years" is the ownership duration): no threshold expectation.
    expect(byId("n").expected.value_sources).toEqual({ radius: "question" });
  });

  test("the schema: value_sources needs a search tool; its threshold needs search_aged_roofs; names are the agent's sources", () => {
    const issues = (entry: unknown) =>
      JSON.stringify(promptsFileSchema.safeParse([entry]).error?.issues ?? []);
    const s1 = byId("s1");
    expect(issues(s1)).toBe("[]");
    expect(
      issues({
        ...s1,
        expected: {
          ...s1.expected,
          tools: ["run_summary"],
          tool_inputs: undefined,
        },
      }),
    ).toContain("value_sources needs search_aged_roofs or long_open_permits");
    const b = byId("b");
    expect(
      issues({
        ...b,
        expected: {
          ...b.expected,
          value_sources: { radius: "question", threshold: "question" },
        },
      }),
    ).toContain("value_sources.threshold needs search_aged_roofs in tools");
    for (const source of ["previous_area", "default", "other"])
      expect(
        issues({
          ...b,
          expected: { ...b.expected, value_sources: { radius: source } },
        }),
      ).toBe("[]");
    expect(
      issues({
        ...b,
        expected: { ...b.expected, value_sources: { radius: "the default" } },
      }),
    ).not.toBe("[]");
  });
});

describe("check value_sources", () => {
  const s1 = byId("s1");
  const S1_SOURCES: ValueSources = {
    radius: {
      value: 3,
      source: "question",
      text: "Radius 3 mi from the question (the screen shows 1 mi).",
    },
    threshold: {
      value: 20,
      source: "question",
      text: "Roof age threshold 20 years from the question (the screen shows 15 years).",
    },
  };
  const call = (
    result: unknown,
    name = "search_aged_roofs",
    is_error = false,
  ): ToolCallRecord => ({
    id: "toolu_1",
    name,
    input: { lat: PIN.lat, lon: PIN.lon, radius_miles: 3, threshold_years: 20 },
    result,
    is_error,
  });
  const answer = (text: string, assumptions: string[]) =>
    ({ text, assumptions }) as unknown as AgentAnswer;
  const ASSUMED = [S1_SOURCES.radius.text, S1_SOURCES.threshold!.text];
  const GOOD_TEXT =
    "Within 3 miles of the map pin, as your question asks, 42 properties have roofs older than 20 years, the threshold from your question.";

  test("pass: the expected sources, their sentences in the assumptions, the text naming them", () => {
    expect(
      checkValueSources(
        answer(GOOD_TEXT, ASSUMED),
        [call({ count: 42, value_sources: S1_SOURCES })],
        s1.expected,
      ),
    ).toEqual({
      result: "pass",
      details: [
        "search_aged_roofs radius 3 mi: source question; assumption stated",
        "search_aged_roofs threshold 20 years: source question; assumption stated",
      ],
    });
  });

  test("fail: another source; no value_sources (a transcript from before them); the assumptions lack the result's text; no search", () => {
    const wrong = checkValueSources(
      answer(GOOD_TEXT, ASSUMED),
      [
        call({
          value_sources: {
            ...S1_SOURCES,
            radius: { ...S1_SOURCES.radius, source: "default" },
          },
        }),
      ],
      s1.expected,
    );
    expect(wrong.result).toBe("fail");
    expect(wrong.details[0]).toBe(
      "search_aged_roofs radius 3 mi: source default (NOT the expected question); assumption stated",
    );
    const old = checkValueSources(
      answer(GOOD_TEXT, ASSUMED),
      [call({ count: 42 })],
      s1.expected,
    );
    expect(old).toMatchObject({
      result: "fail",
      details: ["search_aged_roofs: the result has no value_sources"],
    });
    const unstated = checkValueSources(
      answer(GOOD_TEXT, [S1_SOURCES.radius.text]),
      [call({ value_sources: S1_SOURCES })],
      s1.expected,
    );
    expect(unstated.result).toBe("fail");
    expect(unstated.details[1]).toContain("assumption NOT stated");
    // Every search is checked: a second result with another source fails.
    expect(
      checkValueSources(
        answer(GOOD_TEXT, ASSUMED),
        [
          call({ value_sources: S1_SOURCES }),
          call(
            {
              value_sources: {
                radius: { ...S1_SOURCES.radius, source: "screen" },
              },
            },
            "long_open_permits",
          ),
        ],
        s1.expected,
      ).result,
    ).toBe("fail");
    expect(
      checkValueSources(answer(GOOD_TEXT, ASSUMED), [], s1.expected),
    ).toMatchObject({ result: "fail", details: ["no search"] });
    // A threshold expected but only long_open_permits searched.
    expect(
      checkValueSources(
        answer(GOOD_TEXT, ASSUMED),
        [
          call(
            { value_sources: { radius: S1_SOURCES.radius } },
            "long_open_permits",
          ),
        ],
        s1.expected,
      ).details,
    ).toContain("threshold: no search_aged_roofs result");
  });

  test("n/a: no expectation, or every search failed (no result to read)", () => {
    expect(
      checkValueSources(answer(GOOD_TEXT, ASSUMED), [call({ count: 42 })], {
        ...s1.expected,
        value_sources: undefined,
      }).result,
    ).toBe("n/a");
    expect(
      checkValueSources(
        answer(GOOD_TEXT, ASSUMED),
        [call({ error: "data API busy" }, "search_aged_roofs", true)],
        s1.expected,
      ).result,
    ).toBe("n/a");
  });

  test("a radius from the previous area: the answer's reuse line stands for the result's text", () => {
    const want = {
      ...s1.expected,
      value_sources: { radius: "previous_area" as const },
    };
    const vs = {
      radius: {
        value: 2,
        source: "previous_area",
        text: "Radius 2 mi from the previous search area.",
      },
    };
    expect(
      checkValueSources(
        answer("In the same area as before, 2 miles around the pin, ...", [
          "Radius and center reused from the previous question (map pin, 2 mi).",
        ]),
        [call({ value_sources: vs }, "long_open_permits")],
        want,
      ),
    ).toEqual({
      result: "pass",
      details: [
        "long_open_permits radius 2 mi: source previous_area; assumption stated as the reuse line",
      ],
    });
    expect(
      checkValueSources(
        answer("2 miles.", []),
        [call({ value_sources: vs }, "long_open_permits")],
        want,
      ).result,
    ).toBe("fail");
  });

  test('warnings only: "the default" for a value from the question; the text not naming a source or not stating the value', () => {
    const a1 = byId("a1");
    const A1_SOURCES = {
      radius: {
        value: 5,
        source: "question",
        text: "Radius 5 mi from the question.",
      },
      threshold: {
        value: 15,
        source: "question",
        text: "Roof age threshold 15 years from the question.",
      },
    };
    // The recorded rounds' wording (c8a8712-r1 a1): "5 miles, the default".
    const recorded = checkValueSources(
      answer(
        "**115,169 parcels** within 5 miles of Van Nuys have roofs older than 15 years.\n\n**Assumptions**\n- **Radius:** 5 miles, the default.\n- **Threshold:** 15 years, from your question.",
        [A1_SOURCES.radius.text, A1_SOURCES.threshold.text],
      ),
      [call({ value_sources: A1_SOURCES })],
      a1.expected,
    );
    expect(recorded.result).toBe("pass");
    expect(recorded.warnings).toEqual([
      'radius 5 mi: the text calls it the default, but its source is the question: "- **Radius:** 5 miles, the default."',
      "radius 5 mi: the text states the value but does not name its source (the question)",
    ]);
    // The same text with a result recorded before value_sources: fail, and the same warnings (the call's values, the
    // expected sources).
    const before = checkValueSources(
      answer(
        "**115,169 parcels** within 5 miles of Van Nuys have roofs older than 15 years.\n\n**Assumptions**\n- **Radius:** 5 miles, the default.\n- **Threshold:** 15 years, from your question.",
        [A1_SOURCES.radius.text, A1_SOURCES.threshold.text],
      ),
      [
        {
          ...call({ count: 115_169 }),
          input: {
            lat: 34.20155,
            lon: -118.45361,
            radius_miles: 5,
            threshold_years: 15,
          },
        },
      ],
      a1.expected,
    );
    expect(before.result).toBe("fail");
    expect(before.details).toEqual([
      "search_aged_roofs: the result has no value_sources",
    ]);
    expect(before.warnings).toEqual(recorded.warnings);
    const silent = checkValueSources(
      answer("Within 3 miles of the pin, 42 properties match.", ASSUMED),
      [call({ value_sources: S1_SOURCES })],
      s1.expected,
    );
    expect(silent.result).toBe("pass");
    expect(silent.warnings).toEqual([
      "radius 3 mi: the text states the value but does not name its source (the question)",
      "threshold 20 years: the text does not state the value or its source",
    ]);
  });

  test("callsDefault: the words around the value's own mention only", () => {
    const five = milesText(5);
    expect(callsDefault("Radius: 5 miles, the default.", five)).toBe(true);
    expect(callsDefault("I used the default radius of 5 miles.", five)).toBe(
      true,
    );
    expect(callsDefault("Within 5 miles (the default).", five)).toBe(true);
    expect(
      callsDefault(
        "Within 5 miles from your question; the threshold is the default 15 years.",
        five,
      ),
    ).toBe(false);
    expect(
      callsDefault(
        "Within 5 miles from your question, roofs older than 15 years (the default).",
        five,
      ),
    ).toBe(false);
  });
});
