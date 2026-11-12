import type { ApiClient } from "@oracle-la/api-client";
import { useQuery } from "./useQuery.ts";

const fmt = (n: unknown) =>
  typeof n === "number" ? n.toLocaleString("en-US") : String(n ?? "—");

/** The run_manifest.json fields this view shows (v_run). */
interface RunView {
  run_id?: string;
  run_name?: string;
  generated_at?: string;
  county?: string;
  state?: string;
  fips?: string;
  roll_year?: string;
  row_counts?: {
    parquet?: number;
    expected_from_source_count?: number;
    raw_pages?: number;
  };
  coverage?: {
    with_coordinates?: number;
    with_coordinates_pct?: number;
    with_year_built?: number;
    with_year_built_pct?: number;
  };
  delta?: { added?: number; removed?: number };
  scope?: { where?: string; permits_harvested?: boolean };
  /** County runs record the validator's `overall` result; the pilot run recorded `preflight`. */
  readiness?: { overall?: string; preflight?: string; scope_guard?: string };
  limitations?: string[];
}
/** One run_history.jsonl entry (v_run_history). */
interface HistoryView {
  run_id: string;
  finished_at?: string;
  row_counts?: { parquet?: number };
  delta?: { added?: number; removed?: number };
  parquet_sha256?: string;
  published?: boolean;
}

export function RunSummary({ api }: { api: ApiClient }) {
  const { data, error } = useQuery(
    () => api.explorer.runSummary.query(),
    "runSummary",
  );
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading run summary…</p>;
  const r = data.run as RunView;
  return (
    <section data-testid="run-summary">
      <h2>Run {r.run_id}</h2>
      <p>
        {r.run_name} · generated {r.generated_at} · {r.county}, {r.state} (FIPS{" "}
        {r.fips}) · roll year {r.roll_year}
      </p>
      <div className="cards">
        <div className="card">
          <span>Parcels in Parquet</span>
          <b data-testid="parquet-count">{fmt(r.row_counts?.parquet)}</b>
        </div>
        <div className="card">
          <span>Expected from source count</span>
          <b>{fmt(r.row_counts?.expected_from_source_count)}</b>
        </div>
        <div className="card">
          <span>Raw pages</span>
          <b>{fmt(r.row_counts?.raw_pages)}</b>
        </div>
        <div className="card">
          <span>With coordinates</span>
          <b>
            {fmt(r.coverage?.with_coordinates)} (
            {r.coverage?.with_coordinates_pct}%)
          </b>
        </div>
        <div className="card">
          <span>With year built</span>
          <b>
            {fmt(r.coverage?.with_year_built)} (
            {r.coverage?.with_year_built_pct}%)
          </b>
        </div>
        <div className="card">
          <span>Delta vs previous run</span>
          <b>
            +{fmt(r.delta?.added)} / −{fmt(r.delta?.removed)}
          </b>
        </div>
      </div>
      <h3>Scope</h3>
      <p className="mono">{r.scope?.where}</p>
      <p data-testid="readiness">
        Readiness: {r.readiness?.overall ?? r.readiness?.preflight ?? "—"};
        scope guard {r.readiness?.scope_guard}. Permits harvested:{" "}
        {String(r.scope?.permits_harvested)}.
      </p>
      <h3>Source limitations</h3>
      <ul data-testid="limitations">
        {(r.limitations ?? []).map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <h3>Run history</h3>
      <table data-testid="run-history">
        <thead>
          <tr>
            <th>Run</th>
            <th>Finished</th>
            <th>Parquet rows</th>
            <th>Added</th>
            <th>Removed</th>
            <th>Parquet sha256</th>
            <th>Published</th>
          </tr>
        </thead>
        <tbody>
          {(data.history as unknown as HistoryView[]).map((h) => (
            <tr key={h.run_id}>
              <td>{h.run_id}</td>
              <td>{h.finished_at}</td>
              <td>{fmt(h.row_counts?.parquet)}</td>
              <td>{fmt(h.delta?.added)}</td>
              <td>{fmt(h.delta?.removed)}</td>
              <td className="mono">{h.parquet_sha256}</td>
              <td>{String(h.published)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
