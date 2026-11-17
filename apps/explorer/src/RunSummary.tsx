import type { ApiClient, RunRelation } from "@oracle-la/api-client";
import { gatewayUrl } from "../../../src/publications.ts";
import { PUBLICATIONS } from "./publications.ts";
import { coverageText, type LoadSources } from "./sources.ts";
import { useQuery } from "./useQuery.ts";

const fmt = (n: unknown) =>
  typeof n === "number" ? n.toLocaleString("en-US") : String(n ?? "—");
/** A count as en-US, or an empty cell where the row recorded none (never a dash, never a guess). */
const countCell = (n: unknown) => (typeof n === "number" ? fmt(n) : "");

/**
 * A run's relation to the previous run as recorded: "rebuild of <run ID>, no source changes", "new data", or
 * nothing at all where the run recorded no run_kind (never a guess).
 */
export function runKindText(r: Partial<RunRelation>): string {
  if (r.run_kind === "rebuild")
    return [
      `rebuild of ${r.rebuild_of ?? "—"}`,
      ...(r.source_changes === "none" ? ["no source changes"] : []),
    ].join(", ");
  return r.run_kind ?? "";
}

/** The run_manifest.json fields this view shows (v_run). */
interface RunView extends Partial<RunRelation> {
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
    /** Permit runs: the LADBS rows staged and the permit Parquet files' row counts. */
    permits?: {
      staged?: number;
      parquet?: {
        permits?: number;
        permit_parcels?: number;
        permit_contractors?: number;
      };
    };
  };
  coverage?: {
    with_coordinates?: number;
    with_coordinates_pct?: number;
    with_year_built?: number;
    with_year_built_pct?: number;
    permit_data?: {
      parcels_with_permit_data?: number;
      parcels_without_permit_data?: number;
      parcels_with_permits?: number;
    };
  };
  /** Permit runs: the date open durations count to. */
  derived_field_reference_date?: string;
  delta?: { previous_run_id?: string | null; added?: number; removed?: number };
  scope?: { where?: string; permits_harvested?: boolean };
  /** County runs record the validator's `overall` result; the pilot run recorded `preflight`. */
  readiness?: { overall?: string; preflight?: string; scope_guard?: string };
  limitations?: string[];
}
/** One run_history.jsonl entry (v_run_history). */
interface HistoryView extends Partial<RunRelation> {
  run_id: string;
  finished_at?: string;
  row_counts?: {
    parquet?: number;
    permits?: { parquet?: { permits?: number; permit_parcels?: number } };
  };
  delta?: { added?: number; removed?: number };
  parquet_sha256?: string;
}

/** "net +260 (296,909 → 297,169)": a count's change from the previous run to this one. */
function netText(previous: number, current: number): string {
  const d = current - previous;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  return `net ${sign}${fmt(Math.abs(d))} (${fmt(previous)} → ${fmt(current)})`;
}

/**
 * The permit and permit-to-parcel link counts' change from the previous run (the run's delta.previous_run_id, found
 * in the history): only where both runs recorded the count, never a guess. Parcels are compared by identifier at
 * build (added/removed); these are the permit Parquet files' row counts, so the change is net.
 */
export function permitDeltas(
  run: RunView,
  history: HistoryView[],
): { permits?: string; permit_parcels?: string } {
  const prevId = run.delta?.previous_run_id;
  const prev = prevId
    ? history.find((h) => h.run_id === prevId)?.row_counts?.permits?.parquet
    : undefined;
  const cur = run.row_counts?.permits?.parquet;
  const out: { permits?: string; permit_parcels?: string } = {};
  for (const k of ["permits", "permit_parcels"] as const) {
    const a = prev?.[k];
    const b = cur?.[k];
    if (typeof a === "number" && typeof b === "number") out[k] = netText(a, b);
  }
  return out;
}

export function RunSummary({
  api,
  loadSources,
}: {
  api: ApiClient;
  loadSources: LoadSources;
}) {
  const { data, error } = useQuery(
    () => api.explorer.runSummary.query(),
    "runSummary",
  );
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading run summary…</p>;
  const r = data.run as RunView;
  const history = data.history as unknown as HistoryView[];
  const permitDelta = permitDeltas(r, history);
  return (
    <section data-testid="run-summary">
      <h2>Run {r.run_id}</h2>
      <p>
        {r.run_name} · generated {r.generated_at} · {r.county}, {r.state} (FIPS{" "}
        {r.fips}) · roll year {r.roll_year}
      </p>
      {r.run_kind && <p data-testid="run-kind">Run kind: {runKindText(r)}</p>}
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
          <b data-testid="delta-parcels">
            +{fmt(r.delta?.added)} / −{fmt(r.delta?.removed)} parcels
          </b>
          {permitDelta.permits && (
            <small data-testid="delta-permits">
              permits: {permitDelta.permits}
            </small>
          )}
          {permitDelta.permit_parcels && (
            <small data-testid="delta-permit-parcels">
              permit-to-parcel links: {permitDelta.permit_parcels}
            </small>
          )}
        </div>
      </div>
      {r.row_counts?.permits && (
        <>
          <h3>City of Los Angeles permits (LADBS)</h3>
          <div className="cards" data-testid="permit-counts">
            <div className="card">
              <span>Permits</span>
              <b data-testid="permit-count">
                {fmt(r.row_counts.permits.parquet?.permits)}
              </b>
            </div>
            <div className="card">
              <span>Permit-to-parcel links</span>
              <b>{fmt(r.row_counts.permits.parquet?.permit_parcels)}</b>
            </div>
            <div className="card" data-testid="contractor-rows-card">
              <span>Contractor rows</span>
              <b>{fmt(r.row_counts.permits.parquet?.permit_contractors)}</b>
              <ContractorWindow loadSources={loadSources} />
            </div>
            <div className="card">
              <span>Parcels with permit data</span>
              <b>{fmt(r.coverage?.permit_data?.parcels_with_permit_data)}</b>
            </div>
            <div className="card">
              <span>Parcels with a linked permit</span>
              <b>{fmt(r.coverage?.permit_data?.parcels_with_permits)}</b>
            </div>
            <div className="card">
              <span>Open durations count to</span>
              <b>{fmt(r.derived_field_reference_date)}</b>
            </div>
          </div>
        </>
      )}
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
            <th>Kind</th>
            <th>Finished</th>
            <th>Parquet rows</th>
            <th>Added</th>
            <th>Removed</th>
            <th>Permits</th>
            <th>Permit-to-parcel links</th>
            <th>Parquet sha256</th>
            <th>Published (identifier)</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.run_id}>
              <td>{h.run_id}</td>
              <td data-testid="history-kind">{h.run_kind ?? ""}</td>
              <td>{h.finished_at}</td>
              <td>{fmt(h.row_counts?.parquet)}</td>
              <td>{fmt(h.delta?.added)}</td>
              <td>{fmt(h.delta?.removed)}</td>
              <td data-testid="history-permits">
                {countCell(h.row_counts?.permits?.parquet?.permits)}
              </td>
              <td data-testid="history-permit-parcels">
                {countCell(h.row_counts?.permits?.parquet?.permit_parcels)}
              </td>
              <td className="mono">{h.parquet_sha256}</td>
              <td data-testid="history-published">
                <PublishedCell runId={h.run_id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * A run's publication as runs/publications.jsonl records it (bundled at build): its artifact manifest's CID, the
 * date and a link to the manifest on one public gateway; "not published" for a run with no line.
 */
function PublishedCell({ runId }: { runId: string }) {
  const p = PUBLICATIONS.find((x) => x.run_id === runId);
  if (!p) return <>not published</>;
  return (
    <>
      <span className="mono">{p.manifest_cid}</span> ·{" "}
      {p.published_at.slice(0, 10)} ·{" "}
      <a href={gatewayUrl(p.manifest_cid)}>ipfs.io</a>
    </>
  );
}

/**
 * The contractor source's coverage window under the "Contractor rows" card, from explorer.sources (fetched once
 * per session and shared with the other tabs; rendered only after the run summary, so it never races the
 * cold start's first call).
 */
function ContractorWindow({ loadSources }: { loadSources: LoadSources }) {
  const { data } = useQuery(loadSources, "sources");
  const c = data?.sources.find((s) => s.source_kind === "contractor");
  const text = c && coverageText(c);
  return text ? <small data-testid="contractor-window">{text}</small> : null;
}
