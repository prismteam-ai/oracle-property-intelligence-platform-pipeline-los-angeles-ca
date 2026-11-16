/**
 * The hosted agent's handler with the scripted model, a fake data API (tRPC GET format over the agent package's
 * fakes) and SSM mocked with aws-sdk-client-mock: the two parameters read once and kept in memory, 503 when either
 * is missing, the warm-up, the signed history (accepted, refused when unsigned or altered), the 200 KB cap before
 * parsing, routes and clients, and the one log line, which carries no word of the question, no coordinates, no
 * token and no secret. No network, no model call.
 */
import {
  GetParameterCommand,
  ParameterNotFound,
  SSMClient,
} from "@aws-sdk/client-ssm";
import {
  NO_TOOL_CALL_TEXT,
  ScriptedModel,
  lastToolResult,
  textReply,
  toolReply,
  type ModelClient,
} from "@oracle-la/agent";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  FAKE_API_URL,
  fakeDataApi,
} from "../../../packages/agent/test/fake-data-api.ts";
import {
  FAKE_PARCELS,
  blockNetwork,
  fakeQueries,
} from "../../../packages/agent/test/helpers.ts";
import {
  AGENT_COMMIT,
  ANSWER_ROUTE,
  WARM_ROUTE,
  createHandler,
  defaultDeps,
  type AgentEvent,
  type AnswerResponse,
  type HandlerDeps,
} from "../src/handler.ts";
import { MAX_BODY_BYTES, signConversation } from "../src/history.ts";
import type { AgentLogLine } from "../src/log.ts";
import {
  HISTORY_SECRET_PARAMETER_ENV,
  KEY_PARAMETER_ENV,
} from "../src/secrets.ts";

const KEY_PARAM = "/oracle-la/agent/anthropic-api-key";
const SECRET_PARAM = "/oracle-la/agent/history-signing-secret";
const FAKE_KEY = "fake-anthropic-key-for-tests-only";
const FAKE_SECRET = "fake-history-signing-secret-for-tests";
const TOKEN = "fake-client-token-for-tests";

const ENV = {
  DATA_API_URL: FAKE_API_URL,
  [KEY_PARAMETER_ENV]: KEY_PARAM,
  [HISTORY_SECRET_PARAMETER_ENV]: SECRET_PARAM,
  AGENT_PROVIDER: "anthropic",
  AGENT_MODEL: "sonnet-5.5",
  AGENT_EFFORT: "low",
};

const ssm = mockClient(SSMClient);
beforeAll(blockNetwork);
beforeEach(() => {
  ssm.reset();
  ssm
    .on(GetParameterCommand, { Name: KEY_PARAM, WithDecryption: true })
    .resolves({ Parameter: { Name: KEY_PARAM, Value: FAKE_KEY } })
    .on(GetParameterCommand, { Name: SECRET_PARAM, WithDecryption: true })
    .resolves({ Parameter: { Name: SECRET_PARAM, Value: FAKE_SECRET } });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function event(
  routeKey: string,
  body?: unknown,
  opts: { client?: string | null; raw?: string; token?: string | null } = {},
): AgentEvent {
  const client = opts.client === undefined ? "crm" : opts.client;
  const token = opts.token === undefined ? TOKEN : opts.token;
  return {
    version: "2.0",
    routeKey,
    rawPath: routeKey.split(" ")[1]!,
    rawQueryString: "",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    requestContext: {
      ...(client !== null ? { authorizer: { lambda: { client } } } : {}),
    } as AgentEvent["requestContext"],
    isBase64Encoded: false,
    body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  } as AgentEvent;
}

const CONTEXT = { awsRequestId: "req-1" };

/** A handler over test dependencies; `models` are handed out one per model client built. */
function setup(
  opts: {
    env?: Record<string, string | undefined>;
    steps?: ConstructorParameters<typeof ScriptedModel>[0];
    api?: ReturnType<typeof fakeDataApi>;
    commit?: string;
  } = {},
) {
  const lines: Array<{ message: string; line: AgentLogLine }> = [];
  const usd: number[] = [];
  const model = new ScriptedModel(opts.steps ?? []);
  const keys: string[] = [];
  const api = opts.api ?? fakeDataApi(fakeQueries().queries);
  const deps: HandlerDeps = {
    env: opts.env ?? ENV,
    ssm: new SSMClient({}),
    log: (message, line) => lines.push({ message, line: { ...line } }),
    metrics: { answerUsd: (u) => usd.push(u), flush: () => {} },
    modelFor: (apiKey): ModelClient => {
      keys.push(apiKey);
      return model;
    },
    dataFetch: api.fetch,
    ...(opts.commit !== undefined ? { commit: opts.commit } : {}),
  };
  return { handler: createHandler(deps), lines, usd, model, keys, api };
}

const parse = (res: unknown) =>
  JSON.parse((res as { body: string }).body) as Record<string, unknown>;
const status = (res: unknown) => (res as { statusCode: number }).statusCode;

/** Resolve Van Nuys, search there, answer. */
const VAN_NUYS_STEPS: ConstructorParameters<typeof ScriptedModel>[0] = [
  toolReply([{ name: "resolve_place", input: { name: "Van Nuys" } }]),
  (p) => {
    const { center } = lastToolResult(p, "resolve_place") as {
      center: { lat: number; lon: number };
    };
    return toolReply([
      {
        name: "search_aged_roofs",
        input: { lat: center.lat, lon: center.lon, radius_miles: 5 },
      },
    ]);
  },
  textReply(`Parcel ${FAKE_PARCELS[0]} has the oldest roof.`),
];

describe("the two SSM parameters", () => {
  test("GET /agent/warm reads both parameters (with decryption), builds the model client and makes no model call", async () => {
    const s = setup();
    const res = await s.handler(event(WARM_ROUTE), CONTEXT);
    expect(status(res)).toBe(200);
    // Run from source (no esbuild define), the commit is "unbundled".
    expect(AGENT_COMMIT).toBe("unbundled");
    expect(parse(res)).toEqual({ status: "warm", commit: AGENT_COMMIT });
    const calls = ssm.commandCalls(GetParameterCommand);
    expect(
      calls
        .map((c) => c.args[0].input)
        .sort((a, b) => String(a.Name).localeCompare(String(b.Name))),
    ).toEqual([
      { Name: KEY_PARAM, WithDecryption: true },
      { Name: SECRET_PARAM, WithDecryption: true },
    ]);
    expect(s.keys).toEqual([FAKE_KEY]);
    expect(s.model.requests).toHaveLength(0);
    expect(s.api.requests).toHaveLength(0);
    expect(
      s.lines.map((l) => [l.message, l.line.http_status, l.line.status]),
    ).toEqual([["agent_warm", 200, "warm"]]);
  });

  test("GET /agent/warm returns the agent's commit (the bundle's define; here given to the handler)", async () => {
    const s = setup({ commit: "abc1234" });
    const res = await s.handler(event(WARM_ROUTE), CONTEXT);
    expect(status(res)).toBe(200);
    expect(parse(res)).toEqual({ status: "warm", commit: "abc1234" });
    expect(s.model.requests).toHaveLength(0);
  });

  test("read once per container: the second request reads no parameter", async () => {
    const s = setup({ steps: [textReply("x")] });
    await s.handler(event(WARM_ROUTE), CONTEXT);
    await s.handler(event(WARM_ROUTE), CONTEXT);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(2);
    expect(s.lines.map((l) => l.line.cold_start)).toEqual([true, false]);
  });

  test.each([
    ["the API key", KEY_PARAM],
    ["the history signing secret", SECRET_PARAM],
  ])(
    "%s missing: 503 'agent not configured' on both routes, the error class logged; a parameter placed later is read",
    async (_what, missing) => {
      ssm
        .on(GetParameterCommand, { Name: missing, WithDecryption: true })
        .rejects(
          new ParameterNotFound({
            message: "secret-free message",
            $metadata: {},
          }),
        );
      const s = setup({ steps: [textReply("x")] });
      for (const e of [
        event(WARM_ROUTE),
        event(ANSWER_ROUTE, { question: "q" }),
      ]) {
        const res = await s.handler(e, CONTEXT);
        expect(status(res)).toBe(503);
        expect(parse(res)).toEqual({ error: "agent not configured" });
      }
      expect(s.lines.map((l) => [l.line.status, l.line.error_class])).toEqual([
        ["not_configured", "ParameterNotFound"],
        ["not_configured", "ParameterNotFound"],
      ]);
      expect(s.model.requests).toHaveLength(0);
      // Mario places the parameter: the next request reads it (a failure is not kept).
      ssm
        .on(GetParameterCommand, { Name: missing, WithDecryption: true })
        .resolves({ Parameter: { Name: missing, Value: "placed-later" } });
      expect(status(await s.handler(event(WARM_ROUTE), CONTEXT))).toBe(200);
    },
  );

  test("an empty parameter, an unnamed one, an invalid configuration or no data API URL: 503 as well", async () => {
    ssm
      .on(GetParameterCommand, { Name: SECRET_PARAM, WithDecryption: true })
      .resolves({ Parameter: { Name: SECRET_PARAM, Value: "  " } });
    const empty = await setup().handler(event(WARM_ROUTE), CONTEXT);
    expect(status(empty)).toBe(503);
    for (const env of [
      { ...ENV, [HISTORY_SECRET_PARAMETER_ENV]: undefined },
      { ...ENV, AGENT_MODEL: "gpt" },
      { ...ENV, DATA_API_URL: undefined },
    ]) {
      const s = setup({ env });
      const res = await s.handler(event(WARM_ROUTE), CONTEXT);
      expect(status(res)).toBe(503);
      expect(s.lines[0]!.line.error_class).toMatch(
        /^(MissingParameterName|ConfigError|MissingDataApiUrl)$/,
      );
    }
  });
});

describe("POST /agent/answer and the signed history", () => {
  test("an answer: 200, the agent's answer and a signature over {history, session}; the data API got the caller's token", async () => {
    const s = setup({ steps: VAN_NUYS_STEPS });
    const res = await s.handler(
      event(ANSWER_ROUTE, {
        question:
          "Which properties within five miles of Van Nuys have roofs older than 15 years?",
      }),
      CONTEXT,
    );
    expect(status(res)).toBe(200);
    const a = parse(res) as unknown as AnswerResponse;
    expect(a.status).toBe("answered");
    expect(a.signature).toBe(
      signConversation(FAKE_SECRET, { history: a.history, session: a.session }),
    );
    expect(s.api.requests.map((r) => r.authorization)).toEqual(
      s.api.requests.map(() => `Bearer ${TOKEN}`),
    );
    expect(s.usd).toHaveLength(1);
    expect(s.lines[0]!.line).toMatchObject({
      status: "answered",
      http_status: 200,
      model_calls: 3,
      tool_calls: 2,
      tool_names_ok: ["resolve_place:ok", "search_aged_roofs:ok"],
      history_signature_ok: null,
    });
  });

  test("a follow-up with the history and session as returned (keys in any order) is accepted", async () => {
    const s = setup({
      steps: [...VAN_NUYS_STEPS, textReply("The same parcels, again.")],
    });
    const first = parse(
      await s.handler(
        event(ANSWER_ROUTE, { question: "Which roofs near Van Nuys are old?" }),
        CONTEXT,
      ),
    ) as unknown as AnswerResponse;
    // Re-built with every object's keys in reverse order: the MAC is over canonical JSON.
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverseKeys(x)]),
            )
          : v;
    const reversed = reverseKeys(first.session);
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(first.session));
    const res = await s.handler(
      event(ANSWER_ROUTE, {
        signature: first.signature,
        session: reversed,
        history: reverseKeys(first.history),
        question: "Say that again.",
      }),
      CONTEXT,
    );
    expect(status(res)).toBe(200);
    expect(parse(res).status).toBe("answered");
    expect(s.lines[1]!.line.history_signature_ok).toBe(true);
  });

  test("unsigned, altered (history or session), or signed with another secret: 400, no model call", async () => {
    const s = setup({ steps: VAN_NUYS_STEPS });
    const first = parse(
      await s.handler(
        event(ANSWER_ROUTE, { question: "Which roofs near Van Nuys are old?" }),
        CONTEXT,
      ),
    ) as unknown as AnswerResponse;
    const calls = s.model.requests.length;
    const forgedResult = structuredClone(first.history);
    (forgedResult[2]!.content as Array<{ content: string }>)[0]!.content =
      '{"items":[{"parcel_id":"9999999999"}]}';
    const cases = [
      { history: first.history, session: first.session },
      {
        history: forgedResult,
        session: first.session,
        signature: first.signature,
      },
      {
        history: first.history,
        session: { area: { ...first.session.area, radius_miles: 10 } },
        signature: first.signature,
      },
      {
        history: first.history,
        session: first.session,
        signature: signConversation("another-secret", first),
      },
      { history: first.history, session: first.session, signature: "x" },
    ];
    for (const c of cases) {
      const res = await s.handler(
        event(ANSWER_ROUTE, { question: "And there?", ...c }),
        CONTEXT,
      );
      expect(status(res)).toBe(400);
      expect(parse(res).error).toBe(
        "history refused: it is unsigned or was altered; start a new conversation",
      );
    }
    expect(s.model.requests).toHaveLength(calls);
    expect(s.lines.slice(1).map((l) => l.line.history_signature_ok)).toEqual(
      cases.map(() => false),
    );
  });

  test("the first question needs no signature: no history, or an empty history and session", async () => {
    const s = setup({ steps: [...VAN_NUYS_STEPS] });
    const res = await s.handler(
      event(ANSWER_ROUTE, {
        question: "Which roofs near Van Nuys are old?",
        history: [],
        session: {},
      }),
      CONTEXT,
    );
    expect(status(res)).toBe(200);
  });

  test("an off-topic question: the fixed text, signed; the refused turn is not added to the history", async () => {
    const s = setup({ steps: [textReply("Paris.")] });
    const res = parse(
      await s.handler(
        event(ANSWER_ROUTE, { question: "What is the capital of France?" }),
        CONTEXT,
      ),
    ) as unknown as AnswerResponse;
    expect(res).toMatchObject({
      status: "refused",
      refused_by: "no_tool_call",
      text: NO_TOOL_CALL_TEXT,
      history: [],
    });
    expect(res.signature).toBe(
      signConversation(FAKE_SECRET, { history: [], session: {} }),
    );
  });
});

describe("the request: cap, body, routes and clients", () => {
  test(`a body over ${MAX_BODY_BYTES} bytes: 413 before parsing (not even JSON); the parameters are not read`, async () => {
    const s = setup();
    const res = await s.handler(
      event(ANSWER_ROUTE, undefined, { raw: "x".repeat(MAX_BODY_BYTES + 1) }),
      CONTEXT,
    );
    expect(status(res)).toBe(413);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(s.lines[0]!.line).toMatchObject({
      status: "too_large",
      history_bytes: MAX_BODY_BYTES + 1,
    });
    // At the cap exactly the body is parsed (and refused here only as invalid JSON).
    const at = await s.handler(
      event(ANSWER_ROUTE, undefined, { raw: "x".repeat(MAX_BODY_BYTES) }),
      CONTEXT,
    );
    expect(status(at)).toBe(400);
  });

  test("the cap counts bytes, base64-decoded when the body is encoded", async () => {
    const s = setup();
    const big = Buffer.from("é".repeat(MAX_BODY_BYTES / 2 + 1)).toString(
      "base64",
    );
    const e = {
      ...event(ANSWER_ROUTE, undefined, { raw: big }),
      isBase64Encoded: true,
    };
    expect(status(await s.handler(e, CONTEXT))).toBe(413);
  });

  test("invalid bodies: 400 (not JSON, no question, an unknown field, a question over 2,000 characters)", async () => {
    const s = setup({ steps: [] });
    for (const raw of [
      "{",
      JSON.stringify({}),
      JSON.stringify({ question: "q", extra: 1 }),
      JSON.stringify({ question: "x".repeat(2001) }),
    ]) {
      const res = await s.handler(
        event(ANSWER_ROUTE, undefined, { raw }),
        CONTEXT,
      );
      expect(status(res)).toBe(400);
    }
    expect(s.model.requests).toHaveLength(0);
  });

  test("screen: a valid one is passed to the agent (its user turn); an invalid one is a 400 before any model call", async () => {
    const PIN = { lat: 34.20008, lon: -118.48111, label: "map pin" };
    const ok = setup({ steps: [textReply("x")] });
    const res = await ok.handler(
      event(ANSWER_ROUTE, {
        question: "Which properties here have old roofs?",
        center: PIN,
        screen: { radius_miles: 1, threshold_years: 15 },
      }),
      CONTEXT,
    );
    expect(status(res)).toBe(200);
    const turn = ok.model.requests[0]!.params.messages.at(-1)!;
    expect(JSON.stringify(turn.content)).toContain(
      "Screen values from the request: radius 1 mi, roof age threshold 15 years.",
    );
    const bad = setup({ steps: [] });
    for (const screen of [
      { radius_miles: 11, threshold_years: 15 },
      { radius_miles: 1, threshold_years: 0 },
      { radius_miles: "1", threshold_years: 15 },
      { radius_miles: 1 },
    ]) {
      const r = await bad.handler(
        event(ANSWER_ROUTE, {
          question: "Old roofs here?",
          center: PIN,
          screen,
        }),
        CONTEXT,
      );
      expect(status(r)).toBe(400);
      expect(String(parse(r).error)).toMatch(/^screen/);
    }
    expect(bad.model.requests).toHaveLength(0);
  });

  test("clients: crm and explorer only (403 for mcp or none); 401 without a bearer token; 404 another route", async () => {
    const s = setup();
    expect(
      status(
        await s.handler(
          event(WARM_ROUTE, undefined, { client: "explorer" }),
          CONTEXT,
        ),
      ),
    ).toBe(200);
    expect(
      status(
        await s.handler(
          event(WARM_ROUTE, undefined, { client: "mcp" }),
          CONTEXT,
        ),
      ),
    ).toBe(403);
    expect(
      status(
        await s.handler(
          event(WARM_ROUTE, undefined, { client: null }),
          CONTEXT,
        ),
      ),
    ).toBe(403);
    expect(
      status(
        await s.handler(
          event(ANSWER_ROUTE, { question: "q" }, { token: null }),
          CONTEXT,
        ),
      ),
    ).toBe(401);
    expect(status(await s.handler(event("GET /agent/other"), CONTEXT))).toBe(
      404,
    );
  });
});

describe("the one log line", () => {
  /** Words of the question, its center and the answer that must never be logged. */
  const QUESTION =
    "Which zebrafinch properties near Quillborough within five miles have roofs older than 15 years?";
  const CENTER = { lat: 34.123456, lon: -118.654321, label: "Marmaduke pin" };
  const CANARIES = [
    "zebrafinch",
    "Quillborough",
    "Marmaduke",
    "34.123456",
    "-118.654321",
    "34.12346",
    FAKE_PARCELS[0]!,
    "Velvetanswer",
    TOKEN,
    FAKE_KEY,
    FAKE_SECRET,
  ];

  test("with the real Powertools logger and metrics: one agent_answer line of counts; no question word, coordinate, parcel ID, answer word, token or secret anywhere in the output", async () => {
    const out: string[] = [];
    const capture = (chunk: unknown) => {
      out.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    vi.spyOn(console, "log").mockImplementation(
      (...a: unknown[]) => void out.push(a.map(String).join(" ")),
    );
    vi.spyOn(console, "info").mockImplementation(
      (...a: unknown[]) => void out.push(a.map(String).join(" ")),
    );
    vi.spyOn(console, "warn").mockImplementation(
      (...a: unknown[]) => void out.push(a.map(String).join(" ")),
    );
    const real = defaultDeps();
    const model = new ScriptedModel([
      () =>
        toolReply([
          {
            name: "search_aged_roofs",
            input: { lat: CENTER.lat, lon: CENTER.lon, radius_miles: 5 },
          },
        ]),
      textReply(`Velvetanswer: parcel ${FAKE_PARCELS[0]} near Quillborough.`),
    ]);
    const api = fakeDataApi(fakeQueries().queries);
    const handler = createHandler({
      ...real,
      env: ENV,
      ssm: new SSMClient({}),
      modelFor: () => model,
      dataFetch: api.fetch,
    });
    const res = await handler(
      event(ANSWER_ROUTE, { question: QUESTION, center: CENTER }),
      CONTEXT,
    );
    vi.restoreAllMocks();
    expect(status(res)).toBe(200);
    const text = out.join("");
    const lines = text.split("\n").filter((l) => l.includes('"agent_answer"'));
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(logged).toMatchObject({
      message: "agent_answer",
      request_id: "req-1",
      client: "crm",
      status: "answered",
      model_calls: 2,
      tool_calls: 1,
      tool_names_ok: ["search_aged_roofs:ok"],
      question_chars: QUESTION.length,
      history_messages: 0,
      provider: "anthropic",
      effort: "low",
    });
    for (const c of CANARIES) expect(text).not.toContain(c);
    // The metric line (EMF) is there too, with the spend only.
    expect(text).toContain("AgentAnswerUsd");
  });

  test("the line's keys are exactly the allowlist", async () => {
    const s = setup({ steps: VAN_NUYS_STEPS });
    await s.handler(
      event(ANSWER_ROUTE, { question: "Which roofs near Van Nuys are old?" }),
      CONTEXT,
    );
    expect(Object.keys(s.lines[0]!.line).sort()).toEqual(
      [
        "request_id",
        "route",
        "http_status",
        "client",
        "cold_start",
        "status",
        "refused_by",
        "stopped_by",
        "error_class",
        "provider",
        "model_id",
        "effort",
        "model_calls",
        "tool_calls",
        "tool_names_ok",
        "input_tokens",
        "output_tokens",
        "cache_write_tokens",
        "cache_read_tokens",
        "usd_estimate",
        "elapsed_ms",
        "question_chars",
        "history_messages",
        "history_bytes",
        "records_cited",
        "gaps_count",
        "unverified_ids_count",
        "history_signature_ok",
      ].sort(),
    );
  });
});
