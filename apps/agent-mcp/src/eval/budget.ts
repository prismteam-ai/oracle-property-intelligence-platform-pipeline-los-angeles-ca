/**
 * The eval's spend limit (--max-usd). Spend = the sum over model calls of the API's usage
 * figures (input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens) × the price table in
 * packages/agent (models.ts; Bedrock × 1.1, an estimate). Before EACH model call (runAgent's beforeModelCall), the
 * call's worst case is computed: ceil(request JSON characters / 2) input tokens at the input price (Haiku's
 * over-100,000 price when that bound exceeds 100,000) + max_tokens × the output price. If committed spend + worst
 * case > max-usd, the call is not made and the whole eval stops (stopped_by "budget").
 *
 * Committed spend = metered spend + the worst case of every call that failed (no usage figures came back, so the
 * worst case stands in for whatever it may have cost).
 */
import {
  modelErrorName,
  usageCostUsd,
  worstCaseUsd,
  type ModelClient,
  type PricedModelKey,
  type Provider,
} from "@oracle-la/agent";

/** The SDK's request and response types, through ModelClient (this app does not depend on the SDK). */
type Params = Parameters<ModelClient["create"]>[0];
type Message = Awaited<ReturnType<ModelClient["create"]>>;

/** One model call as metered. */
export interface MeteredCall {
  /** The bound and worst case computed before the call. */
  input_tokens_bound: number;
  max_tokens: number;
  worst_case_usd: number;
  /** The API's usage figures (absent when the call failed). */
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
  /** Spend of the call from its usage figures (0 when it failed). */
  usd: number;
  /** The SDK's error class name when the call failed. */
  error?: string;
}

/** Why the eval stopped before a call. */
export interface BudgetStop {
  committed_usd: number;
  worst_case_usd: number;
  input_tokens_bound: number;
  max_tokens: number;
  max_usd: number;
}

export class Budget {
  readonly provider: Provider;
  readonly model: PricedModelKey;
  readonly maxUsd: number;
  /** Spend from usage figures, all calls so far. */
  spentUsd = 0;
  /** Worst cases of the calls that failed (no usage figures). */
  unmeteredUsd = 0;
  /** Set when a call was refused; the eval stops. */
  stop: BudgetStop | null = null;
  /** The calls since the last take() (one answer's calls). */
  private calls: MeteredCall[] = [];
  private pending: MeteredCall | null = null;

  constructor(provider: Provider, model: PricedModelKey, maxUsd: number) {
    this.provider = provider;
    this.model = model;
    this.maxUsd = maxUsd;
  }

  get committedUsd(): number {
    return this.spentUsd + this.unmeteredUsd;
  }

  /** runAgent's beforeModelCall: false (and `stop` set) when the call's worst case would pass the limit. */
  readonly gate = (params: Params): boolean => {
    const w = worstCaseUsd(
      this.provider,
      this.model,
      JSON.stringify(params).length,
      params.max_tokens,
    );
    if (this.committedUsd + w.usd > this.maxUsd) {
      this.stop = {
        committed_usd: this.committedUsd,
        worst_case_usd: w.usd,
        input_tokens_bound: w.input_tokens_bound,
        max_tokens: params.max_tokens,
        max_usd: this.maxUsd,
      };
      return false;
    }
    this.pending = {
      input_tokens_bound: w.input_tokens_bound,
      max_tokens: params.max_tokens,
      worst_case_usd: w.usd,
      usd: 0,
    };
    return true;
  };

  /** The model client with every call metered (its usage priced, a failure charged at its worst case). */
  meter(inner: ModelClient): ModelClient {
    return {
      create: async (params, opts) => {
        const call: MeteredCall = this.pending ?? {
          // Not gated (never the case in the eval): metered from usage only.
          input_tokens_bound: 0,
          max_tokens: params.max_tokens,
          worst_case_usd: 0,
          usd: 0,
        };
        this.pending = null;
        this.calls.push(call);
        let res: Message;
        try {
          res = await inner.create(params, opts);
        } catch (err) {
          call.error = modelErrorName(err);
          this.unmeteredUsd += call.worst_case_usd;
          throw err;
        }
        const u = res.usage;
        call.usage = {
          input_tokens: u.input_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          output_tokens: u.output_tokens,
        };
        call.usd = usageCostUsd(this.provider, this.model, call.usage);
        this.spentUsd += call.usd;
        return res;
      },
    };
  }

  /** The calls metered since the last take(), and a fresh list for the next answer. */
  take(): MeteredCall[] {
    const out = this.calls;
    this.calls = [];
    return out;
  }
}
