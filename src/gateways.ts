/**
 * The public IPFS gateways the publication is checked on and linked to: the one list in the code (the gateway
 * check, src/gateway-verify.ts, and the Explorer import it). Pure, with no Node imports, so the Explorer can bundle it.
 *
 * Each gateway is answered in path form, https://<host>/ipfs/<cid>[/<path>]. The operator is who runs it; the
 * gateway check passes a file only when it matches on at least two gateways of different operators.
 *
 * Default list (measured 18 Nov 2026, approvals §3e.132): ipfs.aleph.cloud and ipfs.filebase.io returned the
 * rehearsal file, the file inside the rehearsal folder and the folder as a CAR, root block first; gateway.pinata.cloud
 * returned the file. ipfs.io and dweb.link answer non-browser requests with HTTP 429 and are not listed.
 *
 * The check takes another list through --gateway or IPFS_GATEWAYS (parseGatewayList): "host=Operator" items,
 * comma-separated in the variable.
 */

export interface Gateway {
  /** Host name (and optional port), or for a loopback test gateway an http:// origin. */
  host: string;
  /** Who runs the gateway. */
  operator: string;
}

export const GATEWAYS: readonly Gateway[] = Object.freeze([
  { host: "ipfs.aleph.cloud", operator: "Aleph.im" },
  { host: "gateway.pinata.cloud", operator: "Pinata" },
  { host: "ipfs.filebase.io", operator: "Filebase" },
]);

const HOST =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;

/** Whether a host is accepted: a plain host name (https), or an http:// loopback origin for tests. */
export function isGatewayHost(host: string): boolean {
  return HOST.test(host) || LOOPBACK.test(host);
}

/** The gateway's origin: https://<host>, or the loopback origin as given. */
export function gatewayOrigin(g: Gateway): string {
  if (!isGatewayHost(g.host))
    throw new Error(`not a gateway host: "${g.host}"`);
  return g.host.startsWith("http://") ? g.host : `https://${g.host}`;
}

/** Path-form URL of a CID on a gateway, with an optional path inside it (each segment URI-encoded). */
export function gatewayPathUrl(g: Gateway, cid: string, path?: string): string {
  const inside = path
    ? "/" + path.split("/").map(encodeURIComponent).join("/")
    : "";
  return `${gatewayOrigin(g)}/ipfs/${cid}${inside}`;
}

/**
 * A gateway list from "host=Operator" items (comma-separated, or as separate items). An item without
 * "=Operator" is its own operator (its host). Throws on an empty list, a bad host or a host given twice.
 */
export function parseGatewayList(items: string | readonly string[]): Gateway[] {
  const parts = (
    typeof items === "string"
      ? items.split(",")
      : items.flatMap((i) => i.split(","))
  )
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("the gateway list is empty");
  const out = parts.map((p) => {
    const at = p.indexOf("=");
    const host = (at < 0 ? p : p.slice(0, at)).trim();
    const operator = (at < 0 ? host : p.slice(at + 1)).trim();
    if (!isGatewayHost(host)) throw new Error(`not a gateway host: "${host}"`);
    if (!operator) throw new Error(`no operator for ${host}`);
    return { host, operator };
  });
  if (new Set(out.map((g) => g.host)).size !== out.length)
    throw new Error("a gateway host is listed twice");
  return out;
}
