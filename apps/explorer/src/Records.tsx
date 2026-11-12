import { useState } from "react";
import type { ApiClient } from "@oracle-la/api-client";
import { useQuery } from "./useQuery.ts";

const SOURCE = "LA County Assessor - Assessor Parcel Data Roll 2026";

export function Records({ api }: { api: ApiClient }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);
  const { data, error, loading } = useQuery(
    () => api.explorer.records.query({ source_name: SOURCE, after, limit: 50 }),
    `records:${after ?? ""}`,
  );
  if (error) return <p className="error">{error}</p>;
  return (
    <section>
      <h2>Records from {SOURCE}</h2>
      <p data-testid="records-total">
        {data ? `${data.total.toLocaleString("en-US")} records` : "…"} · page{" "}
        {cursors.length + 1}
      </p>
      <p>
        <button
          disabled={!cursors.length || loading}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          Previous
        </button>{" "}
        <button
          data-testid="records-next"
          disabled={!data?.next_after || loading}
          onClick={() => setCursors((c) => [...c, data!.next_after!])}
        >
          Next
        </button>
      </p>
      <table data-testid="records">
        <thead>
          <tr>
            <th>Parcel (AIN)</th>
            <th>Address</th>
            <th>Year built</th>
            <th>Source</th>
            <th>Request URL</th>
            <th>Retrieved at</th>
            <th>Page sha256</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((r) => (
            <tr key={r.parcel_id}>
              <td>{r.parcel_id}</td>
              <td>{r.address}</td>
              <td>{r.year_built ?? "—"}</td>
              <td>{r.source_name}</td>
              <td className="mono">{r.source_request_url}</td>
              <td>{r.source_retrieved_at}</td>
              <td className="mono">{r.source_page_sha256}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
