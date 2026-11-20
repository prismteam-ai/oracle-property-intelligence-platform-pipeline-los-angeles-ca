/**
 * An unknown place says so first: the answer's gaps start with resolve_place's unknown note for the name, then how to
 * ask with a point (PLACE_UNKNOWN_HOW_TO_ASK, which also says what place names resolve to), before any other gap.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { runAgent } from "../src/agent.ts";
import { GAP_NO_CENTER, STANDARD_GAPS } from "../src/policy.ts";
import { systemPrompt } from "../src/prompt.ts";
import { PLACE_UNKNOWN_HOW_TO_ASK, runTool } from "../src/tools.ts";
import {
  ScriptedModel,
  textReply,
  toolReply,
} from "../src/testing/scripted-model.ts";
import { SETTINGS, blockNetwork, fakeQueries } from "./helpers.ts";

beforeAll(blockNetwork);

const unknownNote = (name: string) =>
  `"${name}" matches no jurisdiction or postal city in this run; no center was chosen.`;

describe("an unknown place", () => {
  test("how_to_ask: what place names resolve to (an exact jurisdiction or postal-city name; a district that is not a postal city, such as downtown, is not found), then the latitude/longitude pointer", () => {
    expect(PLACE_UNKNOWN_HOW_TO_ASK).toBe(
      "Place names resolve only to an exact jurisdiction or postal-city name on the County roll (e.g. Van Nuys, Pasadena); a district or neighborhood that is not a postal city, such as downtown, is not found. Ask again with a point: its latitude and longitude (the Explorer's Latitude and Longitude fields above the question, or the CRM's map pin).",
    );
  });

  test("resolve_place: the data API's note unchanged, then how_to_ask", async () => {
    const o = await runTool(
      "resolve_place",
      { name: "downtown Los Angeles" },
      fakeQueries().queries,
    );
    expect(o.gaps).toEqual([
      unknownNote("downtown Los Angeles"),
      PLACE_UNKNOWN_HOW_TO_ASK,
    ]);
  });

  for (const name of ["downtown Los Angeles", "Brightwater Springs"])
    test(`the answer's gaps start with the unknown note for "${name}", then how to ask, then the rest (${name})`, async () => {
      const model = new ScriptedModel([
        toolReply([{ name: "resolve_place", input: { name } }]),
        textReply(`I could not find "${name}" in the data.`),
      ]);
      const a = await runAgent(
        {
          question: `Which properties within two miles of ${name} have roofs older than 20 years?`,
        },
        { model, queries: fakeQueries().queries, settings: SETTINGS },
      );
      expect(a.status).toBe("answered");
      expect(a.gaps[0]).toBe(unknownNote(name));
      expect(a.gaps[1]).toBe(PLACE_UNKNOWN_HOW_TO_ASK);
      // The rest follow, each once: the standard gaps (in their order), then the no-center gap.
      expect(new Set(a.gaps).size).toBe(a.gaps.length);
      for (const g of STANDARD_GAPS)
        expect(a.gaps.indexOf(g)).toBeGreaterThan(1);
      expect(a.gaps).toContain(GAP_NO_CENTER);
      expect(a.gaps.indexOf(GAP_NO_CENTER)).toBeGreaterThan(1);
    });

  test("deterministic order with a resolved place too: the unknown pair first, whatever the call order", async () => {
    const model = new ScriptedModel([
      toolReply([
        { name: "resolve_place", input: { name: "Van Nuys" } },
        { name: "resolve_place", input: { name: "Springfield" } },
      ]),
      textReply("Springfield was not found; Van Nuys was."),
    ]);
    const a = await runAgent(
      { question: "Old roofs near Van Nuys or Springfield?" },
      { model, queries: fakeQueries().queries, settings: SETTINGS },
    );
    expect(a.gaps.slice(0, 2)).toEqual([
      unknownNote("Springfield"),
      PLACE_UNKNOWN_HOW_TO_ASK,
    ]);
  });

  test("no unknown place: the gaps keep their order (standard gaps first)", async () => {
    const model = new ScriptedModel([
      toolReply([{ name: "run_summary", input: {} }]),
      textReply("Run run-1."),
    ]);
    const a = await runAgent(
      { question: "What run is served?" },
      { model, queries: fakeQueries().queries, settings: SETTINGS },
    );
    expect(a.gaps[0]).toBe(STANDARD_GAPS[0]);
  });

  test("the system prompt's place line: say first that the place was not found, then its how_to_ask", () => {
    expect(systemPrompt(5)).toContain(
      "For unknown, your first sentence says the place was not found; then give its how_to_ask.",
    );
  });
});
