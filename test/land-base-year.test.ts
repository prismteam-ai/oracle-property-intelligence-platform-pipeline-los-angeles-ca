import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  baseYearCutoff,
  LAND_BASE_YEAR_STATS_SQL,
  personalDataColumns,
  propertyTableSql,
  sqlLiteral as lit,
} from "../src/property-sql.ts";
import { RAW_FIELDS } from "../src/raw-fields.ts";

const PROVENANCE = [
  "_page_file",
  "_request_url",
  "_retrieved_at",
  "_page_sha256",
];
// Land base year as the roll gives it (text) → land_base_year, ownership_base_year_10y_proxy at 2026-11-12.
const CASES: Array<[string | null, number | null, boolean | null]> = [
  ["0", null, null],
  ["2027", null, null], // after the roll year
  ["1915", null, null], // before the 1975 base
  ["1975", 1975, true],
  ["2016", 2016, true],
  [" 2010 ", 2010, true],
  ["2017", 2017, false], // fiscal year July 2016 - June 2017: mostly within 10 years
  ["2026", 2026, false],
  ["", null, null],
  [null, null, null],
];

let db: DuckDBInstance;
let c: DuckDBConnection;
beforeAll(async () => {
  db = await DuckDBInstance.create(":memory:");
  c = await db.connect();
  const cols = [...RAW_FIELDS, ...PROVENANCE];
  await c.run(
    `create table raw (${cols.map((f) => `"${f}" varchar`).join(", ")})`,
  );
  for (const [i, [year]] of CASES.entries())
    await c.run(
      `insert into raw values (${cols
        .map((f) =>
          f === "AIN"
            ? lit(String(1000000000 + i))
            : f === "Roll_LandBaseYear"
              ? year === null
                ? "null"
                : lit(year)
              : f === "RollYear"
                ? "'2026'"
                : f === "RecordingDate"
                  ? "'1262304000000'"
                  : f === "_retrieved_at"
                    ? "'2026-11-12T00:00:00Z'"
                    : "'1'",
        )
        .join(", ")})`,
    );
  await c.run(propertyTableSql("2026-11-12", "fixture source"));
});
afterAll(() => {
  c.closeSync();
  db.closeSync();
});

test("the reassessment cutoff is the latest fiscal year (to 30 June) ended 10 years before the reference date", () => {
  expect(baseYearCutoff("2026-11-12")).toBe(2016);
  expect(baseYearCutoff("2026-12-31")).toBe(2016);
  expect(baseYearCutoff("2026-07-01")).toBe(2016);
  expect(baseYearCutoff("2026-06-30")).toBe(2016);
  expect(baseYearCutoff("2026-06-29")).toBe(2015);
  expect(baseYearCutoff("2026-01-15")).toBe(2015);
  expect(baseYearCutoff("2028-02-29")).toBe(2017);
  expect(() => baseYearCutoff("12 Nov 2026")).toThrow(/not YYYY-MM-DD/);
});

test("land_base_year: 0 and impossible years are null; the 10-year proxy uses the cutoff", async () => {
  const r = (
    await c.runAndReadAll(
      "select land_base_year y, ownership_base_year_10y_proxy p from property order by parcel_identifier",
    )
  ).getRowObjectsJson();
  expect(r).toEqual(CASES.map(([, y, p]) => ({ y, p })));
});

test("the new columns sit after the recorded-document proxy and pass the personal-data check", async () => {
  const cols = (
    (
      await c.runAndReadAll(
        "select column_name from information_schema.columns where table_name = 'property' order by ordinal_position",
      )
    ).getRowObjectsJson() as Array<{ column_name: string }>
  ).map((x) => x.column_name);
  const i = cols.indexOf("owner_unchanged_10y_proxy");
  expect(cols.slice(i, i + 4)).toEqual([
    "owner_unchanged_10y_proxy",
    "land_base_year",
    "ownership_base_year_10y_proxy",
    "out_of_area_owner",
  ]);
  expect(personalDataColumns(cols)).toEqual([]);
});

test("the land base year counts", async () => {
  const [s] = (
    await c.runAndReadAll(LAND_BASE_YEAR_STATS_SQL)
  ).getRowObjectsJson();
  expect(s).toEqual({
    with_land_base_year: "5",
    null_zero: "1",
    null_before_1975: "1",
    null_after_roll_year: "1",
    null_missing: "2",
    min_year: 1975,
    max_year: 2026,
  });
});
