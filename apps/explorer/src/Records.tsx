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
 * A search in a source's record keys, as a seek with explorer.records' own `after` cursor (keys greater than it):
 * parcel numbers (10 digits) on the roll, permit numbers (15 digits, 5-5-5) on the permit and contractor sources.
 * `label` is the number as typed, digits only for a parcel, dashed after 5 and 10 digits for a permit; a shorter
 * number is a prefix (padded with zeros to the full length, so the page starts at the first key with it).
 */
export interface Seek {
  label: string;
  full: boolean;
  after?: string;
}

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

/** The seek for what was typed, or why it cannot be one (nothing is sent then). */
export function seekFor(kind: SourceKind, text: string): Seek | string {
  const n = KEY_DIGITS[kind];
  const digits = text.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || digits.length > n)
    return `A ${noun(kind)} is up to ${n} digits (dashes and spaces allowed).`;
  const target = digits.padEnd(n, "0");
  const label = kind === "parcel" ? digits : dashed(digits);
  const full = digits.length === n;
  // Contractor rows: the cursor is (permit number, row) and rows are numbered from 1, so row 0 starts at the permit.
  if (kind === "contractor")
    return { label, full, after: `${dashed(target)}:0` };
  // Parcels and permits: the key just below the target (none below all zeros: the first page).
  const below = BigInt(target) - 1n;
  if (below < 0n) return { label, full };
  const prev = below.toString().padStart(n, "0");
  return { label, full, after: kind === "parcel" ? prev : dashed(prev) };
}

/** What the search's first page shows about the number searched, from its first row's key. */
export function seekText(
  kind: SourceKind,
  seek: Seek,
  firstKey: string | undefined,
): string {
  const what = noun(kind);
  const { label, full } = seek;
  const matches =
    firstKey !== undefined &&
    (full ? firstKey === label : firstKey.startsWith(label));
  if (matches)
    return full
      ? `${what[0]!.toUpperCase()}${what.slice(1)} ${label} found, from the first row below.`
      : `${what[0]!.toUpperCase()}${what.slice(1)}s starting with ${label}, from the first row below.`;
  const none = full
    ? `No ${what} ${label} in this source`
    : `No ${what} in this source starts with ${label}`;
  return firstKey === undefined
    ? `${none}, and none comes after it.`
    : `${none}; the page starts at the next one.`;
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
  // A search (seek) also belongs to its source; the cursors then page on from the search's first page.
  const [sel, setSel] = useState<{
    name?: string;
    cursors: string[];
    seek?: Seek;
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
        seek={sel.seek}
        setCursors={(cursors) =>
          setSel({ name: source.source_name, cursors, seek: sel.seek })
        }
        setSeek={(seek) =>
          setSel({ name: source.source_name, cursors: [], seek })
        }
      />
    </section>
  );
}

function SourceRecords({
  api,
  source,
  cursors,
  seek,
  setCursors,
  setSeek,
}: {
  api: ApiClient;
  source: SourceRow;
  cursors: string[];
  seek?: Seek;
  setCursors: (c: string[]) => void;
  setSeek: (s?: Seek) => void;
}) {
  const after = cursors.at(-1) ?? seek?.after;
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
      <SearchForm kind={source.source_kind} seek={seek} setSeek={setSeek} />
      {seek && data && !cursors.length && (
        <p data-testid="records-search-result">
          {seekText(
            source.source_kind,
            seek,
            data.items[0] &&
              (data.items[0].kind === "parcel"
                ? (data.items[0].parcel_id ?? undefined)
                : data.items[0].permit_number),
          )}
        </p>
      )}
      <p data-testid="records-total">
        {data ? `${data.total.toLocaleString("en-US")} records` : "…"} · page{" "}
        {cursors.length + 1}
        {seek && ` from ${seek.label}`}
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

/** The search box: a parcel number on the roll, a permit number on the permit and contractor sources. */
function SearchForm({
  kind,
  seek,
  setSeek,
}: {
  kind: SourceKind;
  seek?: Seek;
  setSeek: (s?: Seek) => void;
}) {
  const [text, setText] = useState(seek?.label ?? "");
  const [invalid, setInvalid] = useState<string>();
  const what = noun(kind);
  return (
    <form
      data-testid="records-search"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) {
          setInvalid(undefined);
          setSeek(undefined);
          return;
        }
        const s = seekFor(kind, text);
        if (typeof s === "string") return setInvalid(s);
        setInvalid(undefined);
        setSeek(s);
      }}
    >
      <label>
        Go to {what}{" "}
        <input
          data-testid="records-search-input"
          value={text}
          inputMode="numeric"
          onChange={(e) => setText(e.target.value)}
        />
      </label>{" "}
      <button type="submit">Go</button>{" "}
      {seek && (
        <button
          type="button"
          onClick={() => {
            setText("");
            setInvalid(undefined);
            setSeek(undefined);
          }}
        >
          Clear search
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
