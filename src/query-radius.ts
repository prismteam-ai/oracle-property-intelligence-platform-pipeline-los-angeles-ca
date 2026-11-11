/**
 * DuckDB proof query: parcels within a radius of a point whose structure year built is
 * strictly older than the age threshold, with provenance.
 *
 * Usage: node src/query-radius.ts --parquet <file> [--lat=34.1990] [--lon=-118.4870]   (negative values need the = form)
 *        [--radius 5] [--age 15] [--as-of-year <current year>] [--limit 5]
 * "Older than 15 years" in 2026 means property_structure_built_year <= 2010 (year < as_of_year - age).
 */
import { parseArgs } from "node:util";
import { DuckDBInstance } from "@duckdb/node-api";

const { values } = parseArgs({
  options: {
    parquet: { type: "string" },
    lat: { type: "string", default: "34.1990" },
    lon: { type: "string", default: "-118.4870" },
    radius: { type: "string", default: "5" }, // miles
    miles: { type: "string" }, // deprecated alias of --radius
    age: { type: "string", default: "15" },
    "as-of-year": {
      type: "string",
      default: String(new Date().getUTCFullYear()),
    },
    limit: { type: "string", default: "5" },
  },
});
if (!values.parquet) throw new Error("--parquet is required");
const lat = Number(values.lat),
  lon = Number(values.lon),
  miles = Number(values.miles ?? values.radius);
const age = Number(values.age),
  asOf = Number(values["as-of-year"]),
  limit = Number(values.limit);
for (const [k, v] of Object.entries({ lat, lon, miles, age, asOf, limit }))
  if (!Number.isFinite(v)) throw new Error(`invalid --${k}`);
const cutoffExclusive = asOf - age; // built strictly before this year

const c = await (await DuckDBInstance.create(":memory:")).connect();
const base = `
with p as (
  select *, 3958.8 * 2 * asin(sqrt(
      pow(sin(radians(latitude - $lat) / 2), 2)
    + cos(radians($lat)) * cos(radians(latitude)) * pow(sin(radians(longitude - $lon) / 2), 2))) as distance_miles
  from read_parquet($parquet)
  where latitude is not null and longitude is not null
)
select * from p where distance_miles <= $miles and property_structure_built_year < $cutoff`;
const params = {
  lat,
  lon,
  miles,
  cutoff: cutoffExclusive,
  parquet: values.parquet,
};

const nearest = (
  await c.runAndReadAll(
    `select parcel_identifier, unnormalized_address, round(3958.8 * 2 * asin(sqrt(pow(sin(radians(latitude - $lat) / 2), 2) + cos(radians($lat)) * cos(radians(latitude)) * pow(sin(radians(longitude - $lon) / 2), 2))), 3) as miles from read_parquet($parquet) where latitude is not null order by miles limit 1`,
    { lat, lon, parquet: values.parquet },
  )
).getRowObjectsJson();
const summary = (
  await c.runAndReadAll(
    `select count(*) as matches, min(property_structure_built_year) as oldest, max(property_structure_built_year) as newest, round(max(distance_miles), 2) as max_distance_miles from (${base})`,
    params,
  )
).getRowObjectsJson();
const sample = (
  await c.runAndReadAll(
    `select parcel_identifier, unnormalized_address, property_structure_built_year, property_effective_built_year, roof_age_basis, round(distance_miles, 2) as distance_miles, latitude, longitude, source_name, source_http_request, source_retrieved_at, source_page_sha256 from (${base}) order by distance_miles limit ${Math.trunc(limit)}`,
    params,
  )
).getRowObjectsJson();

console.log(
  JSON.stringify(
    {
      point: { lat, lon },
      nearest_parcel_to_point: nearest[0],
      radius_miles: miles,
      age_threshold_years: age,
      as_of_year: asOf,
      rule: `property_structure_built_year < ${cutoffExclusive} (i.e. <= ${cutoffExclusive - 1})`,
      summary: summary[0],
      sample,
    },
    null,
    2,
  ),
);
