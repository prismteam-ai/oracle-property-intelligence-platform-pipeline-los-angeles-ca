import type { ApiClient } from "@oracle-la/api-client";
import { useQuery } from "./useQuery.ts";

export function Sources({ api }: { api: ApiClient }) {
  const { data, error } = useQuery(
    () => api.explorer.sources.query(),
    "sources",
  );
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading sources…</p>;
  return (
    <section>
      <h2>Records by source</h2>
      <table data-testid="sources">
        <thead>
          <tr>
            <th>Source</th>
            <th>Records</th>
            <th>Pages</th>
            <th>Retrieved</th>
            <th>Query URL</th>
            <th>Terms</th>
          </tr>
        </thead>
        <tbody>
          {data.sources.map((s) => (
            <tr key={s.source_name}>
              <td>{s.source_name}</td>
              <td>{s.record_count.toLocaleString("en-US")}</td>
              <td>{s.page_count}</td>
              <td>
                {s.first_retrieved_at} → {s.last_retrieved_at}
              </td>
              <td className="mono">{s.query_url}</td>
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
          </tr>
        </thead>
        <tbody>
          {data.pages.map((p) => (
            <tr key={p.source_page_file}>
              <td>{p.source_page_file}</td>
              <td>{p.record_count}</td>
              <td>{p.source_retrieved_at}</td>
              <td className="mono">{p.source_request_url}</td>
              <td className="mono">{p.source_page_sha256}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
