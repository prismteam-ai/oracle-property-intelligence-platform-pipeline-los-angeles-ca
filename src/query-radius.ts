/**
 * DuckDB proof query: parcels within a radius of a point whose roof-age proxy is older than
 * the threshold, with provenance. Uses the shared view contract (@oracle-la/views): the
 * oracle.roof_age_candidates macro and the oracle.v_* views, never raw Parquet columns.
 *
 * Usage: node src/query-radius.ts --parquet <file> [--lat=34.1990] [--lon=-118.4870]   (negative values need the = form)
 *        [--radius 5] [--age 15] [--limit 5]
 * Rule (shared): older than N years means year built < roll year - N; the roll year comes from the data.
 * "Older than 15 years" on roll 2026 means year built <= 2010.
 */
import { parseArgs } from "node:util";
import { DuckDBInstance } from "@duckdb/node-api";
import { propertyViewsSql, roofAgeRule } from "@oracle-la/views";

const { values } = parseArgs({
  options: {
    parquet: { type: "string" },
    lat: { type: "string", default: "34.1990" },
    lon: { type: "string", default: "-118.4870" },
    radius: { type: "string", default: "5" }, // miles
    miles: { type: "string" }, // deprecated alias of --radius
    age: { type: "string", default: "15" },
    limit: { type: "string", default: "5" },
  },
});
if (!values.parquet) throw new Error("--parquet is required");
const lat = Number(values.lat),
  lon = Number(values.lon),
  miles = Number(values.miles ?? values.radius);
const age = Number(values.age),
  limit = Number(values.limit);
for (const [k, v] of Object.entries({ lat, lon, miles, age, limit }))
  if (!Number.isFinite(v)) throw new Error(`invalid --${k}`);
if (!Number.isInteger(age) || age < 0)
  throw new Error("--age must be a non-negative integer");

const c = await (await DuckDBInstance.create(":memory:")).connect();
await c.run(propertyViewsSql({ propertyParquet: values.parquet }));
const rows = async (sql: string, params: Record<string, unknown> = {}) =>
  (await c.runAndReadAll(sql, params as never)).getRowObjectsJson();

const rollYears = (
  await rows(
    "select distinct roll_year from oracle.v_property where roll_year is not null",
  )
).map((r) => Number(r.roll_year));
if (rollYears.length !== 1)
  throw new Error(
    `expected one roll year in the data, found ${rollYears.join(", ") || "none"}`,
  );
const rule = roofAgeRule(rollYears[0]!, age);
const params = { age, lat, lon, miles };

const nearest = await rows(
  `select parcel_id, address, round(oracle.haversine_miles($lat, $lon, latitude, longitude), 3) as miles
  from oracle.v_property where latitude is not null and longitude is not null order by miles limit 1`,
  { lat, lon },
);
const summary = await rows(
  `select count(*) as matches, min(year_built) as oldest, max(year_built) as newest, round(max(distance_miles), 2) as max_distance_miles
  from oracle.roof_age_candidates($age, $lat, $lon, $miles)`,
  params,
);
const sample = await rows(
  `select c.parcel_id, c.address, c.year_built, c.effective_year_built, c.roof_age_basis, round(c.distance_miles, 2) as distance_miles,
    c.latitude, c.longitude, p.source_name, p.source_request_url, p.source_retrieved_at, p.source_page_sha256
  from oracle.roof_age_candidates($age, $lat, $lon, $miles) c join oracle.v_property_provenance p using (parcel_id)
  order by c.distance_miles, c.parcel_id limit ${Math.trunc(limit)}`,
  params,
);

console.log(
  JSON.stringify(
    {
      point: { lat, lon },
      nearest_parcel_to_point: nearest[0],
      radius_miles: miles,
      age_threshold_years: age,
      roll_year: rule.roll_year,
      rule: `year_built < ${rule.built_before_year} (i.e. <= ${rule.built_before_year - 1})`,
      rule_text: rule.text,
      summary: summary[0],
      sample,
    },
    null,
    2,
  ),
);
