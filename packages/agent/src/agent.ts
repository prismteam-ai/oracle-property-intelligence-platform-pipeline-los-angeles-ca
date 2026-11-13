/**
 * The agent loop (design brief §7, §11.2, §11.4): a hand-written tool loop with turn, token and time caps, the
 * people guard before any model call, citations, gaps, and deterministic reasoning and assumptions built from the
 * tool calls. One call = one answer; the conversation (history + session area) goes in and comes back out.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentSettings } from "./config.ts";
import { modelErrorName, type ModelClient } from "./model-client.ts";
import { onceSources, type DataQueries } from "./permit-api.ts";
import {
  BASIS_LABEL,
  candidatesPhrase,
  centerPhrase,
  resolvedPhrase,
  type PlaceBasis,
} from "./place-index.ts";
import {
  GAP_NO_CENTER,
  PEOPLE_REFUSAL_TEXT,
  STANDARD_GAPS,
  buildMarkdown,
  dedupeCitations,
  gapForUnverified,
  idsInText,
  isPeopleQuestion,
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
  type ToolOutcome,
} from "./tools.ts";

/** Kept free before every model call for tool work and the response (ms). */
export const TIME_RESERVE_MS = 1_500;

export interface AgentCenter {
  lat: number;
  lon: number;
  label: string;
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
  | "unexpected_stop";

export interface AgentUsage {
  /** Input tokens incl. cache writes and reads, summed over the answer's model calls. */
  input_tokens: number;
  output_tokens: number;
  model_calls: number;
  tool_calls: number;
}

export interface AgentAnswer {
  status: "answered" | "refused" | "stopped";
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
};

const SEARCH_TOOLS = new Set(["search_aged_roofs", "long_open_permits"]);
const fmt = (n: number) => n.toLocaleString("en-US");
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
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

/** If the last message asks for tools that never ran, answer them as not run (keeps the history valid). */
function closeDanglingToolUse(
  messages: Anthropic.MessageParam[],
  reason: string,
): void {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || typeof last.content === "string")
    return;
  const pending = last.content.filter(
    (b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use",
  );
  if (pending.length)
    messages.push({
      role: "user",
      content: pending.map((b) => ({
        type: "tool_result",
        tool_use_id: b.id,
        is_error: true,
        content: `not run: the answer stopped (${reason})`,
      })),
    });
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

interface Explained {
  reasoning: string[];
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
          `'${r.name}' means the ${basis} ${r.raw_values.join(" / ")}; its search center is ${centerPhrase(r)}.`,
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
      const place = [...places]
        .reverse()
        .find((p) => same(p.lat, lat) && same(p.lon, lon));
      let basis: AreaBasis;
      if (place) {
        label = place.label;
        basis = place.basis;
      } else if (
        req.center &&
        same(req.center.lat, lat) &&
        same(req.center.lon, lon)
      ) {
        label = req.center.label;
        basis = "request_center";
        assumptions.push(
          `Used the request's center "${label}" (${lat}, ${lon}).`,
        );
      } else if (prev && same(prev.lat, lat) && same(prev.lon, lon)) {
        label = prev.label;
        basis = prev.basis;
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
      case "search_aged_roofs":
        reasoning.push(
          `searched parcels within ${f.radius_miles} mi of ${label} built before ${f.built_before_year} (roofs older than ${f.threshold_years} years): ${fmt(f.count)} match, ${f.returned} listed`,
        );
        assumptions.push(
          f.proxy_count === f.returned
            ? `Roof age is the assessor year-built proxy: older than ${f.threshold_years} years means built before ${f.built_before_year} (roll year ${f.roll_year} − ${f.threshold_years}).`
            : `Roof age counts from the effective roof year: a finaled roofing permit's year where the basis is PERMIT, else the assessor year-built proxy; older than ${f.threshold_years} years means an effective roof year before ${f.built_before_year}.`,
        );
        break;
      case "long_open_permits":
        reasoning.push(
          `searched long-open permits, ${LONG_OPEN_SCOPE}, within ${f.radius_miles} mi of ${label} open at least ${fmt(f.min_open_days)} days${f.max_open_days !== null ? ` and at most ${fmt(f.max_open_days)}` : ""}: ${fmt(f.count)} match, ${f.returned} listed`,
        );
        assumptions.push(durationAssumption(req.question, f.min_open_days));
        break;
      case "parcel_detail":
        reasoning.push(
          `read parcel ${f.parcel_id}'s property facts and provenance`,
        );
        break;
      case "parcel_permits":
        reasoning.push(
          `read the permits of parcel ${f.parcel_id} (${plural(f.permits, "permit")}, ${plural(f.contractor_rows, "contractor row")}${f.permit_data_available ? "" : ", no permit data for its jurisdiction"})`,
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
    assumptions: uniq(assumptions),
    gaps: uniq(gaps),
    session: area ? { area } : {},
    centerKnown,
  };
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
    return {
      status: "refused",
      text: PEOPLE_REFUSAL_TEXT,
      reasoning,
      assumptions: [],
      records: [],
      gaps,
      unverified_ids: [],
      usage,
      elapsed_ms: now() - start,
      markdown: buildMarkdown({
        text: PEOPLE_REFUSAL_TEXT,
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

  const messages: Anthropic.MessageParam[] = [
    ...history,
    userTurn(req, prevArea),
  ];
  const tools = anthropicTools();
  const system = systemPrompt(s.maxToolTurns);
  const outcomes: ToolOutcome[] = [];
  let toolRounds = 0;
  let stoppedBy: StoppedBy | undefined;
  let error: string | undefined;
  let finalText = "";

  for (;;) {
    const remaining = deadline - now() - TIME_RESERVE_MS;
    if (remaining <= 0) {
      stoppedBy = "time_budget";
      break;
    }
    const used = usage.input_tokens + usage.output_tokens;
    if (used >= s.maxTokens) {
      stoppedBy = "token_cap";
      break;
    }
    const lastTurn = toolRounds >= s.maxToolTurns;
    let res: Anthropic.Message;
    try {
      usage.model_calls++;
      res = await deps.model.create(
        {
          model: s.modelId,
          max_tokens: Math.min(s.maxOutputTokens, s.maxTokens - used),
          system,
          messages,
          tools,
          tool_choice: lastTurn ? { type: "none" } : { type: "auto" },
          output_config: { effort: s.effort },
        },
        { timeoutMs: remaining, signal: deps.signal },
      );
    } catch (err) {
      stoppedBy = "error";
      error = modelErrorName(err);
      break;
    }
    const u = res.usage;
    usage.input_tokens +=
      u.input_tokens +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0);
    usage.output_tokens += u.output_tokens;
    // The full content goes back unchanged (thinking blocks included).
    messages.push({ role: "assistant", content: res.content });
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
        stoppedBy = "max_tool_turns";
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
  closeDanglingToolUse(messages, stoppedBy ?? "end");

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
    ...STANDARD_GAPS,
    ...outcomes.flatMap((o) => o.gaps),
    ...ex.gaps,
    ...(ex.centerKnown ? [] : [GAP_NO_CENTER]),
    ...(dropped
      ? [
          `${dropped} description field(s) were removed from tool results by the description guard.`,
        ]
      : []),
    ...unverified.map(gapForUnverified),
  ]);
  const status = stoppedBy ? "stopped" : "answered";
  const reasoning = [
    sentence(ex.reasoning) ||
      (stoppedBy ? "No tool was called." : "Answered without calling a tool."),
    stoppedBy ? `The answer stopped early (${stoppedBy}).` : "",
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
