/**
 * HTTP API Lambda authorizer (payload 2.0, simple responses). Allowed tokens are the SHA-256 hashes
 * stored as SSM String parameters under TOKEN_HASH_PATH (one per client). Constant-time compare.
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
let cache: { at: number; hashes: Buffer[] } | undefined;

export async function loadHashes(
  client: SSMClient = ssm,
  path = process.env.TOKEN_HASH_PATH!,
): Promise<Buffer[]> {
  const hashes: Buffer[] = [];
  let NextToken: string | undefined;
  do {
    const res = await client.send(
      new GetParametersByPathCommand({
        Path: path,
        Recursive: true,
        NextToken,
      }),
    );
    for (const p of res.Parameters ?? [])
      if (
        p.Name?.endsWith("/token-sha256") &&
        /^[0-9a-f]{64}$/.test(p.Value ?? "")
      )
        hashes.push(Buffer.from(p.Value!, "hex"));
    NextToken = res.NextToken;
  } while (NextToken);
  return hashes;
}

export function isAllowed(
  authorization: string | undefined,
  hashes: Buffer[],
): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const got = createHash("sha256").update(authorization.slice(7)).digest();
  let ok = false;
  for (const h of hashes)
    ok = (h.length === 32 && timingSafeEqual(got, h)) || ok;
  return ok;
}

export const handler = async (
  event: { headers?: Record<string, string | undefined>; routeKey?: string },
  context: Context,
) => {
  logger.addContext(context);
  metrics.captureColdStartMetric();
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS)
      cache = { at: Date.now(), hashes: await loadHashes() };
    const isAuthorized = isAllowed(event.headers?.authorization, cache.hashes);
    if (!isAuthorized) metrics.addMetric("AuthDenied", MetricUnit.Count, 1);
    logger.info("authorizer decision", {
      routeKey: event.routeKey,
      isAuthorized,
      clients: cache.hashes.length,
    });
    return { isAuthorized };
  } finally {
    metrics.publishStoredMetrics();
  }
};
