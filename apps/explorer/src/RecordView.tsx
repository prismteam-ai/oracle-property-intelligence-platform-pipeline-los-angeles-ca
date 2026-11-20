import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type {
  ApiClient,
  LongOpenItem,
  ParcelDetail,
  RoofAgeBasis,
  SourceKind,
  SourceRow,
  Sources,
} from "@oracle-la/api-client";
import { basisLabel } from "./basis.ts";
import { retrieved } from "./sources.ts";

/**
 * The record a table row opened: the row's key, the parcel whose record is read (parcels.detail: its property and
 * provenance), the read's result, and for a long-open row the permit as the row shows it.
 */
export interface OpenRecord {
  key: string;
  parcelId: string;
  permit?: LongOpenItem;
  detail?: ParcelDetail;
  error?: string;
}

/**
 * A table's open record. open() reads parcels.detail for the row's parcel: one data call per click (none when that
 * row's record is already shown); the sources come from explorer.sources, which the tab has loaded already.
 */
export function useRecord(api: ApiClient) {
  const [rec, setRec] = useState<OpenRecord>();
  // The row whose answer may still be shown: an older row's late answer is dropped.
  const latest = useRef<string | undefined>(undefined);
  const open = (key: string, parcelId: string, permit?: LongOpenItem) => {
    if (rec?.key === key && !rec.error) return;
    latest.current = key;
    const base = { key, parcelId, ...(permit ? { permit } : {}) };
    setRec(base);
    api.parcels.detail.query({ parcel_id: parcelId }).then(
      (detail) => {
        if (latest.current === key) setRec({ ...base, detail });
      },
      (e: Error) => {
        if (latest.current === key) setRec({ ...base, error: e.message });
      },
    );
  };
  const close = () => {
    latest.current = undefined;
    setRec(undefined);
  };
  return { rec, open, close };
}

/**
 * A row's click handler that opens its record, except for clicks on a control inside the row (the row's own open
 * button handles its click; other buttons and links do their own thing).
 */
export const rowClick =
  (openRow: () => void) => (e: MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as Element).closest("button, a, input, select, label"))
      return;
    openRow();
  };

/** The button that opens a row's record: the row's ID, reachable with the keyboard. */
export function OpenButton({
  label,
  id,
  open,
  onOpen,
  children,
}: {
  /** What the record is, e.g. "parcel 2224012045". */
  label: string;
  id: string;
  open: boolean;
  onOpen: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="row-open"
      data-testid="open-record"
      aria-label={`Open the record of ${label}`}
      aria-expanded={open}
      aria-controls={open ? "record-view" : undefined}
      onClick={onOpen}
    >
      {id}
      {children}
    </button>
  );
}

type Value = string | number | boolean | null | undefined;
const text = (v: unknown): string =>
  v === null || v === undefined || v === "" ? "—" : String(v as Value);

/** Label and value pairs as a definition list. */
function Facts({
  testId,
  rows,
}: {
  testId: string;
  rows: ReadonlyArray<[string, ReactNode]>;
}) {
  return (
    <dl className="facts" data-testid={testId}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The parcel fields the Explorer shows elsewhere (Radius query and Records), from parcels.detail's property. */
const parcelRows = (p: Record<string, unknown>): Array<[string, ReactNode]> => [
  ["Parcel (AIN)", text(p.parcel_id)],
  ["Address", text(p.address)],
  ["Year built", text(p.year_built)],
  ["Effective roof year", text(p.effective_roof_year)],
  [
    "Basis",
    basisLabel(
      typeof p.roof_age_basis === "string"
        ? (p.roof_age_basis as RoofAgeBasis)
        : null,
      typeof p.roof_year_permit_number === "string"
        ? p.roof_year_permit_number
        : null,
    ),
  ],
  ["Land base year", text(p.land_base_year)],
  ["Latitude", text(p.latitude)],
  ["Longitude", text(p.longitude)],
];

/** Where the parcel's record came from (as on the Records and Sources tabs), from parcels.detail's provenance. */
const provenanceRows = (
  p: Record<string, unknown>,
): Array<[string, ReactNode]> => [
  ["Source", text(p.source_name)],
  ["Request URL", <span className="mono">{text(p.source_request_url)}</span>],
  ["Retrieved at", text(p.source_retrieved_at)],
  ["Page", text(p.source_page_file)],
  ["Page sha256", <span className="mono">{text(p.source_page_sha256)}</span>],
];

/** A long-open permit's fields as the Long-open table and the Records tab show them. */
const permitRows = (i: LongOpenItem): Array<[string, ReactNode]> => [
  [
    "Permit number",
    `${i.permit_number}${i.building_level ? " (building)" : ""}${i.roof_coating_only ? " (roof coating only)" : ""}`,
  ],
  ["Address", text(i.address)],
  ["Status", text(i.source_status_desc)],
  ["Status class", i.permit_status_class],
  ["Issue date", text(i.permit_issue_date)],
  ["Days open", text(i.open_days)],
  ["Join method", i.join_method ?? "not joined"],
  ["Parcels", text(i.parcel_count)],
  ["Distance (mi)", text(i.distance_miles)],
];

/** A source's terms as the Sources tab shows them. */
const sourceRows = (s: SourceRow): Array<[string, ReactNode]> => [
  ["Source", s.source_name],
  ["Retrieved", retrieved(s)],
  [
    "Query URL",
    <span className="mono">
      {(s.query_urls ?? (s.query_url ? [s.query_url] : ["—"])).map((u) => (
        <span key={u} className="block">
          {u}
        </span>
      ))}
    </span>,
  ],
  ["License", text(s.license)],
  ["Attribution", text(s.attribution)],
  ["Terms", <a href={s.terms_of_use ?? "#"}>terms</a>],
];

function SourceFacts({
  testId,
  sources,
  name,
  kind,
}: {
  testId: string;
  sources: { data?: Sources; error?: string };
  /** The source the record names (parcels: its provenance); else the run's source of this kind. */
  name?: string;
  kind: SourceKind;
}) {
  const s =
    sources.data?.sources.find((x) => x.source_name === name) ??
    sources.data?.sources.find((x) => x.source_kind === kind);
  if (s) return <Facts testId={testId} rows={sourceRows(s)} />;
  return (
    <p className="note" data-testid={testId}>
      {sources.error
        ? `Source: not loaded (${sources.error})`
        : "Loading source…"}
    </p>
  );
}

/**
 * One record opened from a table row, with its source: a parcel's property and provenance (parcels.detail) and the
 * parcel source; for a long-open row first the permit as the row shows it and the permit source, then its parcel's
 * record. Only fields the Explorer shows elsewhere; the data has no owner fields.
 */
export function RecordView({
  rec,
  sources,
  onClose,
}: {
  rec: OpenRecord;
  sources: { data?: Sources; error?: string };
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Opening a record moves the focus to it (keyboard and screen reader users land on what they opened).
  useEffect(() => {
    heading.current?.focus();
  }, [rec.key]);
  const title = rec.permit
    ? `Permit ${rec.permit.permit_number}`
    : `Parcel ${rec.parcelId}`;
  return (
    <section
      id="record-view"
      className="record-view"
      data-testid="record-view"
      data-record={rec.key}
      aria-label={`Record: ${title}`}
    >
      <h3 ref={heading} tabIndex={-1}>
        Record: {title}{" "}
        <button type="button" data-testid="record-close" onClick={onClose}>
          Close
        </button>
      </h3>
      {rec.permit && (
        <>
          <Facts testId="record-permit" rows={permitRows(rec.permit)} />
          <h4>Permit source</h4>
          <SourceFacts
            testId="record-permit-source"
            sources={sources}
            kind="permit"
          />
          <p className="note">
            The long-open list carries no per-permit page provenance; the permit
            pages are on the Sources tab.
          </p>
          <h4>Parcel {rec.parcelId}</h4>
        </>
      )}
      {rec.error ? (
        <p className="error" data-testid="record-error" role="alert">
          {rec.error}
        </p>
      ) : !rec.detail ? (
        <p data-testid="record-loading">Loading the record…</p>
      ) : (
        <>
          <Facts
            testId="record-parcel"
            rows={parcelRows(rec.detail.property)}
          />
          <h4>Provenance</h4>
          <Facts
            testId="record-provenance"
            rows={provenanceRows(rec.detail.provenance)}
          />
          <h4>Parcel source</h4>
          <SourceFacts
            testId="record-parcel-source"
            sources={sources}
            name={
              typeof rec.detail.provenance.source_name === "string"
                ? rec.detail.provenance.source_name
                : undefined
            }
            kind="parcel"
          />
        </>
      )}
    </section>
  );
}
