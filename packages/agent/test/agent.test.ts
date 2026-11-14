/**
 * runAgent with the scripted fake model (design brief §7, §8, §11). No network, no clock dependence.
 * Wording: pipeline README lines 108 and 110 and the CRM README line 13, with "[city xyz]" replaced by "Van Nuys".
 */
import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, test } from "vitest";
import {
  InvalidRequestError,
  longOpenRuleLine,
  runAgent,
  type AgentAnswer,
} from "../src/agent.ts";
import {
  GAP_NO_CENTER,
  PEOPLE_REFUSAL_TEXT,
  STANDARD_GAPS,
} from "../src/policy.ts";
import {
  ScriptedModel,
  lastToolResult,
  message,
  textBlock,
  textReply,
  toolReply,
  toolUseBlock,
} from "../src/testing/scripted-model.ts";
import {
  CONTRACTOR_RETRIEVED,
  FAKE_PARCELS,
  FAKE_PERMITS,
  FAKE_SOURCES,
  LOS_ANGELES_CANDIDATES,
  OUTSIDE_PARCEL,
  PASADENA_RESOLVED,
  PERMIT_RETRIEVED,
  SECRET_DESCRIPTION,
  SETTINGS,
  VAN_NUYS,
  VAN_NUYS_RESOLVED,
  blockNetwork,
  fakeClock,
  fakeQueries,
} from "./helpers.ts";

beforeAll(blockNetwork);

/** Pipeline README line 108, "[city xyz]" → "Van Nuys". */
const README_Q1 =
  "Which properties in Los Angeles County within five miles of Van Nuys have roofs older than 15 years?";
/** Pipeline README line 110 (a follow-up to line 108). */
const README_Q2 =
  "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?";
/** CRM README line 13 wording, "[city xyz]" → "Van Nuys". */
const CRM_Q =
  "show me open roofing permits older than five years within five miles of Van Nuys";

const SECTIONS = [
  "## How this was answered",
  "## Assumptions",
  "## Records cited",
  "## Gaps",
];

function expectSections(a: AgentAnswer): void {
  for (const s of SECTIONS) expect(a.markdown).toContain(s);
  expect(a.reasoning.length).toBeGreaterThan(0);
  for (const g of STANDARD_GAPS) expect(a.gaps).toContain(g);
}

/** Text blocks of the request's last user message that carries text. */
function lastUserTexts(p: Anthropic.MessageCreateParamsNonStreaming): string[] {
  for (const m of [...p.messages].reverse()) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return [m.content];
    const texts = m.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
    if (texts.length) return texts;
  }
  return [];
}

/** The request center, read from the request (never from constants). */
function centerFrom(p: Anthropic.MessageCreateParamsNonStreaming) {
  for (const t of lastUserTexts(p)) {
    const m = /^Center from the request: (.+), (-?[\d.]+), (-?[\d.]+)\.$/.exec(
      t,
    );
    if (m) return { lat: Number(m[2]), lon: Number(m[3]) };
  }
  throw new Error("no center block in the request");
}

/** The previous search area, read from the request (never from constants). */
function areaFrom(p: Anthropic.MessageCreateParamsNonStreaming) {
  for (const t of lastUserTexts(p)) {
    const m =
      /^Previous search area: (.+), center (-?[\d.]+), (-?[\d.]+), radius ([\d.]+) mi\.$/.exec(
        t,
      );
    if (m)
      return {
        label: m[1]!,
        lat: Number(m[2]),
        lon: Number(m[3]),
        radius_miles: Number(m[4]),
      };
  }
  throw new Error("no previous search area in the request");
}

const resolvedCenter = (p: Anthropic.MessageCreateParamsNonStreaming) =>
  (
    lastToolResult(p, "resolve_place") as {
      center: { lat: number; lon: number };
    }
  ).center;

/** The fake's Van Nuys center (34.18651, -118.448912) at 5 decimals, with its parcel count. */
const VAN_NUYS_CENTER = "the median center 34.18651, -118.44891 of 467 parcels";
const VAN_NUYS_STATEMENT = `Resolved 'Van Nuys' (postal city) to ${VAN_NUYS_CENTER}`;
const VAN_NUYS_NOTE = `${VAN_NUYS_STATEMENT}. Stored postal city names: VAN NUYS | VAN NUYS CALIF | VAN NUYS,.`;
const VAN_NUYS_ASSUMPTION = `'Van Nuys' means the postal city VAN NUYS / VAN NUYS CALIF / VAN NUYS,; its search center is ${VAN_NUYS_CENTER}.`;

/** The note resolve_place returned in the request at `index`. */
const resolveNote = (model: ScriptedModel, index: number) =>
  (
    lastToolResult(model.requests[index]!.params, "resolve_place") as {
      note: string;
    }
  ).note;

describe("demo prompts with a center (pipeline README lines 108 and 110, [city xyz] → Van Nuys)", () => {
  test("line 108 → search_aged_roofs, threshold 15, radius 5, from the request center", async () => {
    const { queries, calls } = fakeQueries();
    const thinking: Anthropic.ThinkingBlock = {
      type: "thinking",
      thinking: "",
      signature: "sig-1",
    };
    const model = new ScriptedModel([
      (p) => {
        const c = centerFrom(p);
        return message(
          [
            thinking,
            toolUseBlock("search_aged_roofs", {
              lat: c.lat,
              lon: c.lon,
              radius_miles: 5,
              threshold_years: 15,
            }),
          ],
          "tool_use",
        );
      },
      textReply(
        `Parcels ${FAKE_PARCELS.join(", ")} have roofs older than 15 years (assessor year-built proxy).`,
      ),
    ]);
    const a = await runAgent(
      { question: README_Q1, center: VAN_NUYS },
      { model, queries, settings: SETTINGS },
    );

    expect(a.status).toBe("answered");
    expect(calls[0]).toEqual({
      fn: "parcels.search",
      input: {
        lat: 34.199,
        lon: -118.487,
        radius_miles: 5,
        threshold_years: 15,
        offset: 0,
        limit: 10,
      },
    });
    // Request shape: effort, auto tool choice, strict tools, no thinking/temperature params.
    const r0 = model.requests[0]!.params;
    expect(r0).toMatchObject({
      model: "claude-test-model",
      max_tokens: 2048,
      tool_choice: { type: "auto" },
      output_config: { effort: "low" },
    });
    expect(r0).not.toHaveProperty("thinking");
    expect(r0).not.toHaveProperty("temperature");
    expect(r0.tools).toHaveLength(6);
    // The assistant content (thinking block included) goes back unchanged.
    expect(model.requests[1]!.params.messages[1]).toEqual({
      role: "assistant",
      content: [
        thinking,
        expect.objectContaining({
          type: "tool_use",
          name: "search_aged_roofs",
        }),
      ],
    });
    expect(a.records.map((r) => r.id)).toEqual(FAKE_PARCELS);
    for (const r of a.records) {
      expect(r.source_name).toBe("LA County Assessor Roll");
      expect(r.collected_at).toBe("2026-11-11T16:17:40.932Z");
    }
    expect(a.unverified_ids).toEqual([]);
    expect(a.assumptions).toContain(
      'Used the request\'s center "Van Nuys" (34.199, -118.487).',
    );
    expect(a.assumptions).toContain(
      "Roof age is the assessor year-built proxy: older than 15 years means built before 2011 (roll year 2026 − 15).",
    );
    expect(a.session).toEqual({
      area: {
        label: "Van Nuys",
        lat: 34.199,
        lon: -118.487,
        radius_miles: 5,
        basis: "request_center",
      },
    });
    expect(a.usage).toEqual({
      input_tokens: 200,
      output_tokens: 100,
      model_calls: 2,
      tool_calls: 1,
    });
    expectSections(a);
  });

  test("line 110 → long_open_permits then parcel_permits; inputs reach the queries unchanged", async () => {
    const { queries, calls } = fakeQueries();
    const model = new ScriptedModel([
      (p) => {
        const c = centerFrom(p);
        return toolReply([
          {
            name: "long_open_permits",
            input: {
              lat: c.lat,
              lon: c.lon,
              radius_miles: 5,
              min_open_days: 1826,
            },
          },
        ]);
      },
      (p) => {
        const r = lastToolResult(p, "long_open_permits") as {
          items: Array<{ parcel_id: string }>;
        };
        return toolReply([
          {
            name: "parcel_permits",
            input: { parcel_id: r.items[0]!.parcel_id },
          },
        ]);
      },
      textReply(
        "Parcel 1000000001 has roofing permit 16010-10000-00001 open 4,000 days; the listed contractor is ACME ROOFING INC (license 123456).",
      ),
    ]);
    const a = await runAgent(
      { question: README_Q2, center: VAN_NUYS },
      { model, queries, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    // explorer.sources (the permit citations) is read once for the whole answer.
    expect(calls.map((c) => c.fn)).toEqual([
      "permits.longOpen",
      "explorer.sources",
      "permits.forParcel",
    ]);
    expect(calls[0]!.input).toEqual({
      lat: 34.199,
      lon: -118.487,
      radius_miles: 5,
      min_open_days: 1826,
      sort: "open_days",
      offset: 0,
      limit: 10,
    });
    expect(calls[2]!.input).toEqual({ parcel_id: "1000000001" });
    expect(a.records.map((r) => `${r.kind}:${r.id}`)).toEqual([
      "permit:16010-10000-00001",
      "permit:16010-10000-00003",
      "permit:16010-10000-00002",
      "contractor:16010-10000-00001",
    ]);
    expect(a.reasoning).toBe(
      "Searched long-open permits, roofing work only, within 5 mi of Van Nuys open at least 1,826 days: 57 match, 2 listed; read the permits of parcel 1000000001 (2 permits, 1 contractor row). Rule: long-open permits are roofing work only (the data API's rule: an issued permit for roofing work, open at least 1,826 days; a roof-coating-only permit counts and is flagged).",
    );
    // The permit source is stated once, with the permit numbers listed under it.
    const cited = a.markdown.slice(
      a.markdown.indexOf("## Records cited"),
      a.markdown.indexOf("## Gaps"),
    );
    expect(cited.split(FAKE_SOURCES.permit)).toHaveLength(2);
    // Each source line carries what the run states: the fake permit source an attribution only, the contractor
    // source its license and attribution, each with its own retrieval time.
    expect(cited).toContain(
      `- Permits: ${FAKE_SOURCES.permit} (attribution: LADBS), retrieved ${PERMIT_RETRIEVED}\n  - ${FAKE_PERMITS[0]}\n  - ${FAKE_PERMITS[2]}\n  - ${FAKE_PERMITS[1]}\n`,
    );
    expect(cited).toContain(
      `- Contractor rows of permits: ${FAKE_SOURCES.contractor} (license: CC BY 4.0; attribution: LADBS), retrieved ${CONTRACTOR_RETRIEVED}\n  - ${FAKE_PERMITS[0]}\n`,
    );
    expect(a.unverified_ids).toEqual([]);
    expectSections(a);
  });
});

describe("conversation: pipeline README lines 108 then 110 as ONE conversation ([city xyz] → Van Nuys)", () => {
  test("the follow-up reuses the resolved place and radius from the request it receives", async () => {
    const { queries, calls } = fakeQueries();
    const model = new ScriptedModel([
      // Turn 1
      toolReply([{ name: "resolve_place", input: { name: "Van Nuys" } }]),
      (p) => {
        const c = resolvedCenter(p);
        return toolReply([
          {
            name: "search_aged_roofs",
            input: {
              lat: c.lat,
              lon: c.lon,
              radius_miles: 5,
              threshold_years: 15,
            },
          },
        ]);
      },
      textReply(
        `Near Van Nuys, ${FAKE_PARCELS.length} listed parcels have roofs older than 15 years: ${FAKE_PARCELS.join(", ")}.`,
      ),
      // Turn 2: lat/lon/radius come from the area block of the request, not from constants.
      (p) => {
        const area = areaFrom(p);
        return toolReply([
          {
            name: "long_open_permits",
            input: {
              lat: area.lat,
              lon: area.lon,
              radius_miles: area.radius_miles,
              min_open_days: Math.round(5 * 365.25),
            },
          },
        ]);
      },
      (p) => {
        const r = lastToolResult(p, "long_open_permits") as {
          items: Array<{ parcel_id: string }>;
        };
        return toolReply([
          {
            name: "parcel_permits",
            input: { parcel_id: r.items[0]!.parcel_id },
          },
        ]);
      },
      textReply(
        "Parcel 1000000001 has permit 16010-10000-00001 open 4,000 days; contractor ACME ROOFING INC.",
      ),
    ]);

    const a1 = await runAgent(
      { question: README_Q1 },
      { model, queries, settings: SETTINGS },
    );
    expect(a1.status).toBe("answered");
    expect(a1.session.area).toEqual({
      label: "Van Nuys",
      lat: VAN_NUYS_RESOLVED.lat,
      lon: VAN_NUYS_RESOLVED.lon,
      radius_miles: 5,
      basis: "postal_city",
    });
    // The resolved place states its center (5 decimals) and parcel count in the reasoning, the assumptions and
    // the tool's note.
    expect(a1.reasoning).toBe(
      `${VAN_NUYS_STATEMENT}; searched parcels within 5 mi of Van Nuys built before 2011 (roofs older than 15 years): 42 match, 3 listed.`,
    );
    expect(a1.assumptions).toContain(VAN_NUYS_ASSUMPTION);
    expect(resolveNote(model, 1)).toBe(VAN_NUYS_NOTE);
    expect(a1.markdown).toContain(VAN_NUYS_CENTER);
    expect(a1.gaps).not.toContain(GAP_NO_CENTER);
    expectSections(a1);

    const turn2Start = model.requests.length;
    const a2 = await runAgent(
      { question: README_Q2, history: a1.history, session: a1.session },
      { model, queries, settings: SETTINGS },
    );
    expect(a2.status).toBe("answered");
    const req2 = model.requests[turn2Start]!.params;
    // Turn 2's request carries turn 1's history, then the new user turn with the area block.
    expect(req2.messages.slice(0, a1.history.length)).toEqual(a1.history);
    expect(lastUserTexts(req2)).toEqual([
      `Previous search area: Van Nuys, center ${VAN_NUYS_RESOLVED.lat}, ${VAN_NUYS_RESOLVED.lon}, radius 5 mi.`,
      README_Q2,
    ]);
    // Turn 2's tool inputs equal turn 1's center and radius.
    const search = calls.find((c) => c.fn === "parcels.search")!
      .input as Record<string, number>;
    const longOpen = calls.find((c) => c.fn === "permits.longOpen")!
      .input as Record<string, number>;
    expect({
      lat: longOpen.lat,
      lon: longOpen.lon,
      radius_miles: longOpen.radius_miles,
    }).toEqual({
      lat: search.lat,
      lon: search.lon,
      radius_miles: search.radius_miles,
    });
    expect(longOpen.min_open_days).toBe(1826);
    expect(a2.assumptions).toContain(
      '"many years" read as at least 1,826 days open (5 × 365.25, rounded; the default minimum).',
    );
    expect(a2.assumptions).toContain(
      "Radius and center reused from the previous question (Van Nuys, 5 mi).",
    );
    expect(a2.session.area).toMatchObject({
      label: "Van Nuys",
      basis: "postal_city",
      radius_miles: 5,
    });
    // IDs returned in turn 1 stay verified in turn 2.
    expect(a2.unverified_ids).toEqual([]);
    expectSections(a2);
  });
});

describe("CRM README line 13 ([city xyz] → Van Nuys)", () => {
  test("resolve_place, then long_open_permits radius 5, 1,826 days; roofing work only is the server's filter", async () => {
    const { queries, calls } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([{ name: "resolve_place", input: { name: "Van Nuys" } }]),
      (p) => {
        const c = resolvedCenter(p);
        return toolReply([
          {
            name: "long_open_permits",
            input: {
              lat: c.lat,
              lon: c.lon,
              radius_miles: 5,
              min_open_days: Math.round(5 * 365.25),
            },
          },
        ]);
      },
      (p) => {
        const r = lastToolResult(p, "long_open_permits") as {
          scope: string;
          items: Array<{ permit_number: string }>;
        };
        return textReply(
          `Long-open permits (${r.scope}): ${r.items.map((i) => i.permit_number).join(", ")}.`,
        );
      },
    ]);
    const a = await runAgent(
      { question: CRM_Q },
      { model, queries, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    expect(calls.map((c) => c.fn)).toEqual([
      "places.resolve",
      "permits.longOpen",
      "explorer.sources",
    ]);
    expect(calls[0]!.input).toEqual({ name: "Van Nuys" });
    expect(calls[1]!.input).toEqual({
      lat: VAN_NUYS_RESOLVED.lat,
      lon: VAN_NUYS_RESOLVED.lon,
      radius_miles: 5,
      min_open_days: 1826,
      sort: "open_days",
      offset: 0,
      limit: 10,
    });
    const result = lastToolResult(
      model.requests[2]!.params,
      "long_open_permits",
    ) as {
      scope: string;
      items: Array<{ roofing_work: boolean; roof_coating_only: boolean }>;
    };
    // Each served item keeps both roofing flags.
    expect(
      result.items.map((i) => [i.roofing_work, i.roof_coating_only]),
    ).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(result.scope).toBe("roofing work only");
    expect(a.reasoning).toContain(
      "searched long-open permits, roofing work only, within 5 mi of Van Nuys open at least 1,826 days: 57 match, 2 listed",
    );
    expect(a.assumptions).toContain(
      '"five years" read as at least 1,826 days open (Math.round(5 × 365.25)).',
    );
    // §15.3: the rule, stated in the reasoning (its own sentence after the tool steps).
    const RULE =
      "Rule: long-open permits are roofing work only (the data API's rule: an issued permit for roofing work, open at least 1,826 days; a roof-coating-only permit counts and is flagged).";
    expect(a.reasoning).toContain(` ${RULE}`);
    expect(a.reasoning.endsWith(RULE)).toBe(true);
    expect(a.markdown).toContain(RULE);
    // The server's roofing filter (68c697b) is a fact of the route, not an assumption.
    expect(a.assumptions.filter((x) => /roofing/i.test(x))).toEqual([]);
    expect(a.records.map((r) => r.id)).toEqual([
      "16010-10000-00001",
      "16010-10000-00003",
    ]);
    expect(a.reasoning.slice(0, VAN_NUYS_STATEMENT.length + 2)).toBe(
      `${VAN_NUYS_STATEMENT}; `,
    );
    expect(a.assumptions).toContain(VAN_NUYS_ASSUMPTION);
    expect(resolveNote(model, 1)).toBe(VAN_NUYS_NOTE);
    expectSections(a);
  });
});

describe("place statements", () => {
  test("an ambiguous place states each candidate's center and parcel count; no search is made", async () => {
    const { queries, calls } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([{ name: "resolve_place", input: { name: "Los Angeles" } }]),
      textReply(
        "'Los Angeles' is ambiguous; please give a point or a more specific place.",
      ),
    ]);
    const a = await runAgent(
      { question: "Which roofs near Los Angeles are older than 15 years?" },
      { model, queries, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    expect(calls.map((c) => c.fn)).toEqual(["places.resolve"]);
    const [j, p] = LOS_ANGELES_CANDIDATES;
    expect([j!.center, p!.center]).toEqual([
      { lat: 34.052235, lon: -118.243683 },
      { lat: 34.098001, lon: -118.326742 },
    ]);
    const candidates =
      "the jurisdiction's median center 34.05224, -118.24368 of 1,234 parcels and " +
      "the postal city's median center 34.09800, -118.32674 of 987 parcels";
    const note = `'Los Angeles' is ambiguous: ${candidates} are 5.7 mi apart; no center was chosen.`;
    expect(resolveNote(model, 1)).toBe(note);
    expect(a.reasoning).toBe(
      `Found 'Los Angeles' ambiguous (${candidates}), so chose no center.`,
    );
    expect(a.assumptions).toContain(
      `'Los Angeles' was not used as a center: it is ambiguous between ${candidates}.`,
    );
    expect(a.gaps).toContain(note);
    expect(a.gaps).toContain(GAP_NO_CENTER);
    expectSections(a);
  });
});

describe("citations and gaps", () => {
  test("an ID in the text that no tool returned lands in unverified_ids and the gaps", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([
        { name: "parcel_detail", input: { parcel_id: "1000000001" } },
      ]),
      textReply(
        "Parcel 1000000001 was built in 1950; parcel 9999999999 is next door.",
      ),
    ]);
    const a = await runAgent(
      { question: "Tell me about parcel 1000000001.", center: VAN_NUYS },
      { model, queries, settings: SETTINGS },
    );
    expect(a.unverified_ids).toEqual(["9999999999"]);
    expect(a.gaps.some((g) => g.includes("9999999999"))).toBe(true);
    expect(a.records).toEqual([
      {
        kind: "parcel",
        id: "1000000001",
        source_name: "LA County Assessor Roll",
        collected_at: "2026-11-11T16:17:40.932Z",
      },
    ]);
    expect(a.markdown).toContain(
      "- parcel 1000000001: LA County Assessor Roll, collected 2026-11-11T16:17:40.932Z",
    );
  });

  test("a permit route error: the tool returns an error result and the reasoning says so", async () => {
    const { queries } = fakeQueries();
    const failing = {
      ...queries,
      permits: {
        ...queries.permits,
        longOpen: () =>
          Promise.reject(new Error("permits.longOpen response too large")),
      },
    };
    const model = new ScriptedModel([
      (p) => {
        const c = centerFrom(p);
        return toolReply([
          { name: "long_open_permits", input: { lat: c.lat, lon: c.lon } },
        ]);
      },
      textReply("Permit data could not be read."),
    ]);
    const a = await runAgent(
      { question: README_Q2, center: VAN_NUYS },
      { model, queries: failing, settings: SETTINGS },
    );
    const results = model.requests[1]!.params.messages[2]!
      .content as Anthropic.ToolResultBlockParam[];
    expect(results[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(a.status).toBe("answered");
    expect(a.records).toEqual([]);
    expect(a.reasoning).toMatch(/but permits\.longOpen response too large/);
    expect(a.assumptions).toContain(
      '"many years" read as at least 1,826 days open (5 × 365.25, rounded; the default minimum).',
    );
    expectSections(a);
  });

  test("no center: the gap is stated; the five standard gaps are always there", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      textReply("Which place or point should I search around?"),
    ]);
    const a = await runAgent(
      { question: "Which roofs are old?" },
      { model, queries, settings: SETTINGS },
    );
    expect(a.gaps.slice(0, 5)).toEqual([...STANDARD_GAPS]);
    expect(a.gaps).toContain(GAP_NO_CENTER);
    expect(a.reasoning).toBe("Answered without calling a tool.");
    expectSections(a);
  });

  test("a search at coordinates nobody supplied is flagged", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([
        { name: "search_aged_roofs", input: { lat: 34.05, lon: -118.25 } },
      ]),
      textReply("Done."),
    ]);
    const a = await runAgent(
      { question: README_Q1 },
      { model, queries, settings: SETTINGS },
    );
    expect(
      a.gaps.some((g) => g.includes("34.05, -118.25 was not supplied")),
    ).toBe(true);
    expect(a.session.area?.basis).toBe("coordinates");
  });
});

describe("caps", () => {
  test("tool-turn cap: tool_choice none on the last turn; a further tool_use stops the answer", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([{ name: "run_summary", input: {} }]),
      toolReply([{ name: "run_summary", input: {} }]),
      toolReply([{ name: "run_summary", input: {} }]),
    ]);
    const a = await runAgent(
      { question: "What run is served?" },
      { model, queries, settings: { ...SETTINGS, maxToolTurns: 2 } },
    );
    expect(model.requests.map((r) => r.params.tool_choice)).toEqual([
      { type: "auto" },
      { type: "auto" },
      { type: "none" },
    ]);
    expect(a).toMatchObject({
      status: "stopped",
      stopped_by: "max_tool_turns",
    });
    expect(a.usage.tool_calls).toBe(2);
    // The unanswered tool_use is closed so the history stays valid for a next question.
    const last = a.history.at(-1)!;
    expect(last.role).toBe("user");
    expect((last.content as Anthropic.ToolResultBlockParam[])[0]).toMatchObject(
      { is_error: true },
    );
    expect(a.markdown).toMatch(
      /^\*\*Stopped before a full answer \(max_tool_turns\)\.\*\*/,
    );
    expectSections(a);
  });

  test("after the cap the model can still answer without tools", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([{ name: "run_summary", input: {} }]),
      textReply("Run run-1."),
    ]);
    const a = await runAgent(
      { question: "What run is served?" },
      { model, queries, settings: { ...SETTINGS, maxToolTurns: 1 } },
    );
    expect(a.status).toBe("answered");
    expect(model.requests[1]!.params.tool_choice).toEqual({ type: "none" });
  });

  test("token cap; max_tokens shrinks to the remaining token budget", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([{ name: "run_summary", input: {} }], {
        input: 600,
        output: 100,
      }),
      toolReply([{ name: "run_summary", input: {} }], {
        input: 250,
        output: 100,
      }),
    ]);
    const a = await runAgent(
      { question: "What run is served?" },
      {
        model,
        queries,
        settings: { ...SETTINGS, maxTokens: 1000, maxOutputTokens: 800 },
      },
    );
    expect(model.requests.map((r) => r.params.max_tokens)).toEqual([800, 300]);
    expect(a).toMatchObject({ status: "stopped", stopped_by: "token_cap" });
    expect(a.usage).toMatchObject({
      input_tokens: 850,
      output_tokens: 200,
      model_calls: 2,
    });
  });

  test("time budget: the first call's timeout is the budget minus the reserve; a late tool is not run", async () => {
    const { queries, calls } = fakeQueries();
    const clock = fakeClock();
    const model = new ScriptedModel([
      () => {
        clock.advance(24_000);
        return toolReply([{ name: "run_summary", input: {} }]);
      },
    ]);
    const a = await runAgent(
      { question: "What run is served?" },
      { model, queries, settings: SETTINGS, now: clock.now },
    );
    expect(model.requests[0]!.opts.timeoutMs).toBe(23_500);
    expect(a).toMatchObject({
      status: "stopped",
      stopped_by: "time_budget",
      elapsed_ms: 24_000,
    });
    expect(calls).toEqual([]);
    expect(a.history.at(-1)!.role).toBe("user");
  });

  test("time budget: no model call once the remaining time is spent", async () => {
    const { queries } = fakeQueries();
    const clock = fakeClock();
    const slow = {
      ...queries,
      explorer: {
        ...queries.explorer,
        runSummary: async () => {
          clock.advance(1_000);
          return queries.explorer.runSummary();
        },
      },
    };
    const model = new ScriptedModel([
      () => {
        clock.advance(23_000);
        return toolReply([{ name: "run_summary", input: {} }]);
      },
      textReply("never reached"),
    ]);
    const a = await runAgent(
      { question: "What run is served?" },
      { model, queries: slow, settings: SETTINGS, now: clock.now },
    );
    expect(model.requests).toHaveLength(1);
    expect(model.remaining).toBe(1);
    expect(a).toMatchObject({ status: "stopped", stopped_by: "time_budget" });
  });

  test.each([
    ["refusal", "model_refusal"],
    ["max_tokens", "max_tokens"],
    ["pause_turn", "unexpected_stop"],
  ] as const)("stop_reason %s → stopped_by %s", async (reason, stoppedBy) => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([message([textBlock("partial")], reason)]);
    const a = await runAgent(
      { question: "What run is served?" },
      { model, queries, settings: SETTINGS },
    );
    expect(a).toMatchObject({
      status: "stopped",
      stopped_by: stoppedBy,
      text: "partial",
    });
  });

  test("a model-call error stops with the SDK's typed error class name; no retry", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      new Anthropic.APIConnectionTimeoutError(),
      textReply("never"),
    ]);
    const a = await runAgent(
      { question: "What run is served?" },
      { model, queries, settings: SETTINGS },
    );
    expect(a).toMatchObject({
      status: "stopped",
      stopped_by: "error",
      error: "APIConnectionTimeoutError",
      text: "The model call failed; no answer was produced.",
    });
    expect(model.requests).toHaveLength(1);
    expect(a.reasoning).toBe(
      "No tool was called. The answer stopped early (error).",
    );
  });
});

describe("people questions", () => {
  test("refused with zero model calls and a constant text", async () => {
    const { queries, calls } = fakeQueries();
    const model = new ScriptedModel([]);
    const a = await runAgent(
      {
        question: "Who owns the houses with the oldest roofs near Van Nuys?",
        center: VAN_NUYS,
      },
      { model, queries, settings: SETTINGS },
    );
    expect(model.requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(a).toMatchObject({
      status: "refused",
      text: PEOPLE_REFUSAL_TEXT,
      records: [],
      history: [],
    });
    expect(a.usage.model_calls).toBe(0);
    expectSections(a);
  });

  test("a contractor-business question is not refused", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      textReply("I need a parcel or an area first."),
    ]);
    const a = await runAgent(
      {
        question:
          "Which contractor businesses hold the open permits near Van Nuys, and what are their license numbers?",
        center: VAN_NUYS,
      },
      { model, queries, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    expect(model.requests).toHaveLength(1);
  });
});

describe("descriptions", () => {
  test("fake permit rows with work_desc / description never reach a request or the answer", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      (p) => {
        const c = centerFrom(p);
        return toolReply([
          {
            name: "long_open_permits",
            input: { lat: c.lat, lon: c.lon },
          },
          { name: "parcel_permits", input: { parcel_id: "1000000001" } },
        ]);
      },
      textReply("Done."),
    ]);
    const a = await runAgent(
      { question: README_Q2, center: VAN_NUYS },
      { model, queries, settings: SETTINGS },
    );
    // Both results in ONE user message.
    const results = model.requests[1]!.params.messages[2]!
      .content as Anthropic.ToolResultBlockParam[];
    expect(results.map((r) => r.type)).toEqual(["tool_result", "tool_result"]);
    const everything = JSON.stringify({ requests: model.requests, answer: a });
    expect(everything).not.toContain(SECRET_DESCRIPTION);
    expect(everything).not.toMatch(/work_desc/);
  });
});

describe("request contract", () => {
  test("empty or over-long questions are rejected before anything runs", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([]);
    await expect(
      runAgent({ question: "  " }, { model, queries, settings: SETTINGS }),
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      runAgent(
        { question: "x".repeat(2001) },
        { model, queries, settings: SETTINGS },
      ),
    ).rejects.toThrow(InvalidRequestError);
    expect(model.requests).toHaveLength(0);
  });
});

describe("long-open rule line (§15.3)", () => {
  test("states the searched minimum, and the maximum when one was given", () => {
    expect(longOpenRuleLine(1826, null)).toBe(
      "Rule: long-open permits are roofing work only (the data API's rule: an issued permit for roofing work, open at least 1,826 days; a roof-coating-only permit counts and is flagged).",
    );
    expect(longOpenRuleLine(365, 3653)).toBe(
      "Rule: long-open permits are roofing work only (the data API's rule: an issued permit for roofing work, open at least 365 days and at most 3,653 days; a roof-coating-only permit counts and is flagged).",
    );
  });
  test("not stated when no long-open search ran", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([
        {
          name: "search_aged_roofs",
          input: { lat: VAN_NUYS.lat, lon: VAN_NUYS.lon },
        },
      ]),
      textReply("Done."),
    ]);
    const a = await runAgent(
      { question: "Old roofs near the pin?", center: VAN_NUYS },
      { model, queries, settings: SETTINGS },
    );
    expect(a.reasoning).not.toContain("Rule:");
  });
});

describe("outside the City of Los Angeles (§15.1 d)", () => {
  test("a search whose items all lack permit data adds the place's gap", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([{ name: "resolve_place", input: { name: "Pasadena" } }]),
      (p) => {
        const c = resolvedCenter(p);
        return toolReply([
          {
            name: "search_aged_roofs",
            input: {
              lat: c.lat,
              lon: c.lon,
              radius_miles: 1,
              threshold_years: 20,
            },
          },
        ]);
      },
      textReply("Pasadena is outside the City of Los Angeles: no permit data."),
    ]);
    const a = await runAgent(
      {
        question:
          "Which properties within one mile of Pasadena have roofs older than 20 years?",
      },
      { model, queries, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    expect(a.gaps).toContain(
      "Pasadena is outside the City of Los Angeles: no permit data there.",
    );
    expect(a.session.area).toMatchObject({
      label: "Pasadena",
      lat: PASADENA_RESOLVED.lat,
      lon: PASADENA_RESOLVED.lon,
    });
  });
  test("a search with permit data adds no such gap", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([
        {
          name: "search_aged_roofs",
          input: { lat: VAN_NUYS.lat, lon: VAN_NUYS.lon },
        },
      ]),
      textReply("Done."),
    ]);
    const a = await runAgent(
      { question: "Old roofs near the pin?", center: VAN_NUYS },
      { model, queries, settings: SETTINGS },
    );
    expect(a.gaps.some((g) => g.includes("outside the City"))).toBe(false);
  });
  test("parcel_permits with permit_data_available false adds the parcel's gap", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([
      toolReply([
        { name: "parcel_permits", input: { parcel_id: OUTSIDE_PARCEL } },
      ]),
      textReply("No permit data there."),
    ]);
    const a = await runAgent(
      { question: `Permits of parcel ${OUTSIDE_PARCEL}?` },
      { model, queries, settings: SETTINGS },
    );
    expect(a.gaps).toContain(
      `Parcel ${OUTSIDE_PARCEL} (jurisdiction PASADENA) is outside the City of Los Angeles: no permit data there.`,
    );
  });
});

describe("beforeModelCall (the eval's spend limit)", () => {
  test("sees the exact request before each call; false stops the answer before the call (stopped_by budget)", async () => {
    const { queries } = fakeQueries();
    const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const model = new ScriptedModel([
      toolReply([{ name: "resolve_place", input: { name: "Van Nuys" } }]),
      textReply("never reached"),
    ]);
    const a = await runAgent(
      { question: CRM_Q },
      {
        model,
        queries,
        settings: SETTINGS,
        beforeModelCall: (params) => {
          seen.push(structuredClone(params));
          return seen.length < 2;
        },
      },
    );
    expect(model.requests).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(model.requests[0]!.params);
    expect(a.status).toBe("stopped");
    expect(a.stopped_by).toBe("budget");
    expect(a.usage.model_calls).toBe(1);
    expect(a.markdown).toContain("Stopped before a full answer (budget)");
    expect(a.reasoning).toContain("The answer stopped early (budget).");
  });
  test("an async hook is awaited; true lets every call through", async () => {
    const { queries } = fakeQueries();
    const model = new ScriptedModel([textReply("ok")]);
    let n = 0;
    const a = await runAgent(
      { question: "What does the run contain?" },
      {
        model,
        queries,
        settings: SETTINGS,
        beforeModelCall: async () => (n++, true),
      },
    );
    expect(n).toBe(1);
    expect(a.status).toBe("answered");
  });
});
