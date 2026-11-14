import { readFileSync } from "node:fs";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  PERMIT_JURISDICTION,
  PERSONAL_DATA_PATTERN,
  personalDataColumns,
  propertyTableSql,
  ROOF_AGE_BASIS,
  sqlLiteral,
} from "../src/property-sql.ts";
import { RAW_FIELDS } from "../src/raw-fields.ts";

// Columns stage-raw.ts adds to every row (provenance), not downloaded from the source.
const PROVENANCE = [
  "_page_file",
  "_request_url",
  "_retrieved_at",
  "_page_sha256",
];
const PAGING_KEY = "OBJECTID";

let db: DuckDBInstance;
let c: DuckDBConnection;
beforeAll(async () => {
  db = await DuckDBInstance.create(":memory:");
  c = await db.connect();
});
afterAll(() => {
  c.closeSync();
  db.closeSync();
});

/** Build the property table over a raw table that has exactly these source fields. */
async function buildWith(
  fields: readonly string[],
  city = "1",
): Promise<string[]> {
  await c.run("drop table if exists property");
  await c.run("drop table if exists raw");
  const cols = [...fields, ...PROVENANCE].map((f) => `"${f}" varchar`);
  await c.run(`create table raw (${cols.join(", ")})`);
  const values = [...fields, ...PROVENANCE].map((f) =>
    f === "RecordingDate"
      ? "'1262304000000'"
      : f === "_retrieved_at"
        ? "'2026-11-11T16:17:39Z'"
        : f === "TaxRateArea_CITY"
          ? sqlLiteral(city)
          : sqlLiteral(f === "CENTER_LAT" || f === "CENTER_LON" ? "34.2" : "1"),
  );
  await c.run(`insert into raw values (${values.join(", ")})`);
  await c.run(propertyTableSql("2026-11-11", "fixture source"));
  return (
    (
      await c.runAndReadAll(
        "select column_name from information_schema.columns where table_name = 'property'",
      )
    ).getRowObjectsJson() as Array<{ column_name: string }>
  ).map((r) => r.column_name);
}

test("RAW_FIELDS: no duplicates, holds the paging key and the parcel key", () => {
  expect(new Set(RAW_FIELDS).size).toBe(RAW_FIELDS.length);
  expect(RAW_FIELDS).toContain(PAGING_KEY);
  expect(RAW_FIELDS).toContain("AIN");
});

test("RAW_FIELDS holds both ownership proxies' sources: the recording date and the land base year", () => {
  expect(RAW_FIELDS).toContain("RecordingDate");
  expect(RAW_FIELDS).toContain("Roll_LandBaseYear");
  expect(RAW_FIELDS).toHaveLength(26);
});

test("the build SQL runs over exactly RAW_FIELDS", async () => {
  const columns = await buildWith(RAW_FIELDS);
  expect(columns).toContain("parcel_identifier");
  expect(personalDataColumns(columns)).toEqual([]);
});

test.each([
  [PERMIT_JURISDICTION, true],
  [`${PERMIT_JURISDICTION}   `, true],
  ["LOS ANGELES COUNTY", false],
  ["UNINCORPORATED", false],
])(
  "permit_data_available for tax-rate-area city %j: %j",
  async (city, available) => {
    await buildWith(RAW_FIELDS, city);
    const [r] = (
      await c.runAndReadAll(
        "select permit_data_available, roof_age_basis from property",
      )
    ).getRowObjectsJson();
    expect(r).toEqual({
      permit_data_available: available,
      roof_age_basis: ROOF_AGE_BASIS.yearBuilt,
    });
  },
);

test("every field except the paging key is read by the build SQL", async () => {
  for (const field of RAW_FIELDS.filter((f) => f !== PAGING_KEY)) {
    await expect(
      buildWith(RAW_FIELDS.filter((f) => f !== field)),
      field,
    ).rejects.toThrow(new RegExp(`"${field}"`, "i"));
  }
});

test("RAW_FIELDS excludes the personal-data column pattern", () => {
  expect(RAW_FIELDS.filter((f) => PERSONAL_DATA_PATTERN.test(f))).toEqual([]);
  expect(personalDataColumns(["OwnerName", "MailAddress", "AIN"])).toEqual([
    "OwnerName",
    "MailAddress",
  ]);
  expect(
    personalDataColumns(["owner_unchanged_10y_proxy", "out_of_area_owner"]),
  ).toEqual([]);
});

test("fetch-slice.ts requests RAW_FIELDS, never every field", () => {
  const src = readFileSync("src/fetch-slice.ts", "utf8");
  expect(src).toMatch(/outFields: RAW_FIELDS\.join\(","\)/);
  expect(src).not.toMatch(/outFields: "\*"/);
});
