import { describe, expect, test } from "vitest";
import {
  buildMarkdown,
  idsInText,
  isPeopleQuestion,
  project,
  recordLines,
  unverifiedIds,
} from "../src/policy.ts";

describe("people guard", () => {
  test.each([
    "Who owns 1234 Main St in Van Nuys?",
    "Who lives at parcel 2210012034?",
    "List the owners of the oldest roofs near Van Nuys.",
    "Which homeowners near Burbank have old roofs?",
    "Give me the residents of these properties.",
    "Are the tenants of that building renters?",
    "What is the phone number for the property at 1 Test St?",
    "Find the email of the occupant.",
    "Where does Mr. Smith live?",
    "Is there a person named John Doe on this street?",
  ])("refused: %s", (q) => {
    expect(isPeopleQuestion(q)).toBe(true);
  });
  test.each([
    "Which properties in Los Angeles County within five miles of Van Nuys have roofs older than 15 years?",
    "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?",
    "Which contractor businesses hold the permits near Van Nuys, and what are their license numbers?",
    "Which of these permits are owner-builder permits?",
    "show me open roofing permits older than five years within five miles of Van Nuys",
    "Is this a residential parcel?",
  ])("allowed: %s", (q) => {
    expect(isPeopleQuestion(q)).toBe(false);
  });
});

describe("IDs and projection", () => {
  test("parcel IDs and permit numbers in text; unverified ones", () => {
    const text =
      "Parcels 1000000001 and 9999999999; permit 16010-10000-00001; not 34.1990 or 2026.";
    expect(idsInText(text)).toEqual([
      "1000000001",
      "9999999999",
      "16010-10000-00001",
    ]);
    expect(
      unverifiedIds(text, new Set(["1000000001", "16010-10000-00001"])),
    ).toEqual(["9999999999"]);
  });
  test("project keeps listed scalar keys only", () => {
    expect(
      project(
        { a: 1, b: { x: 1 }, c: "z", owner: "no" },
        { a: "a", b: "b", cee: "c" },
      ),
    ).toEqual({
      a: 1,
      b: null,
      cee: "z",
    });
  });
  test("markdown has the four sections in order", () => {
    const md = buildMarkdown({
      text: "Answer.",
      status: "answered",
      reasoning: "Did a thing.",
      assumptions: [],
      records: [
        {
          kind: "parcel",
          id: "1000000001",
          source_name: "S",
          collected_at: "T",
        },
      ],
      gaps: ["g"],
    });
    const order = [
      "## How this was answered",
      "## Assumptions",
      "## Records cited",
      "## Gaps",
    ].map((h) => md.indexOf(h));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain("- parcel 1000000001: S, collected T");
    expect(md).toContain("## Assumptions\n\n- None.");
  });
  test("source lines state each source's license and attribution when the run states them, once per source", () => {
    expect(
      recordLines([
        {
          kind: "permit",
          id: "16016-10000-00001",
          source_name: "P",
          license: "none stated",
          attribution: "LADBS",
          collected_at: "T1",
        },
        {
          kind: "contractor",
          id: "16016-10000-00001",
          source_name: "C",
          license: "CC BY 4.0",
          attribution: "LADBS",
          collected_at: "T2",
        },
        {
          kind: "permit",
          id: "16016-10000-00002",
          source_name: "P",
          license: "none stated",
          attribution: "LADBS",
          collected_at: "T1",
        },
        {
          kind: "permit",
          id: "16016-10000-00003",
          source_name: "Q",
          attribution: "LADBS",
          collected_at: "T3",
        },
        {
          kind: "permit",
          id: "16016-10000-00004",
          source_name: "R",
          collected_at: "T4",
        },
      ]),
    ).toEqual([
      "- Permits: P (license: none stated; attribution: LADBS), retrieved T1",
      "  - 16016-10000-00001",
      "  - 16016-10000-00002",
      "- Contractor rows of permits: C (license: CC BY 4.0; attribution: LADBS), retrieved T2",
      "  - 16016-10000-00001",
      "- Permits: Q (attribution: LADBS), retrieved T3",
      "  - 16016-10000-00003",
      "- Permits: R, retrieved T4",
      "  - 16016-10000-00004",
    ]);
  });
});
