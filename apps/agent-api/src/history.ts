/**
 * The conversation the client holds between questions, signed by the server:
 * HMAC-SHA256 with the history signing secret (its own SSM SecureString, never derived from the API key)
 * over {history, session}. The client sends back exactly what it received; a history or session that is unsigned or
 * altered is refused, so a client cannot plant tool results (which would make invented IDs count as verified) or
 * earlier turns. The request body is capped at MAX_BODY_BYTES before it is parsed.
 *
 * The MAC is over a canonical JSON text (object keys sorted at every depth), so the client may re-serialize the
 * JSON it received in any key order.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Largest request body accepted, checked on the raw bytes before parsing (200 KB). */
export const MAX_BODY_BYTES = 200 * 1024;

/** The domain of the MAC, so this secret's MACs cannot be reused for anything else. */
const DOMAIN = "oracle-la-agent history v1\n";

/** JSON with every object's keys sorted (arrays keep their order); undefined members are left out as JSON does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface Conversation {
  history: unknown[];
  session: unknown;
}

/** base64url HMAC-SHA256 of the conversation under the secret. */
export function signConversation(secret: string, c: Conversation): string {
  return createHmac("sha256", secret)
    .update(DOMAIN)
    .update(canonicalJson({ history: c.history, session: c.session }))
    .digest("base64url");
}

/** True when `signature` is the conversation's MAC under the secret (constant-time compare). */
export function verifyConversation(
  secret: string,
  c: Conversation,
  signature: unknown,
): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(signature))
    return false;
  const want = Buffer.from(signConversation(secret, c), "base64url");
  const got = Buffer.from(signature, "base64url");
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A conversation with nothing in it (the first question): needs no signature. */
export function isEmptyConversation(c: {
  history?: unknown;
  session?: unknown;
}): boolean {
  const emptyHistory =
    c.history === undefined ||
    (Array.isArray(c.history) && c.history.length === 0);
  const emptySession =
    c.session === undefined ||
    (typeof c.session === "object" &&
      c.session !== null &&
      !Array.isArray(c.session) &&
      Object.keys(c.session).length === 0);
  return emptyHistory && emptySession;
}
