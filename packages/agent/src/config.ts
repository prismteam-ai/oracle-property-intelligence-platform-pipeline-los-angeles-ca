/**
 * Agent configuration from the environment, validated with zod. No default picks a model or a
 * provider. Secrets are not part of the configuration: the Anthropic key file's path is not read from the
 * environment either; the caller passes it (the eval's required --key-file option) and the model client factory
 * reads the file (key-file.ts, model-client.ts). No key is read from the environment.
 */
import { z } from "zod";
import {
  MODEL_KEYS,
  PROVIDERS,
  modelId,
  type ModelKey,
  type Provider,
} from "./models.ts";

/**
 * Upper bound of the time budget. The API Gateway HTTP API "Maximum integration timeout | 30 seconds | No" (AWS,
 * "Quotas for configuring and running an HTTP API in API Gateway",
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html, read 2026-11-13) leaves 2 s
 * for Lambda start and tool overhead.
 */
export const MAX_TIME_BUDGET_MS = 28_000;
/** Lower bound: the loop keeps a 1,500 ms reserve before every model call, so a smaller budget never calls it. */
export const MIN_TIME_BUDGET_MS = 2_000;

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The settings runAgent needs (also usable without the environment, e.g. in tests). */
export interface AgentSettings {
  /** The provider-specific model ID sent in each request. */
  modelId: string;
  /** Tool rounds before the final, tool-free turn (1..10). */
  maxToolTurns: number;
  /** Input + output tokens summed over the whole answer. */
  maxTokens: number;
  /** max_tokens of one model call (shrunk to what maxTokens leaves after the call's estimated input; agent.ts). */
  maxOutputTokens: number;
  /** Wall-clock budget of one answer, in milliseconds (≤ 28,000). */
  timeBudgetMs: number;
  effort: Effort;
  /**
   * The provider the model client calls. With "anthropic" the system prompt and the tool definitions are marked for
   * prompt caching (agent.ts promptCacheParts); any other provider, or none, sends them unmarked.
   */
  provider?: Provider;
}

export interface AgentConfig extends AgentSettings {
  provider: Provider;
  model: ModelKey;
  /** Path of the Anthropic key file, as the caller gave it (used by provider "anthropic" only; never read here). */
  anthropicKeyFile?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const envSchema = z.object({
  AGENT_PROVIDER: z.enum(PROVIDERS),
  AGENT_MODEL: z.enum(MODEL_KEYS),
  AGENT_MAX_TOOL_TURNS: z.coerce.number().int().min(1).max(10).default(5),
  AGENT_MAX_TOKENS: z.coerce.number().int().min(1).default(80_000),
  AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).default(2_048),
  AGENT_TIME_BUDGET_MS: z.coerce
    .number()
    .int()
    .min(MIN_TIME_BUDGET_MS)
    .max(MAX_TIME_BUDGET_MS)
    .default(25_000),
  AGENT_EFFORT: z.enum(EFFORTS).default("low"),
});

/**
 * Parse the agent configuration; throws ConfigError naming each bad variable. The Anthropic key file's path comes
 * from the caller (`options.anthropicKeyFile`, e.g. the eval's --key-file option), never from `env`.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: { anthropicKeyFile?: string } = {},
): AgentConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success)
    throw new ConfigError(
      `invalid agent configuration: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  const e = parsed.data;
  return {
    provider: e.AGENT_PROVIDER,
    model: e.AGENT_MODEL,
    modelId: modelId(e.AGENT_PROVIDER, e.AGENT_MODEL),
    maxToolTurns: e.AGENT_MAX_TOOL_TURNS,
    maxTokens: e.AGENT_MAX_TOKENS,
    maxOutputTokens: e.AGENT_MAX_OUTPUT_TOKENS,
    timeBudgetMs: e.AGENT_TIME_BUDGET_MS,
    effort: e.AGENT_EFFORT,
    ...(options.anthropicKeyFile !== undefined
      ? { anthropicKeyFile: options.anthropicKeyFile }
      : {}),
  };
}
