import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CONTRACT,
  lit,
  propertyViewsSql,
  roofAgeRule,
  runViewsSql,
} from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "views-test-"));
const parquet = join(dir, "property.parquet");
const manifest = join(dir, "run_manifest.json");
const history = join(dir, "run_history.jsonl");
let c: DuckDBConnection;
const q = async (sql: string, params?: unknown[]) =>
  (await c.runAndReadAll(sql, params as never)).getRowObjectsJson() as Array<
    Record<string, unknown>
  >;

// Increment-1 Parquet column names (src/build-outputs.ts). Rows:
// A at the centre built 2010 (in at 15 y), B built 2011 (out), C no year built, D no coordinates,
// E built 1950 but ~33 mi away.
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
  '1 TEST ST' as unnormalized_address, '1' as street_number, null::varchar as street_pre_directional_text, 'TEST ST' as street_name,
  null::varchar as unit_identifier, 'VAN NUYS' as city_name, '91406' as postal_code, null::varchar as plus_four_postal_code,
  'Los Angeles' as county_name, 'CA' as state_code, ${lat ?? "null"}::double as latitude, ${lon ?? "null"}::double as longitude,
  'center' as coordinate_basis, 'LOS ANGELES' as tax_rate_area_city, '2026' as roll_year, date '2010-01-01' as last_recording_date,
  true as owner_unchanged_10y_proxy, null::boolean as out_of_area_owner,
  'https://example.test/query?page=${page}' as source_http_request, 'GET' as source_http_method,
  timestamptz '2026-11-11 16:17:40.932+00' as source_retrieved_at, ${lit("sha-" + page)} as source_page_sha256,
  ${lit(page)} as source_page_file, 'Test Source' as source_name`;

beforeAll(async () => {
  c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run(
    `copy (${[
      row("0000000001", 2010, 34.199, -118.487, "page-0000.json"),
      row("0000000002", 2011, 34.199, -118.487, "page-0000.json"),
      row("0000000003", null, 34.199, -118.487, "page-0001.json"),
      row("0000000004", 1950, null, null, "page-0001.json"),
      row("0000000005", 1950, 34.5, -118.0, "page-0001.json"),
    ].join(" union all ")}) to ${lit(parquet)} (format parquet)`,
  );
  writeFileSync(
    manifest,
    JSON.stringify({
      run_id: "r1",
      run_name: "n",
      generated_at: "2026-11-11T16:20:11.919Z",
      county: "Los Angeles",
      state: "CA",
      fips: "06037",
      roll_year: "2026",
      scope: { increment: 1 },
      readiness: { scope_guard: "PASS" },
      row_counts: { parquet: 5 },
      coverage: { with_coordinates: 4 },
      delta: { added: 5, removed: 0 },
      limitations: ["slice only"],
      derived_field_reference_date: "2026-11-11",
      sources: [
        {
          name: "Test Source",
          role: "roll",
          hub_page: "h",
          query_url: "q",
          terms_of_use: "t",
          access: "a",
        },
      ],
    }),
  );
  writeFileSync(
    history,
    JSON.stringify({
      run_id: "r1",
      finished_at: "2026-11-11T16:20:11.919Z",
      row_counts: { parquet: 5 },
      delta: { added: 5, removed: 0 },
      parquet_sha256: "p",
      manifest_sha256: "m",
      published: false,
    }) + "\n",
  );
  await c.run(propertyViewsSql({ propertyParquet: parquet }));
  await c.run(runViewsSql({ runManifest: manifest, runHistory: history }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("roof_age_candidates", () => {
  test("built 2010 is older than 15 years at roll 2026; built 2011 is not", async () => {
    const ids = (
      await q(
        "select parcel_id from oracle.roof_age_candidates($1, $2, $3, $4) order by 1",
        [15, 34.199, -118.487, 5],
      )
    ).map((r) => r.parcel_id);
    expect(ids).toEqual(["0000000001"]);
  });
  test("parcels without year built or coordinates are excluded, and the radius applies", async () => {
    const all = (
      await q(
        "select parcel_id from oracle.roof_age_candidates($1, $2, $3, $4) order by 1",
        [0, 34.199, -118.487, 100],
      )
    ).map((r) => r.parcel_id);
    expect(all).toEqual(["0000000001", "0000000002", "0000000005"]);
  });
  test("threshold 80 means built before 1946; 75 means built before 1951", async () => {
    expect(
      await q(
        "select count(*)::integer n from oracle.roof_age_candidates($1, $2, $3, $4)",
        [80, 34.199, -118.487, 100],
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      await q(
        "select count(*)::integer n from oracle.roof_age_candidates($1, $2, $3, $4)",
        [75, 34.199, -118.487, 100],
      ),
    ).toEqual([{ n: 1 }]);
  });
  test("haversine: one degree of latitude is about 69.09 miles", async () => {
    const [r] = await q(
      "select round(oracle.haversine_miles(34.0, -118.0, 35.0, -118.0), 2) d",
    );
    expect(Number(r!.d)).toBeCloseTo(69.09, 1);
  });
});

describe("contract views", () => {
  test("every contract view and macro exists", async () => {
    for (const v of CONTRACT.views)
      expect((await q(`select count(*) n from ${v}`)).length).toBe(1);
  });
  test("no owner, mailing or contact columns in any contract view", async () => {
    const cols = (
      await q(
        "select table_name, column_name from information_schema.columns where table_schema = 'oracle' and table_name like 'v_%'",
      )
    ).map((r) => String(r.column_name));
    expect(
      cols.filter((n) =>
        /owner_?name|mail|contact|phone|email|grantee|grantor|taxpayer/i.test(
          n,
        ),
      ),
    ).toEqual([]);
    expect(cols).not.toContain("out_of_area_owner");
  });
  test("provenance per page and per source", async () => {
    expect(
      await q(
        "select source_page_file, record_count::integer n, source_retrieved_at from oracle.v_source_page",
      ),
    ).toEqual([
      {
        source_page_file: "page-0000.json",
        n: 2,
        source_retrieved_at: "2026-11-11T16:17:40.932Z",
      },
      {
        source_page_file: "page-0001.json",
        n: 3,
        source_retrieved_at: "2026-11-11T16:17:40.932Z",
      },
    ]);
    const [s] = await q(
      "select source_name, record_count::integer n, page_count::integer p, terms_of_use from oracle.v_source",
    );
    expect(s).toEqual({
      source_name: "Test Source",
      n: 5,
      p: 2,
      terms_of_use: "t",
    });
  });
  test("run summary and history", async () => {
    const [r] = await q(
      "select run_id, roll_year, limitations from oracle.v_run",
    );
    expect(r).toEqual({
      run_id: "r1",
      roll_year: "2026",
      limitations: ["slice only"],
    });
    expect(
      (await q("select run_id from oracle.v_run_history")).map((x) => x.run_id),
    ).toEqual(["r1"]);
  });
});

describe("roofAgeRule", () => {
  test("states the rule with the computed year", () => {
    const r = roofAgeRule(2026, 15);
    expect(r.built_before_year).toBe(2011);
    expect(r.text).toContain("built before 2011");
    expect(r.text).toContain("2010 or earlier");
    expect(() => roofAgeRule(2026, -1)).toThrow();
  });
});
