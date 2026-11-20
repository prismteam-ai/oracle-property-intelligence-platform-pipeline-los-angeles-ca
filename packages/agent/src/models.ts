/**
 * Model-ID map. Sources (Anthropic's documentation, read 2026-11-13):
 * - Anthropic, "Models overview", https://platform.claude.com/docs/en/about-claude/models/overview.md, rows
 *   "Claude API ID" and "Amazon Bedrock ID" ("The ID on Bedrock's bedrock-mantle endpoint").
 * - Anthropic, "Claude in Amazon Bedrock (bedrock-mantle)",
 *   https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock.md: "Model IDs in Claude in
 *   Amazon Bedrock carry an `anthropic.` provider prefix"; region "eu-north-1 | Europe (Stockholm) | Global, EU,
 *   In-region only".
 * Claude Fable 5.2 is left out: it and Claude Mythos 5.2 "aren't available in Claude in Amazon Bedrock".
 * The model choice is open until phase B, so nothing here picks a default.
 */
export const PROVIDERS = ["anthropic", "bedrock"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const MODEL_KEYS = ["opus-5.5", "sonnet-5.5", "haiku-5.5"] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];

export const MODEL_IDS: Readonly<
  Record<ModelKey, Readonly<Record<Provider, string>>>
> = {
  "opus-5.5": {
    anthropic: "claude-opus-5-5",
    bedrock: "anthropic.claude-opus-5-5",
  },
  "sonnet-5.5": {
    anthropic: "claude-sonnet-5-5",
    bedrock: "anthropic.claude-sonnet-5-5",
  },
  "haiku-5.5": {
    anthropic: "claude-haiku-5-5",
    bedrock: "anthropic.claude-haiku-5-5",
  },
};

/**
 * Bedrock region (Anthropic, "Claude in Amazon Bedrock (bedrock-mantle)", cited above: "eu-north-1 | Europe
 * (Stockholm) | Global, EU, In-region only"). A constant, not configuration.
 */
export const BEDROCK_REGION = "eu-north-1";

export function modelId(provider: Provider, key: ModelKey): string {
  return MODEL_IDS[key][provider];
}

/**
 * Price table for the eval's spend limit, USD per million tokens. Source (read
 * 2026-11-13T23:34:25Z): Anthropic, "Pricing", https://platform.claude.com/docs/en/about-claude/pricing.md,
 * columns base input, 5m cache writes, cache hits,
 * output: "| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |"; "| Claude
 * Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok |
 * $0.50 / MTok |"; "| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok
 * | $0.05 / MTok | $2.50 / MTok |". Opus 5.5 is not priced here (no cache prices were recorded for it), so the eval
 * refuses it. Bedrock: "Regional and multi-region endpoints include a 10 percent premium over global endpoints"
 * (same page), so Bedrock spend is these prices × 1.1, an estimate.
 */
export interface TokenPrices {
  input: number;
  cache_write_5m: number;
  cache_read: number;
  output: number;
}

export interface ModelPrices {
  /** Prices for prompts up to `long.above` tokens (or every prompt when there is no long tier). */
  base: TokenPrices;
  /** Prices for prompts over `above` tokens. */
  long?: { above: number; prices: TokenPrices };
}

export const PRICED_MODEL_KEYS = ["haiku-5.5", "sonnet-5.5"] as const;
export type PricedModelKey = (typeof PRICED_MODEL_KEYS)[number];

export const PRICES_USD_PER_MTOK: Readonly<
  Record<PricedModelKey, ModelPrices>
> = {
  "sonnet-5.5": {
    base: { input: 2, cache_write_5m: 2.5, cache_read: 0.1, output: 10 },
  },
  "haiku-5.5": {
    base: { input: 0.1, cache_write_5m: 0.125, cache_read: 0.01, output: 0.5 },
    long: {
      above: 100_000,
      prices: {
        input: 0.5,
        cache_write_5m: 0.625,
        cache_read: 0.05,
        output: 2.5,
      },
    },
  },
};

/**
 * Bedrock's regional endpoint premium over the Anthropic list prices (Anthropic, "Pricing", cited above: "Regional
 * and multi-region endpoints include a 10 percent premium over global endpoints").
 */
export const BEDROCK_PRICE_FACTOR = 1.1;

/** How a provider's spend is priced, for labels: Bedrock's is an estimate. */
export function pricingBasis(provider: Provider): string {
  return provider === "bedrock"
    ? "estimate: Anthropic list prices × 1.1 (Bedrock regional endpoint premium)"
    : "Anthropic list prices";
}

export function isPricedModel(key: string): key is PricedModelKey {
  return (PRICED_MODEL_KEYS as readonly string[]).includes(key);
}

/** The per-MTok prices of one call whose prompt (all input tokens) is `promptTokens` long. */
export function pricesFor(
  provider: Provider,
  key: PricedModelKey,
  promptTokens: number,
): TokenPrices {
  const m = PRICES_USD_PER_MTOK[key];
  const p = m.long && promptTokens > m.long.above ? m.long.prices : m.base;
  const f = provider === "bedrock" ? BEDROCK_PRICE_FACTOR : 1;
  return {
    input: p.input * f,
    cache_write_5m: p.cache_write_5m * f,
    cache_read: p.cache_read * f,
    output: p.output * f,
  };
}

/** The API's usage figures of one call (null counts as 0). */
export interface UsageFigures {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens: number;
}

/**
 * USD of one call from its usage figures: input, 5m cache writes, cache reads and output at their prices; the
 * prompt length that picks Haiku's tier is input + cache writes + cache reads.
 */
export function usageCostUsd(
  provider: Provider,
  key: PricedModelKey,
  u: UsageFigures,
): number {
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const p = pricesFor(provider, key, u.input_tokens + write + read);
  return (
    (u.input_tokens * p.input +
      write * p.cache_write_5m +
      read * p.cache_read +
      u.output_tokens * p.output) /
    1_000_000
  );
}

/**
 * Bound used for a request's input tokens: at least this many characters of the request JSON per token, i.e.
 * input tokens ≤ ceil(request JSON characters / 2). An assumption, not a tokenizer guarantee: Claude's tokens
 * average several characters of English or JSON, and the request JSON (system, tools, messages) is counted whole.
 */
export const MIN_CHARS_PER_TOKEN = 2;

/**
 * Worst-case USD of one call before it is made: ceil(request JSON characters / 2) input tokens at the input price
 * (Haiku's over-100,000 price when that bound exceeds 100,000) + max_tokens output tokens at the output price.
 */
export function worstCaseUsd(
  provider: Provider,
  key: PricedModelKey,
  requestJsonChars: number,
  maxTokens: number,
): { input_tokens_bound: number; usd: number } {
  const bound = Math.ceil(requestJsonChars / MIN_CHARS_PER_TOKEN);
  const p = pricesFor(provider, key, bound);
  return {
    input_tokens_bound: bound,
    usd: (bound * p.input + maxTokens * p.output) / 1_000_000,
  };
}
