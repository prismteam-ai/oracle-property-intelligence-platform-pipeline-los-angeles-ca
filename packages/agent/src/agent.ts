/**
 * The agent loop: a hand-written tool loop with turn, token and time caps, the
 * people guard before any model call, citations, gaps, and deterministic reasoning and assumptions built from the
 * tool calls. One call = one answer; the conversation (history + session area) goes in and comes back out.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentSettings } from "./config.ts";
import {
  answerStandardGaps,
  contractorWindow,
  type WindowRead,
} from "./contractor-coverage.ts";
import { modelErrorName, type ModelClient } from "./model-client.ts";
import type { Provider } from "./models.ts";
import { ownershipRuleLine } from "./ownership.ts";
import { onceSources, type DataQueries } from "./permit-api.ts";
import {
  BASIS_LABEL,
  candidatesPhrase,
  centerPhrase,
  resolvedPhrase,
  sameCoord,
  type PlaceBasis,
} from "../../views/src/place-index.ts";
import {
  GAP_NO_CENTER,
  NO_TOOL_CALL_TEXT,
  STANDARD_GAPS,
  buildMarkdown,
  dedupeCitations,
  gapForUnverified,
  idsInText,
  isPeopleQuestion,
  peopleRefusalText,
  uniq,
  unverifiedIds,
  type Citation,
} from "./policy.ts";
import { systemPrompt } from "./prompt.ts";
import {
  DEFAULT_MIN_OPEN_DAYS,
  LONG_OPEN_SCOPE,
  anthropicTools,
  runTool,
  toolSchemas,
  type ContractorSummary,
  type ToolOutcome,
} from "./tools.ts";

/** Kept free before every model call for tool work and the response (ms). */
export const TIME_RESERVE_MS = 1_500;

export interface AgentCenter {
  lat: number;
  lon: number;
  label: string;
}

/** The CRM screen's radius and roof age threshold, sent with the question. */
export interface AgentScreen {
  radius_miles: number;
  threshold_years: number;
}

export type AreaBasis = PlaceBasis | "request_center" | "coordinates";

export interface SessionArea {
  label: string;
  lat: number;
  lon: number;
  radius_miles: number;
  basis: AreaBasis;
}

export interface SessionState {
  area?: SessionArea;
}

export interface AgentRequest {
  /** 1..2000 characters. */
  question: string;
  /** The CRM pin or the presenter's place. */
  center?: AgentCenter;
  /** The CRM screen's radius and roof age threshold (used when the question gives none). */
  screen?: AgentScreen;
  /** The conversation so far (returned by the previous call). */
  history?: Anthropic.MessageParam[];
  session?: SessionState;
}

export const agentRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  center: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      label: z.string().trim().min(1).max(200),
    })
    .optional(),
  // Numbers within the tools' own bounds: search_aged_roofs' radius_miles (long_open_permits uses the same schema)
  // and threshold_years, without their defaults.
  screen: z
    .strictObject({
      radius_miles: toolSchemas.search_aged_roofs.shape.radius_miles.unwrap(),
      threshold_years:
        toolSchemas.search_aged_roofs.shape.threshold_years.unwrap(),
    })
    .optional(),
});

export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

export type StoppedBy =
  | "time_budget"
  | "token_cap"
  | "max_tool_turns"
  | "model_refusal"
  | "max_tokens"
  | "error"
  | "unexpected_stop"
  | "budget";

export interface AgentUsage {
  /** Input tokens incl. cache writes and reads, summed over the answer's model calls. */
  input_tokens: number;
  output_tokens: number;
  model_calls: number;
  tool_calls: number;
}

/**
 * Why an answer was refused: the people guard (before any model call), or the no-tool-call rule (the model replied
 * with no tool result in this answer or the conversation; its reply is replaced by NO_TOOL_CALL_TEXT).
 */
export type RefusedBy = "people_guard" | "no_tool_call";

export interface AgentAnswer {
  status: "answered" | "refused" | "stopped";
  /** Set when status is "refused". */
  refused_by?: RefusedBy;
  stopped_by?: StoppedBy;
  /** The SDK's typed error class name when stopped_by is "error". */
  error?: string;
  text: string;
  /** One or two sentences built from the tool calls (deterministic). */
  reasoning: string;
  assumptions: string[];
  records: Citation[];
  gaps: string[];
  unverified_ids: string[];
  usage: AgentUsage;
  elapsed_ms: number;
  markdown: string;
  /** The conversation to pass to the next call. */
  history: Anthropic.MessageParam[];
  session: SessionState;
}

export interface AgentDeps {
  model: ModelClient;
  queries: DataQueries;
  settings: AgentSettings;
  /** Injected clock (ms); defaults to Date.now. */
  now?: () => number;
  signal?: AbortSignal;
  /**
   * Called with the exact request before each model call (e.g. the eval's spend limit). Returning false stops the
   * answer before that call (stopped_by "budget"); the call is not made and not counted.
   */
  beforeModelCall?: (
    params: Anthropic.MessageCreateParamsNonStreaming,
  ) => boolean | Promise<boolean>;
}

const STOP_TEXT: Record<StoppedBy, string> = {
  time_budget: "The time budget ran out before the answer was complete.",
  token_cap: "The token budget ran out before the answer was complete.",
  max_tool_turns:
    "The tool-call limit was reached before the answer was complete.",
  model_refusal: "The model declined to answer this question.",
  max_tokens: "The answer reached the output-token limit and is incomplete.",
  error: "The model call failed; no answer was produced.",
  unexpected_stop: "The model stopped unexpectedly; no answer was produced.",
  budget:
    "The spending limit would have been exceeded by the next model call, so it was not made.",
};

const SEARCH_TOOLS = new Set(["search_aged_roofs", "long_open_permits"]);
const fmt = (n: number) => n.toLocaleString("en-US");
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
/**
 * A search is attributed to a center when both coordinates agree at 5 decimals (the precision resolve_place serves
 * and the agent states), both sides through the same formatter (place-index.ts coordText).
 */
const atCenter = (c: { lat: number; lon: number }, lat: number, lon: number) =>
  sameCoord(c.lat, lat) && sameCoord(c.lon, lon);

/** A tool round needs room for its estimated input plus at least this many output tokens. */
export const MIN_ANSWER_TOKENS = 1_024;
/** Characters per token of the input estimate. */
export const ESTIMATE_CHARS_PER_TOKEN = 3;

/** The previous model call, for the next call's input estimate. */
export interface PreviousCall {
  /** Its input tokens, cache writes and reads included. */
  input_tokens: number;
  output_tokens: number;
}

/**
 * The estimated input tokens of the next model call:
 * - first call of the answer: ceil(request JSON characters / 3), the request being its system prompt, tools and
 *   messages (the whole conversation so far);
 * - later calls: the previous call's input_tokens + output_tokens (its whole input and its reply, both re-sent) +
 *   ceil(JSON characters of the messages added after that reply, i.e. the tool results / 3).
 */
export function estimateInputTokens(
  previous: PreviousCall | undefined,
  /** First call: the request; later calls: the messages added after the previous call's reply. */
  added: unknown,
): number {
  const chars = Math.ceil(
    JSON.stringify(added).length / ESTIMATE_CHARS_PER_TOKEN,
  );
  return previous
    ? previous.input_tokens + previous.output_tokens + chars
    : chars;
}

/** The prompt-cache marker: a 5-minute cache of the request prefix up to and including the marked block. */
export const PROMPT_CACHE_CONTROL = { type: "ephemeral" } as const;

/**
 * The system prompt and tool definitions as one request sends them. Provider "anthropic": the system prompt as one
 * text block and the last tool definition, each with PROMPT_CACHE_CONTROL (tools render before the system prompt, so
 * the two markers cache the tools, then tools and system); the text of the prompt and of every tool is unchanged.
 * Any other provider (the Bedrock path), or none: the system prompt as a string and the tools unmarked, as before.
 */
export function promptCacheParts(
  provider: Provider | undefined,
  system: string,
  tools: Anthropic.Tool[],
): { system: string | Anthropic.TextBlockParam[]; tools: Anthropic.Tool[] } {
  if (provider !== "anthropic") return { system, tools };
  return {
    system: [
      { type: "text", text: system, cache_control: PROMPT_CACHE_CONTROL },
    ],
    tools: tools.map((t, i) =>
      i === tools.length - 1
        ? { ...t, cache_control: PROMPT_CACHE_CONTROL }
        : t,
    ),
  };
}

/** The result text of a tool call the answer closed without running it (closeDanglingToolUse). */
export const NOT_RUN_PREFIX = "not run: the answer stopped";
const plural = (n: number, word: string) =>
  `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function userTurn(
  req: AgentRequest,
  area?: SessionArea,
): Anthropic.MessageParam {
  const blocks: Anthropic.TextBlockParam[] = [];
  if (req.center)
    blocks.push({
      type: "text",
      text: `Center from the request: ${req.center.label}, ${req.center.lat}, ${req.center.lon}.`,
    });
  if (req.screen)
    blocks.push({
      type: "text",
      text: `Screen values from the request: radius ${req.screen.radius_miles} mi, roof age threshold ${req.screen.threshold_years} years.`,
    });
  if (area)
    blocks.push({
      type: "text",
      text: `Previous search area: ${area.label}, center ${area.lat}, ${area.lon}, radius ${area.radius_miles} mi.`,
    });
  blocks.push({ type: "text", text: req.question });
  return { role: "user", content: blocks };
}

/** Tool-result content blocks of the given history, for IDs returned in earlier answers. */
function idsInHistory(history: readonly Anthropic.MessageParam[]): string[] {
  const out: string[] = [];
  for (const m of history) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content)
      if (b.type === "tool_result" && !b.is_error)
        out.push(
          ...idsInText(
            typeof b.content === "string"
              ? b.content
              : (b.content ?? [])
                  .map((c) => (c.type === "text" ? c.text : ""))
                  .join("\n"),
          ),
        );
  }
  return out;
}

const toolResultText = (b: Anthropic.ToolResultBlockParam): string =>
  typeof b.content === "string"
    ? b.content
    : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");

/**
 * True when the history holds the result of a tool call that ran in an earlier answer (its data, or its error). A
 * tool call the answer closed without running it (its result starts with NOT_RUN_PREFIX) does not count.
 */
export function historyHasToolResult(
  history: readonly Anthropic.MessageParam[],
): boolean {
  return history.some(
    (m) =>
      m.role === "user" &&
      typeof m.content !== "string" &&
      m.content.some(
        (b) =>
          b.type === "tool_result" &&
          !toolResultText(b).startsWith(NOT_RUN_PREFIX),
      ),
  );
}

/** Why a tool call the model asked for did not run, by the stop that ended the answer ("end": no stop). */
const NOT_RUN_WHY: Record<StoppedBy | "end", string> = {
  time_budget: "the answer's time budget ran out",
  token_cap: "the answer's token budget ran out",
  max_tool_turns: "the answer's tool-call limit was reached",
  model_refusal: "the model declined to answer",
  max_tokens: "the model's reply reached the output-token limit",
  error: "the model call failed",
  unexpected_stop: "the model stopped unexpectedly",
  budget: "the spending limit was reached",
  end: "the answer ended",
};

/** The result text of a tool call the answer closed without running it: NOT_RUN_PREFIX, the stop and why. */
const notRunText = (reason: StoppedBy | "end"): string =>
  `${NOT_RUN_PREFIX} (${reason}): ${NOT_RUN_WHY[reason]}.`;

/** How many times each value occurs, in order of first occurrence. */
function countBy(values: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}

/** The gap of the calls of one tool the answer closed without running them. */
function notRunGap(
  name: string,
  calls: number,
  reason: StoppedBy | "end",
): string {
  return `${calls === 1 ? `${name} was` : `${fmt(calls)} ${name} calls were`} not run: ${NOT_RUN_WHY[reason]}.`;
}

/**
 * Answer every tool call of this answer's last assistant message that has no result, as not run (is_error, with
 * the stop and why), so the history stays valid for the Messages API and says what happened: when the answer
 * stopped before any call of the round, a user message of results follows; when it stopped part-way, the missing
 * results join the round's results, in the order of the calls. Messages before `from` (the conversation so far)
 * are not touched. Returns the calls closed this way.
 */
function closeDanglingToolUse(
  messages: Anthropic.MessageParam[],
  from: number,
  reason: StoppedBy | "end",
): Anthropic.ToolUseBlockParam[] {
  let at = messages.length - 1;
  while (at >= from && messages[at]!.role !== "assistant") at--;
  const last = messages[at];
  if (at < from || !last || typeof last.content === "string") return [];
  const calls: Anthropic.ToolUseBlockParam[] = [];
  for (const b of last.content) if (b.type === "tool_use") calls.push(b);
  const next = messages[at + 1];
  const given = new Map<string, Anthropic.ToolResultBlockParam>();
  if (next && typeof next.content !== "string")
    for (const b of next.content)
      if (b.type === "tool_result") given.set(b.tool_use_id, b);
  const pending = calls.filter((b) => !given.has(b.id));
  if (!pending.length) return [];
  const results = calls.map(
    (b): Anthropic.ToolResultBlockParam =>
      given.get(b.id) ?? {
        type: "tool_result",
        tool_use_id: b.id,
        is_error: true,
        content: notRunText(reason),
      },
  );
  if (next) messages[at + 1] = { role: "user", content: results };
  else messages.push({ role: "user", content: results });
  return pending;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
};
const YEARS = String.raw`\b(many|several|a few|\d+(?:\.\d+)?|${Object.keys(NUMBER_WORDS).join("|")})\s+years?\b`;

/** How the question's duration became min_open_days (deterministic). */
function durationAssumption(question: string, minDays: number): string {
  const m =
    new RegExp(String.raw`(?:open|permit)[^.?!]*?${YEARS}`, "i").exec(
      question,
    ) ?? new RegExp(YEARS, "i").exec(question);
  const phrase = m?.[0].match(new RegExp(YEARS, "i"))?.[0];
  const word = m?.[1]?.toLowerCase();
  const n =
    word === undefined
      ? undefined
      : (NUMBER_WORDS[word] ?? (/^\d/.test(word) ? Number(word) : undefined));
  const isDefault = minDays === DEFAULT_MIN_OPEN_DAYS;
  if (phrase && n !== undefined && Math.round(n * 365.25) === minDays)
    return `"${phrase}" read as at least ${fmt(minDays)} days open (Math.round(${n} × 365.25)).`;
  if (phrase && n === undefined && isDefault)
    return `"${phrase}" read as at least ${fmt(minDays)} days open (5 × 365.25, rounded; the default minimum).`;
  return `Long-open means at least ${fmt(minDays)} days open${isDefault ? " (5 × 365.25, rounded; the default minimum)" : ""}${phrase ? `; the question says "${phrase}"` : ""}.`;
}

/**
 * The long-open rule as every long-open answer states it, with the searched minimum (and
 * maximum, when one was given).
 */
export function longOpenRuleLine(
  minOpenDays: number,
  maxOpenDays: number | null,
): string {
  const range = `at least ${fmt(minOpenDays)} days${maxOpenDays !== null ? ` and at most ${fmt(maxOpenDays)} days` : ""}`;
  return `Rule: long-open permits are ${LONG_OPEN_SCOPE} (the data API's rule: an issued permit for roofing work, open ${range}; a roof-coating-only permit counts and is flagged).`;
}

/** The gap of a place or parcel whose jurisdiction no permit source covers. */
export const outsideCityGap = (place: string): string =>
  `${place} is outside the City of Los Angeles: no permit data there.`;

/** Where a search's radius or roof age threshold came from (precedence: question, previous area, screen, default). */
export type ValueSource =
  "question" | "previous_area" | "screen" | "default" | "other";

/** The tool defaults: radius 5 mi, roof age threshold 15 years. */
const DEFAULT_RADIUS_MILES = 5;
const DEFAULT_THRESHOLD_YEARS = 15;

const NUMBER_WORD = Object.keys(NUMBER_WORDS).join("|");
/** Distances in the question, in miles: "five miles", "1 mile", "1-mile", "a mile", "half a mile", "2.5 mi". */
function questionMiles(question: string): number[] {
  const re = new RegExp(
    String.raw`\b(half an?|an?|\d+(?:\.\d+)?|${NUMBER_WORD})[\s-]+(?:miles?|mi)\b`,
    "gi",
  );
  return [...question.matchAll(re)].map((m) => {
    const w = m[1]!.toLowerCase();
    if (w.startsWith("half")) return 0.5;
    if (w === "a" || w === "an") return 1;
    return NUMBER_WORDS[w] ?? Number(w);
  });
}
/** Numbers of years in the question: "older than 25 years", "25-year-old roofs", "fifteen years". */
function questionYears(question: string): number[] {
  const re = new RegExp(
    String.raw`\b(\d+(?:\.\d+)?|${NUMBER_WORD})[\s-]+years?\b`,
    "gi",
  );
  return [...question.matchAll(re)].map((m) => {
    const w = m[1]!.toLowerCase();
    return NUMBER_WORDS[w] ?? Number(w);
  });
}

/**
 * The assumption naming where a search's radius or roof age threshold came from (deterministic; the eval's screen
 * check rebuilds it). `screen` is the screen's value for the same setting, when the request had a screen.
 */
export function valueSourceAssumption(
  what: "radius" | "threshold",
  value: number,
  source: ValueSource,
  screen: number | undefined,
): string {
  const label = what === "radius" ? "Radius" : "Roof age threshold";
  const unit = (n: number) => (what === "radius" ? `${n} mi` : `${n} years`);
  const shows =
    screen !== undefined ? ` (the screen shows ${unit(screen)})` : "";
  switch (source) {
    case "question":
      return `${label} ${unit(value)} from the question${shows}.`;
    case "previous_area":
      return `${label} ${unit(value)} from the previous search area${shows}.`;
    case "screen":
      return `${label} ${unit(value)} from the screen (the question gives ${what === "radius" ? "no distance" : "no roof age"}).`;
    case "default":
      return `${label} ${unit(value)}: the tool's default${screen !== undefined ? `, not the screen's ${unit(screen)}` : ""}.`;
    case "other":
      return `${label} ${unit(value)}: from neither the question${screen !== undefined ? ", the screen" : ""} nor the previous search area.`;
  }
}

/** The source of a search's value: the question, the previous area (radius only), the screen, the default, or none. */
function valueSource(
  value: number,
  inQuestion: readonly number[],
  previous: number | undefined,
  screen: number | undefined,
  fallback: number,
): ValueSource {
  if (inQuestion.some((n) => same(n, value))) return "question";
  if (previous !== undefined && same(previous, value)) return "previous_area";
  if (screen !== undefined && same(screen, value)) return "screen";
  if (same(fallback, value)) return "default";
  return "other";
}

interface Explained {
  reasoning: string[];
  /** Rule lines, each its own sentence after the reasoning. */
  rules: string[];
  assumptions: string[];
  gaps: string[];
  session: SessionState;
  centerKnown: boolean;
}

/** Reasoning fragments, assumptions, extra gaps and the new session area, from the tool calls in order. */
function explain(
  req: AgentRequest,
  prev: SessionArea | undefined,
  outcomes: readonly ToolOutcome[],
): Explained {
  const reasoning: string[] = [];
  const rules: string[] = [];
  const assumptions: string[] = [];
  const gaps: string[] = [];
  const places: Array<{
    label: string;
    lat: number;
    lon: number;
    basis: PlaceBasis;
  }> = [];
  let area = prev;
  let centerKnown = Boolean(req.center || prev);

  for (const o of outcomes) {
    const input = (o.input ?? {}) as Record<string, unknown>;
    if (o.name === "resolve_place" && o.fact?.tool === "resolve_place") {
      const r = o.fact.resolution;
      if (r.status === "resolved") {
        centerKnown = true;
        const basis = BASIS_LABEL[r.basis];
        places.push({
          label: r.name,
          lat: r.center.lat,
          lon: r.center.lon,
          basis: r.basis,
        });
        // Center (5 decimals) and parcel count, as in the tool's note (place-index.ts resolutionNote).
        reasoning.push(
          `resolved ${resolvedPhrase(r.name, r)}${r.also_matched ? ` (it also matched a ${BASIS_LABEL[r.also_matched.basis]} with ${centerPhrase(r.also_matched)})` : ""}`,
        );
        assumptions.push(
          `'${r.name}' means the ${basis} ${r.raw_values.map((v) => `"${v}"`).join(" / ")}; its search center is ${centerPhrase(r)}.`,
        );
      } else if (r.status === "ambiguous") {
        reasoning.push(
          `found '${r.name}' ambiguous (${candidatesPhrase(r.candidates)}), so chose no center`,
        );
        assumptions.push(
          `'${r.name}' was not used as a center: it is ambiguous between ${candidatesPhrase(r.candidates)}.`,
        );
      } else
        reasoning.push(`did not find "${r.name}" among the run's place names`);
      continue;
    }

    let label = "";
    if (
      SEARCH_TOOLS.has(o.name) &&
      typeof input.lat === "number" &&
      typeof input.lon === "number"
    ) {
      const lat = input.lat;
      const lon = input.lon;
      const radius = Number(input.radius_miles);
      const place = [...places].reverse().find((p) => atCenter(p, lat, lon));
      let basis: AreaBasis;
      let reused = false;
      if (place) {
        label = place.label;
        basis = place.basis;
      } else if (req.center && atCenter(req.center, lat, lon)) {
        label = req.center.label;
        basis = "request_center";
        assumptions.push(
          `Used the request's center "${label}" (${lat}, ${lon}).`,
        );
      } else if (prev && atCenter(prev, lat, lon)) {
        label = prev.label;
        basis = prev.basis;
        reused = true;
        assumptions.push(
          same(prev.radius_miles, radius)
            ? `Radius and center reused from the previous question (${prev.label}, ${prev.radius_miles} mi).`
            : `Center reused from the previous question (${prev.label}); radius changed to ${radius} mi.`,
        );
      } else {
        label = `${lat}, ${lon}`;
        basis = "coordinates";
        gaps.push(
          `The search center ${lat}, ${lon} was not supplied by the request, the previous search area or resolve_place.`,
        );
      }
      area = { label, lat, lon, radius_miles: radius, basis };
      // Where the radius and (search_aged_roofs) the roof age threshold came from. A radius reused with the
      // previous area's center is already stated above.
      const radiusFrom = valueSource(
        radius,
        questionMiles(req.question),
        reused ? prev!.radius_miles : undefined,
        req.screen?.radius_miles,
        DEFAULT_RADIUS_MILES,
      );
      if (radiusFrom !== "previous_area")
        assumptions.push(
          valueSourceAssumption(
            "radius",
            radius,
            radiusFrom,
            req.screen?.radius_miles,
          ),
        );
      if (
        o.name === "search_aged_roofs" &&
        typeof input.threshold_years === "number"
      )
        assumptions.push(
          valueSourceAssumption(
            "threshold",
            input.threshold_years,
            valueSource(
              input.threshold_years,
              questionYears(req.question),
              undefined,
              req.screen?.threshold_years,
              DEFAULT_THRESHOLD_YEARS,
            ),
            req.screen?.threshold_years,
          ),
        );
    }

    const f = o.fact;
    if (!o.ok || !f) {
      if (
        o.name === "long_open_permits" &&
        typeof input.min_open_days === "number"
      ) {
        reasoning.push(
          `tried to search long-open permits within ${String(input.radius_miles)} mi of ${label} open at least ${fmt(input.min_open_days)} days, but ${o.error}`,
        );
        assumptions.push(durationAssumption(req.question, input.min_open_days));
      } else reasoning.push(`called ${o.name}, which failed (${o.error})`);
      continue;
    }
    switch (f.tool) {
      case "search_aged_roofs": {
        // Which matching parcels have permit data: all of them counted, or (truncated points) only the nearest;
        // null: that read failed. Roof age covers every matching parcel either way, and with truncated points the
        // line says so first, then that the outside-the-City count was made only for the nearest.
        const cov = f.matched_permit_data;
        const without = cov?.without_permit_data ?? 0;
        const lo = f.long_open;
        const nearest = cov && !cov.complete ? cov.checked : null;
        const roofAge = (n: number) => `roof age covers all ${fmt(n)}`;
        const countedNearest = (n: number) =>
          `how many lie outside the City of Los Angeles, where there is no permit data, was counted only for the nearest ${fmt(n)}`;
        let matched: string;
        if (lo && lo.count === null)
          matched =
            nearest === null
              ? `${fmt(lo.of)} match, none with permit data (outside the City of Los Angeles), so whether they have a long-open roofing permit is not available (unknown, not 0)`
              : `${fmt(lo.of)} match (${roofAge(lo.of)}); ${countedNearest(nearest)}: all ${fmt(nearest)} do, so whether they have a long-open roofing permit is not available (unknown, not 0)`;
        // The long-open count itself comes from the nearest parcels when the points are truncated: a lower bound.
        else if (lo)
          matched = `${fmt(lo.of)} match${nearest === null ? "" : ` (${roofAge(lo.of)})`}, of which ${lo.complete ? "" : "at least "}${fmt(lo.count ?? 0)} parcels (not permits) have a long-open roofing permit (open at least ${fmt(lo.min_open_days)} days)${lo.complete ? "" : `, counted among the nearest${nearest === null ? "" : ` ${fmt(nearest)}`} only`}${without > 0 ? `; ${fmt(without)}${nearest === null ? "" : ` of those ${fmt(nearest)}`} have no permit data (outside the City of Los Angeles), unknown there` : ""}`;
        else
          matched = `${fmt(f.matched)} match${without === 0 ? "" : nearest === null ? ` (${fmt(without)} without permit data: outside the City of Los Angeles)` : ` (${roofAge(f.matched)}; ${countedNearest(nearest)}: ${outsideOf(without, nearest)})`}`;
        reasoning.push(
          `searched parcels within ${f.radius_miles} mi of ${label} whose effective roof year (the later of the year built and a finaled roofing permit's year) is before ${f.built_before_year} (roofs older than ${f.threshold_years} years)${f.ownership_basis ? `, owner unchanged for 10 years or more by the "${f.ownership_basis}" basis` : ""}: ${matched}, ${f.returned} listed`,
        );
        assumptions.push(
          f.proxy_count === f.returned
            ? `Roof age counts from the effective roof year, the later of the year built and a finaled roofing permit's year${f.returned > 0 ? "; for every listed parcel it is the year built (the assessor proxy)" : ""}: older than ${f.threshold_years} years means an effective roof year before ${f.built_before_year} (roll year ${f.roll_year} − ${f.threshold_years}).`
            : `Roof age counts from the effective roof year: a finaled roofing permit's year where the basis is PERMIT, else the assessor year-built proxy; older than ${f.threshold_years} years means an effective roof year before ${f.built_before_year}.`,
        );
        // No matching parcel has permit data (of those counted: the nearest, when the map points are truncated).
        // Without that read, the listed parcels decide, as they did before it.
        if (
          cov
            ? cov.checked > 0 && cov.with_permit_data === 0
            : f.returned > 0 && f.no_permit_data === f.returned
        )
          gaps.push(outsideCityGap(label));
        // The basis, its weakness and the proxy note, stated with the answer (ownership.ts).
        if (f.ownership_basis) rules.push(ownershipRuleLine(f.ownership_basis));
        break;
      }
      case "long_open_permits": {
        // Which parcels in the circle have permit data: all of them counted, or (truncated points) only the nearest;
        // null: that read failed. The count and the list cover every permit in the circle either way, and with
        // truncated points or a failed read the line says so first, then what is known of the outside-the-City count.
        const cov = f.permit_data;
        const without = cov?.without_permit_data ?? 0;
        const r = f.radius_miles;
        // "how many of the 42 parcels with a roof year lie outside ..., was counted only for the nearest 3"
        const countedNearest = (c: NonNullable<typeof cov>) =>
          `how many of the ${fmt(c.parcels)} parcels with a roof year lie outside the City of Los Angeles, where there is no permit data, was counted only for the nearest ${fmt(c.checked)}`;
        let matched: string;
        if (f.count !== null)
          matched = `${fmt(f.count)} match${!cov || without === 0 ? "" : cov.complete ? ` (${fmt(without)} of the ${fmt(cov.parcels)} parcels with a roof year without permit data: outside the City of Los Angeles)` : ` (the count and the list cover every permit within ${r} mi; ${countedNearest(cov)}: ${outsideOf(without, cov.checked)})`}`;
        else if (!cov)
          matched = `the list covers every permit within ${r} mi and found none; how many of the parcels with a roof year lie outside the City of Los Angeles, where there is no permit data, is not known (that read failed), so the count is not available (unknown, not 0)`;
        else if (cov.complete)
          matched = `none of the ${fmt(cov.parcels)} parcels with a roof year has permit data (outside the City of Los Angeles), so the count is not available (unknown, not 0)`;
        else
          matched = `the list covers every permit within ${r} mi and found none; ${countedNearest(cov)}: all ${fmt(cov.checked)} do, so the count is not available (unknown, not 0)`;
        reasoning.push(
          `searched long-open permits, ${LONG_OPEN_SCOPE}, within ${f.radius_miles} mi of ${label} open at least ${fmt(f.min_open_days)} days${f.max_open_days !== null ? ` and at most ${fmt(f.max_open_days)}` : ""}: ${matched}, ${f.returned} listed`,
        );
        // No parcel in the circle has permit data (of those counted): the place is outside the City of Los Angeles.
        if (cov && cov.checked > 0 && cov.with_permit_data === 0)
          gaps.push(outsideCityGap(label));
        assumptions.push(durationAssumption(req.question, f.min_open_days));
        rules.push(longOpenRuleLine(f.min_open_days, f.max_open_days));
        // with_contractor_window: the second list, within the contractor window (its limit computed by the tool).
        if (f.within_window?.status === "read") {
          reasoning.push(
            `listed the long-open permits issued within the contractor window (open at most ${fmt(f.within_window.max_open_days)} days): ${f.within_window.count === null ? "not available (unknown, not 0)" : `${fmt(f.within_window.count)} match`}, ${f.within_window.returned} listed, each with its permit's contractor rows (${contractorPhrase(f.within_window.contractors)})`,
          );
          rules.push(
            longOpenRuleLine(f.min_open_days, f.within_window.max_open_days),
          );
        } else if (f.within_window)
          reasoning.push(
            "did not list the long-open permits within the contractor window (stated as a gap)",
          );
        break;
      }
      case "parcel_detail":
        reasoning.push(
          `read parcel ${f.parcel_id}'s property facts and provenance`,
        );
        break;
      case "parcel_permits":
        reasoning.push(
          `read the permits of parcel ${f.parcel_id} (${plural(f.permits, "permit")}, ${plural(f.contractor_rows, "contractor row")}${f.permit_data_available ? "" : ", no permit data for its jurisdiction"})`,
        );
        if (!f.permit_data_available)
          gaps.push(
            outsideCityGap(
              `Parcel ${f.parcel_id}${f.jurisdiction ? ` (jurisdiction ${f.jurisdiction})` : ""}`,
            ),
          );
        break;
      case "run_summary":
        reasoning.push("read the run summary and its sources");
        break;
      case "resolve_place":
        break;
    }
  }
  return {
    reasoning: uniq(reasoning),
    rules: uniq(rules),
    assumptions: uniq(assumptions),
    gaps: uniq(gaps),
    session: area ? { area } : {},
    centerKnown,
  };
}

/** How many of the nearest parcels counted lie outside the City of Los Angeles: "all 3 do" or "1 of them". */
const outsideOf = (without: number, counted: number) =>
  without === counted ? `all ${fmt(counted)} do` : `${fmt(without)} of them`;

/** "8 named, 1 owner-builder, 1 not read": the contractor statuses of the within-window list, those that occur. */
function contractorPhrase(c: ContractorSummary): string {
  const said = (Object.keys(c) as Array<keyof ContractorSummary>)
    .filter((k) => c[k] > 0)
    .map((k) => `${c[k]} ${k}`);
  return said.length ? said.join(", ") : "none listed";
}

function sentence(fragments: readonly string[]): string {
  if (!fragments.length) return "";
  const s = fragments.join("; ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** Answer one question. Never throws for model or tool failures (they become a stopped answer or a tool error). */
export async function runAgent(
  request: AgentRequest,
  deps: AgentDeps,
): Promise<AgentAnswer> {
  const parsed = agentRequestSchema.safeParse(request);
  if (!parsed.success)
    throw new InvalidRequestError(
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "(request)"}: ${i.message}`)
        .join("; "),
    );
  const req: AgentRequest = {
    ...request,
    question: parsed.data.question,
    center: parsed.data.center,
    screen: parsed.data.screen,
  };
  const now = deps.now ?? Date.now;
  // explorer.sources (the permit and contractor citations) is read at most once per answer.
  const queries = onceSources(deps.queries);
  const s = deps.settings;
  const start = now();
  const deadline = start + s.timeBudgetMs;
  const history = [...(request.history ?? [])];
  const prevArea = request.session?.area;
  const usage: AgentUsage = {
    input_tokens: 0,
    output_tokens: 0,
    model_calls: 0,
    tool_calls: 0,
  };

  if (isPeopleQuestion(req.question)) {
    const reasoning =
      "Refused before any model call: the question asks about people, and owner or resident data is neither collected nor served.";
    const gaps = [...STANDARD_GAPS];
    const text = peopleRefusalText(req.question);
    return {
      status: "refused",
      refused_by: "people_guard",
      text,
      reasoning,
      assumptions: [],
      records: [],
      gaps,
      unverified_ids: [],
      usage,
      elapsed_ms: now() - start,
      markdown: buildMarkdown({
        text,
        status: "refused",
        reasoning,
        assumptions: [],
        records: [],
        gaps,
      }),
      history,
      session: request.session ?? {},
    };
  }

  // The contractor rows' window from the run's sources (read once per answer, shared with the tools' citations):
  // the system prompt's contractor lines and the contractor gap name it. A failed read keeps the documented end.
  const windowRead: WindowRead = await queries.explorer.sources().then(
    (src): WindowRead => {
      const window = contractorWindow(src);
      return window ? { status: "stated", window } : { status: "none" };
    },
    (): WindowRead => ({ status: "failed" }),
  );
  const messages: Anthropic.MessageParam[] = [
    ...history,
    userTurn(req, prevArea),
  ];
  // Provider "anthropic": both marked for prompt caching (promptCacheParts); their text is unchanged.
  const { system, tools } = promptCacheParts(
    s.provider,
    systemPrompt(
      s.maxToolTurns,
      windowRead.status === "stated" ? windowRead.window : null,
    ),
    anthropicTools(),
  );
  const outcomes: ToolOutcome[] = [];
  let toolRounds = 0;
  let stoppedBy: StoppedBy | undefined;
  let error: string | undefined;
  let finalText = "";
  /** The previous call's usage and the message count right after its reply (for the next estimate). */
  let previous: (PreviousCall & { messages: number }) | undefined;
  /** Set when the token cap stopped the answer before a call: that call's estimate and what was left. */
  let tokenStop: { estimate: number; left: number } | undefined;

  for (;;) {
    const remaining = deadline - now() - TIME_RESERVE_MS;
    if (remaining <= 0) {
      stoppedBy = "time_budget";
      break;
    }
    const used = usage.input_tokens + usage.output_tokens;
    const left = s.maxTokens - used;
    const request = {
      model: s.modelId,
      system,
      messages,
      tools,
      output_config: { effort: s.effort },
    };
    // The cap counts input + output over the answer's calls, so this call's input counts too (estimated).
    const estimate = estimateInputTokens(
      previous,
      previous ? messages.slice(previous.messages) : request,
    );
    // A tool round needs room for its input and MIN_ANSWER_TOKENS; else only a final answer (tool_choice none)
    // with what is left after the input; when not even that is left, stop before the call (no truncated output).
    const room = left - estimate;
    if (room <= 0) {
      stoppedBy = "token_cap";
      tokenStop = { estimate, left: Math.max(0, left) };
      break;
    }
    const tokenLastTurn = room < MIN_ANSWER_TOKENS;
    const lastTurn = toolRounds >= s.maxToolTurns || tokenLastTurn;
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: Math.min(s.maxOutputTokens, room),
      system,
      messages,
      tools,
      tool_choice: lastTurn ? { type: "none" } : { type: "auto" },
      output_config: request.output_config,
    };
    if (deps.beforeModelCall && !(await deps.beforeModelCall(params))) {
      stoppedBy = "budget";
      break;
    }
    let res: Anthropic.Message;
    try {
      usage.model_calls++;
      res = await deps.model.create(params, {
        timeoutMs: remaining,
        signal: deps.signal,
      });
    } catch (err) {
      stoppedBy = "error";
      error = modelErrorName(err);
      break;
    }
    const u = res.usage;
    const callInput =
      u.input_tokens +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0);
    usage.input_tokens += callInput;
    usage.output_tokens += u.output_tokens;
    // The full content goes back unchanged (thinking blocks included).
    messages.push({ role: "assistant", content: res.content });
    previous = {
      input_tokens: callInput,
      output_tokens: u.output_tokens,
      messages: messages.length,
    };
    finalText = textOf(res);

    if (res.stop_reason === "refusal") {
      stoppedBy = "model_refusal";
      break;
    }
    if (res.stop_reason === "max_tokens") {
      stoppedBy = "max_tokens";
      break;
    }
    if (res.stop_reason === "tool_use") {
      if (lastTurn) {
        stoppedBy =
          toolRounds >= s.maxToolTurns ? "max_tool_turns" : "token_cap";
        break;
      }
      const calls = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        if (deadline - now() - TIME_RESERVE_MS <= 0) {
          stoppedBy = "time_budget";
          break;
        }
        usage.tool_calls++;
        const o = await runTool(call.name, call.input, queries);
        outcomes.push(o);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(o.content),
          ...(o.ok ? {} : { is_error: true }),
        });
      }
      if (results.length) messages.push({ role: "user", content: results });
      if (stoppedBy) break;
      toolRounds++;
      continue;
    }
    if (res.stop_reason === "end_turn" || res.stop_reason === "stop_sequence")
      break;
    stoppedBy = "unexpected_stop";
    break;
  }
  const notRun = closeDanglingToolUse(
    messages,
    history.length,
    stoppedBy ?? "end",
  );

  // The no-tool-call rule: a reply of the model with no tool call behind it, in this answer (no
  // tool call ran, whether it returned data or an error) or in the conversation (no earlier tool result), is never
  // shown. The fixed text replaces it, the answer is refused, and the turn is not added to the history (the history
  // goes back as it came). A stopped answer counts too when the model wrote text (e.g. a long reply cut at
  // max_tokens); a stop with no model text keeps its stop text.
  if (finalText && !outcomes.length && !historyHasToolResult(history)) {
    const reasoning = `Withheld: the model replied without any tool result in this answer or the conversation, so its reply is replaced by the fixed scope text${stoppedBy ? ` (the reply had stopped early: ${stoppedBy})` : ""}.`;
    const gaps = [...answerStandardGaps(windowRead)];
    return {
      status: "refused",
      refused_by: "no_tool_call",
      text: NO_TOOL_CALL_TEXT,
      reasoning,
      assumptions: [],
      records: [],
      gaps,
      unverified_ids: [],
      usage,
      elapsed_ms: now() - start,
      markdown: buildMarkdown({
        text: NO_TOOL_CALL_TEXT,
        status: "refused",
        reasoning,
        assumptions: [],
        records: [],
        gaps,
      }),
      history,
      session: request.session ?? {},
    };
  }

  const text = stoppedBy && !finalText ? STOP_TEXT[stoppedBy] : finalText;
  const records = dedupeCitations(outcomes.flatMap((o) => o.records));
  const returned = new Set<string>([
    ...idsInHistory(history),
    ...outcomes.flatMap((o) => o.ids),
    ...records.map((r) => r.id),
  ]);
  const unverified = unverifiedIds(text, returned);
  const ex = explain(req, prevArea, outcomes);
  const dropped = outcomes.reduce((n, o) => n + o.dropped, 0);
  const gaps = uniq([
    ...answerStandardGaps(windowRead),
    ...outcomes.flatMap((o) => o.gaps),
    ...ex.gaps,
    ...(ex.centerKnown ? [] : [GAP_NO_CENTER]),
    ...(dropped
      ? [
          `${dropped} description field(s) were removed from tool results by the description guard.`,
        ]
      : []),
    ...unverified.map(gapForUnverified),
    // Each tool the model asked for that did not run, and why.
    ...[...countBy(notRun.map((b) => b.name))].map(([name, calls]) =>
      notRunGap(name, calls, stoppedBy ?? "end"),
    ),
  ]);
  const status = stoppedBy ? "stopped" : "answered";
  const reasoning = [
    sentence(ex.reasoning) ||
      (stoppedBy ? "No tool was called." : "Answered without calling a tool."),
    ...ex.rules,
    stoppedBy ? `The answer stopped early (${stoppedBy}).` : "",
    tokenStop
      ? `The next model call was not made: its input was estimated at ${fmt(tokenStop.estimate)} tokens with ${fmt(tokenStop.left)} of the ${fmt(s.maxTokens)}-token cap left.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    status,
    ...(stoppedBy ? { stopped_by: stoppedBy } : {}),
    ...(error ? { error } : {}),
    text,
    reasoning,
    assumptions: ex.assumptions,
    records,
    gaps,
    unverified_ids: unverified,
    usage,
    elapsed_ms: now() - start,
    markdown: buildMarkdown({
      text,
      status,
      stopped_by: stoppedBy,
      reasoning,
      assumptions: ex.assumptions,
      records,
      gaps,
    }),
    history: messages,
    session: ex.session.area ? ex.session : (request.session ?? {}),
  };
}
