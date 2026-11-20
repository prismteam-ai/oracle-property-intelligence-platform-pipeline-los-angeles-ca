import { useState, type ChangeEvent, type FormEvent } from "react";
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
import {
  DEFAULT_CENTER,
  inputValue,
  LAT,
  LON,
  RADIUS,
  readAll,
  readNumber,
  typed,
  type NumberRule,
} from "./numeric.ts";
import { OpenButton, RecordView, rowClick, useRecord } from "./RecordView.tsx";
import type { LoadSources } from "./sources.ts";
import { useQuery } from "./useQuery.ts";

const THRESHOLD: NumberRule = {
  label: "Roof older than (years)",
  min: 1,
  max: 120,
  whole: true,
};

/**
 * Radius + roof-age query as form and table (no map in the Explorer; the CRM owns the map). A row opens its
 * record with its source (RecordView): one parcels.detail call per click; the sources are loaded with the tab.
 */
export function RadiusQuery({
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
    threshold_years: "15",
  });
  // The ownership filter: off by default; turned on, "both" is preselected.
  const [ownership, setOwnership] = useState<{
    on: boolean;
    basis: OwnershipBasis;
  }>({ on: false, basis: DEFAULT_BASIS });
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState<SearchResult>();
  const [error, setError] = useState<string>();
  const sources = useQuery(loadSources, "sources");
  const record = useRecord(api);
  const run = async (off: number) => {
    setError(undefined);
    const read = readAll({
      lat: readNumber(form.lat, LAT),
      lon: readNumber(form.lon, LON),
      radius_miles: readNumber(form.radius_miles, RADIUS),
      threshold_years: readNumber(form.threshold_years, THRESHOLD),
    });
    // An empty or invalid field: a plain message, nothing sent.
    if ("error" in read) return setError(read.error);
    try {
      setRes(
        await api.parcels.search.query({
          ...read.values,
          // Sent only when the filter is on: no ownership filter by default.
          ...(ownership.on ? { ownership_basis: ownership.basis } : {}),
          offset: off,
          limit: 50,
        }),
      );
      setOffset(off);
      record.close();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(0);
  };
  const num = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = typed(e);
    setForm((f) => ({ ...f, [k]: v }));
  };
  return (
    <section>
      <h2>Properties within a radius with roofs older than a threshold</h2>
      <form
        className="inline"
        onSubmit={submit}
        noValidate
        data-testid="radius-form"
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
          Roof older than (years)
          <input
            name="threshold"
            type="number"
            step={1}
            min={1}
            max={120}
            value={inputValue(form.threshold_years)}
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
      {error && (
        <p className="error" data-testid="radius-error" role="alert">
          {error}
        </p>
      )}
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
          {record.rec && (
            <RecordView
              rec={record.rec}
              sources={sources}
              onClose={record.close}
            />
          )}
          <table data-testid="radius-results" className="records-table">
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
              {res.items.map((i) => {
                const open = () => record.open(i.parcel_id, i.parcel_id);
                const shown = record.rec?.key === i.parcel_id;
                return (
                  <tr
                    key={i.parcel_id}
                    data-testid="radius-row"
                    data-parcel={i.parcel_id}
                    className={shown ? "record-row shown" : "record-row"}
                    onClick={rowClick(open)}
                  >
                    <td>
                      <OpenButton
                        label={`parcel ${i.parcel_id}`}
                        id={i.parcel_id}
                        open={shown}
                        onOpen={open}
                      />
                    </td>
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
                );
              })}
            </tbody>
          </table>
          <p>
            Coordinates are assessor parcel center points. A row opens its
            record with its provenance and source.
          </p>
        </>
      )}
    </section>
  );
}
