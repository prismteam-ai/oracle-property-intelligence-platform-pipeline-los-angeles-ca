/**
 * API clients from apps/api/cdk/clients.json. A browser client's origin is either a literal `origin` or
 * `amplifyBranch`: a branch of the Amplify app whose ID is in the SSM parameter `amplifyAppIdParameter`,
 * read at deploy time, so no app ID sits in tracked files. A client that never runs in a browser (the local
 * MCP server) says so with `browser: false` and has no origin. The origins drive the HTTP API's CORS; the
 * names drive the per-client token-hash SSM parameters.
 */
export interface ClientEntry {
  name: string;
  origin?: string;
  amplifyBranch?: string;
  /** false: not a browser client, so no CORS origin (the only accepted value; omit it otherwise). */
  browser?: false;
}
export interface ClientsFile {
  amplifyAppIdParameter?: string;
  clients: ClientEntry[];
}

const NAME = /^[a-z][a-z0-9-]*$/;
const ORIGIN = /^https:\/\/[a-z0-9.-]+$/;
const BRANCH = /^[a-z0-9][a-z0-9-]*$/;
const PARAMETER = /^\/[\w./-]+$/;

/**
 * Checks clients.json: unique names; exactly one of origin, amplifyBranch and browser: false per client (so a
 * browser client cannot lose its origin by omission); the parameter when a branch is used.
 */
export function parseClients(file: ClientsFile): ClientsFile {
  const seen = new Set<string>();
  for (const c of file.clients) {
    if (!NAME.test(c.name)) throw new Error(`bad API client name "${c.name}"`);
    if (seen.has(c.name))
      throw new Error(`API client "${c.name}" is listed twice`);
    seen.add(c.name);
    if (c.browser !== undefined && c.browser !== false)
      throw new Error(
        `API client "${c.name}": browser may only be false (omit it for a browser client)`,
      );
    const forms = [c.origin, c.amplifyBranch, c.browser].filter(
      (v) => v !== undefined,
    ).length;
    if (forms !== 1)
      throw new Error(
        `API client "${c.name}": set exactly one of origin, amplifyBranch and browser: false`,
      );
    if (c.origin !== undefined && !ORIGIN.test(c.origin))
      throw new Error(`bad origin for API client "${c.name}"`);
    if (c.amplifyBranch !== undefined && !BRANCH.test(c.amplifyBranch))
      throw new Error(`bad amplifyBranch for API client "${c.name}"`);
  }
  const branches = file.clients.some((c) => c.amplifyBranch !== undefined);
  if (branches && !PARAMETER.test(file.amplifyAppIdParameter ?? ""))
    throw new Error(
      "clients.json: amplifyAppIdParameter (an SSM parameter name) is required for amplifyBranch clients",
    );
  return file;
}

/**
 * A client's CORS origin; undefined for a client with `browser: false`. `hostAppId` is the Amplify app ID (at
 * synth, a deploy-time token).
 */
export function clientOrigin(
  c: ClientEntry,
  hostAppId?: string,
): string | undefined {
  if (c.browser === false) return undefined;
  if (c.origin !== undefined) return c.origin;
  if (hostAppId === undefined)
    throw new Error(`API client "${c.name}": no Amplify app ID for its branch`);
  return `https://${c.amplifyBranch}.${hostAppId}.amplifyapp.com`;
}

/** The HTTP API's CORS allowed origins: one per browser client, in list order. */
export const corsOrigins = (
  clients: ClientEntry[],
  hostAppId?: string,
): string[] =>
  clients.flatMap((c) => {
    const o = clientOrigin(c, hostAppId);
    return o === undefined ? [] : [o];
  });
