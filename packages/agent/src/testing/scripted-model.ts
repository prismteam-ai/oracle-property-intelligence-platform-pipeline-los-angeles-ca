/**
 * ScriptedModel: a deterministic ModelClient for tests (design brief §8). It returns scripted Anthropic.Message
 * values in order, records every request (deep-copied, so later history growth does not change it), and throws
 * when the script runs out. No network, no SDK client.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelCallOptions, ModelClient } from "../model-client.ts";

export interface RecordedRequest {
  params: Anthropic.MessageCreateParamsNonStreaming;
  opts: ModelCallOptions;
}

/** A scripted reply, an error to throw, or a function of the request (for replies that read the request). */
export type ScriptStep =
  | Anthropic.Message
  | Error
  | ((
      params: Anthropic.MessageCreateParamsNonStreaming,
      opts: ModelCallOptions,
    ) => Anthropic.Message | Error);

export class ScriptOverrunError extends Error {
  constructor(calls: number) {
    super(`ScriptedModel: no scripted step left for call ${calls}`);
    this.name = "ScriptOverrunError";
  }
}

export class ScriptedModel implements ModelClient {
  readonly requests: RecordedRequest[] = [];
  private readonly steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.steps = [...steps];
  }

  get remaining(): number {
    return this.steps.length;
  }

  async create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    opts: ModelCallOptions,
  ): Promise<Anthropic.Message> {
    const { signal, ...rest } = opts;
    this.requests.push({
      params: structuredClone(params),
      opts: signal ? { ...rest, signal } : rest,
    });
    const step = this.steps.shift();
    if (step === undefined) throw new ScriptOverrunError(this.requests.length);
    const out = typeof step === "function" ? step(params, opts) : step;
    if (out instanceof Error) throw out;
    return structuredClone(out);
  }
}

const usageOf = (input = 100, output = 50): Anthropic.Usage => ({
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  input_tokens: input,
  output_tokens: output,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
});

let seq = 0;

/** A complete Message with the given content and stop reason. */
export function message(
  content: Anthropic.ContentBlock[],
  stop_reason: Anthropic.StopReason,
  usage: { input?: number; output?: number } = {},
): Anthropic.Message {
  seq += 1;
  return {
    id: `msg_scripted_${seq}`,
    container: null,
    content,
    diagnostics: null,
    model: "scripted",
    role: "assistant",
    stop_details: null,
    stop_reason,
    stop_sequence: null,
    type: "message",
    usage: usageOf(usage.input, usage.output),
  };
}

export const textBlock = (text: string): Anthropic.TextBlock => ({
  type: "text",
  text,
  citations: null,
});

export function toolUseBlock(
  name: string,
  input: Record<string, unknown>,
  id = `toolu_${name}_${(seq += 1)}`,
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

/** A final text answer (stop_reason end_turn). */
export const textReply = (
  text: string,
  usage?: { input?: number; output?: number },
): Anthropic.Message => message([textBlock(text)], "end_turn", usage);

/** One round of tool calls (stop_reason tool_use). */
export const toolReply = (
  calls: Array<{ name: string; input: Record<string, unknown> }>,
  usage?: { input?: number; output?: number },
): Anthropic.Message =>
  message(
    calls.map((c) => toolUseBlock(c.name, c.input)),
    "tool_use",
    usage,
  );

/** The latest tool_result content of a tool, parsed, from a request's messages (for steps that read results). */
export function lastToolResult(
  params: Anthropic.MessageCreateParamsNonStreaming,
  toolName: string,
): unknown {
  const ids = new Map<string, string>();
  let found: unknown;
  for (const m of params.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") ids.set(b.id, b.name);
      if (
        b.type === "tool_result" &&
        ids.get(b.tool_use_id) === toolName &&
        typeof b.content === "string"
      )
        found = JSON.parse(b.content);
    }
  }
  return found;
}
