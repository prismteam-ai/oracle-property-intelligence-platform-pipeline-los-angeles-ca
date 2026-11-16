/**
 * The hosted agent's Lambda handler (HTTP API, payload 2.0), for the OracleLaAgentApi stack to bundle
 * (`apps/agent-api/src/handler.ts`, export `handler`). Routes, both behind the shared token authorizer:
 * - POST /agent/answer: one answer per request; body { question, center?, screen?, history?, session?, signature? }.
 * - GET /agent/warm: loads the configuration and reads both SSM parameters, builds the model client; no model call.
 *
 * Environment (names only, no secret): DATA_API_URL; KEY_PARAMETER_NAME and HISTORY_SECRET_PARAMETER_NAME (the two
 * SecureStrings /oracle-la/agent/anthropic-api-key and /oracle-la/agent/history-signing-secret); the AGENT_*
 * settings of @oracle-la/agent config.ts (AGENT_PROVIDER, AGENT_MODEL, AGENT_EFFORT, AGENT_MAX_TOOL_TURNS,
 * AGENT_MAX_TOKENS, AGENT_MAX_OUTPUT_TOKENS, AGENT_TIME_BUDGET_MS); POWERTOOLS_SERVICE_NAME and
 * POWERTOOLS_METRICS_NAMESPACE for the log line and the AgentAnswerUsd metric.
 *
 * Responses: 200 the answer (AgentAnswer plus `signature`, the MAC of the returned {history, session}); 400 an
 * invalid body or a refused history (unsigned or altered); 401 no bearer token; 403 a client other than crm or
 * explorer; 404 another route; 413 a body over 200 KB (checked before parsing); 503 "agent not configured" (a
 * parameter missing, empty or unreadable, or the configuration invalid); 500 anything else (class logged only).
 *
 * The caller's own bearer token is forwarded to the data API for the tools' reads (held in memory for the request
 * only). No X-Ray tracer is attached to outbound calls: their URLs carry the tools' inputs in the query string.
 */
import { Buffer } from "node:buffer";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { SSMClient } from "@aws-sdk/client-ssm";
import {
  InvalidRequestError,
  anthropicModelClient,
  createModelClient,
  httpDataQueries,
  isPricedModel,
  loadConfig,
  runAgent,
  usageCostUsd,
  type AgentAnswer,
  type AgentConfig,
  type AgentRequest,
  type HttpDataQueriesOptions,
  type ModelClient,
  type SessionState,
} from "@oracle-la/agent";
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import { z } from "zod";
import {
  MAX_BODY_BYTES,
  isEmptyConversation,
  signConversation,
  verifyConversation,
} from "./history.ts";
import {
  answerCounts,
  emptyLine,
  toolNamesOk,
  type AgentLogLine,
} from "./log.ts";
import {
  AgentNotConfiguredError,
  secretsLoader,
  type AgentSecrets,
} from "./secrets.ts";

/** The clients the agent serves (the authorizer's context.client); the "mcp" client reads data routes only. */
export const AGENT_CLIENTS: ReadonlySet<string> = new Set(["crm", "explorer"]);
export const ANSWER_ROUTE = "POST /agent/answer";
export const WARM_ROUTE = "GET /agent/warm";
export const NOT_CONFIGURED = "agent not configured";

export type AgentEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<{
  client?: string;
}>;

/** The answer as the route returns it: the agent's answer and the signature of its {history, session}. */
export type AnswerResponse = AgentAnswer & { signature: string };

export interface HandlerDeps {
  env: Record<string, string | undefined>;
  ssm: SSMClient;
  /** Writes the one structured line per request. */
  log: (message: string, line: AgentLogLine) => void;
  /** Records the answer's estimated spend (AgentAnswerUsd) and flushes it at the end of the request. */
  metrics: { answerUsd: (usd: number) => void; flush: () => void };
  /** The model client for the configuration (default: provider "anthropic" from the key in memory). */
  modelFor?: (apiKey: string, config: AgentConfig) => ModelClient;
  /** The data API adapter's fetch (default the global fetch; tests pass a fake data API). */
  dataFetch?: HttpDataQueriesOptions["fetch"];
  now?: () => number;
}

const bodySchema = z.strictObject({
  question: z.string(),
  center: z.unknown().optional(),
  screen: z.unknown().optional(),
  history: z.array(z.unknown()).optional(),
  session: z.unknown().optional(),
  signature: z.string().optional(),
});

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
  },
  body: JSON.stringify(body),
});

const className = (err: unknown): string =>
  err instanceof Error ? err.name || "Error" : "UnknownError";

const defaultModelFor = (apiKey: string, config: AgentConfig): ModelClient =>
  config.provider === "anthropic"
    ? anthropicModelClient(apiKey)
    : createModelClient({ provider: config.provider });

interface Ready {
  config: AgentConfig;
  dataApiUrl: string;
  secrets: AgentSecrets;
  model: ModelClient;
}

/** The handler over its dependencies (the exported `handler` uses the real ones). */
export function createHandler(deps: HandlerDeps) {
  const now = deps.now ?? Date.now;
  const loadSecrets = secretsLoader(deps.ssm, deps.env);
  const modelFor = deps.modelFor ?? defaultModelFor;
  let config: AgentConfig | undefined;
  let model: { key: string; client: ModelClient } | undefined;
  let cold = true;

  /** Configuration, both secrets and the model client; AgentNotConfiguredError when any is missing. */
  async function ready(): Promise<Ready> {
    let cfg: AgentConfig;
    try {
      cfg = config ??= loadConfig(deps.env);
    } catch (err) {
      throw new AgentNotConfiguredError(className(err), { cause: err });
    }
    const dataApiUrl = deps.env.DATA_API_URL;
    if (!dataApiUrl) throw new AgentNotConfiguredError("MissingDataApiUrl");
    const secrets = await loadSecrets();
    if (model?.key !== secrets.anthropicApiKey)
      model = {
        key: secrets.anthropicApiKey,
        client: (() => {
          try {
            return modelFor(secrets.anthropicApiKey, cfg);
          } catch (err) {
            throw new AgentNotConfiguredError(className(err), { cause: err });
          }
        })(),
      };
    return { config: cfg, dataApiUrl, secrets, model: model.client };
  }

  return async function handler(
    event: AgentEvent,
    context: Pick<Context, "awsRequestId">,
  ): Promise<APIGatewayProxyResultV2> {
    const start = now();
    const client = event.requestContext.authorizer?.lambda?.client ?? null;
    const line = emptyLine({
      request_id: context.awsRequestId,
      route: event.routeKey,
      client,
      cold_start: cold,
    });
    cold = false;
    const finish = (
      res: APIGatewayProxyResultV2,
      status: string,
    ): APIGatewayProxyResultV2 => {
      line.http_status =
        typeof res === "object" && "statusCode" in res
          ? (res.statusCode ?? 200)
          : 200;
      line.status ||= status;
      line.elapsed_ms = now() - start;
      deps.log(
        event.routeKey === WARM_ROUTE ? "agent_warm" : "agent_answer",
        line,
      );
      deps.metrics.flush();
      return res;
    };

    try {
      if (event.routeKey !== ANSWER_ROUTE && event.routeKey !== WARM_ROUTE)
        return finish(json(404, { error: "not found" }), "not_found");
      if (client === null || !AGENT_CLIENTS.has(client))
        return finish(json(403, { error: "forbidden" }), "forbidden");

      if (event.routeKey === WARM_ROUTE) {
        try {
          const r = await ready();
          line.provider = r.config.provider;
          line.model_id = r.config.modelId;
          line.effort = r.config.effort;
        } catch (err) {
          if (!(err instanceof AgentNotConfiguredError)) throw err;
          line.error_class = err.errorClass;
          return finish(json(503, { error: NOT_CONFIGURED }), "not_configured");
        }
        return finish(json(200, { status: "warm" }), "warm");
      }

      // The body: capped on its raw bytes before anything parses it.
      const raw = event.body ?? "";
      const bytes = event.isBase64Encoded
        ? Buffer.from(raw, "base64")
        : Buffer.from(raw, "utf8");
      line.history_bytes = bytes.length;
      if (bytes.length > MAX_BODY_BYTES)
        return finish(
          json(413, {
            error: `request too large: at most ${MAX_BODY_BYTES} bytes`,
          }),
          "too_large",
        );
      const token = /^Bearer\s+(\S+)$/i.exec(
        event.headers?.authorization ?? "",
      )?.[1];
      if (!token)
        return finish(json(401, { error: "unauthorized" }), "unauthorized");

      let r: Ready;
      try {
        r = await ready();
      } catch (err) {
        if (!(err instanceof AgentNotConfiguredError)) throw err;
        line.error_class = err.errorClass;
        return finish(json(503, { error: NOT_CONFIGURED }), "not_configured");
      }
      line.provider = r.config.provider;
      line.model_id = r.config.modelId;
      line.effort = r.config.effort;

      let parsed: z.infer<typeof bodySchema>;
      try {
        const body = bodySchema.safeParse(JSON.parse(bytes.toString("utf8")));
        if (!body.success) throw new InvalidRequestError("invalid body");
        parsed = body.data;
      } catch {
        return finish(
          json(400, {
            error:
              "invalid body: expected JSON { question, center?, screen?, history?, session?, signature? }",
          }),
          "invalid",
        );
      }
      line.question_chars = parsed.question.length;
      line.history_messages = parsed.history?.length ?? 0;

      // The conversation must come back exactly as this server signed it (or be empty: the first question).
      if (!isEmptyConversation(parsed)) {
        const ok = verifyConversation(
          r.secrets.historySigningSecret,
          { history: parsed.history ?? [], session: parsed.session ?? {} },
          parsed.signature,
        );
        line.history_signature_ok = ok;
        if (!ok)
          return finish(
            json(400, {
              error:
                "history refused: it is unsigned or was altered; start a new conversation",
            }),
            "history_refused",
          );
      }

      const metered = meter(r.model);
      let answer: AgentAnswer;
      try {
        answer = await runAgent(
          {
            question: parsed.question,
            center: parsed.center as AgentRequest["center"],
            screen: parsed.screen as AgentRequest["screen"],
            history: (parsed.history ?? []) as AgentRequest["history"],
            session: (parsed.session ?? {}) as SessionState,
          },
          {
            model: metered.client,
            queries: httpDataQueries({
              apiUrl: r.dataApiUrl,
              apiToken: token,
              deadline: start + r.config.timeBudgetMs,
              now,
              ...(deps.dataFetch ? { fetch: deps.dataFetch } : {}),
            }),
            settings: r.config,
            now,
          },
        );
      } catch (err) {
        if (!(err instanceof InvalidRequestError)) throw err;
        return finish(json(400, { error: err.message }), "invalid");
      }

      Object.assign(line, answerCounts(answer));
      line.tool_names_ok = toolNamesOk(
        answer.history,
        parsed.history?.length ?? 0,
      );
      const u = metered.usage;
      line.input_tokens = u.input_tokens;
      line.output_tokens = u.output_tokens;
      line.cache_write_tokens = u.cache_creation_input_tokens;
      line.cache_read_tokens = u.cache_read_input_tokens;
      line.usd_estimate = isPricedModel(r.config.model)
        ? Number(usageCostUsd(r.config.provider, r.config.model, u).toFixed(6))
        : null;
      if (line.usd_estimate !== null) deps.metrics.answerUsd(line.usd_estimate);
      const response: AnswerResponse = {
        ...answer,
        signature: signConversation(r.secrets.historySigningSecret, {
          history: answer.history,
          session: answer.session,
        }),
      };
      return finish(json(200, response), answer.status);
    } catch (err) {
      line.error_class = className(err);
      return finish(json(500, { error: "internal error" }), "error");
    }
  };
}

/** A model client that sums each call's usage (input, cache writes and reads, output) for the cost estimate. */
function meter(inner: ModelClient): {
  client: ModelClient;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
} {
  const usage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  return {
    usage,
    client: {
      async create(params, opts) {
        const res = await inner.create(params, opts);
        usage.input_tokens += res.usage.input_tokens;
        usage.cache_creation_input_tokens +=
          res.usage.cache_creation_input_tokens ?? 0;
        usage.cache_read_input_tokens += res.usage.cache_read_input_tokens ?? 0;
        usage.output_tokens += res.usage.output_tokens;
        return res;
      },
    },
  };
}

/** The real dependencies: Powertools Logger and Metrics, the SDK's SSM client, the process environment. */
export function defaultDeps(): HandlerDeps {
  const logger = new Logger();
  const metrics = new Metrics();
  let added = false;
  return {
    env: process.env,
    ssm: new SSMClient({}),
    log: (message, line) => logger.info(message, { ...line }),
    metrics: {
      answerUsd: (usd) => {
        metrics.addMetric("AgentAnswerUsd", MetricUnit.NoUnit, usd);
        added = true;
      },
      // Only when the request added the metric (no empty-metrics warning on refusals and warm-ups).
      flush: () => {
        if (added) metrics.publishStoredMetrics();
        added = false;
      },
    },
  };
}

/** The Lambda entry point. */
export const handler = createHandler(defaultDeps());
