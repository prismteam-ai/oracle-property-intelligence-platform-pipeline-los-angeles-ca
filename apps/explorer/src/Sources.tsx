import {
  CHANGES_MADE,
  coverageText,
  retrieved,
  type LoadSources,
} from "./sources.ts";
import { useQuery } from "./useQuery.ts";

/** Every source of the run (the roll, the LADBS permits, the LADBS contractor view) with its terms and pages. */
export function Sources({ loadSources }: { loadSources: LoadSources }) {
  const { data, error } = useQuery(loadSources, "sources");
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading sources…</p>;
  // Pages grouped by source, in the sources' order, then by page file (the API orders by page file only).
  const rank = new Map(data.sources.map((s, i) => [s.source_name, i]));
  const pages = [...data.pages].sort(
    (a, b) =>
      (rank.get(a.source_name) ?? 0) - (rank.get(b.source_name) ?? 0) ||
      a.source_page_file.localeCompare(b.source_page_file),
  );
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
      <table data-testid="pages">
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
          {pages.map((p) => (
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
    </section>
  );
}
