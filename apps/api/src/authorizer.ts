/**
 * HTTP API Lambda authorizer (payload 2.0, simple responses). Allowed tokens are the SHA-256 hashes
 * stored as SSM String parameters under TOKEN_HASH_PATH, one per client at <path><client>/token-sha256.
 * Constant-time compare. An allowed request carries the matched client's name in the authorizer context
 * (`context.client`); the data API ignores it, the CRM leads API accepts only "crm".
 * Never logs the header or the token.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Context } from "aws-lambda";

const logger = new Logger();
const metrics = new Metrics();
const ssm = new SSMClient({});
const CACHE_MS = 5 * 60_000;
export interface ClientHash {
  client: string;
  hash: Buffer;
}
let cache: { at: number; hashes: ClientHash[] } | undefined;

export async function loadHashes(
  client: SSMClient = ssm,
  path = process.env.TOKEN_HASH_PATH!,
): Promise<ClientHash[]> {
  const hashes: ClientHash[] = [];
  let NextToken: string | undefined;
  do {
    const res = await client.send(
      new GetParametersByPathCommand({
        Path: path,
        Recursive: true,
        NextToken,
      }),
    );
    for (const p of res.Parameters ?? []) {
      const client = /\/([^/]+)\/token-sha256$/.exec(p.Name ?? "")?.[1];
      if (client && /^[0-9a-f]{64}$/.test(p.Value ?? ""))
        hashes.push({ client, hash: Buffer.from(p.Value!, "hex") });
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return hashes;
}

/** The client whose token hash matches the Bearer token, or undefined. Compares against every hash. */
export function matchClient(
  authorization: string | undefined,
  hashes: ClientHash[],
): string | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const got = createHash("sha256").update(authorization.slice(7)).digest();
  let match: string | undefined;
  for (const h of hashes)
    if (h.hash.length === 32 && timingSafeEqual(got, h.hash))
      match ??= h.client;
  return match;
}

export const isAllowed = (
  authorization: string | undefined,
  hashes: ClientHash[],
): boolean => matchClient(authorization, hashes) !== undefined;

export const handler = async (
  event: { headers?: Record<string, string | undefined>; routeKey?: string },
  context: Context,
) => {
  logger.addContext(context);
  metrics.captureColdStartMetric();
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS)
      cache = { at: Date.now(), hashes: await loadHashes() };
    const client = matchClient(event.headers?.authorization, cache.hashes);
    const isAuthorized = client !== undefined;
    if (!isAuthorized) metrics.addMetric("AuthDenied", MetricUnit.Count, 1);
    logger.info("authorizer decision", {
      routeKey: event.routeKey,
      isAuthorized,
      client,
      clients: cache.hashes.length,
    });
    return isAuthorized
      ? { isAuthorized, context: { client } }
      : { isAuthorized };
  } finally {
    metrics.publishStoredMetrics();
  }
};
