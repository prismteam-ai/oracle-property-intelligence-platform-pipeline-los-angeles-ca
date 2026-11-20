/**
 * The one structured log line per request: counts, tokens, cost, timings and outcome.
 * Built field by field from this allowlist, never by spreading a request or an answer. Never logged: the question,
 * the history, the answer text or markdown, the reasoning and assumptions, tool inputs (coordinates, parcel IDs)
 * and tool results, the center or its label, the bearer token or any header, the key or the signing secret, and
 * error messages (only class names). Kit: "NEVER log passwords, tokens, secrets, or PII"
 * (apply-engineering-guidelines/rules/observability-logging-tracing.md).
 */
import type { AgentAnswer } from "@oracle-la/agent";

type Message = AgentAnswer["history"][number];

export interface AgentLogLine {
  request_id: string;
  route: string;
  http_status: number;
  /** The authorizer's client name ("crm" | "explorer"), or null when none was passed. */
  client: string | null;
  cold_start: boolean;
  /** answered | refused | stopped, or the request's own outcome (invalid, too_large, not_configured, ...). */
  status: string;
  refused_by: string | null;
  stopped_by: string | null;
  /** A class name only (model SDK error, SSM error, ...), never a message. */
  error_class: string | null;
  provider: string | null;
  model_id: string | null;
  effort: string | null;
  model_calls: number;
  tool_calls: number;
  /** Tool name and outcome per call, e.g. ["resolve_place:ok", "long_open_permits:error"]; no inputs. */
  tool_names_ok: string[];
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  /** Estimated spend of the answer's model calls (models.ts prices); null when the model has no recorded price. */
  usd_estimate: number | null;
  elapsed_ms: number;
  question_chars: number | null;
  history_messages: number | null;
  /** Size of the request body in bytes (the history is most of it). */
  history_bytes: number | null;
  records_cited: number;
  gaps_count: number;
  unverified_ids_count: number;
  /** true: a signed history matched; false: refused as unsigned or altered; null: no history was sent. */
  history_signature_ok: boolean | null;
}

/** A line with every count at zero, for requests refused before an answer. */
export function emptyLine(
  base: Pick<AgentLogLine, "request_id" | "route" | "client" | "cold_start">,
): AgentLogLine {
  return {
    ...base,
    http_status: 0,
    status: "",
    refused_by: null,
    stopped_by: null,
    error_class: null,
    provider: null,
    model_id: null,
    effort: null,
    model_calls: 0,
    tool_calls: 0,
    tool_names_ok: [],
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    usd_estimate: null,
    elapsed_ms: 0,
    question_chars: null,
    history_messages: null,
    history_bytes: null,
    records_cited: 0,
    gaps_count: 0,
    unverified_ids_count: 0,
    history_signature_ok: null,
  };
}

/**
 * "<tool>:ok" or "<tool>:error" for each tool call the answer added to the history (after the `previous` messages
 * it came with); names only.
 */
export function toolNamesOk(
  history: readonly Message[],
  previous: number,
): string[] {
  const added = history.slice(previous);
  const errors = new Map<string, boolean>();
  for (const m of added)
    if (m.role === "user" && typeof m.content !== "string")
      for (const b of m.content)
        if (b.type === "tool_result")
          errors.set(b.tool_use_id, b.is_error === true);
  const out: string[] = [];
  for (const m of added)
    if (m.role === "assistant" && typeof m.content !== "string")
      for (const b of m.content)
        if (b.type === "tool_use")
          out.push(`${b.name}:${errors.get(b.id) ? "error" : "ok"}`);
  return out;
}

/** The answer's counts for the line (never its text). */
export function answerCounts(
  a: AgentAnswer,
): Pick<
  AgentLogLine,
  | "status"
  | "refused_by"
  | "stopped_by"
  | "model_calls"
  | "tool_calls"
  | "records_cited"
  | "gaps_count"
  | "unverified_ids_count"
> & { error_class: string | null } {
  return {
    status: a.status,
    refused_by: a.refused_by ?? null,
    stopped_by: a.stopped_by ?? null,
    error_class: a.error ?? null,
    model_calls: a.usage.model_calls,
    tool_calls: a.usage.tool_calls,
    records_cited: a.records.length,
    gaps_count: a.gaps.length,
    unverified_ids_count: a.unverified_ids.length,
  };
}
