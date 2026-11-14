/**
 * Checks of one eval answer (design brief §15.1):
 * - counts: for every tool call of the answer, the same query called directly with the same input (schema defaults
 *   applied, mapped the way the tool maps it) gives the same count and the same returned IDs in the same order;
 * - cited: unverified_ids is empty and every parcel ID or permit number in the answer text is cited: among its
 *   records, or a parcel ID a cited permit record links to (linkedParcels);
 * - gaps / gaps_text: each expected gap ID is in the answer's gaps list / mentioned in the answer text;
 * - elapsed: elapsed_ms < 30,000 (the API Gateway integration timeout, docs/sources.md §3);
 * - tools, refusal, place: the prompt's expected tools (and input values), refusal and place outcome.
 */
import {
  idsInText,
  placeKey,
  toolSchemas,
  type AgentAnswer,
  type AgentRequest,
  type DataQueries,
  type SessionArea,
  type ToolName,
} from "@oracle-la/agent";
import { GAPS, type EvalPrompt } from "./prompts.ts";

/** The API Gateway HTTP API's maximum integration timeout (docs/sources.md §3), in ms. */
export const ELAPSED_LIMIT_MS = 30_000;

export const CHECK_NAMES = [
  "counts",
  "cited",
  "gaps",
  "gaps_text",
  "elapsed",
  "tools",
  "refusal",
  "place",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type CheckValue = "pass" | "fail" | "n/a";
export interface CheckResult {
  result: CheckValue;
  details: string[];
}
export type AnswerChecks = Record<CheckName, CheckResult>;

type Message = NonNullable<AgentRequest["history"]>[number];
type Block = Exclude<Message["content"], string>[number];
type ToolUse = Extract<Block, { type: "tool_use" }>;
type ToolResultBlock = Extract<Block, { type: "tool_result" }>;

/** One tool call of an answer with its result as the model received it. */
export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  /** The tool result parsed from its JSON text (null when it never ran). */
  result: unknown;
  is_error: boolean;
}

const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "search_aged_roofs",
  "long_open_permits",
]);
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ids = (items: unknown, key: string): string[] =>
  arr(items).map((x) => String(rec(x)[key]));

function resultText(b: ToolResultBlock): string {
  if (typeof b.content === "string") return b.content;
  return (b.content ?? [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
}

/** The tool calls the answer made: its history after the previous history's length. */
export function toolCallsOf(
  answer: AgentAnswer,
  previousLength: number,
): ToolCallRecord[] {
  const added = answer.history.slice(previousLength);
  const results = new Map<string, ToolResultBlock>();
  for (const m of added)
    if (m.role === "user" && typeof m.content !== "string")
      for (const b of m.content)
        if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const calls: ToolCallRecord[] = [];
  for (const m of added) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "tool_use") continue;
      const u = b as ToolUse;
      const r = results.get(u.id);
      let result: unknown = null;
      if (r) {
        const text = resultText(r);
        try {
          result = JSON.parse(text);
        } catch {
          result = text;
        }
      }
      calls.push({
        id: u.id,
        name: u.name,
        input: u.input,
        result,
        is_error: r?.is_error === true,
      });
    }
  }
  return calls;
}

const check = (details: string[], ok: boolean | null): CheckResult => ({
  result: ok === null ? "n/a" : ok ? "pass" : "fail",
  details,
});

const listEq = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The parsed input of a call (defaults applied), or null when it does not parse. */
function parsedInput(c: ToolCallRecord): Record<string, unknown> | null {
  if (!(c.name in toolSchemas)) return null;
  const p = toolSchemas[c.name as ToolName].safeParse(c.input ?? {});
  return p.success ? (p.data as Record<string, unknown>) : null;
}

/**
 * The direct query of one tool call and the comparison with the tool's result: a list of mismatches (empty when
 * they agree), or null when the input does not parse (no query to compare with).
 */
async function compareDirect(
  c: ToolCallRecord,
  q: DataQueries,
): Promise<{ mismatches: string[]; what: string } | null> {
  const input = parsedInput(c);
  if (!input) return null;
  const r = rec(c.result);
  const n = (k: string) => Number(input[k]);
  const out: string[] = [];
  const cmp = (label: string, tool: unknown, direct: unknown) => {
    if (JSON.stringify(tool) !== JSON.stringify(direct))
      out.push(
        `${label}: tool ${JSON.stringify(tool)} ≠ direct ${JSON.stringify(direct)}`,
      );
  };
  const cmpList = (label: string, tool: string[], direct: string[]) => {
    if (!listEq(tool, direct))
      out.push(
        `${label} differ: tool [${tool.join(", ")}] ≠ direct [${direct.join(", ")}]`,
      );
  };
  let direct: () => Promise<string>;
  switch (c.name as ToolName) {
    case "resolve_place":
      direct = async () => {
        const d = await q.places.resolve({ name: String(input.name) });
        cmp("status", r.status, d.status);
        if (d.status === "resolved") {
          cmp("center", r.center, d.center);
          cmp("parcel_count", r.parcel_count, d.parcel_count);
          cmp("center_reliable", r.center_reliable, d.center_reliable);
        }
        if (d.status === "ambiguous")
          cmp(
            "candidates",
            arr(r.candidates).map((x) => rec(x).parcel_count),
            d.candidates.map((x) => x.parcel_count),
          );
        return `places.resolve: ${d.status}`;
      };
      break;
    case "search_aged_roofs":
      direct = async () => {
        const d = await q.parcels.search({
          lat: n("lat"),
          lon: n("lon"),
          radius_miles: n("radius_miles"),
          threshold_years: n("threshold_years"),
          offset: 0,
          limit: n("limit"),
        });
        cmp("count", r.count, d.count);
        cmpList(
          "parcel IDs",
          ids(r.items, "parcel_id"),
          d.items.map((x) => x.parcel_id),
        );
        return `parcels.search: count ${d.count}, ${d.items.length} IDs`;
      };
      break;
    case "long_open_permits":
      direct = async () => {
        const d = await q.permits.longOpen({
          lat: n("lat"),
          lon: n("lon"),
          radius_miles: n("radius_miles"),
          min_open_days: n("min_open_days"),
          ...(input.max_open_days !== undefined
            ? { max_open_days: n("max_open_days") }
            : {}),
          sort: "open_days",
          offset: 0,
          limit: n("limit"),
        });
        cmp("count", r.count, d.count);
        cmpList(
          "permit numbers",
          ids(r.items, "permit_number"),
          d.items.map((x) => x.permit_number),
        );
        cmpList(
          "parcel IDs",
          ids(r.items, "parcel_id"),
          d.items.map((x) => x.parcel_id),
        );
        return `permits.longOpen: count ${d.count}, ${d.items.length} IDs`;
      };
      break;
    case "parcel_detail":
      direct = async () => {
        const d = await q.parcels.detail({
          parcel_id: String(input.parcel_id),
        });
        cmp(
          "parcel_id",
          rec(r.property).parcel_id,
          String(d.property.parcel_id),
        );
        return `parcels.detail: ${String(d.property.parcel_id)}`;
      };
      break;
    case "parcel_permits":
      direct = async () => {
        const d = await q.permits.forParcel({
          parcel_id: String(input.parcel_id),
        });
        cmp(
          "permit_data_available",
          r.permit_data_available,
          d.permit_data_available === true,
        );
        cmpList(
          "permit numbers",
          ids(r.permits, "permit_number"),
          d.permits.map((x) => x.permit_number),
        );
        return `permits.forParcel: ${d.permits.length} permits`;
      };
      break;
    case "run_summary":
      direct = async () => {
        const d = await q.explorer.runSummary();
        cmp("run_id", rec(r.run).run_id, d.run.run_id ?? null);
        return `explorer.runSummary: ${String(d.run.run_id)}`;
      };
      break;
  }
  let what: string;
  try {
    what = await direct();
  } catch (err) {
    // A failed tool call agrees with a direct call that fails too.
    const msg = err instanceof Error ? err.message : String(err);
    return c.is_error
      ? { mismatches: [], what: `both failed (${msg})` }
      : {
          mismatches: [`the direct query failed (${msg}); the tool did not`],
          what: "direct query failed",
        };
  }
  if (c.is_error) out.unshift("the tool failed; the direct query did not");
  return { mismatches: out, what };
}

/** (i) Every tool call's count and IDs equal the direct query's. */
export async function checkCounts(
  calls: readonly ToolCallRecord[],
  queries: DataQueries,
): Promise<CheckResult> {
  if (!calls.length) return check(["no tool call"], true);
  const details: string[] = [];
  let ok = true;
  let compared = 0;
  for (const c of calls) {
    const cmp = await compareDirect(c, queries);
    if (!cmp) {
      details.push(`${c.name}: input does not parse; not compared`);
      continue;
    }
    compared++;
    if (cmp.mismatches.length) {
      ok = false;
      details.push(`${c.name}: ${cmp.mismatches.join("; ")}`);
    } else details.push(`${c.name}: equal (${cmp.what})`);
  }
  return check(details, compared ? ok : null);
}

/**
 * Parcel IDs a cited permit record links to, from the answer's own tool results (never from its text): a
 * long_open_permits item's parcel_id when the item's permit number is a cited permit record, and parcel_permits'
 * parcel_id when at least one of its permits is a cited permit record. The permit citation covers its parcel link.
 * Failed tool calls link nothing.
 */
export function linkedParcels(
  calls: readonly ToolCallRecord[],
  answer: AgentAnswer,
): Map<string, string> {
  const citedPermits = new Set(
    answer.records.filter((r) => r.kind === "permit").map((r) => r.id),
  );
  /** parcel ID → the cited permit number that links it. */
  const linked = new Map<string, string>();
  const link = (parcel: unknown, permit: unknown) => {
    if (
      typeof parcel === "string" &&
      typeof permit === "string" &&
      citedPermits.has(permit) &&
      !linked.has(parcel)
    )
      linked.set(parcel, permit);
  };
  for (const c of calls) {
    if (c.is_error) continue;
    const r = rec(c.result);
    if (c.name === "long_open_permits")
      for (const item of arr(r.items))
        link(rec(item).parcel_id, rec(item).permit_number);
    if (c.name === "parcel_permits")
      for (const permit of arr(r.permits))
        link(r.parcel_id, rec(permit).permit_number);
  }
  return linked;
}

/**
 * (ii) Every listed record cited: no unverified ID, and every ID in the text is among the records or is a parcel ID
 * a cited permit record links to (linkedParcels).
 */
export function checkCited(
  answer: AgentAnswer,
  calls: readonly ToolCallRecord[],
): CheckResult {
  const recorded = new Set(answer.records.map((r) => r.id));
  const linked = linkedParcels(calls, answer);
  const inText = idsInText(answer.text);
  const viaLink = inText.filter((id) => !recorded.has(id) && linked.has(id));
  const notCited = inText.filter((id) => !recorded.has(id) && !linked.has(id));
  const details = [
    answer.unverified_ids.length
      ? `unverified IDs: ${answer.unverified_ids.join(", ")}`
      : "no unverified ID",
    notCited.length
      ? `IDs in the text but not cited: ${notCited.join(", ")}`
      : `${inText.length} ID(s) in the text, all cited`,
    ...(viaLink.length
      ? [
          `cited through a permit record: ${viaLink.map((id) => `${id} (permit ${linked.get(id)!})`).join(", ")}`,
        ]
      : []),
  ];
  return check(details, !answer.unverified_ids.length && !notCited.length);
}

/** (iii) The expected gaps in the answer's gaps list, and mentioned in its text. */
export function checkGaps(
  answer: AgentAnswer,
  expected: EvalPrompt["expected"]["gaps"],
): { gaps: CheckResult; gaps_text: CheckResult } {
  if (!expected.length) {
    const none = check(["no gap expected"], null);
    return { gaps: none, gaps_text: none };
  }
  const listed = expected.map((id) => ({
    id,
    ok: answer.gaps.some((g) => GAPS[id].inGaps(g)),
  }));
  const said = expected.map((id) => ({
    id,
    ok: GAPS[id].inText.test(answer.text),
  }));
  return {
    gaps: check(
      listed.map((x) => `${x.id}: ${x.ok ? "listed" : "NOT in the gaps"}`),
      listed.every((x) => x.ok),
    ),
    gaps_text: check(
      said.map(
        (x) => `${x.id}: ${x.ok ? "mentioned" : "NOT mentioned in the text"}`,
      ),
      said.every((x) => x.ok),
    ),
  };
}

/** (iv) elapsed_ms < 30,000. */
export function checkElapsed(answer: AgentAnswer): CheckResult {
  const ok = answer.elapsed_ms < ELAPSED_LIMIT_MS;
  return check(
    [`${answer.elapsed_ms} ms ${ok ? "<" : "≥"} ${ELAPSED_LIMIT_MS} ms`],
    ok,
  );
}

/** The expected tools were called, one call of each with its expected input values. */
export function checkTools(
  calls: readonly ToolCallRecord[],
  expected: EvalPrompt["expected"],
): CheckResult {
  const details = [`called: ${calls.map((c) => c.name).join(", ") || "none"}`];
  let ok = true;
  for (const t of expected.tools) {
    if (!calls.some((c) => c.name === t)) {
      ok = false;
      details.push(`${t} not called`);
    }
  }
  for (const [tool, want] of Object.entries(expected.tool_inputs ?? {})) {
    if (!want) continue;
    const match = calls.some((c) => {
      if (c.name !== tool) return false;
      const input = parsedInput(c);
      return (
        input !== null &&
        Object.entries(want).every(([k, v]) =>
          typeof v === "number" && typeof input[k] === "number"
            ? same(input[k], v)
            : input[k] === v,
        )
      );
    });
    if (!match) {
      ok = false;
      details.push(`no ${tool} call with ${JSON.stringify(want)}`);
    }
  }
  if (!expected.tools.length && calls.length) {
    // A prompt that expects no tool (a refusal) fails on any call.
    ok = false;
    details.push("a tool was called although none was expected");
  }
  return check(details, ok);
}

/** Refused (zero model calls) when expected; answered otherwise. */
export function checkRefusal(
  answer: AgentAnswer,
  refused: boolean,
): CheckResult {
  const detail = `status ${answer.status}${answer.stopped_by ? ` (${answer.stopped_by})` : ""}, ${answer.usage.model_calls} model call(s)`;
  return check(
    [detail],
    refused
      ? answer.status === "refused" && answer.usage.model_calls === 0
      : answer.status === "answered",
  );
}

interface Resolution {
  status?: unknown;
  name?: unknown;
  basis?: unknown;
  center?: { lat: number; lon: number };
  center_reliable?: unknown;
  parcel_count?: unknown;
  raw_values?: unknown;
}

/** The place outcome (see placeSchema in prompts.ts). */
export function checkPlace(
  calls: readonly ToolCallRecord[],
  expected: EvalPrompt["expected"]["place"],
  previousArea: SessionArea | undefined,
): CheckResult {
  const resolutions = calls
    .filter((c) => c.name === "resolve_place" && !c.is_error)
    .map((c) => rec(c.result) as Resolution);
  const searches = calls
    .filter((c) => SEARCH_TOOLS.has(c.name))
    .map(parsedInput)
    .filter((x): x is Record<string, unknown> => x !== null);
  const at = (s: Record<string, unknown>, p: { lat: number; lon: number }) =>
    typeof s.lat === "number" &&
    typeof s.lon === "number" &&
    same(s.lat, p.lat) &&
    same(s.lon, p.lon);
  const details = [
    `resolve_place: ${resolutions.map((r) => `${String(r.name)} → ${String(r.status)}${r.status === "resolved" ? `${r.center_reliable === false ? " (unreliable)" : ""}, ${String(r.parcel_count)} parcels` : ""}`).join("; ") || "none"}`,
    `searches: ${searches.length}`,
  ];
  switch (expected.outcome) {
    case "none":
      return check(details, resolutions.length === 0);
    case "reused_previous_area": {
      if (!previousArea)
        return check([...details, "no previous search area"], false);
      details.push(
        `previous area ${previousArea.label}, ${previousArea.lat}, ${previousArea.lon}, ${previousArea.radius_miles} mi`,
      );
      return check(
        details,
        searches.length > 0 &&
          searches.every(
            (s) =>
              at(s, previousArea) &&
              typeof s.radius_miles === "number" &&
              same(s.radius_miles, previousArea.radius_miles),
          ),
      );
    }
    default:
      break;
  }
  const key = placeKey(expected.name);
  const mine = resolutions.filter(
    (r) => typeof r.name === "string" && placeKey(r.name) === key,
  );
  if (!mine.length)
    return check([...details, `no resolve_place for ${expected.name}`], false);
  switch (expected.outcome) {
    case "unknown":
      return check(
        details,
        mine.some((r) => r.status === "unknown") && searches.length === 0,
      );
    case "ambiguous/unreliable":
      return check(
        details,
        mine.some(
          (r) =>
            r.status === "ambiguous" ||
            (r.status === "resolved" && r.center_reliable === false),
        ) && searches.length === 0,
      );
    case "resolved": {
      const ok = mine.some(
        (r) =>
          r.status === "resolved" &&
          r.center_reliable === true &&
          r.center !== undefined &&
          (expected.jurisdiction === undefined ||
            (r.basis === "jurisdiction" &&
              arr(r.raw_values).includes(expected.jurisdiction))) &&
          (expected.parcel_count === undefined ||
            r.parcel_count === expected.parcel_count) &&
          searches.some((s) => at(s, r.center!)),
      );
      if (!ok)
        details.push(
          `want resolved${expected.jurisdiction ? `, jurisdiction ${expected.jurisdiction}` : ""}${expected.parcel_count ? `, ${expected.parcel_count} parcels` : ""}, reliable, and a search at its center`,
        );
      return check(details, ok);
    }
  }
}

/** All checks of one answer. */
export async function checkAnswer(args: {
  prompt: EvalPrompt;
  answer: AgentAnswer;
  /** The history length before this answer (its own tool calls come after). */
  previousLength: number;
  /** The session area before this answer (the previous answer's). */
  previousArea: SessionArea | undefined;
  queries: DataQueries;
}): Promise<{ checks: AnswerChecks; calls: ToolCallRecord[] }> {
  const { prompt, answer } = args;
  const calls = toolCallsOf(answer, args.previousLength);
  const gaps = checkGaps(answer, prompt.expected.gaps);
  return {
    calls,
    checks: {
      counts: await checkCounts(calls, args.queries),
      cited: checkCited(answer, calls),
      gaps: gaps.gaps,
      gaps_text: gaps.gaps_text,
      elapsed: checkElapsed(answer),
      tools: checkTools(calls, prompt.expected),
      refusal: checkRefusal(answer, prompt.expected.refused),
      place: checkPlace(calls, prompt.expected.place, args.previousArea),
    },
  };
}

/** True when no check failed. */
export const allPassed = (c: AnswerChecks): boolean =>
  CHECK_NAMES.every((n) => c[n].result !== "fail");
