/**
 * Model interface and its two providers (design brief §4). Both use the SDK's own request and response types.
 * Bindings checked against the installed packages: @anthropic-ai/sdk 1.3.0 (ClientOptions in client.d.mts,
 * messages.create(params, { timeout, signal })) and @anthropic-ai/bedrock-sdk 1.1.0 (AnthropicBedrockMantle,
 * BedrockMantleClientOptions.awsRegion, mantle-client.d.ts).
 *
 * Provider "anthropic" (Mario, 13 Nov 2026): the key comes only from the key file (key-file.ts). Environment
 * fallbacks of the installed @anthropic-ai/sdk 1.3.0 (paths under node_modules/@anthropic-ai/sdk/) and how each is
 * neutralized:
 * - client.mjs:128-132: ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are read only when no credential option is
 *   passed. We pass `apiKey` (from the file) and `authToken: null`, so neither variable is read.
 * - client.mjs:205-233 with core/credentials.mjs: the profile / config / federation chain (ANTHROPIC_PROFILE,
 *   ANTHROPIC_CONFIG_DIR, ANTHROPIC_IDENTITY_TOKEN[_FILE], ANTHROPIC_BASE_URL in a profile, ...) runs only for the
 *   credential types profile, config and defaultChain. With `apiKey` passed the type is "apiKey": never reached.
 * - client.mjs:102 and :142: `baseURL` defaults to ANTHROPIC_BASE_URL, else the literal `https://api.anthropic.com`
 *   (also client.mjs:1039; the package exports no constant for it). We pass ANTHROPIC_DEFAULT_BASE_URL explicitly.
 * - client.mjs:102: `webhookKey` defaults to ANTHROPIC_WEBHOOK_SIGNING_KEY. We pass `webhookKey: null` (unread).
 * - client.mjs:176-186: ANTHROPIC_CUSTOM_HEADERS is always read and merged into defaultHeaders, which
 *   buildHeaders (client.mjs:962-977) applies AFTER the auth headers, so it could replace Authorization or add
 *   x-api-key. No option turns it off, so `fetch` is pinnedFetch: it refuses any origin but the pinned base URL,
 *   drops every credential header and sets Authorization to the file key exactly as the SDK's apiKeyAuth does
 *   (client.mjs:448-452, `Bearer <apiKey>`), and refuses redirects.
 * - Not credential-bearing, left alone: ANTHROPIC_LOG (client.mjs:161; debug logs redact authorization,
 *   x-api-key and the other credential headers, internal/utils/log.mjs:96-104) and ANTHROPIC_OPEN_TELEMETRY*
 *   (internal/tracing.mjs:78-85; trace options, no credential).
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { ConfigError } from "./config.ts";
import { readAnthropicKeyFile } from "./key-file.ts";
import { BEDROCK_REGION, type Provider } from "./models.ts";

/**
 * The SDK's built-in default base URL, from the installed source (@anthropic-ai/sdk 1.3.0 client.mjs:142,
 * "baseURL: baseURL || `https://api.anthropic.com`"). A test checks it against that line.
 */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** The SDK's fetch signature (internal/builtin-types.d.mts:1). */
export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Headers that carry credentials: the SDK's own redaction list (internal/utils/log.mjs:98-104), plus `host`
 * so no header can name another host.
 */
export const CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "api-key",
  "x-api-key",
  "x-amz-security-token",
  "cookie",
  "host",
] as const;

/** A request to a host other than the pinned base URL (never sent). */
export class ForeignHostError extends Error {
  constructor(origin: string) {
    super(
      `refusing to send the Anthropic key to ${origin}; only ${ANTHROPIC_DEFAULT_BASE_URL} is allowed`,
    );
    this.name = "ForeignHostError";
  }
}

/**
 * A fetch that sends the file key to the pinned base URL only: other origins and Request inputs are refused
 * before anything is sent; every credential header (incl. any from ANTHROPIC_CUSTOM_HEADERS) is dropped and
 * Authorization is set to `Bearer <apiKey>`; redirects are refused. `inner` defaults to globalThis.fetch at
 * call time.
 */
export function pinnedFetch(apiKey: string, inner?: Fetch): Fetch {
  const origin = new URL(ANTHROPIC_DEFAULT_BASE_URL).origin;
  return async (input, init) => {
    if (input instanceof Request)
      throw new TypeError(
        "pinnedFetch takes a URL string (the SDK's request path passes one)",
      );
    const url = new URL(input);
    if (url.origin !== origin) throw new ForeignHostError(url.origin);
    const headers = new Headers(init?.headers);
    for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    headers.set("authorization", `Bearer ${apiKey}`);
    return (inner ?? globalThis.fetch)(url.href, {
      ...init,
      headers,
      redirect: "error",
    });
  };
}

/** The exact options provider "anthropic" passes to the SDK constructor. */
export interface AnthropicClientOptions {
  apiKey: string;
  authToken: null;
  webhookKey: null;
  baseURL: string;
  maxRetries: number;
  fetch: Fetch;
}

/** Constructor options with every environment fallback neutralized (see the header comment). */
export function anthropicClientOptions(
  apiKey: string,
  inner?: Fetch,
): AnthropicClientOptions {
  return {
    apiKey,
    authToken: null,
    webhookKey: null,
    baseURL: ANTHROPIC_DEFAULT_BASE_URL,
    maxRetries: 0,
    fetch: pinnedFetch(apiKey, inner),
  };
}

export interface ModelCallOptions {
  /** Per-call timeout in milliseconds (the time left in the answer's budget). */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ModelClient {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    opts: ModelCallOptions,
  ): Promise<Anthropic.Message>;
}

/** The part of an SDK client the providers use. */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number; signal?: AbortSignal | null },
    ): PromiseLike<Anthropic.Message>;
  };
}

export interface ClientConstructors {
  anthropic: new (opts: AnthropicClientOptions) => MessagesClient;
  bedrock: new (opts: {
    awsRegion: string;
    maxRetries: number;
  }) => MessagesClient;
}

/** The real SDK classes. Tests inject their own so no network client is ever built. */
export const SDK_CONSTRUCTORS: ClientConstructors = {
  anthropic: Anthropic,
  bedrock: AnthropicBedrockMantle,
};

/** Wrap an SDK client: one call, no retries (maxRetries 0 at construction), the budget's timeout. */
export function wrapClient(client: MessagesClient): ModelClient {
  return {
    async create(params, opts) {
      return client.messages.create(params, {
        timeout: opts.timeoutMs,
        signal: opts.signal,
      });
    },
  };
}

/**
 * The provider switch. "anthropic" reads the key file at `config.anthropicKeyFile`, the path its caller passed
 * (ConfigError when there is none; AnthropicKeyFileError, before any client is constructed, when it is missing, not
 * mode 0600, not valid JSON or without apiKey) and passes the neutralized options; no environment variable is read
 * for it. "bedrock" uses the SDK's credential resolution in eu-north-1. Retries are off: the time budget leaves no
 * room for them.
 */
export function createModelClient(
  config: { provider: Provider; anthropicKeyFile?: string },
  opts: { constructors?: ClientConstructors } = {},
): ModelClient {
  const ctors = opts.constructors ?? SDK_CONSTRUCTORS;
  if (config.provider === "anthropic") {
    if (!config.anthropicKeyFile)
      throw new ConfigError(
        'provider "anthropic" needs the path of its key file (the eval\'s --key-file <path>); none was given',
      );
    const apiKey = readAnthropicKeyFile(config.anthropicKeyFile);
    return wrapClient(new ctors.anthropic(anthropicClientOptions(apiKey)));
  }
  return wrapClient(
    new ctors.bedrock({ awsRegion: BEDROCK_REGION, maxRetries: 0 }),
  );
}

/** The SDK's typed error class name for a failed model call (never the message text, which may be long). */
export function modelErrorName(err: unknown): string {
  if (
    err instanceof Anthropic.APIError ||
    err instanceof Anthropic.AnthropicError
  )
    return err.constructor.name;
  if (err instanceof Error) return err.name || "Error";
  return "UnknownError";
}
