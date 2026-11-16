/**
 * Checks of one eval answer:
 * - counts: for every tool call of the answer, the same query called directly with the same input (schema defaults
 *   applied, mapped the way the tool maps it) gives the same count and the same returned IDs in the same order;
 * - cited: unverified_ids is empty and every parcel ID or permit number in the answer text is cited: among its
 *   records, or a parcel ID a cited permit record links to (linkedParcels);
 * - gaps / gaps_text: each expected gap ID is in the answer's gaps list / mentioned in the answer text;
 * - elapsed: elapsed_ms < 30,000 (the API Gateway HTTP API's maximum integration timeout);
 * - tools, refusal, place: the prompt's expected tools (and input values), refusal (and which: the people guard
 *   or the no-tool-call rule) and place outcome;
 * - ownership: an answer through the ownership filter states its basis and weakness and never implies the owner
 *   is known;
 * - license_status: the answer text never says a contractor license expired or is invalid (nothing in the data
 *   states a license's status);
 * - contractors: every within-window permit the text names has its contractor named as the tool returned it;
 * - stated_counts: every number the text states for the rows it shows from a long-open list equals the rows of that
 *   list the text names (totals, such as how many match, are not such statements).
 */
import type { OwnershipBasis } from "@oracle-la/api/contract";
import {
  DEFAULT_MIN_OPEN_DAYS,
  DEFAULT_OWNERSHIP_BASIS,
  NOT_RUN_PREFIX,
  NO_TOOL_CALL_TEXT,
  OWNERSHIP_BASES,
  WITHIN_WINDOW_LIMIT,
  idsInText,
  ownershipRuleLine,
  placeKey,
  toolSchemas,
  type AgentAnswer,
  type AgentRequest,
  type DataQueries,
  type SessionArea,
  type ToolName,
} from "@oracle-la/agent";
import { GAPS, type EvalPrompt, type GapSpec } from "./prompts.ts";

/**
 * The API Gateway HTTP API's maximum integration timeout, in ms: "Maximum integration timeout | 30 seconds | No"
 * (AWS, "Quotas for configuring and running an HTTP API in API Gateway",
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html, read 2026-11-13).
 */
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
  "ownership",
  "license_status",
  "contractors",
  "stated_counts",
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
/** Equal at 5 decimals, the precision the agent outputs and states: both sides printed with toFixed(5). */
const same5 = (a: number, b: number) => a.toFixed(5) === b.toFixed(5);
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

/** One list of a long_open_permits result, with the max_open_days and limit its direct query uses. */
interface LongOpenList {
  name: string;
  r: Record<string, unknown>;
  max_open_days?: number;
  limit: number;
}

/**
 * The lists of a long_open_permits result: the result itself, or with with_contractor_window its labeled
 * longest_open list (the call's own max_open_days and limit) and, when it was listed, its within_contractor_window
 * list (the max_open_days the tool computed and stated; at most min(limit, WITHIN_WINDOW_LIMIT) permits).
 */
function longOpenLists(
  r: Record<string, unknown>,
  input: Record<string, unknown>,
): LongOpenList[] {
  const own =
    typeof input.max_open_days === "number" ? input.max_open_days : undefined;
  const limit = Number(input.limit);
  if (input.with_contractor_window !== true)
    return [{ name: "", r, max_open_days: own, limit }];
  const lists: LongOpenList[] = [
    { name: "longest_open", r: rec(r.longest_open), max_open_days: own, limit },
  ];
  const w = rec(r.within_contractor_window);
  if (typeof w.max_open_days === "number")
    lists.push({
      name: "within_contractor_window",
      r: w,
      max_open_days: w.max_open_days,
      limit: Math.min(limit, WITHIN_WINDOW_LIMIT),
    });
  return lists;
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
        // With the ownership filter on, the basis the tool sends ("both" unless one is named; tools.ts).
        const filter = {
          lat: n("lat"),
          lon: n("lon"),
          radius_miles: n("radius_miles"),
          threshold_years: n("threshold_years"),
          ...(input.ownership_filter === true
            ? {
                ownership_basis:
                  (input.ownership_basis as OwnershipBasis | undefined) ??
                  DEFAULT_OWNERSHIP_BASIS,
              }
            : {}),
        };
        if (input.long_open_permit === true) {
          // The long-open filter: the parcels parcels.points marks long-open (the CRM legend's count), nearest
          // first, and the first `limit` of them.
          const p = await q.parcels.points({
            ...filter,
            min_open_days: DEFAULT_MIN_OPEN_DAYS,
          });
          // A parcel with a long-open mark has permit data; with no parcel that has permit data or a mark, not
          // available (null), never 0.
          const covered = p.permit_data_available.filter(
            (m, i) => m === 1 || p.long_open_permit[i] === 1,
          ).length;
          const available = p.id.length === 0 || covered > 0;
          const marked = p.id.filter((_, i) => p.long_open_permit[i] === 1);
          cmp("count", r.count, available ? marked.length : null);
          cmp("long_open_permit unit", rec(r.long_open_permit).unit, "parcels");
          cmp(
            "long_open_permit status",
            rec(r.long_open_permit).status,
            available ? "available" : "not_available",
          );
          cmp(
            "long_open_permit with_permit_data",
            rec(r.long_open_permit).with_permit_data,
            covered,
          );
          cmpList(
            "parcel IDs",
            ids(r.items, "parcel_id"),
            marked.slice(0, n("limit")),
          );
          return available
            ? `parcels.points: ${marked.length} of ${p.count} parcels marked long-open, ${Math.min(marked.length, n("limit"))} IDs`
            : `parcels.points: none of the ${p.id.length} parcels checked of ${p.count} has permit data, count not available`;
        }
        const d = await q.parcels.search({
          ...filter,
          offset: 0,
          limit: n("limit"),
        });
        cmp("count", r.count, d.count);
        cmpList(
          "parcel IDs",
          ids(r.items, "parcel_id"),
          d.items.map((x) => x.parcel_id),
        );
        // The matching parcels without permit data (nor a long-open mark), as the result states them (absent: none),
        // from the points; with truncated points, the nearest checked of how many match.
        const p = await q.parcels.points({
          ...filter,
          min_open_days: DEFAULT_MIN_OPEN_DAYS,
        });
        const without = p.permit_data_available.filter(
          (m, i) => m === 0 && p.long_open_permit[i] !== 1,
        ).length;
        cmp(
          "permit_data without_permit_data",
          rec(r.permit_data).without_permit_data ?? 0,
          without,
        );
        if (p.truncated) {
          cmp("permit_data checked", rec(r.permit_data).checked, p.id.length);
          cmp("permit_data matched", rec(r.permit_data).matched, p.count);
          cmp("permit_data complete", rec(r.permit_data).complete, false);
        }
        return `parcels.search: count ${d.count}, ${d.items.length} IDs; parcels.points: ${without} of ${p.id.length} checked without permit data`;
      };
      break;
    case "long_open_permits":
      direct = async () => {
        // Each list of the result (with with_contractor_window, the labeled longest-open and within-window lists)
        // against its own direct query.
        const said: string[] = [];
        for (const list of longOpenLists(r, input)) {
          const d = await q.permits.longOpen({
            lat: n("lat"),
            lon: n("lon"),
            radius_miles: n("radius_miles"),
            min_open_days: n("min_open_days"),
            ...(list.max_open_days !== undefined
              ? { max_open_days: list.max_open_days }
              : {}),
            sort: "open_days",
            offset: 0,
            limit: list.limit,
          });
          const tag = list.name ? `${list.name} ` : "";
          cmp(`${tag}count`, list.r.count, d.count);
          cmpList(
            `${tag}permit numbers`,
            ids(list.r.items, "permit_number"),
            d.items.map((x) => x.permit_number),
          );
          cmpList(
            `${tag}parcel IDs`,
            ids(list.r.items, "parcel_id"),
            d.items.map((x) => x.parcel_id),
          );
          said.push(
            `permits.longOpen${list.name ? ` (${list.name})` : ""}: count ${d.count}, ${d.items.length} IDs`,
          );
        }
        return said.join("; ");
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

/**
 * A tool call the agent closed without running it because the answer stopped (its result is the agent's "not run:
 * the answer stopped (<reason>)" text): there is no tool result to compare.
 */
const notRun = (c: ToolCallRecord): boolean =>
  c.is_error &&
  typeof c.result === "string" &&
  c.result.startsWith(NOT_RUN_PREFIX);

/**
 * (i) Every tool call's count and IDs equal the direct query's. A call the answer closed without running it is
 * reported as not run and not compared; the stop itself fails the answer through the refusal (status) check.
 */
export async function checkCounts(
  calls: readonly ToolCallRecord[],
  queries: DataQueries,
): Promise<CheckResult> {
  if (!calls.length) return check(["no tool call"], true);
  const details: string[] = [];
  let ok = true;
  let compared = 0;
  for (const c of calls) {
    if (notRun(c)) {
      details.push(`${c.name}: not run (the answer stopped); not compared`);
      continue;
    }
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
      for (const list of longOpenLists(r, parsedInput(c) ?? {}))
        for (const item of arr(list.r.items))
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

/** The expected place's name, when the prompt names a place. */
const placeNameOf = (
  place: EvalPrompt["expected"]["place"],
): string | undefined => ("name" in place ? place.name : undefined);

/**
 * (iii) The expected gaps in the answer's gaps list, and mentioned in its text (a gap's text pattern may depend on
 * the prompt's expected place name).
 */
export function checkGaps(
  answer: AgentAnswer,
  expected: EvalPrompt["expected"]["gaps"],
  placeName?: string,
): { gaps: CheckResult; gaps_text: CheckResult } {
  if (!expected.length) {
    const none = check(["no gap expected"], null);
    return { gaps: none, gaps_text: none };
  }
  const listed = expected.map((id) => ({
    id,
    ok: answer.gaps.some((g) => GAPS[id].inGaps(g)),
  }));
  const said = expected.map((id) => {
    const spec: GapSpec = GAPS[id];
    const re =
      typeof spec.inText === "function" ? spec.inText(placeName) : spec.inText;
    return { id, ok: re.test(answer.text) };
  });
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

/**
 * The expected tools were called, one call of each with its expected input values, and no forbidden tool was
 * called. A prompt with no expected tool and no forbidden_tools (a refusal) fails on any call.
 */
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
  for (const t of expected.forbidden_tools ?? []) {
    const n = calls.filter((c) => c.name === t).length;
    if (n) {
      ok = false;
      details.push(`forbidden tool ${t} called (${n} call(s))`);
    }
  }
  if (!expected.tools.length && !expected.forbidden_tools && calls.length) {
    // A prompt that expects no tool and lists no forbidden tool (a refusal) fails on any call.
    ok = false;
    details.push("a tool was called although none was expected");
  }
  return check(details, ok);
}

/**
 * Refused when expected, answered otherwise. A people-guard refusal (the default) makes zero model calls; a
 * no-tool-call refusal shows the fixed text (NO_TOOL_CALL_TEXT), whatever the model wrote.
 */
export function checkRefusal(
  answer: AgentAnswer,
  expected: Pick<EvalPrompt["expected"], "refused" | "refusal">,
): CheckResult {
  const detail = `status ${answer.status}${answer.refused_by ? ` (${answer.refused_by})` : ""}${answer.stopped_by ? ` (${answer.stopped_by})` : ""}, ${answer.usage.model_calls} model call(s)`;
  if (!expected.refused) return check([detail], answer.status === "answered");
  const kind = expected.refusal ?? "people_guard";
  return check(
    [`${detail}; want refused by ${kind}`],
    answer.status === "refused" &&
      answer.refused_by === kind &&
      (kind === "people_guard"
        ? answer.usage.model_calls === 0
        : answer.text === NO_TOOL_CALL_TEXT),
  );
}

/**
 * What an answer's text must say for each ownership basis (ownership.ts OWNERSHIP_TEXTS): the basis (recorded
 * documents, reassessment, or both) and its weakness (a refinance or a lien resets "recording" and "both"; a
 * transfer that does not reassess escapes "base_year"), in the model's own words.
 */
const RECORDING =
  /\brecord(?:ed|ing|s)?\b[^.!?\n]{0,60}\b(?:documents?|deeds?|transfers?)\b|\b(?:documents?|deeds?)\b[^.!?\n]{0,60}\brecord(?:ed|ing)\b/i;
const REASSESSMENT = /\breassess|\bbase[\s-]year/i;
export const OWNERSHIP_TEXT_CHECKS: Record<
  (typeof OWNERSHIP_BASES)[number],
  { basis: readonly RegExp[]; weakness: RegExp }
> = {
  recording: { basis: [RECORDING], weakness: /refinanc|\blien/i },
  base_year: {
    basis: [REASSESSMENT],
    weakness:
      /spouse|parent|child|(?:do|does|did)(?:n['’]t| not) (?:trigger (?:a )?)?reassess|without (?:a )?reassess/i,
  },
  both: { basis: [RECORDING, REASSESSMENT], weakness: /refinanc|\blien/i },
};
/** Text that names an owner: "owned by Jane Doe", "the owner is Smith Trust", "owner's name is ...". */
export const OWNER_NAMED =
  /\b(?:[Oo]wned by|[Oo]wners? (?:is|are)|[Oo]wner['’]?s? names? (?:is|are))\s+(?!The same\b|Not\b|Unknown\b)[A-Z][a-z]/;

/**
 * (v) With expected.ownership: a search_aged_roofs call with the ownership filter that returned its basis; the
 * reasoning states that basis's rule line (deterministic); the text states the basis and its weakness; and no text
 * names an owner. n/a without the expectation.
 */
export function checkOwnership(
  answer: AgentAnswer,
  calls: readonly ToolCallRecord[],
  expected: EvalPrompt["expected"],
): CheckResult {
  if (!expected.ownership) return check(["no ownership expected"], null);
  const filtered = calls
    .filter((c) => c.name === "search_aged_roofs" && !c.is_error)
    .filter((c) => parsedInput(c)?.ownership_filter === true)
    .map((c) => rec(rec(c.result).ownership).basis)
    .filter((b): b is (typeof OWNERSHIP_BASES)[number] =>
      (OWNERSHIP_BASES as readonly unknown[]).includes(b),
    );
  const basis = filtered[0];
  if (basis === undefined)
    return check(
      ["no search_aged_roofs call with the ownership filter"],
      false,
    );
  const want = OWNERSHIP_TEXT_CHECKS[basis];
  const ruleLine = answer.reasoning.includes(ownershipRuleLine(basis));
  const basisSaid = want.basis.every((re) => re.test(answer.text));
  const weaknessSaid = want.weakness.test(answer.text);
  const named = OWNER_NAMED.exec(answer.text)?.[0];
  return check(
    [
      `basis ${basis}`,
      `rule line ${ruleLine ? "in the reasoning" : "NOT in the reasoning"}`,
      `basis ${basisSaid ? "stated" : "NOT stated"} in the text`,
      `weakness ${weaknessSaid ? "stated" : "NOT stated"} in the text`,
      named ? `the text names an owner: "${named}"` : "no owner named",
    ],
    ruleLine && basisSaid && weaknessSaid && !named,
  );
}

/**
 * A license status claim: "license" and an expiry or invalidity word in one sentence (no . ! ? or line break
 * between them), in either order. The tools return no expiration date and nothing is checked against the state
 * license board, so no answer can know a license's status.
 */
export const LICENSE_STATUS_CLAIM =
  /\blicen[cs]es?\b[^.!?\n]*?\b(?:expir\w*|invalid|lapsed|inactive|revoked|suspended)\b|\b(?:expir\w*|invalid|lapsed|inactive|revoked|suspended)\b[^.!?\n]*?\blicen[cs]es?\b/i;

/** (vi) With expected.no_license_status: the text makes no license status claim. n/a without the expectation. */
export function checkLicenseStatus(
  answer: AgentAnswer,
  expected: EvalPrompt["expected"],
): CheckResult {
  if (!expected.no_license_status)
    return check(["no license status expectation"], null);
  const claim = LICENSE_STATUS_CLAIM.exec(answer.text)?.[0];
  return check(
    [
      claim
        ? `the text states a license status: "${claim}"`
        : "no license status stated",
    ],
    claim === undefined,
  );
}

/** Upper case letters and digits only: "A - 1 All-American Roofing, Inc." → "A1ALLAMERICANROOFINGINC". */
const squash = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** What the text must say for a within-window permit, per contractor status (tools.ts ContractorStatus). */
export const CONTRACTOR_STATUS_TEXT: Record<string, RegExp> = {
  "owner-builder": /owner[\s-]?builder/i,
  "none stated":
    /\bno contractor\b|\bnone (?:stated|listed|named)\b|\bnot (?:stated|listed|named)\b|\bno (?:license|contractor row)/i,
  "after the contractor window":
    /\bno contractor\b|\bafter\b[^.!?\n]*\bwindow\b|\bnot (?:stated|listed|named)\b/i,
  "not read":
    /\bnot read\b|\bcould(?:n['’]t| not) be read\b|\bunavailable\b|\bnot available\b|\bfailed\b/i,
};

/**
 * (vii) With expected.contractors_named: a long_open_permits call with
 * with_contractor_window listed the within-window permits; the text names at least one of them; and for each one it
 * names, the text from that permit number to the next listed permit number names its contractor: for a named one a
 * business or canonical name (letters and digits compared) or a license number of its rows; otherwise its status in
 * words (owner-builder, no contractor stated, not read). n/a without the expectation.
 */
export function checkContractors(
  answer: AgentAnswer,
  calls: readonly ToolCallRecord[],
  expected: EvalPrompt["expected"],
): CheckResult {
  if (!expected.contractors_named)
    return check(["no contractor expectation"], null);
  const items = calls
    .filter(
      (c) =>
        c.name === "long_open_permits" &&
        !c.is_error &&
        parsedInput(c)?.with_contractor_window === true,
    )
    .flatMap((c) => arr(rec(rec(c.result).within_contractor_window).items))
    .map(rec)
    .filter((it) => typeof it.permit_number === "string");
  if (!items.length)
    return check(
      ["no within-window list (long_open_permits with with_contractor_window)"],
      false,
    );
  const text = answer.text;
  const at = items
    .map((it) => ({ it, i: text.indexOf(String(it.permit_number)) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i);
  if (!at.length)
    return check(
      [
        `none of the ${items.length} within-window permits is named in the text`,
      ],
      false,
    );
  const details: string[] = [];
  let ok = true;
  // A permit's part of the text: from the start of its line (or the permit number, when the previous listed permit is
  // on the same line) to the start of the next listed permit's line (or that permit number, on the same line).
  const lineStart = (i: number) => text.lastIndexOf("\n", i - 1) + 1;
  at.forEach(({ it, i }, k) => {
    const prev = at[k - 1];
    const next = at[k + 1];
    const start = prev && lineStart(i) <= prev.i ? i : lineStart(i);
    const end = !next
      ? text.length
      : lineStart(next.i) > i
        ? lineStart(next.i)
        : next.i;
    const segment = text.slice(start, end);
    const status = String(it.contractor_status);
    const rows = arr(it.contractors).map(rec);
    const named =
      status === "named"
        ? rows.some((c) =>
            [
              c.contractors_business_name,
              c.canonical_business_name,
              c.license_identifier,
            ].some(
              (v) =>
                typeof v === "string" &&
                squash(v).length > 0 &&
                squash(segment).includes(squash(v)),
            ),
          )
        : (CONTRACTOR_STATUS_TEXT[status]?.test(segment) ?? false);
    if (!named) ok = false;
    details.push(
      `${String(it.permit_number)} (${status}): ${named ? "contractor named" : "contractor NOT named"}`,
    );
  });
  return check(
    [
      `${at.length} of ${items.length} within-window permits named in the text`,
      ...details,
    ],
    ok,
  );
}

/** Number words a stated count may use. */
const COUNT_WORDS: Record<string, number> = {
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
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  "twenty-five": 25,
};
const COUNT = String.raw`(\d{1,3}(?:,\d{3})*|${Object.keys(COUNT_WORDS).join("|")})`;
/** Not a count of rows: a duration, distance or share follows the number. */
const NOT_ROWS = String.raw`(?![\s-]*(?:%|percent\b|days?\b|years?\b|miles?\b|mi\b))`;
/**
 * Statements of how many rows the text shows from a list, each with the number in group 1: "the 5 longest", "the
 * top 10", "showing 10", "lists 5", "Only 10 permits are shown", "the 10 longest-open permits in that window are
 * below", "here are 5". A total ("2,309 permits match", "2,039 of the 2,309") is none of these.
 */
export const STATED_COUNT_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:the|these|those)\s+(?:top\s+|first\s+)?${COUNT}(?=[\s-]+(?:longest|oldest)\b)`,
    "gi",
  ),
  new RegExp(String.raw`\b(?:top|first)\s+${COUNT}\b${NOT_ROWS}`, "gi"),
  new RegExp(
    String.raw`\b(?:showing|shows?|shown|listing|lists?|listed)\s+(?:here\s+)?(?:only\s+)?(?:the\s+)?(?:top\s+|first\s+)?${COUNT}\b${NOT_ROWS}`,
    "gi",
  ),
  new RegExp(
    String.raw`\b${COUNT}\b${NOT_ROWS}\s+(?:[\w'’-]+\s+){0,5}?(?:are|is)\s+(?:only\s+)?(?:shown|listed|below|included)\b`,
    "gi",
  ),
  new RegExp(
    String.raw`\b(?:here|below)\s+are\s+(?:only\s+)?(?:the\s+)?(?:top\s+|first\s+)?${COUNT}\b${NOT_ROWS}`,
    "gi",
  ),
];

/** A statement of how many rows the text shows, with its sentence and where its number is. */
export interface StatedCount {
  /** The matched words. */
  said: string;
  count: number;
  /** Index of the number in the text. */
  at: number;
  sentence: string;
}

const countValue = (token: string): number =>
  COUNT_WORDS[token.toLowerCase()] ?? Number(token.replace(/,/g, ""));

/** Every statement of rows shown in the text, in order, each number once (in its longest matched wording). */
export function statedCounts(text: string): StatedCount[] {
  const byAt = new Map<number, StatedCount>();
  for (const re of STATED_COUNT_PATTERNS)
    for (const m of text.matchAll(new RegExp(re.source, `${re.flags}d`))) {
      const token = m[1]!;
      const at = m.indices![1]![0];
      // The same number matched again: keep the longest wording.
      const seen = byAt.get(at);
      if (seen) {
        if (m[0].length > seen.said.length) seen.said = m[0];
        continue;
      }
      // The sentence: from the previous sentence end or line break to the next.
      const before = text.slice(0, at);
      const start = Math.max(
        0,
        before.lastIndexOf("\n") + 1,
        ...[". ", "! ", "? "].map((e) => {
          const i = before.lastIndexOf(e);
          return i < 0 ? 0 : i + 2;
        }),
      );
      const rest = text.slice(at);
      const end = rest.search(/[.!?](?=\s|$)|\n/);
      byAt.set(at, {
        said: m[0],
        count: countValue(token),
        at,
        sentence: text.slice(start, end < 0 ? undefined : at + end + 1).trim(),
      });
    }
  return [...byAt.values()].sort((a, b) => a.at - b.at);
}

const LIST_LABEL: Record<string, string> = {
  "": "long-open list",
  longest_open: "longest-open list",
  within_contractor_window: "within-window list",
};

/**
 * (viii) With expected.stated_counts: every statement of how many rows the text shows from a long-open list (see
 * STATED_COUNT_PATTERNS; never a total) equals the rows of that list the text names (its permit numbers in the
 * text). The list a statement is about: "per list", "each list" or "both lists" means every list; "window" the
 * within-window list; "overall" or "any issue date" the longest-open list; otherwise the list whose first named row
 * follows the statement most closely (else the one whose last named row precedes it). n/a without the expectation.
 */
export function checkStatedCounts(
  answer: AgentAnswer,
  calls: readonly ToolCallRecord[],
  expected: EvalPrompt["expected"],
): CheckResult {
  if (!expected.stated_counts)
    return check(["no stated-count expectation"], null);
  const text = answer.text;
  const lists = calls
    .filter((c) => c.name === "long_open_permits" && !c.is_error)
    .flatMap((c) => longOpenLists(rec(c.result), parsedInput(c) ?? {}))
    .map((l) => {
      const at = ids(l.r.items, "permit_number")
        .map((p) => text.indexOf(p))
        .filter((i) => i >= 0);
      return {
        name: l.name,
        label: LIST_LABEL[l.name] ?? l.name,
        shown: at.length,
        first: at.length ? Math.min(...at) : -1,
        last: at.length ? Math.max(...at) : -1,
      };
    });
  const statements = statedCounts(text);
  if (!lists.length)
    return check(
      [
        "no long-open list in the answer's tool results",
        ...statements.map((s) => `"${s.said}": no list to compare with`),
      ],
      statements.length ? false : null,
    );
  const details = lists.map(
    (l) => `${l.label}: ${l.shown} row(s) named in the text`,
  );
  if (!statements.length)
    return check([...details, "no statement of rows shown"], true);
  let ok = true;
  for (const s of statements) {
    const sentence = s.sentence.toLowerCase();
    let about: typeof lists;
    if (/\b(?:per|each|both)\s+lists?\b/.test(sentence)) about = lists;
    else if (
      /\bwindow\b/.test(sentence) &&
      lists.some((l) => l.name === "within_contractor_window")
    )
      about = lists.filter((l) => l.name === "within_contractor_window");
    else if (
      /\b(?:overall|any issue date|any date)\b/.test(sentence) &&
      lists.some((l) => l.name === "longest_open")
    )
      about = lists.filter((l) => l.name === "longest_open");
    else {
      const after = lists
        .filter((l) => l.first > s.at)
        .sort((a, b) => a.first - b.first)[0];
      const before = lists
        .filter((l) => l.last >= 0 && l.last < s.at)
        .sort((a, b) => b.last - a.last)[0];
      about = [after ?? before ?? lists[0]!];
    }
    for (const l of about) {
      const equal = s.count === l.shown;
      if (!equal) ok = false;
      details.push(
        `"${s.said}" (${s.count}) → ${l.label}, ${l.shown} row(s) shown: ${equal ? "equal" : "NOT equal"}`,
      );
    }
  }
  return check(details, ok);
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
  // resolve_required false (prompt i): with no resolve_place call for the name the place check is skipped (n/a);
  // any search is then judged only by the expected and forbidden tools. A call made is checked as below.
  if (
    !mine.length &&
    expected.outcome === "resolved" &&
    expected.resolve_required === false
  )
    return check(
      [
        ...details,
        `no resolve_place for ${expected.name}: allowed, not required (resolve_required false), so the place check is skipped`,
      ],
      null,
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
      const searchRequired = expected.search_required !== false;
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
          // At its center: equal when both round to the same 5-decimal value. With search_required false, no
          // search passes; a search that was made must still be at the center.
          ((!searchRequired && searches.length === 0) ||
            searches.some(
              (s) =>
                typeof s.lat === "number" &&
                typeof s.lon === "number" &&
                same5(s.lat, r.center!.lat) &&
                same5(s.lon, r.center!.lon),
            )),
      );
      if (!ok)
        details.push(
          `want resolved${expected.jurisdiction ? `, jurisdiction ${expected.jurisdiction}` : ""}${expected.parcel_count ? `, ${expected.parcel_count} parcels` : ""}, reliable, and ${searchRequired ? "a search" : "no search or a search"} at its center`,
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
  const gaps = checkGaps(
    answer,
    prompt.expected.gaps,
    placeNameOf(prompt.expected.place),
  );
  return {
    calls,
    checks: {
      counts: await checkCounts(calls, args.queries),
      cited: checkCited(answer, calls),
      gaps: gaps.gaps,
      gaps_text: gaps.gaps_text,
      elapsed: checkElapsed(answer),
      tools: checkTools(calls, prompt.expected),
      refusal: checkRefusal(answer, prompt.expected),
      place: checkPlace(calls, prompt.expected.place, args.previousArea),
      ownership: checkOwnership(answer, calls, prompt.expected),
      license_status: checkLicenseStatus(answer, prompt.expected),
      contractors: checkContractors(answer, calls, prompt.expected),
      stated_counts: checkStatedCounts(answer, calls, prompt.expected),
    },
  };
}

/** True when no check failed. */
export const allPassed = (c: AnswerChecks): boolean =>
  CHECK_NAMES.every((n) => c[n].result !== "fail");
