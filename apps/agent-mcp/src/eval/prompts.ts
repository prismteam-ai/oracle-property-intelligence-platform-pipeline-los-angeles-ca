/**
 * The eval's prompts file (design brief §15.1): apps/agent-mcp/eval/prompts.json, validated here. Each entry is one
 * question with its conversation group (entries of a group run in file order as ONE conversation, history and
 * session carried) and what its answer must show: the tools called (optionally with input values), the gap IDs
 * stated, whether it is refused, and the place outcome.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GAP_NO_CENTER,
  STANDARD_GAPS,
  TOOL_NAMES,
  type ToolName,
} from "@oracle-la/agent";
import { z } from "zod";

/** The tracked prompts file. */
export const DEFAULT_PROMPTS_FILE = fileURLToPath(
  new URL("../../eval/prompts.json", import.meta.url),
);

/**
 * The cases of design brief §15.1 a–i, then the scope and abuse cases of approvals §3e.75 d: j off-topic, k a
 * writing task, l an instruction to ignore the rules (each refused by the no-tool-call rule), m who is the owner
 * (refused by the people guard), n how long without an ownership change (answered through the ownership filter);
 * then o, a coverage question of approvals §3e.78.1 (answered from run_summary: BBB ratings are not available, and why).
 */
export const PROMPT_CASES = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
] as const;

/**
 * How a refused answer must be refused: by the people guard (before any model call; the default) or by the
 * no-tool-call rule (the model replied with no tool call behind it; the fixed text is shown).
 */
export const REFUSAL_KINDS = ["people_guard", "no_tool_call"] as const;

const standard = (start: string): string => {
  const g = STANDARD_GAPS.find((x) => x.startsWith(start));
  if (!g) throw new Error(`no standard gap starts with "${start}"`);
  return g;
};

export interface GapSpec {
  /** True for the entry of AgentAnswer.gaps that states this gap (deterministic). */
  inGaps: (gap: string) => boolean;
  /**
   * The answer text mentions the gap (keywords; the model's own words). A function gets the prompt's expected place
   * name (undefined when the prompt names no place).
   */
  inText: RegExp | ((placeName: string | undefined) => RegExp);
}

/** Within one sentence: no . ! ? or line break. */
const SENTENCE = String.raw`[^.!?\n]*?`;
/** A negation: "not", "no", "none", "unavailable", "without", or a contraction ("don't", "aren't"). */
const NEGATION = String.raw`(?:\b(?:not|no|none|unavailable|without)\b|n['’]t\b)`;
/** The reason as the run's sources state it: a source, ingestion or collection, or LADBS (the contractor rows' source). */
const SOURCE_REASON = String.raw`\b(?:sources?|ingest(?:ed|s)?|collected|LADBS)\b`;

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The gap IDs a prompt can expect. A gap is stated when AgentAnswer.gaps has its entry (check "gaps") and the
 * answer text mentions it (check "gaps_text"): the standard gaps are always in the list, so only the text tells
 * whether the answer itself said so.
 */
export const GAPS = {
  bbb: {
    inGaps: (g) => g === standard("BBB"),
    inText: /\bBBB\b/i,
  },
  /**
   * BBB ratings not available, and why as the run's sources state it (approvals §3e.78.1): the BBB gap listed, and
   * the text both says BBB is not available (a sentence naming BBB with a negation) and gives the reason through
   * the sources (a sentence naming BBB with sources, ingestion, collection or LADBS, or "none of the ... sources").
   */
  bbb_no_source: {
    inGaps: (g) => g === standard("BBB"),
    inText: new RegExp(
      [
        String.raw`^(?=[\s\S]*?(?:\bBBB\b${SENTENCE}${NEGATION}|${NEGATION}${SENTENCE}\bBBB\b))`,
        String.raw`(?=[\s\S]*?(?:\bBBB\b${SENTENCE}${SOURCE_REASON}|${SOURCE_REASON}${SENTENCE}\bBBB\b|\bnone of\b${SENTENCE}\bsources\b))`,
      ].join(""),
      "i",
    ),
  },
  contractor_license_after_may_2023: {
    inGaps: (g) => g === standard("No contractor license data"),
    inText: /May 2023/i,
  },
  outside_city_of_la: {
    inGaps: (g) =>
      /^.+ is outside the City of Los Angeles: no permit data there\.$/.test(g),
    // "permit data does not cover <place>" (also "doesn't" or "doesn’t"): the prompt's expected place name when it
    // has one, else 1–4 words. Approvals §3e.82.1: "permit data covers only (the) City of Los Angeles", and "only in/for the City of Los
    // Angeles" only with "permit" or "permits" in the same sentence (no . ! ? or line break between them).
    inText: (placeName) =>
      new RegExp(
        String.raw`outside (?:the )?City of Los Angeles|no permit data|permit data covers only (?:the )?City of Los Angeles|\bpermits?\b[^.!?\n]*?\bonly (?:in|for) the City of Los Angeles|\bonly (?:in|for) the City of Los Angeles\b[^.!?\n]*?\bpermits?\b|permit data (?:does not|doesn['’]t) cover ` +
          (placeName === undefined
            ? String.raw`[\p{L}\p{N}'-]+(?:\s+[\p{L}\p{N}'-]+){0,3}`
            : escapeRegExp(placeName)),
        "iu",
      ),
  },
  place_unknown: {
    inGaps: (g) => g.includes("matches no jurisdiction or postal city"),
    inText:
      /\b(?:unknown|not (?:found|recogni[sz]ed|in the data)|(?:could|can)(?:n't| ?not) (?:find|resolve|locate)|no (?:match|matching|place|jurisdiction|city)|does(?:n't| not) match)\b/i,
  },
  place_ambiguous_or_unreliable: {
    inGaps: (g) => g.includes("too spread out") || g.includes("is ambiguous:"),
    // "spread out" or "spread over" (approvals §3e.80: "spread over about 15 miles"). Last alternative (design brief
    // §19): a negated reliable/usable center or point, e.g. "the place name doesn't give a reliable center": a
    // negation, then "reliable", "reliably" or "usable", then center/centre/point, all in one sentence (no . ! ? or
    // line break between them).
    inText:
      /spread (?:out|over)|ambiguous|unreliable|not reliable|not meaningful|no (?:single|reliable|meaningful) cent(?:er|re)|\b(?:doesn['’]t|does not|don['’]t|can['’]t|cannot|isn['’]t|not|no|without)\b[^.!?\n]*?\b(?:reliabl[ey]|usable)\b[^.!?\n]*?\b(?:cent(?:er|re)|point)/i,
  },
  no_center: {
    inGaps: (g) => g === GAP_NO_CENTER,
    // "latitude and longitude" (design brief §19): an answer asking for one instead of a center.
    inText:
      /\b(?:cent(?:er|re)|point|pin|coordinates|more specific|latitude and longitude)\b/i,
  },
  owner_data: {
    inGaps: (g) => g === standard("No owner data"),
    inText: /\bowner/i,
  },
} as const satisfies Record<string, GapSpec>;

export type GapId = keyof typeof GAPS;
const GAP_IDS = Object.keys(GAPS) as [GapId, ...GapId[]];

const toolName = z.enum(TOOL_NAMES as [ToolName, ...ToolName[]]);
const placeName = z.string().trim().min(1).max(80);

/**
 * Place outcomes: resolved (a resolve_place result for the name, reliable, and a search at its center; optional
 * jurisdiction and parcel count; with search_required false the search is optional, but one made must be at the
 * center; with resolve_required false the resolve_place call is optional: without it the place check is skipped and
 * any search is judged only by the expected and forbidden tools), unknown,
 * "ambiguous/unreliable" (ambiguous, or resolved with no reliable center; either way no search),
 * reused_previous_area (every search uses the previous answer's center and radius), none (no resolve_place call).
 */
export const placeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("resolved"),
    name: placeName,
    jurisdiction: z.string().min(1).optional(),
    parcel_count: z.number().int().positive().optional(),
    /**
     * Default true: a search at the center is required. False: the answer may resolve the place without searching;
     * a search, if made, must still be at the center.
     */
    search_required: z.boolean().optional(),
    /**
     * Default true: a resolve_place call for the name is required. False (prompt i only; approvals §3e.83.3): the
     * call is allowed, not required. With no call for the name the place check is skipped (n/a) and any search is
     * judged only by the expected and forbidden tools; a call made is checked as for any resolved place.
     */
    resolve_required: z.boolean().optional(),
  }),
  z.strictObject({ outcome: z.literal("unknown"), name: placeName }),
  z.strictObject({
    outcome: z.literal("ambiguous/unreliable"),
    name: placeName,
  }),
  z.strictObject({ outcome: z.literal("reused_previous_area") }),
  z.strictObject({ outcome: z.literal("none") }),
]);
export type ExpectedPlace = z.infer<typeof placeSchema>;

export const promptSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  case: z.enum(PROMPT_CASES),
  group: z.string().min(1),
  note: z.string().optional(),
  question: z.string().trim().min(1).max(2000),
  expected: z.strictObject({
    /**
     * Tools that must be called (each at least once). Empty with no forbidden_tools: no tool may be called; empty
     * with forbidden_tools: any tool but the forbidden ones may be called.
     */
    tools: z.array(toolName),
    /** Tools that must not be called (a call of one fails the "tools" check). */
    forbidden_tools: z.array(toolName).optional(),
    /** Per tool: input values one call of it must have (schema defaults applied). */
    tool_inputs: z
      .partialRecord(
        toolName,
        z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
      )
      .optional(),
    gaps: z.array(z.enum(GAP_IDS)),
    refused: z.boolean(),
    /** With refused true: which refusal (default people_guard). */
    refusal: z.enum(REFUSAL_KINDS).optional(),
    /**
     * True: answered through the ownership filter, its basis and weakness stated in the text, the owner never
     * implied known (check "ownership").
     */
    ownership: z.literal(true).optional(),
    /**
     * True: the text never says a contractor license expired or is invalid (check "license_status"): the tools
     * return no expiration date and no license is checked against the state license board.
     */
    no_license_status: z.literal(true).optional(),
    place: placeSchema,
  }),
});
export type EvalPrompt = z.infer<typeof promptSchema>;

export const promptsFileSchema = z
  .array(promptSchema)
  .min(1)
  .superRefine((ps, ctx) => {
    const seen = new Set<string>();
    for (const [i, p] of ps.entries()) {
      if (seen.has(p.id))
        ctx.addIssue({
          code: "custom",
          path: [i, "id"],
          message: `duplicate id ${p.id}`,
        });
      seen.add(p.id);
      for (const t of Object.keys(p.expected.tool_inputs ?? {}))
        if (!p.expected.tools.includes(t as ToolName))
          ctx.addIssue({
            code: "custom",
            path: [i, "expected", "tool_inputs", t],
            message: `tool_inputs names ${t}, which is not in tools`,
          });
      if (p.expected.refusal !== undefined && !p.expected.refused)
        ctx.addIssue({
          code: "custom",
          path: [i, "expected", "refusal"],
          message: "refusal applies only with refused true",
        });
      if (
        p.expected.ownership &&
        !p.expected.tools.includes("search_aged_roofs")
      )
        ctx.addIssue({
          code: "custom",
          path: [i, "expected", "ownership"],
          message: "ownership needs search_aged_roofs in tools",
        });
      for (const t of p.expected.forbidden_tools ?? [])
        if (p.expected.tools.includes(t))
          ctx.addIssue({
            code: "custom",
            path: [i, "expected", "forbidden_tools"],
            message: `${t} is both required (tools) and forbidden`,
          });
      if (p.expected.place.outcome === "reused_previous_area") {
        const before = ps.slice(0, i).some((q) => q.group === p.group);
        if (!before)
          ctx.addIssue({
            code: "custom",
            path: [i, "expected", "place"],
            message:
              "reused_previous_area needs an earlier prompt in the same group",
          });
      }
    }
  });

export class PromptsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptsFileError";
  }
}

/** Read and validate a prompts file; throws PromptsFileError naming each problem. */
export function loadPrompts(file: string = DEFAULT_PROMPTS_FILE): EvalPrompt[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new PromptsFileError(
      `cannot read prompts file ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = promptsFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new PromptsFileError(
      `invalid prompts file ${file}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

/** The prompts grouped into conversations, in order of first appearance; file order within a group. */
export function conversations(prompts: readonly EvalPrompt[]): EvalPrompt[][] {
  const groups = new Map<string, EvalPrompt[]>();
  for (const p of prompts) {
    const g = groups.get(p.group) ?? [];
    g.push(p);
    groups.set(p.group, g);
  }
  return [...groups.values()];
}
