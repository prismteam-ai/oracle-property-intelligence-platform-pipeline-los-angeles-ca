import { useEffect, useState } from "react";
import { createApiClient, type ApiClient } from "@oracle-la/api-client";
import { createAgentApi, type AgentApi } from "./agent-api.ts";
import { AskAgent } from "./AskAgent.tsx";
import { EXPLORER_COMMIT } from "./commit.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { LongOpen } from "./LongOpen.tsx";
import { Mcp } from "./Mcp.tsx";
import { Placeholders } from "./Placeholders.tsx";
import { RadiusQuery } from "./RadiusQuery.tsx";
import { Records } from "./Records.tsx";
import { RunSummary } from "./RunSummary.tsx";
import { Sources } from "./Sources.tsx";
import { sourcesLoader, type LoadSources } from "./sources.ts";

const TABS = [
  "Run summary",
  "Sources & pages",
  "Records",
  "Radius query",
  "Long-open permits",
  "Ask the agent",
  "MCP",
  "Coming next",
] as const;
type Tab = (typeof TABS)[number];

/**
 * The agent API with its warm-up reporting the agent's commit: what each GET /agent/warm reported (no commit when
 * the response had none or no response came).
 */
function reportingCommit(
  api: AgentApi,
  report: (r: { commit?: string }) => void,
): AgentApi {
  return {
    ...api,
    warm: () =>
      api.warm().then(
        (r) => {
          report(r.commit ? { commit: r.commit } : {});
          return r;
        },
        (e: unknown) => {
          report({});
          throw e;
        },
      ),
  };
}

export function App() {
  // The tRPC client is a callable proxy, so it is held inside an object (never passed to a state setter alone).
  const [conn, setConn] = useState<{
    api: ApiClient;
    loadSources: LoadSources;
    config: AppConfig;
    /** Present only when config.json names the agent API. */
    agent?: { api: AgentApi; warmData: () => Promise<unknown> };
  }>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>("Run summary");
  // The agent's commit as GET /agent/warm reported it; unset until the first warm-up has answered.
  const [agentCommit, setAgentCommit] = useState<{ commit?: string }>();
  useEffect(() => {
    loadConfig()
      .then((c) => {
        const api = createApiClient(c);
        // The warm-up's data requests are sent one HTTP request each (never batched into one), to explorer.sources:
        // about 0.8 s each, so the two overlap and reach two data API instances.
        const unbatched = createApiClient({ ...c, batch: false });
        setConn({
          api,
          loadSources: sourcesLoader(api),
          config: c,
          ...(c.agentApiUrl
            ? {
                agent: {
                  api: reportingCommit(
                    createAgentApi({
                      agentApiUrl: c.agentApiUrl,
                      apiToken: c.apiToken,
                    }),
                    setAgentCommit,
                  ),
                  warmData: () => unbatched.explorer.sources.query(),
                },
              }
            : {}),
        });
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const api = conn?.api;
  // The agent tab exists only when config.json names the agent API.
  const tabs = TABS.filter((t) => t !== "Ask the agent" || conn?.agent);
  return (
    <>
      <header>
        <h1>
          Oracle Property Intelligence — Los Angeles County pipeline explorer
        </h1>
        <p>
          DuckDB over the private run output, through SQL views. Los Angeles
          County assessor roll 2026, City of Los Angeles building permits and
          the contractor view (LADBS); the run&apos;s scope is on the Run
          summary tab. Not public.
        </p>
      </header>
      <nav role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      <main>
        {error && (
          <p className="error" data-testid="error">
            Error: {error}
          </p>
        )}
        {!api && !error && <p>Loading…</p>}
        {conn && tab === "Run summary" && (
          <RunSummary api={conn.api} loadSources={conn.loadSources} />
        )}
        {conn && tab === "Sources & pages" && (
          <Sources api={conn.api} loadSources={conn.loadSources} />
        )}
        {conn && tab === "Records" && (
          <Records api={conn.api} loadSources={conn.loadSources} />
        )}
        {conn && tab === "Radius query" && (
          <RadiusQuery api={conn.api} loadSources={conn.loadSources} />
        )}
        {conn && tab === "Long-open permits" && (
          <LongOpen api={conn.api} loadSources={conn.loadSources} />
        )}
        {conn?.agent && (
          // Kept mounted (hidden) on other tabs: the conversation lives in this component's state only.
          <div hidden={tab !== "Ask the agent"}>
            <AskAgent
              agent={conn.agent.api}
              warmData={conn.agent.warmData}
              active={tab === "Ask the agent"}
            />
          </div>
        )}
        {conn && tab === "MCP" && (
          <Mcp apiUrl={conn.config.apiUrl} apiToken={conn.config.apiToken} />
        )}
        {tab === "Coming next" && <Placeholders />}
      </main>
      <footer>
        <p className="note" data-testid="commits">
          Explorer commit{" "}
          <span className="mono" data-testid="explorer-commit">
            {EXPLORER_COMMIT}
          </span>
          {conn?.agent && (
            <>
              {" "}
              · Agent commit{" "}
              <span className="mono" data-testid="agent-commit">
                {agentCommit
                  ? (agentCommit.commit ?? "not reported")
                  : "not checked yet (the Ask the agent tab checks it)"}
              </span>
            </>
          )}
        </p>
      </footer>
    </>
  );
}
