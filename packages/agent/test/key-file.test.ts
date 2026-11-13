/**
 * Provider "anthropic" reads its key from a file only (Mario, 13 Nov 2026), and every environment fallback of the
 * installed @anthropic-ai/sdk 1.3.0 that could add a credential or redirect the key is neutralized.
 * Key files live in a scratch directory (os.tmpdir mkdtemp) and hold fake keys; there is no default path. No
 * network: fetch throws, and the real-SDK test injects a recording fetch.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import {
  AnthropicKeyFileError,
  readAnthropicKeyFile,
} from "../src/key-file.ts";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ForeignHostError,
  anthropicClientOptions,
  createModelClient,
  pinnedFetch,
  wrapClient,
  type Fetch,
} from "../src/model-client.ts";
import { textReply } from "../src/testing/scripted-model.ts";
import { blockNetwork, recordingConstructors } from "./helpers.ts";

beforeAll(blockNetwork);
afterEach(() => {
  vi.unstubAllEnvs();
});

const dir = mkdtempSync(join(tmpdir(), "agent-key-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const KEY = "file-key-not-real";
/** Text that must never appear in an error message. */
const SENTINEL = "SENTINEL-CONTENT-7f3a";

let files = 0;
function keyFile(content: string, mode: number): string {
  const path = join(dir, `key-${++files}.json`);
  writeFileSync(path, content);
  chmodSync(path, mode); // explicit: writeFileSync's mode is masked by the umask
  return path;
}
const goodKeyFile = (mode = 0o600) =>
  keyFile(JSON.stringify({ apiKey: KEY }), mode);

/** The AnthropicKeyFileError `fn` throws (fails the test if it throws nothing or something else). */
function refusal(fn: () => unknown): AnthropicKeyFileError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AnthropicKeyFileError);
    return err as AnthropicKeyFileError;
  }
  throw new Error("expected an AnthropicKeyFileError");
}

/** Every environment variable the SDK reads that could carry, add or redirect a credential, set hostile. */
function stubHostileEnv(): void {
  vi.stubEnv("ANTHROPIC_API_KEY", "env-api-key");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-auth-token");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example");
  vi.stubEnv("ANTHROPIC_WEBHOOK_SIGNING_KEY", "env-webhook-key");
  vi.stubEnv(
    "ANTHROPIC_CUSTOM_HEADERS",
    [
      "Authorization: Bearer env-header-token",
      "X-Api-Key: env-header-key",
      "Proxy-Authorization: Basic env-proxy",
      "Cookie: env-cookie",
      "Host: evil.example",
    ].join("\n"),
  );
  vi.stubEnv("ANTHROPIC_PROFILE", "env-profile");
  // Scratch only: even if the credential chain ran, it would look here, never in the real config directory.
  vi.stubEnv("ANTHROPIC_CONFIG_DIR", join(dir, "no-config-dir"));
}

describe("Anthropic key file (the path its caller passes, e.g. --key-file)", () => {
  test("mode 600 works: the injected constructor receives the file's key", () => {
    const r = recordingConstructors();
    createModelClient(
      { provider: "anthropic", anthropicKeyFile: goodKeyFile() },
      { constructors: r.constructors },
    );
    expect(r.built).toHaveLength(1);
    expect(r.built[0]).toMatchObject({
      provider: "anthropic",
      opts: { apiKey: KEY },
    });
  });

  test.each([
    ["0644", 0o644],
    ["0640", 0o640],
    ["0400", 0o400],
  ])(
    "mode %s is refused before any client is built; the error names the path and the mode",
    (octal, mode) => {
      const r = recordingConstructors();
      const path = goodKeyFile(mode);
      const err = refusal(() =>
        createModelClient(
          { provider: "anthropic", anthropicKeyFile: path },
          { constructors: r.constructors },
        ),
      );
      expect(err).toMatchObject({ path, problem: "mode", mode: octal });
      expect(err.message).toContain(path);
      expect(err.message).toContain(`mode ${octal}`);
      expect(err.message).not.toContain(KEY);
      expect(r.built).toEqual([]);
    },
  );

  test("a directory is refused: not a regular file", () => {
    const path = join(dir, "a-directory");
    mkdirSync(path);
    chmodSync(path, 0o700);
    const err = refusal(() => readAnthropicKeyFile(path));
    expect(err).toMatchObject({
      path,
      problem: "not-a-regular-file",
      mode: "0700",
    });
  });

  test("a missing file, invalid JSON and a missing or empty apiKey are refused, with no content in the message", () => {
    const r = recordingConstructors();
    const invalid = `{"apiKey": ${SENTINEL}}`;
    // JSON.parse's own message quotes the input, which is why it is never used.
    expect(() => JSON.parse(invalid)).toThrow(/SENTINEL/);
    const cases: Array<[string, string]> = [
      [join(dir, "absent.json"), "missing"],
      [keyFile(invalid, 0o600), "invalid-json"],
      [keyFile(JSON.stringify({ key: SENTINEL }), 0o600), "missing-api-key"],
      [
        keyFile(JSON.stringify({ apiKey: "", note: SENTINEL }), 0o600),
        "missing-api-key",
      ],
      [keyFile(JSON.stringify([SENTINEL]), 0o600), "missing-api-key"],
    ];
    for (const [path, problem] of cases) {
      const err = refusal(() =>
        createModelClient(
          { provider: "anthropic", anthropicKeyFile: path },
          { constructors: r.constructors },
        ),
      );
      expect(err).toMatchObject({ path, problem });
      expect(err.message).toContain(path);
      expect(err.message).not.toContain("SENTINEL");
      expect(err.message).not.toContain("7f3a");
    }
    expect(r.built).toEqual([]);
  });

  test("ANTHROPIC_API_KEY set with no file is still refused; it has no effect on the configuration either", () => {
    stubHostileEnv();
    const r = recordingConstructors();
    const path = join(dir, "absent.json");
    const err = refusal(() =>
      createModelClient(
        { provider: "anthropic", anthropicKeyFile: path },
        { constructors: r.constructors },
      ),
    );
    expect(err).toMatchObject({ path, problem: "missing" });
    expect(err.message).not.toContain("env-");
    expect(r.built).toEqual([]);
    const base = { AGENT_PROVIDER: "anthropic", AGENT_MODEL: "sonnet-5.5" };
    expect(
      loadConfig(
        {
          ...base,
          ANTHROPIC_API_KEY: "env-api-key",
          ANTHROPIC_AUTH_TOKEN: "env-auth-token",
        },
        { anthropicKeyFile: path },
      ),
    ).toEqual(loadConfig(base, { anthropicKeyFile: path }));
  });

  test("the path is a parameter with no default: loadConfig takes it from its caller, never from the environment", () => {
    const base = { AGENT_PROVIDER: "anthropic", AGENT_MODEL: "sonnet-5.5" };
    const path = join(dir, "given.json");
    expect(loadConfig(base, { anthropicKeyFile: path }).anthropicKeyFile).toBe(
      path,
    );
    expect(loadConfig(base).anthropicKeyFile).toBeUndefined();
    // The path given to loadConfig is the file the factory reads: the injected constructor gets its fake key.
    const r = recordingConstructors();
    createModelClient(loadConfig(base, { anthropicKeyFile: goodKeyFile() }), {
      constructors: r.constructors,
    });
    expect(r.built).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        opts: expect.objectContaining({ apiKey: KEY }),
      }),
    ]);
    // The removed variable has no effect.
    expect(
      loadConfig({ ...base, AGENT_ANTHROPIC_KEY_FILE: path }).anthropicKeyFile,
    ).toBeUndefined();
  });

  test("provider anthropic without a path is refused before any client is built", () => {
    const r = recordingConstructors();
    for (const anthropicKeyFile of [undefined, ""]) {
      expect(() =>
        createModelClient(
          { provider: "anthropic", anthropicKeyFile },
          { constructors: r.constructors },
        ),
      ).toThrow(ConfigError);
      expect(() =>
        createModelClient(
          { provider: "anthropic", anthropicKeyFile },
          { constructors: r.constructors },
        ),
      ).toThrow(/--key-file <path>/);
    }
    expect(r.built).toEqual([]);
  });
});

describe("environment fallbacks of @anthropic-ai/sdk 1.3.0 are neutralized", () => {
  test("constructor options: the file key, authToken null, webhookKey null, the pinned base URL, no retries, the pinned fetch", () => {
    stubHostileEnv();
    const r = recordingConstructors();
    createModelClient(
      { provider: "anthropic", anthropicKeyFile: goodKeyFile() },
      { constructors: r.constructors },
    );
    expect(r.built).toEqual([
      {
        provider: "anthropic",
        opts: {
          apiKey: KEY,
          authToken: null,
          webhookKey: null,
          baseURL: "https://api.anthropic.com",
          maxRetries: 0,
          fetch: expect.any(Function),
        },
      },
    ]);
  });

  test("the pinned base URL is the installed SDK's own default (client.mjs)", () => {
    const sdkDir = dirname(
      createRequire(import.meta.url).resolve("@anthropic-ai/sdk"),
    );
    const pkg = JSON.parse(
      readFileSync(join(sdkDir, "package.json"), "utf8"),
    ) as { version: string };
    expect(pkg.version).toBe("1.3.0");
    const source = readFileSync(join(sdkDir, "client.mjs"), "utf8");
    expect(source).toContain(
      `baseURL: baseURL || \`${ANTHROPIC_DEFAULT_BASE_URL}\`,`,
    );
    expect(source).toContain(
      `return this.baseURL !== '${ANTHROPIC_DEFAULT_BASE_URL}';`,
    );
  });

  test("the real SDK client under hostile environment variables sends only the file key, only to api.anthropic.com", async () => {
    stubHostileEnv();
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const recordingFetch: Fetch = async (input, init) => {
      sent.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify(textReply("ok")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new Anthropic(anthropicClientOptions(KEY, recordingFetch));
    expect(client.baseURL).toBe("https://api.anthropic.com");
    expect(client.apiKey).toBe(KEY);
    expect(client.authToken).toBeNull();
    expect(client.webhookKey).toBeNull();
    const reply = await wrapClient(client).create(
      {
        model: "claude-test-model",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      },
      { timeoutMs: 1_000 },
    );
    expect(reply.content).toEqual([
      expect.objectContaining({ type: "text", text: "ok" }),
    ]);
    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    for (const name of ["x-api-key", "proxy-authorization", "cookie", "host"])
      expect(headers.get(name)).toBeNull();
    // No value from the environment anywhere in the request headers.
    for (const [, value] of headers) expect(value).not.toContain("env-");

    // Control (same environment, the SDK's own defaults, recording fetch: nothing is sent): ANTHROPIC_BASE_URL
    // redirects the request and ANTHROPIC_CUSTOM_HEADERS replaces the passed key (client.mjs:102, 176-186, 962-977).
    const unpinned = new Anthropic({
      apiKey: KEY,
      maxRetries: 0,
      fetch: recordingFetch,
    });
    await wrapClient(unpinned).create(
      {
        model: "claude-test-model",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      },
      { timeoutMs: 1_000 },
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]!.url).toBe("https://evil.example/v1/messages");
    const controlHeaders = new Headers(sent[1]!.init.headers);
    expect(controlHeaders.get("authorization")).toBe("Bearer env-header-token");
    expect(controlHeaders.get("x-api-key")).toBe("env-header-key");
  });

  test("pinnedFetch: another origin or a Request input is refused before sending; credential headers are replaced; redirects are refused", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const inner: Fetch = async (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return new Response("{}");
    };
    const f = pinnedFetch(KEY, inner);
    await expect(f("https://evil.example/v1/messages")).rejects.toBeInstanceOf(
      ForeignHostError,
    );
    await expect(
      f("http://api.anthropic.com/v1/messages"),
    ).rejects.toBeInstanceOf(ForeignHostError);
    await expect(
      f(new Request("https://api.anthropic.com/v1/messages")),
    ).rejects.toBeInstanceOf(TypeError);
    expect(seen).toEqual([]);

    await f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      redirect: "follow",
      headers: {
        authorization: "Bearer other",
        "x-api-key": "other",
        "api-key": "other",
        "x-amz-security-token": "other",
        cookie: "other",
        host: "evil.example",
        "anthropic-version": "2026-10-21",
      },
    });
    expect(seen).toHaveLength(1);
    const headers = new Headers(seen[0]!.init.headers);
    expect([...headers]).toEqual([
      ["anthropic-version", "2026-10-21"],
      ["authorization", `Bearer ${KEY}`],
    ]);
    expect(seen[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
  });
});
