import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  buildPermitTables,
  ROOF_YEAR_RULE_VERSION,
  type PermitBuildStats,
} from "../src/permit-sql.ts";
import { ROOF_AGE_BASIS } from "../src/property-sql.ts";
import { setupTables } from "./fixtures/permit-tables.ts";

const at = (d: string) => `${d}T00:00:00.000`;
const ROLL = [
  { AIN: "1000000001", YearBuilt: "1960" }, // latest of two finaled re-roofs
  { AIN: "1000000002", YearBuilt: "2000" }, // finaled re-roof before year built: ignored
  { AIN: "1000000003", YearBuilt: "0" }, // no year built, finaled re-roof
  { AIN: "1000000004", YearBuilt: "1970" }, // finaled after the reference date: ignored
  { AIN: "1000000005", YearBuilt: "0" }, // no year built, no permit
  { AIN: "1000000006", YearBuilt: "1960" }, // two finaled the same day: higher permit number
  { AIN: "1000000007", YearBuilt: "1960" }, // finaled, not roofing work
  { AIN: "1000000008", YearBuilt: "1960" }, // Express Permit roof word
  { AIN: "3000000001", YearBuilt: "1950", TaxRateArea_CITY: "BURBANK  " }, // outside the City of LA
  ...["2000000001", "2000000002", "2000000003"].map((AIN) => ({
    AIN,
    YearBuilt: "1980",
    UseCode: "010C",
    SitusHouseNo: "30",
    SitusStreet: "PINE ST",
    SitusZIP5: "90003",
  })),
];
const fin = (nbr: string, apn: string, date: string, extra = {}) => ({
  permit_nbr: nbr,
  apn,
  status_date: at(date),
  ...extra,
});
const PERMITS = [
  fin("P01", "1000000001", "2010-05-01"),
  fin("P02", "1000000001", "2018-07-01"),
  fin("P03", "1000000001", "2022-01-01", {
    work_desc: "COATING TO AN EXISTING ROOF",
  }),
  fin("P04", "1000000001", "2023-01-01", { status_desc: "Issued" }),
  fin("P05", "1000000002", "1995-01-01"),
  fin("P06", "1000000003", "2012-01-01"),
  fin("P07", "1000000004", "2027-01-01"),
  fin("P08", "2000000***", "2016-06-06", {
    primary_address: "30 PINE ST",
    zip_code: "90003",
  }),
  fin("P09", "3000000001", "2019-01-01"),
  fin("P10", "1000000006", "2014-02-02"),
  fin("P11", "1000000006", "2014-02-02"),
  fin("P12", "1000000007", "2020-01-01", {
    work_desc: "WATERPROOFING OF DECK",
  }),
  fin("P13", "1000000008", "2011-01-01", {
    work_desc: "T/O (E) ROOF",
    business_unit: "Express Permit",
  }),
];

let db: DuckDBInstance;
let c: DuckDBConnection;
let stats: PermitBuildStats;
beforeAll(async () => {
  db = await DuckDBInstance.create(":memory:");
  c = await db.connect();
  await setupTables(c, ROLL, PERMITS, []);
  stats = await buildPermitTables(c, {
    referenceDate: "2026-11-12",
    permitSourceName: "fixture permits",
    contractorSourceName: "fixture contractors",
  });
});
afterAll(() => {
  c.closeSync();
  db.closeSync();
});

const P = ROOF_AGE_BASIS.permit;
const Y = ROOF_AGE_BASIS.yearBuilt;
test.each([
  ["1000000001", 2018, "P02", P],
  ["1000000002", 2000, null, Y],
  ["1000000003", 2012, "P06", P],
  ["1000000004", 1970, null, Y],
  ["1000000005", null, null, Y],
  ["1000000006", 2014, "P11", P],
  ["1000000007", 1960, null, Y],
  ["1000000008", 2011, "P13", P],
  ["3000000001", 2019, "P09", P],
  ["2000000001", 2016, "P08", P],
  ["2000000002", 2016, "P08", P],
  ["2000000003", 2016, "P08", P],
])("parcel %s: roof year %j from %j", async (ain, year, permit, basis) => {
  const [r] = (
    await c.runAndReadAll(
      `select effective_roof_year, roof_year_permit_number, roof_age_basis, roof_year_rule_version
       from property where parcel_identifier = '${ain}'`,
    )
  ).getRowObjectsJson();
  expect(r).toEqual({
    effective_roof_year: year,
    roof_year_permit_number: permit,
    roof_age_basis: basis,
    roof_year_rule_version: ROOF_YEAR_RULE_VERSION,
  });
});

test("ignored and coating-only permits are counted", () => {
  expect(stats.roof_permits_ignored).toEqual({
    "after-reference-date": 1,
    "before-year-built": 1,
  });
  expect(stats.roof_year).toEqual({
    permit_basis: 8,
    year_built_basis: 3,
    no_roof_year: 1,
    permit_year_without_year_built: 1,
    permit_basis_in_permit_jurisdiction: 7,
    finaled_coating_only_permits: 1,
  });
});

test("the coating-only permit stays in the permit table", async () => {
  const [r] = (
    await c.runAndReadAll(
      "select roofing_work, roof_coating_only, permit_status_class from permit where permit_number = 'P03'",
    )
  ).getRowObjectsJson();
  expect(r).toEqual({
    roofing_work: true,
    roof_coating_only: true,
    permit_status_class: "closed",
  });
});

test("permit coverage: the City of LA only, and its permits kept elsewhere", () => {
  expect(stats.coverage).toEqual({
    parcels_with_permit_data: 11,
    parcels_without_permit_data: 1,
    parcels_with_permits: 11,
  });
  expect(stats.joined_outside_permit_jurisdiction).toEqual({ direct: 1 });
});
