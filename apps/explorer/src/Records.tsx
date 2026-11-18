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

/**
 * A search in a source's record keys, as a filter (explorer.records' `match`): only the records whose parcel number
 * (10 digits, on the roll) or permit number (15 digits, 5-5-5, on the permit and contractor sources) starts with the
 * number typed. The match is the number as typed, digits only for a parcel, dashed after 5 and 10 digits for a
 * permit (as the API matches and echoes it).
 */
const KEY_DIGITS: Record<SourceKind, number> = {
  parcel: 10,
  permit: 15,
  contractor: 15,
};
const noun = (kind: SourceKind) =>
  kind === "parcel" ? "parcel number" : "permit number";
const dashed = (digits: string) =>
  [digits.slice(0, 5), digits.slice(5, 10), digits.slice(10)]
    .filter(Boolean)
    .join("-");

/** The match for what was typed, or why it cannot be one (nothing is sent then). */
export function matchFor(
  kind: SourceKind,
  text: string,
): { match: string } | string {
  const n = KEY_DIGITS[kind];
  const digits = text.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || digits.length > n)
    return `A ${noun(kind)} is up to ${n} digits (dashes and spaces allowed).`;
  return { match: kind === "parcel" ? digits : dashed(digits) };
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The count line of a search: how many of the source's records start with the match. */
export function matchText(
  matchTotal: number,
  total: number,
  match: string,
): string {
  return `${fmt(matchTotal)} of ${fmt(total)} records ${matchTotal === 1 ? "matches" : "match"} ${match}`;
}

/** The line shown when no record starts with the match. */
export function noMatchText(kind: SourceKind, match: string): string {
  return `No ${noun(kind)} in this source starts with ${match}.`;
}

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
  // A search (match) also belongs to its source; the cursors then page inside the matches.
  const [sel, setSel] = useState<{
    name?: string;
    cursors: string[];
    match?: string;
  }>({
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
        match={sel.match}
        setCursors={(cursors) =>
          setSel({ name: source.source_name, cursors, match: sel.match })
        }
        setMatch={(match) =>
          setSel({ name: source.source_name, cursors: [], match })
        }
      />
    </section>
  );
}

function SourceRecords({
  api,
  source,
  cursors,
  match,
  setCursors,
  setMatch,
}: {
  api: ApiClient;
  source: SourceRow;
  cursors: string[];
  match?: string;
  setCursors: (c: string[]) => void;
  setMatch: (m?: string) => void;
}) {
  const after = cursors.at(-1);
  const { data, error, loading } = useQuery(
    () =>
      api.explorer.records.query({
        source_name: source.source_name,
        after,
        limit: 50,
        // Only with a search: without one the request is as before.
        ...(match === undefined ? {} : { match }),
      }),
    `records:${source.source_name}:${after ?? ""}:${match ?? ""}`,
  );
  const none = match !== undefined && data?.match_total === 0;
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
      <SearchForm kind={source.source_kind} match={match} setMatch={setMatch} />
      {none && match !== undefined && (
        <p data-testid="records-search-none">
          {noMatchText(source.source_kind, match)}
        </p>
      )}
      <p data-testid="records-total">
        {!data
          ? "…"
          : match === undefined
            ? `${fmt(data.total)} records`
            : matchText(data.match_total ?? 0, data.total, match)}{" "}
        · page {cursors.length + 1}
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
      <table data-testid="records" data-kind={source.source_kind} hidden={none}>
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

/** The search box: a parcel number on the roll, a permit number on the permit and contractor sources. */
function SearchForm({
  kind,
  match,
  setMatch,
}: {
  kind: SourceKind;
  match?: string;
  setMatch: (m?: string) => void;
}) {
  const [text, setText] = useState(match ?? "");
  const [invalid, setInvalid] = useState<string>();
  const what = noun(kind);
  return (
    <form
      data-testid="records-search"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) {
          setInvalid(undefined);
          setMatch(undefined);
          return;
        }
        const m = matchFor(kind, text);
        if (typeof m === "string") return setInvalid(m);
        setInvalid(undefined);
        setMatch(m.match);
      }}
    >
      <label>
        {`${what[0]!.toUpperCase()}${what.slice(1)} starts with`}{" "}
        <input
          data-testid="records-search-input"
          value={text}
          inputMode="numeric"
          onChange={(e) => setText(e.target.value)}
        />
      </label>{" "}
      <button type="submit">Find</button>{" "}
      {match !== undefined && (
        <button
          type="button"
          onClick={() => {
            setText("");
            setInvalid(undefined);
            setMatch(undefined);
          }}
        >
          Show all records
        </button>
      )}
      {invalid && (
        <span className="error" data-testid="records-search-invalid">
          {" "}
          {invalid}
        </span>
      )}
    </form>
  );
}
