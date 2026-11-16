import { useState, type ChangeEvent, type FormEvent } from "react";
import type {
  ApiClient,
  DEFAULT_MIN_OPEN_DAYS,
  LongOpenItem,
  LongOpenResult,
  ParcelPermits,
} from "@oracle-la/api-client";
import { basisLabel } from "./basis.ts";
import {
  DEFAULT_CENTER,
  inputValue,
  LAT,
  LON,
  MAX_DAYS,
  RADIUS,
  readAll,
  readNumber,
  readOptional,
  typed,
  type NumberRule,
} from "./numeric.ts";
import { OpenButton, RecordView, rowClick, useRecord } from "./RecordView.tsx";
import { contractorNote, retrieved, type LoadSources } from "./sources.ts";
import { useQuery } from "./useQuery.ts";

/** The API's default minimum (5 years x 365.25, rounded); typed so a different API default fails the typecheck. */
export const DEFAULT_MIN_DAYS: typeof DEFAULT_MIN_OPEN_DAYS = 1826;
const PAGE = 50;
const MIN_DAYS_RULE: NumberRule = {
  label: "Open at least (days)",
  min: 0,
  max: MAX_DAYS,
  whole: true,
};
const MAX_DAYS_RULE: NumberRule = {
  label: "Open at most (days, optional)",
  min: 0,
  max: MAX_DAYS,
  whole: true,
};

/** forParcel results by parcel ID: fetched when a row of that parcel is first expanded, then kept. */
type ParcelState = { data?: ParcelPermits; error?: string };

/**
 * Long-open roofing permits around a point (permits.longOpen). Long-open items carry no contractors and no
 * per-item provenance: a row's contractors come from permits.forParcel for its parcel, fetched only when the
 * row is expanded (one call per parcel, kept for the session); the source is cited once from
 * explorer.sources (the LADBS permit datasets). Work descriptions are not served and never shown. A row opens its
 * record (RecordView): the permit as the row shows it with the permit source, and its parcel's record (one
 * parcels.detail call per click).
 */
export function LongOpen({
  api,
  loadSources,
}: {
  api: ApiClient;
  loadSources: LoadSources;
}) {
  // The fields' text as typed; read only when the search runs.
  const [form, setForm] = useState({
    lat: DEFAULT_CENTER.lat,
    lon: DEFAULT_CENTER.lon,
    radius_miles: "5",
    min_open_days: String(DEFAULT_MIN_DAYS),
    max_open_days: "",
    sort: "open_days" as "open_days" | "distance",
  });
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState<LongOpenResult>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [parcels, setParcels] = useState<Record<string, ParcelState>>({});
  const sources = useQuery(loadSources, "sources");
  const record = useRecord(api);
  const permitSource = sources.data?.sources.find(
    (s) => s.source_kind === "permit",
  );
  const contractorSource = sources.data?.sources.find(
    (s) => s.source_kind === "contractor",
  );

  const run = async (off: number) => {
    setError(undefined);
    const read = readAll({
      lat: readNumber(form.lat, LAT),
      lon: readNumber(form.lon, LON),
      radius_miles: readNumber(form.radius_miles, RADIUS),
      min_open_days: readNumber(form.min_open_days, MIN_DAYS_RULE),
      max_open_days: readOptional(form.max_open_days, MAX_DAYS_RULE),
    });
    // An empty or invalid field: a plain message, nothing sent.
    if ("error" in read) return setError(read.error);
    const { max_open_days: max, ...rest } = read.values;
    if (max !== undefined && max < rest.min_open_days)
      return setError(
        `Open at most (${max.toLocaleString("en-US")} days) is below open at least (${rest.min_open_days.toLocaleString("en-US")} days): set a larger maximum or clear it.`,
      );
    try {
      setRes(
        await api.permits.longOpen.query({
          ...rest,
          // Sent only when set: no maximum by default.
          ...(max === undefined ? {} : { max_open_days: max }),
          sort: form.sort,
          offset: off,
          limit: PAGE,
        }),
      );
      setOffset(off);
      setOpen(new Set());
      record.close();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(0);
  };
  const toggle = (item: LongOpenItem) => {
    const next = new Set(open);
    if (next.has(item.permit_number)) next.delete(item.permit_number);
    else next.add(item.permit_number);
    setOpen(next);
    const id = item.parcel_id;
    if (next.has(item.permit_number) && !parcels[id]) {
      setParcels((p) => ({ ...p, [id]: {} }));
      api.permits.forParcel.query({ parcel_id: id }).then(
        (data) => setParcels((p) => ({ ...p, [id]: { data } })),
        (e: Error) => setParcels((p) => ({ ...p, [id]: { error: e.message } })),
      );
    }
  };
  const num =
    (k: "lat" | "lon" | "radius_miles" | "min_open_days" | "max_open_days") =>
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = typed(e);
      setForm((f) => ({ ...f, [k]: v }));
    };

  return (
    <section>
      <h2>Long-open roofing permits within a radius</h2>
      <form
        className="inline"
        onSubmit={submit}
        noValidate
        data-testid="long-open-form"
      >
        <label>
          Latitude
          <input
            name="lat"
            inputMode="decimal"
            autoComplete="off"
            value={form.lat}
            onChange={num("lat")}
          />
        </label>
        <label>
          Longitude
          <input
            name="lon"
            inputMode="decimal"
            autoComplete="off"
            value={form.lon}
            onChange={num("lon")}
          />
        </label>
        <label>
          Radius (miles)
          <input
            name="radius"
            type="number"
            // Whole miles on the arrows (from 1); a decimal from 0.1 can be typed.
            step={1}
            min={1}
            max={10}
            value={inputValue(form.radius_miles)}
            onChange={num("radius_miles")}
          />
        </label>
        <label>
          Open at least (days)
          <input
            name="min_open_days"
            type="number"
            step={1}
            min={0}
            max={MAX_DAYS}
            value={inputValue(form.min_open_days)}
            onChange={num("min_open_days")}
          />
        </label>
        <label>
          Open at most (days, optional)
          <input
            name="max_open_days"
            type="number"
            step={1}
            min={0}
            max={MAX_DAYS}
            value={inputValue(form.max_open_days)}
            onChange={num("max_open_days")}
          />
        </label>
        <label>
          Order
          <select
            name="sort"
            value={form.sort}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                sort: e.target.value as "open_days" | "distance",
              }))
            }
          >
            <option value="open_days">longest open first</option>
            <option value="distance">nearest first</option>
          </select>
        </label>
        <button type="submit">Find long-open permits</button>
      </form>
      <p className="note" data-testid="long-open-source">
        {permitSource ? (
          <>
            Source: {permitSource.source_name}, retrieved{" "}
            {retrieved(permitSource)}. Attribution: {permitSource.attribution}.
            License: {permitSource.license}.{" "}
            <a href={permitSource.terms_of_use ?? "#"}>Terms of use</a>. The
            list carries no per-permit page provenance; the permit pages are on
            the Sources tab.
          </>
        ) : sources.error ? (
          `Source: not loaded (${sources.error})`
        ) : (
          "Loading source…"
        )}
      </p>
      {error && (
        <p className="error" data-testid="long-open-error" role="alert">
          {error}
        </p>
      )}
      {res && (
        <>
          <p className="note" data-testid="long-open-rule">
            {res.rule.text}
          </p>
          <p>
            <b data-testid="long-open-count">
              {res.count.toLocaleString("en-US")}
            </b>{" "}
            long-open roofing permits · showing{" "}
            {res.items.length ? offset + 1 : 0}–{offset + res.items.length}{" "}
            <button
              disabled={offset === 0}
              onClick={() => void run(Math.max(0, offset - PAGE))}
            >
              Previous
            </button>{" "}
            <button
              disabled={res.next_offset === null}
              onClick={() => void run(res.next_offset!)}
            >
              Next
            </button>
          </p>
          {record.rec && (
            <RecordView
              rec={record.rec}
              sources={sources}
              onClose={record.close}
            />
          )}
          <table data-testid="long-open-results" className="records-table">
            <thead>
              <tr>
                <th>Permit</th>
                <th>Address</th>
                <th>Status</th>
                <th>Issued</th>
                <th>Days open</th>
                <th>Distance (mi)</th>
                <th>Parcel (AIN)</th>
                <th>Roof year (basis)</th>
                <th>Contractor</th>
                <th>BBB</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {res.items.map((i) => (
                <Row
                  key={i.permit_number}
                  item={i}
                  expanded={open.has(i.permit_number)}
                  onToggle={() => toggle(i)}
                  shown={record.rec?.key === i.permit_number}
                  onOpen={() => record.open(i.permit_number, i.parcel_id, i)}
                  parcel={parcels[i.parcel_id]}
                  sourceName={permitSource?.source_name}
                  contractorNote={
                    contractorSource && contractorNote(contractorSource)
                  }
                />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function Row({
  item: i,
  expanded,
  onToggle,
  parcel,
  sourceName,
  contractorNote,
  shown,
  onOpen,
}: {
  item: LongOpenItem;
  expanded: boolean;
  onToggle: () => void;
  /** This row's record is the one shown. */
  shown: boolean;
  onOpen: () => void;
  parcel: ParcelState | undefined;
  sourceName: string | undefined;
  contractorNote: string | undefined;
}) {
  const permit = parcel?.data?.permits.find(
    (p) => p.permit_number === i.permit_number,
  );
  return (
    <>
      <tr
        data-testid="long-open-row"
        data-permit={i.permit_number}
        className={shown ? "record-row shown" : "record-row"}
        onClick={rowClick(onOpen)}
      >
        <td>
          <OpenButton
            label={`permit ${i.permit_number}`}
            id={i.permit_number}
            open={shown}
            onOpen={onOpen}
          />
          {i.building_level && " (building)"}
          {i.roof_coating_only && " (roof coating only)"}
        </td>
        <td>{i.address ?? "—"}</td>
        <td data-testid="status">
          {i.source_status_desc ?? "—"} ({i.permit_status_class})
        </td>
        <td>{i.permit_issue_date ?? "—"}</td>
        <td data-testid="open-days">{i.open_days ?? "—"}</td>
        <td>{i.distance_miles}</td>
        <td>{i.parcel_id}</td>
        <td data-testid="roof-year" title={i.roof_age_basis}>
          {i.effective_roof_year ?? "—"} (
          {basisLabel(i.roof_age_basis, i.roof_year_permit_number)})
        </td>
        <td>
          <button
            aria-expanded={expanded}
            data-testid="contractors-toggle"
            onClick={onToggle}
          >
            {expanded ? "Hide contractors" : "Show contractors"}
          </button>
        </td>
        <td data-testid="bbb">not available</td>
        <td data-testid="source">{sourceName ?? "—"}</td>
      </tr>
      {expanded && (
        <tr data-testid="contractors-row">
          <td colSpan={11}>
            {!parcel?.data && !parcel?.error && "Loading contractors…"}
            {parcel?.error && <span className="error">{parcel.error}</span>}
            {parcel?.data && (
              <>
                {!permit || permit.contractors.length === 0 ? (
                  <p data-testid="no-contractors">
                    The LADBS contractor view has no row for this permit.
                  </p>
                ) : (
                  <table data-testid="contractors">
                    <thead>
                      <tr>
                        <th>Business name</th>
                        <th>License number</th>
                        <th>License class (raw)</th>
                        <th>License class (normalized)</th>
                        <th>Owner-builder</th>
                        <th>License expires</th>
                        <th>City, state</th>
                        <th>Identity (license)</th>
                        <th>Canonical name</th>
                        <th>Name variants</th>
                      </tr>
                    </thead>
                    <tbody>
                      {permit.contractors.map((c, n) => (
                        <tr key={n}>
                          <td>{c.contractors_business_name ?? "—"}</td>
                          <td>{c.license_identifier ?? "—"}</td>
                          <td>{c.source_license_type ?? "—"}</td>
                          <td>
                            {[c.license_class, c.license_class_note]
                              .filter(Boolean)
                              .join("; ") || "—"}
                          </td>
                          <td>
                            {c.is_owner_builder === null
                              ? "—"
                              : c.is_owner_builder
                                ? "yes"
                                : "no"}
                          </td>
                          <td>{c.license_expiration_date ?? "—"}</td>
                          <td>
                            {[c.city_name, c.state_code]
                              .filter(Boolean)
                              .join(", ") || "—"}
                          </td>
                          <td data-testid="identity-key">
                            {c.contractor_identity_key ?? "—"}
                          </td>
                          <td data-testid="canonical-name">
                            {c.canonical_business_name ?? "—"}
                          </td>
                          <td data-testid="name-variants">
                            {c.name_variant_count ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {permit && permit.contractors.length > 0 && contractorNote && (
                  <p className="note">{contractorNote}</p>
                )}
                <p data-testid="bbb-reason">
                  BBB: not available. {parcel.data.bbb.reason}
                </p>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
