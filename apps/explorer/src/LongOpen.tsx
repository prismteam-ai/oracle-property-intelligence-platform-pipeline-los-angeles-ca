import { useState, type FormEvent } from "react";
import type {
  ApiClient,
  DEFAULT_MIN_OPEN_DAYS,
  LongOpenItem,
  LongOpenResult,
  ParcelPermits,
} from "@oracle-la/api-client";
import { basisLabel } from "./basis.ts";
import {
  contractorAttribution,
  retrieved,
  type LoadSources,
} from "./sources.ts";
import { useQuery } from "./useQuery.ts";

/** The API's default minimum (5 years x 365.25, rounded); typed so a different API default fails the typecheck. */
export const DEFAULT_MIN_DAYS: typeof DEFAULT_MIN_OPEN_DAYS = 1826;
const PAGE = 50;

/** forParcel results by parcel ID: fetched when a row of that parcel is first expanded, then kept. */
type ParcelState = { data?: ParcelPermits; error?: string };

/**
 * Long-open roofing permits around a point (permits.longOpen). Long-open items carry no contractors and no
 * per-item provenance: a row's contractors come from permits.forParcel for its parcel, fetched only when the
 * row is expanded (one call per parcel, kept for the session); the source is cited once from
 * explorer.sources (the LADBS permit datasets). Work descriptions are not served and never shown.
 */
export function LongOpen({
  api,
  loadSources,
}: {
  api: ApiClient;
  loadSources: LoadSources;
}) {
  const [form, setForm] = useState({
    lat: 34.199,
    lon: -118.487,
    radius_miles: 5,
    min_open_days: DEFAULT_MIN_DAYS as number,
    max_open_days: "",
    sort: "open_days" as "open_days" | "distance",
  });
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState<LongOpenResult>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [parcels, setParcels] = useState<Record<string, ParcelState>>({});
  const sources = useQuery(loadSources, "sources");
  const permitSource = sources.data?.sources.find(
    (s) => s.source_kind === "permit",
  );
  const contractorSource = sources.data?.sources.find(
    (s) => s.source_kind === "contractor",
  );

  const run = async (off: number) => {
    setError(undefined);
    try {
      const max = form.max_open_days.trim();
      setRes(
        await api.permits.longOpen.query({
          lat: form.lat,
          lon: form.lon,
          radius_miles: form.radius_miles,
          min_open_days: form.min_open_days,
          // Sent only when set: no maximum by default.
          ...(max === "" ? {} : { max_open_days: Number(max) }),
          sort: form.sort,
          offset: off,
          limit: PAGE,
        }),
      );
      setOffset(off);
      setOpen(new Set());
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
    (k: "lat" | "lon" | "radius_miles" | "min_open_days") =>
    (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [k]: Number(e.target.value) }));

  return (
    <section>
      <h2>Long-open roofing permits within a radius</h2>
      <form className="inline" onSubmit={submit} data-testid="long-open-form">
        <label>
          Latitude
          <input
            name="lat"
            type="number"
            step="any"
            value={form.lat}
            onChange={num("lat")}
          />
        </label>
        <label>
          Longitude
          <input
            name="lon"
            type="number"
            step="any"
            value={form.lon}
            onChange={num("lon")}
          />
        </label>
        <label>
          Radius (miles)
          <input
            name="radius"
            type="number"
            step="any"
            min={0.1}
            max={10}
            value={form.radius_miles}
            onChange={num("radius_miles")}
          />
        </label>
        <label>
          Open at least (days)
          <input
            name="min_open_days"
            type="number"
            min={0}
            value={form.min_open_days}
            onChange={num("min_open_days")}
          />
        </label>
        <label>
          Open at most (days, optional)
          <input
            name="max_open_days"
            type="number"
            min={0}
            value={form.max_open_days}
            onChange={(e) =>
              setForm((f) => ({ ...f, max_open_days: e.target.value }))
            }
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
      {error && <p className="error">{error}</p>}
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
          <table data-testid="long-open-results">
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
                  parcel={parcels[i.parcel_id]}
                  sourceName={permitSource?.source_name}
                  contractorNote={
                    contractorSource && contractorAttribution(contractorSource)
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
}: {
  item: LongOpenItem;
  expanded: boolean;
  onToggle: () => void;
  parcel: ParcelState | undefined;
  sourceName: string | undefined;
  contractorNote: string | undefined;
}) {
  const permit = parcel?.data?.permits.find(
    (p) => p.permit_number === i.permit_number,
  );
  return (
    <>
      <tr data-testid="long-open-row" data-permit={i.permit_number}>
        <td>
          {i.permit_number}
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
