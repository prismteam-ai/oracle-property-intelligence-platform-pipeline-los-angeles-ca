/**
 * Where a search's radius and roof age threshold came from (value-source.ts): the rule, its sentences, the
 * `value_sources` of search_aged_roofs' and long_open_permits' results (the model reads them before it answers), and
 * the answer's assumptions built from the same sentences.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { runAgent } from "../src/agent.ts";
import { runTool } from "../src/tools.ts";
import {
  ScriptedModel,
  lastToolResult,
  textReply,
  toolReply,
} from "../src/testing/scripted-model.ts";
import {
  DEFAULT_RADIUS_MILES,
  DEFAULT_THRESHOLD_YEARS,
  questionMiles,
  questionYears,
  valueSourceAssumption,
  valueSources,
  type ValueSources,
} from "../src/value-source.ts";
import {
  SETTINGS,
  VAN_NUYS_RESOLVED,
  blockNetwork,
  fakeQueries,
} from "./helpers.ts";

beforeAll(blockNetwork);

const PIN = { lat: 34.20008, lon: -118.48111, label: "map pin" };
const SCREEN = { radius_miles: 1, threshold_years: 15 };

describe("valueSources: the rule and its sentences", () => {
  test("number words and digits in the question", () => {
    expect(
      questionMiles(
        "within five miles, a mile, half a mile, a 2-mile circle, 2.5 mi",
      ),
    ).toEqual([5, 1, 0.5, 2, 2.5]);
    expect(
      questionYears("older than twenty years, 25-year-old roofs, 40 years"),
    ).toEqual([20, 25, 40]);
    expect(DEFAULT_RADIUS_MILES).toBe(5);
    expect(DEFAULT_THRESHOLD_YEARS).toBe(15);
  });

  test("question: a value the question names, even when it equals the default (five miles of Van Nuys)", () => {
    const v = valueSources(
      {
        question:
          "Which properties within five miles of Van Nuys have roofs older than 15 years?",
      },
      { ...VAN_NUYS_RESOLVED, radius_miles: 5, threshold_years: 15 },
    );
    expect(v).toEqual({
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
    } satisfies ValueSources);
  });

  test("question over the screen; screen; default; other: each text is valueSourceAssumption's", () => {
    const at = { lat: PIN.lat, lon: PIN.lon };
    const s1 = valueSources(
      {
        question:
          "Which properties within three miles of here have roofs older than 20 years?",
        screen: SCREEN,
        center: PIN,
      },
      { ...at, radius_miles: 3, threshold_years: 20 },
    );
    expect(s1.radius.text).toBe(
      "Radius 3 mi from the question (the screen shows 1 mi).",
    );
    expect(s1.threshold!.text).toBe(
      "Roof age threshold 20 years from the question (the screen shows 15 years).",
    );
    const s2 = valueSources(
      {
        question: "Which properties around this pin have old roofs?",
        screen: { radius_miles: 2, threshold_years: 20 },
        center: PIN,
      },
      { ...at, radius_miles: 2, threshold_years: 20 },
    );
    expect([s2.radius.source, s2.threshold!.source]).toEqual([
      "screen",
      "screen",
    ]);
    expect(s2.radius.text).toBe(
      "Radius 2 mi from the screen (the question gives no distance).",
    );
    const dflt = valueSources(
      { question: "Old roofs here?", screen: SCREEN, center: PIN },
      { ...at, radius_miles: 5, threshold_years: 15 },
    );
    expect(dflt.radius).toEqual({
      value: 5,
      source: "default",
      text: "Radius 5 mi: the tool's default, not the screen's 1 mi.",
    });
    expect(dflt.threshold!.source).toBe("screen");
    const other = valueSources(
      { question: "Old roofs here?", center: PIN },
      { ...at, radius_miles: 3, threshold_years: 30 },
    );
    expect(other.radius.text).toBe(
      "Radius 3 mi: from neither the question nor the previous search area.",
    );
    expect(other.threshold!.text).toBe(
      "Roof age threshold 30 years: from neither the question nor the previous search area.",
    );
    const screens = [SCREEN, { radius_miles: 2, threshold_years: 20 }, SCREEN];
    for (const [i, v] of [s1, s2, dflt, other].entries()) {
      const screen = screens[i];
      expect(v.radius.text).toBe(
        valueSourceAssumption(
          "radius",
          v.radius.value,
          v.radius.source,
          screen?.radius_miles,
        ),
      );
      expect(v.threshold!.text).toBe(
        valueSourceAssumption(
          "threshold",
          v.threshold!.value,
          v.threshold!.source,
          screen?.threshold_years,
        ),
      );
    }
  });

  test("previous area: only at the previous area's center, and only when neither the request's center nor a place resolved in the answer is there (explain()'s rule); the threshold never", () => {
    const previous = { lat: 34.1, lon: -118.3, radius_miles: 2 };
    const input = {
      lat: 34.1,
      lon: -118.3,
      radius_miles: 2,
      threshold_years: 15,
    };
    const reused = valueSources(
      { question: "And in that area?", previous },
      input,
    );
    expect(reused.radius).toEqual({
      value: 2,
      source: "previous_area",
      text: "Radius 2 mi from the previous search area.",
    });
    expect(reused.threshold!.source).toBe("default");
    // Elsewhere: not the previous area's radius.
    expect(
      valueSources(
        { question: "And in that area?", previous },
        { ...input, lat: 34.2 },
      ).radius.source,
    ).toBe("other");
    // The request's center at the same point: attributed to the request, not to the previous area.
    expect(
      valueSources(
        { question: "And in that area?", previous, center: previous },
        input,
      ).radius.source,
    ).toBe("other");
    // A place resolved earlier in the answer at the same point: attributed to the place.
    expect(
      valueSources(
        { question: "And in that area?", previous, places: [previous] },
        input,
      ).radius.source,
    ).toBe("other");
    // The question's value wins over the previous area's.
    expect(
      valueSources({ question: "Within two miles of there?", previous }, input)
        .radius.source,
    ).toBe("question");
  });
});

describe("runTool: value_sources in the search results", () => {
  const ctx = {
    question:
      "Which properties within three miles of here have roofs older than 20 years?",
    screen: SCREEN,
    center: PIN,
  };
  test("search_aged_roofs states the radius and the threshold; long_open_permits the radius only", async () => {
    const { queries } = fakeQueries();
    const s = await runTool(
      "search_aged_roofs",
      { lat: PIN.lat, lon: PIN.lon, radius_miles: 3, threshold_years: 20 },
      queries,
      ctx,
    );
    expect(s.ok).toBe(true);
    expect((s.content as { value_sources: unknown }).value_sources).toEqual({
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
    });
    const l = await runTool(
      "long_open_permits",
      { lat: PIN.lat, lon: PIN.lon, radius_miles: 1 },
      queries,
      ctx,
    );
    expect(l.ok).toBe(true);
    expect((l.content as { value_sources: unknown }).value_sources).toEqual({
      radius: {
        value: 1,
        source: "screen",
        text: "Radius 1 mi from the screen (the question gives no distance).",
      },
    });
  });

  test("defaults applied: a search with no radius and no threshold states the defaults", async () => {
    const { queries } = fakeQueries();
    const s = await runTool(
      "search_aged_roofs",
      { lat: PIN.lat, lon: PIN.lon },
      queries,
      { question: "Old roofs here?" },
    );
    const v = (s.content as { value_sources: ValueSources }).value_sources;
    expect([v.radius.text, v.threshold!.text]).toEqual([
      "Radius 5 mi: the tool's default.",
      "Roof age threshold 15 years: the tool's default.",
    ]);
  });

  test("without a request context (an MCP call), other tools, or a failed input: no value_sources", async () => {
    const { queries } = fakeQueries();
    const noCtx = await runTool(
      "search_aged_roofs",
      { lat: PIN.lat, lon: PIN.lon, radius_miles: 3 },
      queries,
    );
    expect(noCtx.content).not.toHaveProperty("value_sources");
    const place = await runTool(
      "resolve_place",
      { name: "Van Nuys" },
      queries,
      ctx,
    );
    expect(place.content).not.toHaveProperty("value_sources");
    const bad = await runTool(
      "search_aged_roofs",
      { lat: PIN.lat, lon: PIN.lon, radius_miles: 99 },
      queries,
      ctx,
    );
    expect(bad.ok).toBe(false);
    expect(bad.content).not.toHaveProperty("value_sources");
  });
});

describe("runAgent: the model reads value_sources; the assumptions state the same sentences", () => {
  const sourcesSeen = (model: ScriptedModel, tool: string): ValueSources =>
    (
      lastToolResult(model.requests.at(-1)!.params, tool) as {
        value_sources: ValueSources;
      }
    ).value_sources;

  test('"within five miles of Van Nuys": the result says question, not default, and the assumptions carry its text', async () => {
    const model = new ScriptedModel([
      toolReply([{ name: "resolve_place", input: { name: "Van Nuys" } }]),
      toolReply([
        {
          name: "search_aged_roofs",
          input: { ...VAN_NUYS_RESOLVED, radius_miles: 5, threshold_years: 15 },
        },
      ]),
      textReply("Listed."),
    ]);
    const a = await runAgent(
      {
        question:
          "Which properties in Los Angeles County within five miles of Van Nuys have roofs older than 15 years?",
      },
      { model, queries: fakeQueries().queries, settings: SETTINGS },
    );
    const v = sourcesSeen(model, "search_aged_roofs");
    expect(v.radius.source).toBe("question");
    expect(v.threshold!.source).toBe("question");
    expect(a.assumptions).toContain(v.radius.text);
    expect(a.assumptions).toContain(v.threshold!.text);
  });

  test("a follow-up at the previous area: previous_area in the result; the assumptions keep their reuse line (unchanged)", async () => {
    const first = await runAgent(
      {
        question:
          "Which properties within two miles of here have roofs older than 40 years?",
        center: PIN,
      },
      {
        model: new ScriptedModel([
          toolReply([
            {
              name: "search_aged_roofs",
              input: {
                lat: PIN.lat,
                lon: PIN.lon,
                radius_miles: 2,
                threshold_years: 40,
              },
            },
          ]),
          textReply("Listed."),
        ]),
        queries: fakeQueries().queries,
        settings: SETTINGS,
      },
    );
    const model = new ScriptedModel([
      toolReply([
        {
          name: "long_open_permits",
          input: { lat: PIN.lat, lon: PIN.lon, radius_miles: 2 },
        },
      ]),
      textReply("Listed."),
    ]);
    const a = await runAgent(
      {
        question: "Which of them in that area have long-open permits?",
        screen: SCREEN,
        history: first.history,
        session: first.session,
      },
      { model, queries: fakeQueries().queries, settings: SETTINGS },
    );
    const v = sourcesSeen(model, "long_open_permits");
    expect(v.radius).toEqual({
      value: 2,
      source: "previous_area",
      text: "Radius 2 mi from the previous search area (the screen shows 1 mi).",
    });
    expect(a.assumptions).toContain(
      "Radius and center reused from the previous question (map pin, 2 mi).",
    );
    expect(a.assumptions).not.toContain(v.radius.text);
  });

  test("a place resolved in the same answer at the previous area's center: attributed to the place in both", async () => {
    const first = await runAgent(
      {
        question:
          "Which properties within two miles of Van Nuys have roofs older than 40 years?",
      },
      {
        model: new ScriptedModel([
          toolReply([{ name: "resolve_place", input: { name: "Van Nuys" } }]),
          toolReply([
            {
              name: "search_aged_roofs",
              input: {
                ...VAN_NUYS_RESOLVED,
                radius_miles: 2,
                threshold_years: 40,
              },
            },
          ]),
          textReply("Listed."),
        ]),
        queries: fakeQueries().queries,
        settings: SETTINGS,
      },
    );
    const model = new ScriptedModel([
      toolReply([{ name: "resolve_place", input: { name: "Van Nuys" } }]),
      toolReply([
        {
          name: "search_aged_roofs",
          input: { ...VAN_NUYS_RESOLVED, radius_miles: 2, threshold_years: 40 },
        },
      ]),
      textReply("Listed."),
    ]);
    const a = await runAgent(
      {
        question: "And roofs older than 40 years near Van Nuys?",
        history: first.history,
        session: first.session,
      },
      { model, queries: fakeQueries().queries, settings: SETTINGS },
    );
    const v = sourcesSeen(model, "search_aged_roofs");
    expect(v.radius.source).toBe("other");
    expect(a.assumptions).toContain(v.radius.text);
    expect(a.assumptions).toContain(v.threshold!.text);
  });
});
