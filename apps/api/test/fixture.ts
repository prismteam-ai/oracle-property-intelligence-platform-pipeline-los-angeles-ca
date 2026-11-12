/**
 * Synthetic run for the API tests (no binary file in the repo, no real parcel): a few rows with the
 * increment-1 Parquet columns, written at setup to a temporary directory together with a run manifest
 * and run history, under the file names the Lambda uses after its S3 copy.
 *
 * Rows around the reference point (34.199, -118.487), roll year 2026:
 *   0000000001 at the point, built 2010 (older than 15 years)      page-0000
 *   0000000002 ~0.5 mi north, built 1990                            page-0000
 *   0000000003 at the point, built 2011 (NOT older than 15 years)   page-0000
 *   0000000004 at the point, no year built (excluded)               page-0000
 *   0000000005 no coordinates, built 1950 (excluded)                page-0001
 *   0000000006 ~9 mi north, built 1950 (outside 5 mi, inside 10 mi)  page-0001
 *   0000000007 ~0.2 mi south, built 1940 (older than 80 years)      page-0001
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

export const FIXTURE = {
  runId: "fixture-run",
  point: { lat: 34.199, lon: -118.487 },
  source: "Fixture Source",
  rows: 7,
} as const;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const row = (
  id: string,
  yb: number | null,
  lat: number | null,
  lon: number | null,
  page: string,
) => `select
  ${lit(id)} as parcel_identifier, ${lit(id)} as assessor_id_formatted, ${lit(id)} as request_identifier,
  ${yb ?? "null"}::integer as property_structure_built_year, ${yb ?? "null"}::integer as property_effective_built_year,
  'PROXY' as roof_age_basis, 'SFR' as source_use_type, '0100' as source_use_code, 'Single' as source_use_code_description,
  ${lit(`${Number(id)} TEST ST`)} as unnormalized_address, ${lit(String(Number(id)))} as street_number, null::varchar as street_pre_directional_text,
  'TEST ST' as street_name, null::varchar as unit_identifier, 'TEST CITY' as city_name, '00000' as postal_code, null::varchar as plus_four_postal_code,
  'Los Angeles' as county_name, 'CA' as state_code, ${lat ?? "null"}::double as latitude, ${lon ?? "null"}::double as longitude,
  'fixture' as coordinate_basis, 'LOS ANGELES' as tax_rate_area_city, '2026' as roll_year, date '2010-01-01' as last_recording_date,
  true as owner_unchanged_10y_proxy, null::boolean as out_of_area_owner,
  ${lit(`https://example.test/query?page=${page}`)} as source_http_request, 'GET' as source_http_method,
  timestamptz '2026-11-11 16:17:40.932+00' as source_retrieved_at, ${lit("sha-" + page)} as source_page_sha256,
  ${lit(page)} as source_page_file, ${lit(FIXTURE.source)} as source_name`;

/** Write the fixture files; returns the directory and the Parquet sha256. */
export async function writeFixture(): Promise<{
  dir: string;
  parquetSha256: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "api-fixture-"));
  const { lat, lon } = FIXTURE.point;
  const rows = [
    row("0000000001", 2010, lat, lon, "page-0000.json"),
    row("0000000002", 1990, lat + 0.00724, lon, "page-0000.json"),
    row("0000000003", 2011, lat, lon, "page-0000.json"),
    row("0000000004", null, lat, lon, "page-0000.json"),
    row("0000000005", 1950, null, null, "page-0001.json"),
    row("0000000006", 1950, lat + 0.13, lon, "page-0001.json"),
    row("0000000007", 1940, lat - 0.0029, lon, "page-0001.json"),
  ];
  const parquet = join(dir, "los-angeles_property_roll2026_slice.parquet");
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run(
    `copy (${rows.join(" union all ")}) to ${lit(parquet)} (format parquet)`,
  );
  writeFileSync(
    join(dir, "run_manifest.json"),
    JSON.stringify({
      run_id: FIXTURE.runId,
      run_name: "fixture",
      generated_at: "2026-11-11T16:20:11.919Z",
      county: "Los Angeles",
      state: "CA",
      fips: "06037",
      roll_year: "2026",
      scope: { increment: 1 },
      readiness: { scope_guard: "PASS" },
      row_counts: { parquet: FIXTURE.rows },
      coverage: { with_coordinates: 6 },
      delta: { added: FIXTURE.rows, removed: 0 },
      limitations: ["fixture only"],
      derived_field_reference_date: "2026-11-11",
      sources: [
        {
          name: FIXTURE.source,
          role: "roll",
          hub_page: "https://example.test/hub",
          query_url: "https://example.test/query",
          terms_of_use: "https://example.test/terms",
          access: "anonymous",
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "run_history.jsonl"),
    JSON.stringify({
      run_id: FIXTURE.runId,
      finished_at: "2026-11-11T16:20:11.919Z",
      row_counts: { parquet: FIXTURE.rows },
      delta: { added: FIXTURE.rows, removed: 0 },
      parquet_sha256: "x",
      manifest_sha256: "y",
      published: false,
    }) + "\n",
  );
  return {
    dir,
    parquetSha256: createHash("sha256")
      .update(readFileSync(parquet))
      .digest("hex"),
  };
}
