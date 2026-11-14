import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import {
  SDK_CONSTRUCTORS,
  createModelClient,
  modelErrorName,
} from "../src/model-client.ts";
import { BEDROCK_REGION, MODEL_IDS, MODEL_KEYS } from "../src/models.ts";
import { blockNetwork, recordingConstructors } from "./helpers.ts";

beforeAll(blockNetwork);

/** Scratch directory (os.tmpdir); nothing is ever written to it here. */
const scratch = mkdtempSync(join(tmpdir(), "agent-config-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("configuration", () => {
  const base = { AGENT_PROVIDER: "anthropic", AGENT_MODEL: "sonnet-5.5" };

  test("defaults (no default picks a model or provider)", () => {
    expect(loadConfig(base)).toEqual({
      provider: "anthropic",
      model: "sonnet-5.5",
      modelId: "claude-sonnet-5-5",
      maxToolTurns: 5,
      maxTokens: 40_000,
      maxOutputTokens: 2_048,
      timeBudgetMs: 25_000,
      effort: "low",
    });
  });
  test("missing AGENT_MODEL is rejected", () => {
    expect(() => loadConfig({ AGENT_PROVIDER: "anthropic" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ AGENT_PROVIDER: "anthropic" })).toThrow(
      /AGENT_MODEL/,
    );
  });
  test("missing or unknown AGENT_PROVIDER is rejected", () => {
    expect(() => loadConfig({ AGENT_MODEL: "opus-5.5" })).toThrow(
      /AGENT_PROVIDER/,
    );
    expect(() => loadConfig({ ...base, AGENT_PROVIDER: "vertex" })).toThrow(
      ConfigError,
    );
  });
  test("a model outside the map is rejected (Fable 5.2 is not in it)", () => {
    expect(() => loadConfig({ ...base, AGENT_MODEL: "fable-5.2" })).toThrow(
      /AGENT_MODEL/,
    );
  });
  test("time budget above 28,000 ms is rejected; 28,000 is accepted", () => {
    expect(() =>
      loadConfig({ ...base, AGENT_TIME_BUDGET_MS: "28001" }),
    ).toThrow(/AGENT_TIME_BUDGET_MS/);
    expect(
      loadConfig({ ...base, AGENT_TIME_BUDGET_MS: "28000" }).timeBudgetMs,
    ).toBe(28_000);
  });
  test("tool turns are bounded 1..10; effort is low|medium|high", () => {
    expect(() => loadConfig({ ...base, AGENT_MAX_TOOL_TURNS: "11" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, AGENT_MAX_TOOL_TURNS: "0" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, AGENT_EFFORT: "max" })).toThrow(
      ConfigError,
    );
    expect(loadConfig({ ...base, AGENT_EFFORT: "high" }).effort).toBe("high");
  });
  test("bedrock resolves the anthropic.-prefixed ID", () => {
    expect(
      loadConfig({ AGENT_PROVIDER: "bedrock", AGENT_MODEL: "opus-5.5" })
        .modelId,
    ).toBe("anthropic.claude-opus-5-5");
  });
});

describe("model-ID map", () => {
  test("every Bedrock ID is 'anthropic.' + the Claude API ID", () => {
    for (const key of MODEL_KEYS)
      expect(MODEL_IDS[key].bedrock).toBe(
        `anthropic.${MODEL_IDS[key].anthropic}`,
      );
  });
  test('exact IDs from the "Models overview" page (rows "Claude API ID" and "Amazon Bedrock ID")', () => {
    expect(MODEL_IDS).toEqual({
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
    });
    expect(BEDROCK_REGION).toBe("eu-north-1");
  });
});

describe("model client factory", () => {
  test("the default constructors are the SDK classes (not constructed here)", () => {
    expect(SDK_CONSTRUCTORS.anthropic).toBe(Anthropic);
    expect(SDK_CONSTRUCTORS.bedrock).toBe(AnthropicBedrockMantle);
  });
  test("bedrock selects AnthropicBedrockMantle options: eu-north-1, no retries, and sends the anthropic. ID; the key file is not read", async () => {
    const r = recordingConstructors();
    // A key file that does not exist: reading it would refuse, so bedrock not throwing shows it is never read.
    const cfg = loadConfig(
      { AGENT_PROVIDER: "bedrock", AGENT_MODEL: "haiku-5.5" },
      { anthropicKeyFile: join(scratch, "absent.json") },
    );
    const client = createModelClient(cfg, { constructors: r.constructors });
    expect(r.built).toEqual([
      { provider: "bedrock", opts: { awsRegion: "eu-north-1", maxRetries: 0 } },
    ]);
    const ac = new AbortController();
    await client.create(
      {
        model: cfg.modelId,
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      },
      { timeoutMs: 1234, signal: ac.signal },
    );
    expect(r.calls).toHaveLength(1);
    expect((r.calls[0]!.params as { model: string }).model).toBe(
      "anthropic.claude-haiku-5-5",
    );
    expect(r.calls[0]!.options).toEqual({ timeout: 1234, signal: ac.signal });
  });
  test("error names come from the SDK's typed classes", () => {
    expect(modelErrorName(new Anthropic.APIConnectionTimeoutError())).toBe(
      "APIConnectionTimeoutError",
    );
    expect(modelErrorName(new TypeError("x"))).toBe("TypeError");
    expect(modelErrorName("nope")).toBe("UnknownError");
  });
});
