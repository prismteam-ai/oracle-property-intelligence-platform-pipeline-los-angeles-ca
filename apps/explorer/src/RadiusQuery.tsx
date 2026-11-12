import { useState, type FormEvent } from "react";
import type { ApiClient, SearchResult } from "@oracle-la/api-client";

/** Radius + roof-age query as form and table (D11: no map in the explorer; the CRM owns the map). */
export function RadiusQuery({ api }: { api: ApiClient }) {
  const [form, setForm] = useState({
    lat: 34.199,
    lon: -118.487,
    radius_miles: 5,
    threshold_years: 15,
  });
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState<SearchResult>();
  const [error, setError] = useState<string>();
  const run = async (off: number) => {
    setError(undefined);
    try {
      setRes(
        await api.parcels.search.query({ ...form, offset: off, limit: 50 }),
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
      {error && <p className="error">{error}</p>}
      {res && (
        <>
          <p className="note" data-testid="rule">
            {res.rule.text}
          </p>
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
                <th>Roof-age proxy (years)</th>
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
                  <td>{i.year_built}</td>
                  <td>{i.roof_age_years_proxy}</td>
                  <td data-testid="distance">{i.distance_miles}</td>
                  <td>{i.latitude}</td>
                  <td>{i.longitude}</td>
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
