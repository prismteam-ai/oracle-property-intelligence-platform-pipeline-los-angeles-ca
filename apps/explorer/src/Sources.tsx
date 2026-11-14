import { useState } from "react";
import type { ApiClient, SourceRow } from "@oracle-la/api-client";
import {
  CHANGES_MADE,
  coverageText,
  retrieved,
  type LoadSources,
} from "./sources.ts";
import { useQuery } from "./useQuery.ts";

/** Pages per explorer.sourcePages call (the API's most). */
export const PAGES_PER_CALL = 100;

/**
 * Every source of the run (the roll, the LADBS permits, the LADBS contractor view) with its terms, then one
 * source's pages, paged through explorer.sourcePages.
 */
export function Sources({
  api,
  loadSources,
}: {
  api: ApiClient;
  loadSources: LoadSources;
}) {
  const { data, error } = useQuery(loadSources, "sources");
  // The offset belongs to one source: choosing another source starts again at its first pages.
  const [sel, setSel] = useState<{ name?: string; offset: number }>({
    offset: 0,
  });
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading sources…</p>;
  const source =
    data.sources.find((s) => s.source_name === sel.name) ??
    data.sources.find((s) => s.source_kind === "parcel") ??
    data.sources[0];
  return (
    <section>
      <h2>Records by source</h2>
      <table data-testid="sources">
        <thead>
          <tr>
            <th>Source</th>
            <th>Kind</th>
            <th>Records</th>
            <th>Pages</th>
            <th>Retrieved</th>
            <th>Query URL</th>
            <th>License</th>
            <th>Attribution</th>
            <th>Changes made</th>
            <th>Coverage</th>
            <th>Terms</th>
          </tr>
        </thead>
        <tbody>
          {data.sources.map((s) => (
            <tr key={s.source_name} data-kind={s.source_kind}>
              <td>{s.source_name}</td>
              <td>{s.source_kind}</td>
              <td>{s.record_count.toLocaleString("en-US")}</td>
              <td>{s.page_count.toLocaleString("en-US")}</td>
              <td>{retrieved(s)}</td>
              <td className="mono">
                {(s.query_urls ?? [s.query_url]).map((u) => (
                  <div key={u}>{u}</div>
                ))}
              </td>
              <td data-testid="source-license">{s.license ?? "—"}</td>
              <td data-testid="source-attribution">{s.attribution ?? "—"}</td>
              <td data-testid="source-changes">
                {CHANGES_MADE[s.source_kind] ?? "—"}
              </td>
              <td data-testid="source-coverage">{coverageText(s) ?? "—"}</td>
              <td>
                <a href={s.terms_of_use ?? "#"}>terms</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Pages (exact request, retrieval time, page hash)</h3>
      {source && (
        <>
          <label>
            Source{" "}
            <select
              data-testid="pages-source"
              value={source.source_name}
              onChange={(e) => setSel({ name: e.target.value, offset: 0 })}
            >
              {data.sources.map((s) => (
                <option key={s.source_name} value={s.source_name}>
                  {s.source_name}
                </option>
              ))}
            </select>
          </label>
          <SourcePages
            key={source.source_name}
            api={api}
            source={source}
            offset={sel.offset}
            setOffset={(offset) => setSel({ name: source.source_name, offset })}
          />
        </>
      )}
    </section>
  );
}

/** One source's pages, PAGES_PER_CALL at a time, in page-file order. */
function SourcePages({
  api,
  source,
  offset,
  setOffset,
}: {
  api: ApiClient;
  source: SourceRow;
  offset: number;
  setOffset: (o: number) => void;
}) {
  const { data, error, loading } = useQuery(
    () =>
      api.explorer.sourcePages.query({
        source_name: source.source_name,
        offset,
        limit: PAGES_PER_CALL,
      }),
    `pages:${source.source_name}:${offset}`,
  );
  if (error) return <p className="error">{error}</p>;
  return (
    <>
      <p data-testid="pages-total">
        {data
          ? data.items.length
            ? `${data.total.toLocaleString("en-US")} pages · ${(offset + 1).toLocaleString("en-US")}–${(offset + data.items.length).toLocaleString("en-US")}`
            : `${data.total.toLocaleString("en-US")} pages`
          : "…"}
      </p>
      <p>
        <button
          disabled={offset === 0 || loading}
          onClick={() => setOffset(Math.max(0, offset - PAGES_PER_CALL))}
        >
          Previous
        </button>{" "}
        <button
          data-testid="pages-next"
          disabled={data?.next_offset == null || loading}
          onClick={() => setOffset(data!.next_offset!)}
        >
          Next
        </button>
      </p>
      <table data-testid="pages" data-kind={source.source_kind}>
        <thead>
          <tr>
            <th>Page</th>
            <th>Records</th>
            <th>Retrieved at (UTC)</th>
            <th>Request URL</th>
            <th>Page sha256</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((p) => (
            <tr key={`${p.source_name}/${p.source_page_file}`}>
              <td>{p.source_page_file}</td>
              <td>{p.record_count}</td>
              <td>{p.source_retrieved_at}</td>
              <td className="mono">{p.source_request_url}</td>
              <td className="mono">{p.source_page_sha256}</td>
              <td>{p.source_kind}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
