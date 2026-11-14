/** The eval's price table (models.ts, design brief §15.1; docs/sources.md §5). Pure arithmetic, no network. */
import { describe, expect, test } from "vitest";
import {
  BEDROCK_PRICE_FACTOR,
  MIN_CHARS_PER_TOKEN,
  MODEL_KEYS,
  PRICED_MODEL_KEYS,
  PRICES_USD_PER_MTOK,
  isPricedModel,
  pricesFor,
  pricingBasis,
  usageCostUsd,
  worstCaseUsd,
} from "../src/models.ts";

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 12);

describe("price table", () => {
  test("the quoted list prices per MTok; Opus is not priced", () => {
    expect(PRICES_USD_PER_MTOK["sonnet-5.5"]).toEqual({
      base: { input: 2, cache_write_5m: 2.5, cache_read: 0.1, output: 10 },
    });
    expect(PRICES_USD_PER_MTOK["haiku-5.5"]).toEqual({
      base: {
        input: 0.1,
        cache_write_5m: 0.125,
        cache_read: 0.01,
        output: 0.5,
      },
      long: {
        above: 100_000,
        prices: {
          input: 0.5,
          cache_write_5m: 0.625,
          cache_read: 0.05,
          output: 2.5,
        },
      },
    });
    expect([...PRICED_MODEL_KEYS].sort()).toEqual(
      MODEL_KEYS.filter((k) => k !== "opus-5.5").sort(),
    );
    expect(isPricedModel("opus-5.5")).toBe(false);
    expect(isPricedModel("haiku-5.5")).toBe(true);
  });
  test("Bedrock is × 1.1 and labeled an estimate", () => {
    expect(BEDROCK_PRICE_FACTOR).toBe(1.1);
    const b = pricesFor("bedrock", "sonnet-5.5", 10);
    close(b.input, 2.2);
    close(b.cache_write_5m, 2.75);
    close(b.cache_read, 0.11);
    close(b.output, 11);
    expect(pricingBasis("bedrock")).toMatch(/^estimate: .*× 1\.1/);
    expect(pricingBasis("anthropic")).not.toMatch(/estimate/);
  });
  test("Haiku's tier: up to 100,000 prompt tokens base, over 100,000 long", () => {
    expect(pricesFor("anthropic", "haiku-5.5", 100_000).input).toBe(0.1);
    expect(pricesFor("anthropic", "haiku-5.5", 100_001).input).toBe(0.5);
    // Sonnet has one tier.
    expect(pricesFor("anthropic", "sonnet-5.5", 500_000).input).toBe(2);
  });
});

describe("spend from usage figures", () => {
  test("input, 5m cache writes, cache reads and output at their prices", () => {
    close(
      usageCostUsd("anthropic", "sonnet-5.5", {
        input_tokens: 1_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 10_000,
        output_tokens: 500,
      }),
      (1_000 * 2 + 2_000 * 2.5 + 10_000 * 0.1 + 500 * 10) / 1e6,
    );
  });
  test("null cache figures count as 0; Bedrock × 1.1", () => {
    close(
      usageCostUsd("bedrock", "sonnet-5.5", {
        input_tokens: 1_000,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens: 500,
      }),
      ((1_000 * 2 + 500 * 10) / 1e6) * 1.1,
    );
  });
  test("Haiku's tier counts input + cache writes + cache reads", () => {
    const u = {
      input_tokens: 60_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 50_000,
      output_tokens: 1_000,
    };
    close(
      usageCostUsd("anthropic", "haiku-5.5", u),
      (60_000 * 0.5 + 50_000 * 0.05 + 1_000 * 2.5) / 1e6,
    );
  });
});

describe("worst case before a call", () => {
  test("ceil(request JSON characters / 2) at the input price + max_tokens at the output price", () => {
    expect(MIN_CHARS_PER_TOKEN).toBe(2);
    const w = worstCaseUsd("anthropic", "sonnet-5.5", 20_001, 2_048);
    expect(w.input_tokens_bound).toBe(10_001);
    close(w.usd, (10_001 * 2 + 2_048 * 10) / 1e6);
  });
  test("Haiku: the over-100,000 price when the bound exceeds 100,000", () => {
    const under = worstCaseUsd("anthropic", "haiku-5.5", 200_000, 1_000);
    expect(under.input_tokens_bound).toBe(100_000);
    close(under.usd, (100_000 * 0.1 + 1_000 * 0.5) / 1e6);
    const over = worstCaseUsd("bedrock", "haiku-5.5", 200_002, 1_000);
    expect(over.input_tokens_bound).toBe(100_001);
    close(over.usd, ((100_001 * 0.5 + 1_000 * 2.5) / 1e6) * 1.1);
  });
});
