import { useState, type FormEvent } from "react";
import type {
  ApiClient,
  OwnershipBasis,
  SearchResult,
} from "@oracle-la/api-client";
import { basisLabel } from "./basis.ts";
import {
  BASES,
  DEFAULT_BASIS,
  OWNERSHIP_TEXTS,
  PROXY_NOTE,
} from "./ownership.ts";

/** Radius + roof-age query as form and table (no map in the Explorer; the CRM owns the map). */
export function RadiusQuery({ api }: { api: ApiClient }) {
  const [form, setForm] = useState({
    lat: 34.199,
    lon: -118.487,
    radius_miles: 5,
    threshold_years: 15,
  });
  // The ownership filter: off by default; turned on, "both" is preselected.
  const [ownership, setOwnership] = useState<{
    on: boolean;
    basis: OwnershipBasis;
  }>({ on: false, basis: DEFAULT_BASIS });
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState<SearchResult>();
  const [error, setError] = useState<string>();
  const run = async (off: number) => {
    setError(undefined);
    try {
      setRes(
        await api.parcels.search.query({
          ...form,
          // Sent only when the filter is on: no ownership filter by default.
          ...(ownership.on ? { ownership_basis: ownership.basis } : {}),
          offset: off,
          limit: 50,
        }),
      );
      setOffset(off);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(0);
  };
  const num = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: Number(e.target.value) }));
  return (
    <section>
      <h2>Properties within a radius with roofs older than a threshold</h2>
      <form className="inline" onSubmit={submit} data-testid="radius-form">
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
          Roof older than (years)
          <input
            name="threshold"
            type="number"
            min={1}
            max={120}
            value={form.threshold_years}
            onChange={num("threshold_years")}
          />
        </label>
        <button type="submit">Search</button>
      </form>
      <fieldset data-testid="ownership">
        <legend>
          <label>
            <input
              type="checkbox"
              name="ownership-on"
              checked={ownership.on}
              onChange={(e) =>
                setOwnership((o) => ({ ...o, on: e.target.checked }))
              }
            />{" "}
            Owner unchanged for 10 years or more (ownership filter)
          </label>
        </legend>
        {ownership.on && (
          <>
            {BASES.map(([basis, label]) => (
              <div key={basis} className="basis" data-basis={basis}>
                <label>
                  <input
                    type="radio"
                    name="ownership-basis"
                    value={basis}
                    checked={ownership.basis === basis}
                    onChange={() => setOwnership((o) => ({ ...o, basis }))}
                  />{" "}
                  {label}
                </label>
                <p className="note">{OWNERSHIP_TEXTS[basis].text}</p>
                <p className="note" data-testid="ownership-weakness">
                  Weakness: {OWNERSHIP_TEXTS[basis].weakness}
                </p>
              </div>
            ))}
            <p className="note" data-testid="ownership-proxy-note">
              {PROXY_NOTE}
            </p>
          </>
        )}
      </fieldset>
      {error && <p className="error">{error}</p>}
      {res && (
        <>
          <p className="note" data-testid="rule">
            {res.rule.text}
          </p>
          {res.ownership && (
            <p
              className="note"
              data-testid="ownership-rule"
              data-basis={res.ownership.basis}
            >
              Ownership filter ({res.ownership.basis}): {res.ownership.text}{" "}
              Weakness: {res.ownership.weakness} {res.ownership.proxy_note}
            </p>
          )}
          <p>
            <b data-testid="radius-count">
              {res.count.toLocaleString("en-US")}
            </b>{" "}
            matching parcels · showing {offset + 1}–{offset + res.items.length}{" "}
            <button
              disabled={offset === 0}
              onClick={() => void run(Math.max(0, offset - 50))}
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
          <table data-testid="radius-results">
            <thead>
              <tr>
                <th>Parcel</th>
                <th>Address</th>
                <th>Year built</th>
                <th>Effective roof year</th>
                <th>Basis</th>
                <th>Roof age (years)</th>
                <th>Land base year</th>
                <th>Distance (mi)</th>
                <th>Latitude</th>
                <th>Longitude</th>
              </tr>
            </thead>
            <tbody>
              {res.items.map((i) => (
                <tr key={i.parcel_id}>
                  <td>{i.parcel_id}</td>
                  <td>{i.address}</td>
                  <td>{i.year_built ?? "—"}</td>
                  <td>{i.effective_roof_year}</td>
                  <td title={i.roof_age_basis} data-testid="basis">
                    {basisLabel(i.roof_age_basis, i.roof_year_permit_number)}
                  </td>
                  <td>{i.roof_age_years}</td>
                  <td data-testid="land-base-year">
                    {i.land_base_year ?? "—"}
                  </td>
                  <td data-testid="distance">{i.distance_miles}</td>
                  <td data-testid="lat">{i.latitude}</td>
                  <td data-testid="lon">{i.longitude}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Coordinates are assessor parcel centre points; provenance per parcel
            is on the Records tab.
          </p>
        </>
      )}
    </section>
  );
}
