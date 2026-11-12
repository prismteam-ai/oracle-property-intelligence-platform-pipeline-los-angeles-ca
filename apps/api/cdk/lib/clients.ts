/**
 * API clients from apps/api/cdk/clients.json. A client's browser origin is either a literal `origin` or
 * `amplifyBranch`: a branch of the Amplify app whose ID is in the SSM parameter `amplifyAppIdParameter`,
 * read at deploy time, so no app ID sits in tracked files. The origins drive the HTTP API's CORS; the names
 * drive the per-client token-hash SSM parameters.
 */
export interface ClientEntry {
  name: string;
  origin?: string;
  amplifyBranch?: string;
}
export interface ClientsFile {
  amplifyAppIdParameter?: string;
  clients: ClientEntry[];
}

const NAME = /^[a-z][a-z0-9-]*$/;
const ORIGIN = /^https:\/\/[a-z0-9.-]+$/;
const BRANCH = /^[a-z0-9][a-z0-9-]*$/;
const PARAMETER = /^\/[\w./-]+$/;

/** Checks clients.json: unique names, exactly one origin form per client, the parameter when a branch is used. */
export function parseClients(file: ClientsFile): ClientsFile {
  const seen = new Set<string>();
  for (const c of file.clients) {
    if (!NAME.test(c.name)) throw new Error(`bad API client name "${c.name}"`);
    if (seen.has(c.name))
      throw new Error(`API client "${c.name}" is listed twice`);
    seen.add(c.name);
    if ((c.origin === undefined) === (c.amplifyBranch === undefined))
      throw new Error(
        `API client "${c.name}": set exactly one of origin and amplifyBranch`,
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

/** A client's CORS origin. `hostAppId` is the Amplify app ID (at synth, a deploy-time token). */
export function clientOrigin(c: ClientEntry, hostAppId?: string): string {
  if (c.origin !== undefined) return c.origin;
  if (hostAppId === undefined)
    throw new Error(`API client "${c.name}": no Amplify app ID for its branch`);
  return `https://${c.amplifyBranch}.${hostAppId}.amplifyapp.com`;
}
