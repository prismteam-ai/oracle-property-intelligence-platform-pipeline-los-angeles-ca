/**
 * The public IPFS gateways the publication is checked on and linked to: the one list in the code (the gateway
 * check, src/gateway-verify.ts, and the Explorer import it). Pure, with no Node imports, so the Explorer can bundle it.
 *
 * Each gateway is answered in path form, https://<host>/ipfs/<cid>[/<path>], and has a declared operator: who runs
 * it. The gateway check counts a match only on gateways whose operator does not pin the content (--pinned-by), and
 * needs two counted operators.
 *
 * Default list (measured 18 Nov 2026, approvals §3e.132): ipfs.aleph.cloud and ipfs.filebase.io returned the
 * rehearsal file, the file inside the rehearsal folder and the folder as a CAR, root block first; gateway.pinata.cloud
 * returned the file, and in the night's gateway check also the file inside the folder and the folder CAR. The two
 * gateways the assignment gives as examples answer non-browser requests with HTTP 429 (retired 21 Sep 2026) and are
 * not listed.
 *
 * The check takes another list through --gateway or IPFS_GATEWAYS (parseGatewayList): "host=Operator" items,
 * comma-separated in the variable; every item must declare its operator.
 */

export interface Gateway {
  /** A host name (https), or an origin: https://<host>[:port], or http:// for a local test gateway only. */
  host: string;
  /** Who runs the gateway. */
  operator: string;
}

export const GATEWAYS: readonly Gateway[] = Object.freeze([
  { host: "ipfs.aleph.cloud", operator: "Aleph.im" },
  { host: "gateway.pinata.cloud", operator: "Pinata" },
  { host: "ipfs.filebase.io", operator: "Filebase" },
]);

const NAME =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(:\d{1,5})?$/i;

/** The parts of a gateway's host field: scheme (https when only a host is given), host name, port. */
export function gatewayParts(
  host: string,
): { scheme: "https" | "http"; name: string; port: string } | null {
  const m = /^(?:(https?):\/\/)?([^/?#]+)$/i.exec(host);
  if (!m || !NAME.test(m[2])) return null;
  const at = m[2].lastIndexOf(":");
  const hasPort = at > m[2].lastIndexOf("]") && at > 0;
  return {
    scheme: (m[1]?.toLowerCase() ?? "https") as "https" | "http",
    name: (hasPort ? m[2].slice(0, at) : m[2]).toLowerCase(),
    port: hasPort ? m[2].slice(at + 1) : "",
  };
}

/** Whether a host field is well formed (any scheme; see localGatewayProblem for what a real run accepts). */
export function isGatewayHost(host: string): boolean {
  return gatewayParts(host) !== null;
}

function ipv4(name: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

/**
 * Why a gateway is not acceptable in a real run, or null: not https, or a local or private address written in the
 * host: localhost, IPv4 0.0.0.0/8, loopback 127/8, RFC 1918 (10/8, 172.16/12, 192.168/16), link-local 169.254/16;
 * IPv6 unspecified (::), loopback (::1), link-local (fe80::/10), unique-local (fc00::/7), and IPv4-mapped forms of
 * the IPv4 ranges. Host names are not resolved (no DNS lookup here).
 */
export function localGatewayProblem(g: Gateway): string | null {
  const p = gatewayParts(g.host);
  if (!p) return `not a gateway host: "${g.host}"`;
  if (p.scheme !== "https") return `${g.host}: not https`;
  const name = p.name;
  if (name === "localhost" || name.endsWith(".localhost"))
    return `${g.host}: a local host name`;
  const v4 =
    ipv4(name) ??
    (/^\[::ffff:([\d.]+)\]$/i.exec(name)
      ? ipv4(/^\[::ffff:([\d.]+)\]$/i.exec(name)![1])
      : null);
  if (v4) {
    const [a, b] = v4;
    if (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
      return `${g.host}: a loopback, private or link-local address`;
    return null;
  }
  if (name.startsWith("[")) {
    const v6 = name.slice(1, -1);
    if (
      /^(0*:)*:?0*$/.test(v6) || // :: (unspecified)
      /^(0*:)*:?0*1$/.test(v6) || // ::1 (loopback)
      /^fe[89ab][0-9a-f]?:/.test(v6) || // fe80::/10
      /^f[cd][0-9a-f]{0,2}:/.test(v6) // fc00::/7
    )
      return `${g.host}: a loopback, unique-local or link-local IPv6 address`;
  }
  return null;
}

/** The gateway's origin: https://<host> for a bare host, else the origin as given. */
export function gatewayOrigin(g: Gateway): string {
  const p = gatewayParts(g.host);
  if (!p) throw new Error(`not a gateway host: "${g.host}"`);
  return `${p.scheme}://${p.name}${p.port ? `:${p.port}` : ""}`;
}

/** Path-form URL of a CID on a gateway, with an optional path inside it (each segment URI-encoded). */
export function gatewayPathUrl(g: Gateway, cid: string, path?: string): string {
  const inside = path
    ? "/" + path.split("/").map(encodeURIComponent).join("/")
    : "";
  return `${gatewayOrigin(g)}/ipfs/${cid}${inside}`;
}

/** Whether a URL is on the gateway's own host or one of its subdomains (a redirect to <cid>.ipfs.<host>, say). */
export function onGatewayHost(g: Gateway, url: string): boolean {
  const p = gatewayParts(g.host);
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  const q = m ? gatewayParts(m[1]) : null;
  if (!p || !q) return false;
  return q.name === p.name || q.name.endsWith(`.${p.name}`);
}

/**
 * A gateway list from "host=Operator" items (comma-separated, or as separate items). Throws on an empty list, an
 * item without its operator, a bad host or a host given twice.
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
    if (at < 0)
      throw new Error(
        `gateway "${p}" has no declared operator (write it as host=Operator)`,
      );
    const host = p.slice(0, at).trim();
    const operator = p.slice(at + 1).trim();
    if (!isGatewayHost(host)) throw new Error(`not a gateway host: "${host}"`);
    if (!operator) throw new Error(`gateway ${host} has no declared operator`);
    return { host, operator };
  });
  if (new Set(out.map((g) => gatewayOrigin(g))).size !== out.length)
    throw new Error("a gateway host is listed twice");
  return out;
}
