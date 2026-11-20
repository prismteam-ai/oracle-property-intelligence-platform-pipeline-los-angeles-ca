import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CONTRACT,
  daysFromYears,
  lit,
  longOpenRule,
  permitViewsSql,
  propertyViewsSql,
  roofAgeRule,
  runViewsSql,
} from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "views-test-"));
const parquet = join(dir, "property.parquet");
const manifest = join(dir, "run_manifest.json");
const history = join(dir, "run_history.jsonl");
const permits = join(dir, "permits.parquet");
const permitParcels = join(dir, "permit_parcels.parquet");
const contractors = join(dir, "permit_contractors.parquet");
let c: DuckDBConnection;
const q = async (sql: string, params?: unknown[]) =>
  (await c.runAndReadAll(sql, params as never)).getRowObjectsJson() as Array<
    Record<string, unknown>
  >;

// Property Parquet column names (src/property-sql.ts, src/permit-sql.ts). Rows:
// A at the centre built 2010 (in at 15 y), B built 2011 (out), C no year built, D no coordinates,
// E built 1950 but ~33 mi away, F at the centre built 1950 with a roof year 2015 from a permit (out at 15 y).
// Ownership proxies [owner_unchanged_10y_proxy, ownership_base_year_10y_proxy] (default both true): B true/false,
// C false/true, D null/null.
const row = (
  id: string,
  yb: number | null,
  lat: number | null,
  lon: number | null,
  page: string,
  permitYear?: number,
  own: [boolean | null, boolean | null] = [true, true],
) => `select
  ${lit(id)} as parcel_identifier, ${lit(id)} as assessor_id_formatted, ${lit(id)} as request_identifier,
  ${yb ?? "null"}::integer as property_structure_built_year, ${yb ?? "null"}::integer as property_effective_built_year,
  ${permitYear ? "'PERMIT'" : "'PROXY'"} as roof_age_basis, ${permitYear ?? yb ?? "null"}::integer as effective_roof_year,
  ${permitYear ? "'16016-10000-00001'" : "null::varchar"} as roof_year_permit_number, 'roof-year-1' as roof_year_rule_version,
  true as permit_data_available, 'SFR' as source_use_type, '0100' as source_use_code, 'Single' as source_use_code_description,
  '1 TEST ST' as unnormalized_address, '1' as street_number, null::varchar as street_pre_directional_text, 'TEST ST' as street_name,
  null::varchar as unit_identifier, 'VAN NUYS' as city_name, '91406' as postal_code, null::varchar as plus_four_postal_code,
  'Los Angeles' as county_name, 'CA' as state_code, ${lat ?? "null"}::double as latitude, ${lon ?? "null"}::double as longitude,
  'center' as coordinate_basis, 'LOS ANGELES' as tax_rate_area_city, '2026' as roll_year, date '2010-01-01' as last_recording_date,
  ${own[0] ?? "null::boolean"} as owner_unchanged_10y_proxy, null::boolean as out_of_area_owner,
  ${own[1] === null ? "null" : own[1] ? 2000 : 2020}::integer as land_base_year,
  ${own[1] ?? "null::boolean"} as ownership_base_year_10y_proxy,
  'https://example.test/query?page=${page}' as source_http_request, 'GET' as source_http_method,
  timestamptz '2026-11-11 16:17:40.932+00' as source_retrieved_at, ${lit("sha-" + page)} as source_page_sha256,
  ${lit(page)} as source_page_file, 'Test Source' as source_name`;

beforeAll(async () => {
  c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run(
    `copy (${[
      row("0000000001", 2010, 34.199, -118.487, "page-0000.json"),
      row("0000000002", 2011, 34.199, -118.487, "page-0000.json", undefined, [
        true,
        false,
      ]),
      row("0000000003", null, 34.199, -118.487, "page-0001.json", undefined, [
        false,
        true,
      ]),
      row("0000000004", 1950, null, null, "page-0001.json", undefined, [
        null,
        null,
      ]),
      row("0000000005", 1950, 34.5, -118.0, "page-0001.json"),
      row("0000000006", 1950, 34.199, -118.487, "page-0001.json", 2015),
    ].join(" union all ")}) to ${lit(parquet)} (format parquet)`,
  );
  // Permits: P1 building-level on A and F (both at the center), open-issued 2,000 days, roofing work; P2 on E
  // (~33 mi), open-issued 3,000 days, roofing work through the roof-coating phrase only; P3 on A, closed; P4 on
  // B (at the center), open-issued 3,000 days, not roofing work. The permit table has a work_desc column no
  // view may show.
  const permit = (
    n: string,
    cls: string,
    days: number | null,
    work: "roofing" | "coating-only" | "not roofing" = "roofing",
  ) => `select
    ${lit(n)} as permit_number, null::varchar as source_apn, '1 TEST ST' as unnormalized_address, '91406' as postal_code,
    'Bldg-Alter/Repair' as source_permit_type, null::varchar as source_permit_sub_type, null::varchar as source_business_unit,
    date '2020-01-01' as application_received_date, date '2020-01-01' as permit_issue_date, 'Issued' as source_status_desc,
    date '2020-01-01' as status_date, ${lit(cls)} as permit_status_class, date '2020-01-01' as open_since,
    ${days ?? "null"}::integer as open_days, ${work !== "not roofing"} as roof_r, false as roof_only,
    ${work !== "not roofing"} as roofing_work, ${work === "coating-only"} as roof_coating_only, 'direct' as join_method, null::varchar as unjoined_cause, 'pi9x-tg5x' as source_dataset,
    'issued' as source_dataset_kind, 'roof-flags-4' as roof_flag_rule_version, 'permit-status-1' as permit_status_rule_version,
    'permit-join-1' as join_rule_version, 'NOT SERVED' as work_desc, 'https://example.test/p' as source_http_request,
    'GET' as source_http_method, timestamptz '2026-11-12 13:14:56.570+00' as source_retrieved_at, 'sha-p' as source_page_sha256,
    'pages/pi9x-tg5x_p000.json.gz' as source_page_file, 'Permits' as source_name`;
  await c.run(
    `copy (${[
      permit("16016-10000-00001", "open-issued", 2000),
      permit("16016-10000-00002", "open-issued", 3000, "coating-only"),
      permit("16016-10000-00003", "closed", null),
      permit("16016-10000-00004", "open-issued", 3000, "not roofing"),
    ].join(" union all ")}) to ${lit(permits)} (format parquet)`,
  );
  await c.run(
    `copy (select * from (values ('16016-10000-00001', '0000000001', 'condo-building', true),
       ('16016-10000-00001', '0000000006', 'condo-building', true), ('16016-10000-00002', '0000000005', 'direct', false),
       ('16016-10000-00003', '0000000001', 'direct', false), ('16016-10000-00004', '0000000002', 'direct', false))
       t(permit_number, parcel_identifier, join_method, building_level), (select 'permit-join-1' as join_rule_version))
     to ${lit(permitParcels)} (format parquet)`,
  );
  await c.run(
    `copy (select * from (values ('16016-10000-00001', 'B CO', '2'), ('16016-10000-00001', 'A CO', '1'))
       t(permit_number, contractors_business_name, license_identifier),
       (select 'C39' as source_license_type, 'C-39' as license_class, 'Roofing' as license_class_name,
         null::varchar as license_class_note, false as is_owner_builder, date '2027-01-31' as license_expiration_date,
         'VAN NUYS' as city_name, 'CA' as state_code, date '2020-01-01' as permit_issue_date,
         'license-classes-1' as license_class_rule_version, 'https://example.test/c' as source_http_request,
         'GET' as source_http_method, timestamptz '2026-11-12 14:00:51.383+00' as source_retrieved_at,
         'sha-c' as source_page_sha256, 'pages/8guu-8f5m_p000.json.gz' as source_page_file, 'Contractors' as source_name,
         license_identifier as contractor_identity_key, contractors_business_name as canonical_business_name,
         1 as name_variant_count, 1 as identity_permit_count, 'contractor-identity-1' as contractor_identity_rule_version))
     to ${lit(contractors)} (format parquet)`,
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
  await c.run(
    permitViewsSql({
      permitsParquet: permits,
      permitParcelsParquet: permitParcels,
      permitContractorsParquet: contractors,
    }),
  );
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
    expect(all).toEqual([
      "0000000001",
      "0000000002",
      "0000000005",
      "0000000006",
    ]);
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
        "select source_kind, source_page_file, record_count::integer n, source_retrieved_at from oracle.v_source_page",
      ),
    ).toEqual([
      {
        source_kind: "parcel",
        source_page_file: "page-0000.json",
        n: 2,
        source_retrieved_at: "2026-11-11T16:17:40.932Z",
      },
      {
        source_kind: "parcel",
        source_page_file: "page-0001.json",
        n: 4,
        source_retrieved_at: "2026-11-11T16:17:40.932Z",
      },
      {
        source_kind: "contractor",
        source_page_file: "pages/8guu-8f5m_p000.json.gz",
        n: 2,
        source_retrieved_at: "2026-11-12T14:00:51.383Z",
      },
      {
        source_kind: "permit",
        source_page_file: "pages/pi9x-tg5x_p000.json.gz",
        n: 4,
        source_retrieved_at: "2026-11-12T13:14:56.570Z",
      },
    ]);
    const [s] = await q(
      "select source_name, record_count::integer n, page_count::integer p, terms_of_use, license, query_urls from oracle.v_source where source_kind = 'parcel'",
    );
    expect(s).toEqual({
      source_name: "Test Source",
      n: 6,
      p: 2,
      terms_of_use: "t",
      license: null,
      query_urls: null,
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
  test("a manifest and history lines written before run_kind give null run kind fields; a source without coverage gives null", async () => {
    expect(
      await q("select run_kind, rebuild_of, source_changes from oracle.v_run"),
    ).toEqual([{ run_kind: null, rebuild_of: null, source_changes: null }]);
    expect(
      await q(
        "select run_id, run_kind, rebuild_of, source_changes from oracle.v_run_history",
      ),
    ).toEqual([
      { run_id: "r1", run_kind: null, rebuild_of: null, source_changes: null },
    ]);
    expect(
      (await q("select source_name, coverage from oracle.v_source")).find(
        (r) => r.source_name === "Test Source",
      ),
    ).toEqual({ source_name: "Test Source", coverage: null });
  });
  test("a rebuild run: run kind fields from the manifest and its history line (older lines null); the contractor source's coverage", async () => {
    const d = mkdtempSync(join(tmpdir(), "views-rebuild-"));
    const m = join(d, "run_manifest.json");
    const h = join(d, "run_history.jsonl");
    const rebuild = {
      run_kind: "rebuild",
      rebuild_of: "r1",
      source_changes: "none",
    };
    writeFileSync(
      m,
      JSON.stringify({
        ...JSON.parse(readFileSync(manifest, "utf8")),
        run_id: "r2",
        ...rebuild,
        sources: [
          { name: "Test Source", role: "roll", coverage: null },
          {
            name: "Contractors",
            role: "contractors",
            coverage: {
              field: "permit_issue_date",
              first: "2013-01-02",
              last: "2023-05-19",
            },
          },
        ],
      }),
    );
    writeFileSync(
      h,
      readFileSync(history, "utf8") +
        JSON.stringify({
          run_id: "r2",
          finished_at: "2026-11-14T13:14:38.462Z",
          ...rebuild,
          published: false,
        }) +
        "\n",
    );
    const c2 = await (await DuckDBInstance.create(":memory:")).connect();
    await c2.run(propertyViewsSql({ propertyParquet: parquet }));
    await c2.run(
      permitViewsSql({
        permitsParquet: permits,
        permitParcelsParquet: permitParcels,
        permitContractorsParquet: contractors,
      }),
    );
    await c2.run(runViewsSql({ runManifest: m, runHistory: h }));
    const q2 = async (sql: string) =>
      (await c2.runAndReadAll(sql)).getRowObjectsJson();
    expect(
      await q2("select run_kind, rebuild_of, source_changes from oracle.v_run"),
    ).toEqual([rebuild]);
    expect(
      await q2(
        "select run_id, run_kind, rebuild_of, source_changes from oracle.v_run_history",
      ),
    ).toEqual([
      { run_id: "r1", run_kind: null, rebuild_of: null, source_changes: null },
      { run_id: "r2", ...rebuild },
    ]);
    expect(
      await q2(
        "select source_name, coverage from oracle.v_source order by source_name",
      ),
    ).toEqual([
      {
        source_name: "Contractors",
        coverage: {
          field: "permit_issue_date",
          first: "2013-01-02",
          last: "2023-05-19",
        },
      },
      { source_name: "Permits", coverage: null },
      { source_name: "Test Source", coverage: null },
    ]);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("ownership_passes", () => {
  const ids = async (basis: string | null) =>
    (
      await q(
        `select parcel_id from oracle.v_property
         where oracle.ownership_passes($1::varchar, owner_unchanged_10y_proxy, ownership_base_year_10y_proxy)
         order by 1`,
        [basis],
      )
    ).map((r) => r.parcel_id);
  test("no basis: every parcel; each basis its proxy; both the intersection; a null proxy never passes", async () => {
    const all = (
      await q("select parcel_id from oracle.v_property order by 1")
    ).map((r) => r.parcel_id);
    expect(await ids(null)).toEqual(all);
    const recording = await ids("recording");
    const baseYear = await ids("base_year");
    const both = await ids("both");
    expect(recording).toEqual([
      "0000000001",
      "0000000002",
      "0000000005",
      "0000000006",
    ]);
    expect(baseYear).toEqual([
      "0000000001",
      "0000000003",
      "0000000005",
      "0000000006",
    ]);
    expect(both).toEqual(recording.filter((i) => baseYear.includes(i)));
    expect(both).not.toContain("0000000004"); // both proxies null
  });
  test("an unknown basis is an error, never no filter", async () => {
    await expect(ids("owner")).rejects.toThrow(/unknown ownership basis/);
  });
  test("v_property serves the land base year and its proxy", async () => {
    expect(
      await q(
        "select parcel_id, land_base_year, ownership_base_year_10y_proxy from oracle.v_property where parcel_id in ('0000000002', '0000000004') order by 1",
      ),
    ).toEqual([
      {
        parcel_id: "0000000002",
        land_base_year: 2020,
        ownership_base_year_10y_proxy: false,
      },
      {
        parcel_id: "0000000004",
        land_base_year: null,
        ownership_base_year_10y_proxy: null,
      },
    ]);
  });
});

describe("roofAgeRule", () => {
  test("states the rule with the computed year", () => {
    const r = roofAgeRule(2026, 15);
    expect(r.built_before_year).toBe(2011);
    expect(r.text).toContain("an effective roof year before 2011");
    expect(r.text).toContain("2010 or earlier");
    expect(() => roofAgeRule(2026, -1)).toThrow();
  });
  test("names both bases", () => {
    const { text } = roofAgeRule(2026, 15);
    expect(text).toContain("basis PROXY");
    expect(text).toContain("basis PERMIT");
    expect(text).toContain("finaled LADBS roofing permit");
  });
});

describe("longOpenRule and daysFromYears", () => {
  test("durations in days; 5 years is 1,826 days", () => {
    expect(daysFromYears(5)).toBe(1826);
    expect(daysFromYears(10)).toBe(3653);
    expect(daysFromYears(1)).toBe(365);
  });
  test("states the window, the reference date and the status class", () => {
    const r = longOpenRule("2026-11-12", 1826, null);
    expect(r).toMatchObject({
      reference_date: "2026-11-12",
      status_class: "open-issued",
      min_open_days: 1826,
      max_open_days: null,
    });
    expect(r.text).toContain("at least 1,826 days");
    expect(r.text).toContain("2026-11-12");
    expect(r.text).toContain("Roofing work only");
    expect(longOpenRule("2026-11-12", 1826, 3653).text).toContain(
      "between 1,826 and 3,653 days",
    );
    const bad: Array<[string, number, number | null]> = [
      ["2026-11", 1826, null],
      ["2026-11-12", -1, null],
      ["2026-11-12", 1826, 1825],
      ["2026-11-12", 1.5, null],
    ];
    for (const [d, min, max] of bad)
      expect(() => longOpenRule(d, min, max)).toThrow();
  });
});

describe("permit views", () => {
  test("long_open_permits: a building-level permit counts once, at its nearest unit", async () => {
    // P1 links A and F, both at the centre: it is counted once, at the lower parcel ID.
    expect(
      await q(
        "select permit_number, parcel_id, parcel_count::integer pc, building_level from oracle.long_open_permits(1826, null, null, 34.199, -118.487, 50) order by 1",
      ),
    ).toEqual([
      {
        permit_number: "16016-10000-00001",
        parcel_id: "0000000001",
        pc: 2,
        building_level: true,
      },
      {
        permit_number: "16016-10000-00002",
        parcel_id: "0000000005",
        pc: 1,
        building_level: false,
      },
    ]);
  });
  test("long_open_permits: maximum, radius and roof-age threshold; long_open_parcels marks every unit", async () => {
    const n = async (args: string) =>
      (
        await q(
          `select count(*)::integer n from oracle.long_open_permits(${args})`,
        )
      )[0]!.n;
    expect(await n("1826, 2500, null, 34.199, -118.487, 50")).toBe(1);
    expect(await n("1826, null, null, 34.199, -118.487, 5")).toBe(1);
    expect(await n("0, null, null, 34.199, -118.487, 50")).toBe(2); // the closed permit never counts
    // At 15 years A (2010) qualifies, so P1 stays, now at A; at 80 years neither A nor F does.
    expect(await n("1826, null, 15, 34.199, -118.487, 5")).toBe(1);
    expect(await n("1826, null, 80, 34.199, -118.487, 5")).toBe(0);
    expect(
      await q(
        "select parcel_id from oracle.long_open_parcels(1826, null) order by 1",
      ),
    ).toEqual([
      { parcel_id: "0000000001" },
      { parcel_id: "0000000005" },
      { parcel_id: "0000000006" },
    ]);
  });
  test("long_open_parcels and long_open_permits count roofing work only; a coating-only permit counts", async () => {
    // P4 (B, at the center, 3,000 days) is open-issued but not roofing work: in no window, at no radius.
    for (const args of [
      "1826, null, null, 34.199, -118.487, 50",
      "0, null, null, 34.199, -118.487, 50",
      "3000, 3000, null, 34.199, -118.487, 50",
    ])
      expect(
        await q(
          `select permit_number, roofing_work, roof_coating_only from oracle.long_open_permits(${args}) order by 1`,
        ),
        args,
      ).toEqual(
        args.startsWith("3000")
          ? [
              {
                permit_number: "16016-10000-00002",
                roofing_work: true,
                roof_coating_only: true,
              },
            ]
          : [
              {
                permit_number: "16016-10000-00001",
                roofing_work: true,
                roof_coating_only: false,
              },
              {
                permit_number: "16016-10000-00002",
                roofing_work: true,
                roof_coating_only: true,
              },
            ],
      );
    expect(
      await q(
        "select distinct permit_number from oracle.long_open_parcels(0, null) order by 1",
      ),
    ).toEqual([
      { permit_number: "16016-10000-00001" },
      { permit_number: "16016-10000-00002" },
    ]);
    // The permit views still list P4, tagged.
    expect(
      await q(
        "select p.permit_number, p.roofing_work, pp.parcel_id from oracle.v_permit p join oracle.v_permit_parcel pp using (permit_number) where p.permit_number = '16016-10000-00004'",
      ),
    ).toEqual([
      {
        permit_number: "16016-10000-00004",
        roofing_work: false,
        parcel_id: "0000000002",
      },
    ]);
  });
  test("contractor rows carry their identity (key, canonical name, variant and permit counts)", async () => {
    expect(
      await q(
        `select contractor_identity_key, canonical_business_name, name_variant_count, identity_permit_count,
           contractor_identity_rule_version from oracle.v_permit_contractor order by 1`,
      ),
    ).toEqual([
      {
        contractor_identity_key: "1",
        canonical_business_name: "A CO",
        name_variant_count: 1,
        identity_permit_count: 1,
        contractor_identity_rule_version: "contractor-identity-1",
      },
      {
        contractor_identity_key: "2",
        canonical_business_name: "B CO",
        name_variant_count: 1,
        identity_permit_count: 1,
        contractor_identity_rule_version: "contractor-identity-1",
      },
    ]);
  });
  test("contractor rows are numbered per permit in value order; dates are text", async () => {
    expect(
      await q(
        "select contractor_row::integer r, contractors_business_name, license_expiration_date from oracle.v_permit_contractor order by 1",
      ),
    ).toEqual([
      {
        r: 1,
        contractors_business_name: "A CO",
        license_expiration_date: "2027-01-31",
      },
      {
        r: 2,
        contractors_business_name: "B CO",
        license_expiration_date: "2027-01-31",
      },
    ]);
  });
  test("no permit view has a work description column", async () => {
    const cols = (
      await q(
        "select table_name, column_name from information_schema.columns where table_schema = 'oracle'",
      )
    ).map((r) => `${r.table_name}.${r.column_name}`);
    expect(cols.filter((c) => /^v_permit/.test(c) && /desc/i.test(c))).toEqual([
      "v_permit.source_status_desc",
    ]);
    expect(cols.filter((c) => /^v_.*work_?desc/i.test(c))).toEqual([]);
  });
});

describe("roof_age_candidates bounding-box prefilter", () => {
  // Points just inside (0.9999 r) and just outside (1.0001 r) each circle, every 15 degrees of bearing and
  // at the two bearings of the circle's widest longitude (acos(tan(r/R) * tan(lat)), east and west), placed
  // with the spherical direct formula. The box must keep every inside point: the result is exactly the
  // inside set, and a box narrower than the circle in latitude or longitude loses a point. The 89.99 degree
  // centre has the pole inside its 10-mile circle, so its box spans every longitude.
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const deg = (r: number) => (r * 180) / Math.PI;
  const dest = (lat: number, lon: number, bearing: number, miles: number) => {
    const d = miles / R;
    const p1 = rad(lat);
    const t = rad(bearing);
    const p2 = Math.asin(
      Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t),
    );
    const l2 =
      rad(lon) +
      Math.atan2(
        Math.sin(t) * Math.sin(d) * Math.cos(p1),
        Math.cos(d) - Math.sin(p1) * Math.sin(p2),
      );
    return [deg(p2), ((deg(l2) + 540) % 360) - 180] as const;
  };
  const centres = [
    [34.2, -118.4],
    [33.5, -117.9],
    [89.99, 0],
  ] as const;
  const radii = [0.1, 1, 5, 10];
  const pts: Array<{ id: string; c: number; miles: number }> = [];
  let box: DuckDBConnection;
  beforeAll(async () => {
    const rows: string[] = [];
    centres.forEach(([lat, lon], c) =>
      radii.forEach((r) =>
        [0.9999, 1.0001].forEach((f) => {
          const t = deg(
            Math.acos(Math.min(1, Math.tan(r / R) * Math.tan(rad(lat)))),
          );
          for (const b of [
            ...Array.from({ length: 24 }, (_, i) => i * 15),
            t,
            360 - t,
          ]) {
            const id = String(pts.length + 1).padStart(10, "0");
            const [plat, plon] = dest(lat, lon, b, r * f);
            pts.push({ id, c, miles: r * f });
            rows.push(row(id, 1950, plat, plon, "page-0000.json"));
          }
        }),
      ),
    );
    const file = join(dir, "box.parquet");
    box = await (await DuckDBInstance.create(":memory:")).connect();
    await box.run(
      `copy (${rows.join(" union all ")}) to ${lit(file)} (format parquet)`,
    );
    await box.run(propertyViewsSql({ propertyParquet: file }));
  });

  test("keeps every point inside the circle and nothing outside, for each centre and radius", async () => {
    for (const [c, [lat, lon]] of centres.entries())
      for (const r of radii) {
        const got = (
          await (
            await box.runAndReadAll(
              "select parcel_id from oracle.roof_age_candidates(0, $1, $2, $3) order by 1",
              [lat, lon, r],
            )
          ).getRowObjectsJson()
        ).map((x) => x.parcel_id);
        const want = pts
          .filter((p) => p.c === c && p.miles <= r)
          .map((p) => p.id);
        expect(got, `centre ${lat},${lon} radius ${r}`).toEqual(want);
      }
  });
});
