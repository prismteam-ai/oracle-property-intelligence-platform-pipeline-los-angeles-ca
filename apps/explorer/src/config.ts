/** config.json is served next to the app behind the Amplify password. Built from location.origin so the
 * https://user:pass@host/ URL form works (relative fetches fail in that form). */
export interface AppConfig {
  apiUrl: string;
  apiToken: string;
  client: string;
  /** The agent API (OracleLaAgentApi output AgentApiUrl); without it the "Ask the agent" tab is hidden. */
  agentApiUrl?: string;
}
export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch(new URL("/config.json", location.origin), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
  return (await res.json()) as AppConfig;
}
