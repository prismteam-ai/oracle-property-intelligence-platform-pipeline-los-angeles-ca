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

/** Bedrock region (sources.md §2: "eu-north-1 | Global, EU, In-region only"). A constant, not configuration. */
export const BEDROCK_REGION = "eu-north-1";

export function modelId(provider: Provider, key: ModelKey): string {
  return MODEL_IDS[key][provider];
}
