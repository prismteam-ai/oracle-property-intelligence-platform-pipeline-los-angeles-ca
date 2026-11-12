import { useEffect, useState } from "react";
import { createApiClient, type ApiClient } from "@oracle-la/api-client";
import { loadConfig } from "./config.ts";
import { Placeholders } from "./Placeholders.tsx";
import { RadiusQuery } from "./RadiusQuery.tsx";
import { Records } from "./Records.tsx";
import { RunSummary } from "./RunSummary.tsx";
import { Sources } from "./Sources.tsx";

const TABS = [
  "Run summary",
  "Sources & pages",
  "Records",
  "Radius query",
  "Coming next",
] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [api, setApi] = useState<ApiClient>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>("Run summary");
  useEffect(() => {
    // Updater form: the tRPC client is a callable proxy, so setApi(client) would be treated as an updater.
    loadConfig()
      .then((c) => {
        const client = createApiClient(c);
        setApi(() => client);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <>
      <header>
        <h1>
          Oracle Property Intelligence — Los Angeles County pipeline explorer
        </h1>
        <p>
          DuckDB over the private run output, through SQL views. Los Angeles
          County assessor roll 2026; the run&apos;s scope is on the Run summary
          tab. Not public.
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
        {api && tab === "Run summary" && <RunSummary api={api} />}
        {api && tab === "Sources & pages" && <Sources api={api} />}
        {api && tab === "Records" && <Records api={api} />}
        {api && tab === "Radius query" && <RadiusQuery api={api} />}
        {tab === "Coming next" && <Placeholders />}
      </main>
    </>
  );
}
