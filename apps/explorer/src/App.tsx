import { useEffect, useState } from "react";
import { createApiClient, type ApiClient } from "@oracle-la/api-client";
import { loadConfig } from "./config.ts";
import { LongOpen } from "./LongOpen.tsx";
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
  "Coming next",
] as const;
type Tab = (typeof TABS)[number];

export function App() {
  // The tRPC client is a callable proxy, so it is held inside an object (never passed to a state setter alone).
  const [conn, setConn] = useState<{
    api: ApiClient;
    loadSources: LoadSources;
  }>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>("Run summary");
  useEffect(() => {
    loadConfig()
      .then((c) => {
        const api = createApiClient(c);
        setConn({ api, loadSources: sourcesLoader(api) });
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const api = conn?.api;
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
        {TABS.map((t) => (
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
          <Sources loadSources={conn.loadSources} />
        )}
        {conn && tab === "Records" && (
          <Records api={conn.api} loadSources={conn.loadSources} />
        )}
        {api && tab === "Radius query" && <RadiusQuery api={api} />}
        {conn && tab === "Long-open permits" && (
          <LongOpen api={conn.api} loadSources={conn.loadSources} />
        )}
        {tab === "Coming next" && <Placeholders />}
      </main>
    </>
  );
}
