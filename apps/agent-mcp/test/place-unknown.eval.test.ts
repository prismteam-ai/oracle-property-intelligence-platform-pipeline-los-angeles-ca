/**
 * Prompts t and u (places resolve_place does not know) and check place_unknown: the answer's gaps start with the
 * unknown note for the name, then how to ask with a point; the text's first sentence not saying so is a warning.
 */
import {
  PLACE_UNKNOWN_HOW_TO_ASK,
  STANDARD_GAPS,
  isPeopleQuestion,
  type AgentAnswer,
} from "@oracle-la/agent";
import { describe, expect, test } from "vitest";
import { checkPlaceUnknown, type ToolCallRecord } from "../src/eval/checks.ts";
import { DEFAULT_PROMPTS_FILE, loadPrompts } from "../src/eval/prompts.ts";

const prompts = loadPrompts(DEFAULT_PROMPTS_FILE);
const byId = (id: string) => prompts.find((p) => p.id.startsWith(`${id}-`))!;
const note = (name: string) =>
  `"${name}" matches no jurisdiction or postal city in this run; no center was chosen.`;

describe("prompts t and u", () => {
  test("t: downtown Los Angeles; u: Brightwater Springs; unknown, the coordinate fields asked for, no search", () => {
    const t = byId("t");
    const u = byId("u");
    expect(t.question).toBe(
      "Which properties within five miles of downtown Los Angeles have roofs older than 30 years?",
    );
    expect(u.question).toBe(
      "Which properties within two miles of Brightwater Springs have roofs older than 20 years?",
    );
    for (const [p, name] of [
      [t, "downtown Los Angeles"],
      [u, "Brightwater Springs"],
    ] as const) {
      expect(p.expected).toEqual({
        tools: ["resolve_place"],
        gaps: ["place_unknown", "no_center", "point_fields"],
        refused: false,
        place: { outcome: "unknown", name },
      });
      expect(p.request).toBeUndefined();
      // Not a people question: the model is asked.
      expect(isPeopleQuestion(p.question)).toBe(false);
    }
    expect(t.group).not.toBe(u.group);
  });
});

describe("check place_unknown", () => {
  const t = byId("t");
  const name = "downtown Los Angeles";
  const resolveCall = (result: unknown): ToolCallRecord => ({
    id: "toolu_1",
    name: "resolve_place",
    input: { name },
    result,
    is_error: false,
  });
  const unknown = resolveCall({
    status: "unknown",
    name,
    note: note(name),
    how_to_ask: PLACE_UNKNOWN_HOW_TO_ASK,
  });
  const answer = (text: string, gaps: string[]) =>
    ({ text, gaps }) as unknown as AgentAnswer;
  const GAPS_FIRST = [note(name), PLACE_UNKNOWN_HOW_TO_ASK, ...STANDARD_GAPS];
  const TEXT =
    "I could not find downtown Los Angeles in the data. Ask again with its latitude and longitude.";

  test("pass: gaps[0] the note for the name, gaps[1] how to ask, the first sentence says not found", () => {
    expect(
      checkPlaceUnknown(answer(TEXT, GAPS_FIRST), [unknown], t.expected.place),
    ).toEqual({
      result: "pass",
      details: [
        "gaps[0] is the unknown note for downtown Los Angeles",
        "gaps[1] is how to ask with a point",
      ],
    });
    // The model's name may differ in case or spacing (placeKey).
    expect(
      checkPlaceUnknown(
        answer(TEXT, [note("Downtown  Los Angeles"), PLACE_UNKNOWN_HOW_TO_ASK]),
        [
          resolveCall({
            status: "unknown",
            name: "Downtown  Los Angeles",
            note: note("Downtown  Los Angeles"),
          }),
        ],
        t.expected.place,
      ).result,
    ).toBe("pass");
  });

  test("fail: the gaps in the old order (standard gaps first), the pair swapped, another name's note, or no unknown result", () => {
    const old = checkPlaceUnknown(
      answer(TEXT, [...STANDARD_GAPS, note(name), PLACE_UNKNOWN_HOW_TO_ASK]),
      [unknown],
      t.expected.place,
    );
    expect(old).toEqual({
      result: "fail",
      details: [
        "gaps[0] is NOT the unknown note for downtown Los Angeles",
        "gaps[1] is NOT how to ask with a point",
      ],
    });
    expect(
      checkPlaceUnknown(
        answer(TEXT, [PLACE_UNKNOWN_HOW_TO_ASK, note(name)]),
        [unknown],
        t.expected.place,
      ).result,
    ).toBe("fail");
    expect(
      checkPlaceUnknown(
        answer(TEXT, [note("Springfield"), PLACE_UNKNOWN_HOW_TO_ASK]),
        [unknown],
        t.expected.place,
      ).result,
    ).toBe("fail");
    // resolve_place called with "Los Angeles" instead (resolved, not unknown): no result for the name.
    expect(
      checkPlaceUnknown(
        answer(TEXT, GAPS_FIRST),
        [
          resolveCall({
            status: "resolved",
            name: "Los Angeles",
            note: "x",
          }),
        ],
        t.expected.place,
      ),
    ).toEqual({
      result: "fail",
      details: ["no unknown resolve_place result for downtown Los Angeles"],
    });
  });

  test("warning only: the first sentence does not say the place was not found", () => {
    const late = checkPlaceUnknown(
      answer(
        "Place names resolve to cities only. I could not find downtown Los Angeles.",
        GAPS_FIRST,
      ),
      [unknown],
      t.expected.place,
    );
    expect(late.result).toBe("pass");
    expect(late.warnings).toEqual([
      'the first sentence does not say downtown Los Angeles was not found: "Place names resolve to cities only."',
    ]);
  });

  test("n/a for any other place outcome", () => {
    expect(
      checkPlaceUnknown(answer(TEXT, GAPS_FIRST), [unknown], {
        outcome: "none",
      }).result,
    ).toBe("n/a");
    expect(
      checkPlaceUnknown(
        answer(TEXT, GAPS_FIRST),
        [unknown],
        byId("a1").expected.place,
      ).result,
    ).toBe("n/a");
  });
});
