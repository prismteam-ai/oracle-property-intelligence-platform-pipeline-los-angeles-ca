import { useState } from "react";
import type {
  ApiClient,
  RecordRow,
  SourceKind,
  SourceRow,
} from "@oracle-la/api-client";
import { contractorNote, type LoadSources } from "./sources.ts";
import { useQuery } from "./useQuery.ts";

const yesNo = (b: boolean | null) => (b === null ? "—" : b ? "yes" : "no");

/** The columns for one kind of record (the provenance columns follow for every kind). */
const COLUMNS: Record<
  SourceKind,
  Array<[string, (r: RecordRow) => string | number | null]>
> = {
  parcel: [
    ["Parcel (AIN)", (r) => r.parcel_id],
    ["Address", (r) => r.address],
    ["Year built", (r) => r.year_built ?? "—"],
  ],
  permit: [
    ["Permit number", (r) => (r.kind === "permit" ? r.permit_number : null)],
    ["Status", (r) => (r.kind === "permit" ? r.source_status_desc : null)],
    [
      "Status class",
      (r) => (r.kind === "permit" ? r.permit_status_class : null),
    ],
    ["Issue date", (r) => (r.kind === "permit" ? r.permit_issue_date : null)],
    [
      "Join method",
      (r) => (r.kind === "permit" ? (r.join_method ?? "not joined") : null),
    ],
    ["Parcels", (r) => (r.kind === "permit" ? r.parcel_count : null)],
    ["Address", (r) => r.address],
  ],
  contractor: [
    [
      "Permit number",
      (r) => (r.kind === "contractor" ? r.permit_number : null),
    ],
    [
      "Business name",
      (r) => (r.kind === "contractor" ? r.contractors_business_name : null),
    ],
    [
      "License number",
      (r) => (r.kind === "contractor" ? r.license_identifier : null),
    ],
    [
      "License class (raw)",
      (r) => (r.kind === "contractor" ? r.source_license_type : null),
    ],
    [
      "License class (normalized)",
      (r) =>
        r.kind === "contractor"
          ? [r.license_class, r.license_class_note].filter(Boolean).join("; ")
          : null,
    ],
    [
      "Owner-builder",
      (r) => (r.kind === "contractor" ? yesNo(r.is_owner_builder) : null),
    ],
    // The identity: one per license number; its name variants are counted, never listed; no name, none shown.
    [
      "Identity (license)",
      (r) =>
        r.kind === "contractor" ? (r.contractor_identity_key ?? null) : null,
    ],
    [
      "Canonical name",
      (r) =>
        r.kind === "contractor" ? (r.canonical_business_name ?? null) : null,
    ],
    [
      "Name variants",
      (r) => (r.kind === "contractor" ? (r.name_variant_count ?? null) : null),
    ],
  ],
};

/** One source's records, paged with the API's cursor; the source is chosen from explorer.sources. */
export function Records({
  api,
  loadSources,
}: {
  api: ApiClient;
  loadSources: LoadSources;
}) {
  const sources = useQuery(loadSources, "sources");
  // The cursor stack belongs to one source: choosing another source starts again at its first page.
  const [sel, setSel] = useState<{ name?: string; cursors: string[] }>({
    cursors: [],
  });
  if (sources.error) return <p className="error">{sources.error}</p>;
  if (!sources.data) return <p>Loading sources…</p>;
  const source =
    sources.data.sources.find((s) => s.source_name === sel.name) ??
    sources.data.sources.find((s) => s.source_kind === "parcel") ??
    sources.data.sources[0];
  if (!source) return <p>No sources in this run.</p>;
  return (
    <section>
      <label>
        Source{" "}
        <select
          data-testid="records-source"
          value={source.source_name}
          onChange={(e) => setSel({ name: e.target.value, cursors: [] })}
        >
          {sources.data.sources.map((s) => (
            <option key={s.source_name} value={s.source_name}>
              {s.source_name}
            </option>
          ))}
        </select>
      </label>
      <SourceRecords
        key={source.source_name}
        api={api}
        source={source}
        cursors={sel.cursors}
        setCursors={(cursors) => setSel({ name: source.source_name, cursors })}
      />
    </section>
  );
}

function SourceRecords({
  api,
  source,
  cursors,
  setCursors,
}: {
  api: ApiClient;
  source: SourceRow;
  cursors: string[];
  setCursors: (c: string[]) => void;
}) {
  const after = cursors.at(-1);
  const { data, error, loading } = useQuery(
    () =>
      api.explorer.records.query({
        source_name: source.source_name,
        after,
        limit: 50,
      }),
    `records:${source.source_name}:${after ?? ""}`,
  );
  if (error) return <p className="error">{error}</p>;
  const columns = COLUMNS[source.source_kind];
  return (
    <>
      <h2>Records from {source.source_name}</h2>
      {source.source_kind === "contractor" && (
        <p className="note" data-testid="records-attribution">
          {contractorNote(source)}
        </p>
      )}
      {source.source_kind === "permit" && (
        <p className="note" data-testid="records-attribution">
          Attribution: {source.attribution}. License: {source.license}.
        </p>
      )}
      <p data-testid="records-total">
        {data ? `${data.total.toLocaleString("en-US")} records` : "…"} · page{" "}
        {cursors.length + 1}
      </p>
      <p>
        <button
          disabled={!cursors.length || loading}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Previous
        </button>{" "}
        <button
          data-testid="records-next"
          disabled={!data?.next_after || loading}
          onClick={() => setCursors([...cursors, data!.next_after!])}
        >
          Next
        </button>
      </p>
      <table data-testid="records" data-kind={source.source_kind}>
        <thead>
          <tr>
            {columns.map(([h]) => (
              <th key={h}>{h}</th>
            ))}
            <th>Source</th>
            <th>Request URL</th>
            <th>Retrieved at</th>
            <th>Page sha256</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((r) => (
            <tr key={r.record_key}>
              {columns.map(([h, get]) => (
                <td key={h}>{get(r) ?? "—"}</td>
              ))}
              <td>{r.source_name}</td>
              <td className="mono">{r.source_request_url}</td>
              <td>{r.source_retrieved_at}</td>
              <td className="mono">{r.source_page_sha256}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
