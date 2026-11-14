/**
 * The two secrets of the hosted agent, read from SSM Parameter Store (SecureString, alias/aws/ssm) on first use and
 * kept in memory for the container's life (hosting plan revision 2 §1; approvals §3e.74.1, §3e.76): the Anthropic
 * API key and the history signing secret. Only their names come from the environment (KEY_PARAMETER_NAME,
 * HISTORY_SECRET_PARAMETER_NAME); the values never go to disk, an argument, the environment or a log. A read that
 * fails is not kept, so a parameter placed after a cold start is read by the next request. Missing, empty or
 * unreadable → AgentNotConfiguredError (the handler answers 503 "agent not configured" and logs the class only).
 */
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

/** The environment variables that name the two parameters. */
export const KEY_PARAMETER_ENV = "KEY_PARAMETER_NAME";
export const HISTORY_SECRET_PARAMETER_ENV = "HISTORY_SECRET_PARAMETER_NAME";

export interface AgentSecrets {
  anthropicApiKey: string;
  historySigningSecret: string;
}

/** A parameter is not named, missing, empty or unreadable. `cause` holds the SDK error (its class is logged). */
export class AgentNotConfiguredError extends Error {
  /** The class name of what failed (e.g. ParameterNotFound, AccessDeniedException), never its message. */
  readonly errorClass: string;
  constructor(errorClass: string, options?: { cause?: unknown }) {
    super("agent not configured", options);
    this.name = "AgentNotConfiguredError";
    this.errorClass = errorClass;
  }
}

const className = (err: unknown): string =>
  err instanceof Error ? err.name || "Error" : "UnknownError";

async function readParameter(ssm: SSMClient, name: string): Promise<string> {
  let value: string | undefined;
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    value = res.Parameter?.Value;
  } catch (err) {
    throw new AgentNotConfiguredError(className(err), { cause: err });
  }
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new AgentNotConfiguredError("EmptyParameter");
  return trimmed;
}

/** Reads both parameters once (both in parallel); later calls reuse the values. A failure is retried next call. */
export function secretsLoader(
  ssm: SSMClient,
  env: Record<string, string | undefined>,
): () => Promise<AgentSecrets> {
  let loaded: Promise<AgentSecrets> | undefined;
  return () =>
    (loaded ??= (async () => {
      const keyName = env[KEY_PARAMETER_ENV];
      const secretName = env[HISTORY_SECRET_PARAMETER_ENV];
      if (!keyName || !secretName)
        throw new AgentNotConfiguredError("MissingParameterName");
      const [anthropicApiKey, historySigningSecret] = await Promise.all([
        readParameter(ssm, keyName),
        readParameter(ssm, secretName),
      ]);
      return { anthropicApiKey, historySigningSecret };
    })().catch((err: unknown) => {
      loaded = undefined;
      throw err;
    }));
}
