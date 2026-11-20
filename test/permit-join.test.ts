import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  CONDO_BUILDINGS_SQL,
  JOIN_BY_METHOD_SQL,
  JOIN_RULE_VERSION,
  joinPermits,
  UNJOINED_BY_CAUSE_SQL,
} from "../src/permit-join.ts";
import { sqlLiteral as lit } from "../src/property-sql.ts";

let db: DuckDBInstance;
let c: DuckDBConnection;
const rows = async (sql: string) =>
  (await c.runAndReadAll(sql)).getRowObjectsJson() as Array<
    Record<string, unknown>
  >;
const v = (x: string | null) => (x === null ? "null" : lit(x));

// Synthetic roll: [AIN, street_number, direction, street_name, zip, use code, lat, lon]
const PARCELS: Array<
  [
    string,
    string | null,
    string | null,
    string | null,
    string,
    string,
    number,
    number,
  ]
> = [
  ["1111111001", "10", null, "OAK AVE", "90001", "0100", 34.1, -118.1], // direct target
  ["2222222001", "20", "W", "ELM ST", "90002", "0100", 34.2, -118.2], // unique address
  ["3333333001", "30", null, "PINE ST", "90003", "010C", 34.3, -118.3], // condo building, 3 units
  ["3333333002", "30", null, "PINE ST", "90003", "010C", 34.3, -118.3],
  ["3333333003", "30", null, "PINE ST", "90003", "010E", 34.3, -118.3],
  ["4444444001", "40", null, "CEDAR ST", "90004", "0100", 34.4, -118.4], // non-condo pair
  ["4444444002", "40", null, "CEDAR ST", "90004", "0100", 34.4, -118.4],
  ["5555555001", "50", "S", "MAPLE AVE", "90005", "0100", 34.5, -118.5], // direction S only
  ["6661234001", "60", null, "BIRCH ST", "90006", "0100", 34.6, -118.6], // same address, two books
  ["7771234001", "60", null, "BIRCH ST", "90006", "0100", 34.6, -118.6],
  ["8888888001", "80", "N", "ASH ST", "90008", "010C", 34.8, -118.8], // condo units in two buildings
  ["8888888002", "80", "S", "ASH ST", "90008", "010C", 34.8, -118.8],
  ["9999999001", "90", null, "FIR ST", "90009", "010C", 34.9, -118.9], // condo + non-condo
  ["9999999002", "90", null, "FIR ST", "90009", "0100", 34.9, -118.9],
  ["1212121001", "12 1/2", null, "YEW ST", "90012", "0100", 34.12, -118.12], // fractions
  ["1212121002", "12", null, "YEW ST", "90012", "0100", 34.12, -118.12],
  ["1313131001", null, null, null, "90013", "0100", 34.13, -118.13], // no situs address
];

// [permit_nbr, apn, primary_address, zip, lat, lon, expected method, expected cause, expected parcels]
type Case = [
  string,
  string | null,
  string | null,
  string | null,
  number | null,
  number | null,
  string | null,
  string | null,
  string[],
];
const CASES: Case[] = [
  [
    "P01",
    "1111111001",
    "999 NOWHERE ST",
    "90099",
    null,
    null,
    "direct",
    null,
    ["1111111001"],
  ],
  [
    "P02",
    "2222222999",
    "20 W ELM STREET #4",
    "90002",
    null,
    null,
    "address",
    null,
    ["2222222001"],
  ],
  [
    "P03",
    "3333333***",
    "30 PINE ST",
    "90003",
    null,
    null,
    "condo-building",
    null,
    ["3333333001", "3333333002", "3333333003"],
  ],
  [
    "P04",
    null,
    "40 CEDAR ST",
    "90004",
    null,
    null,
    null,
    "apn-missing/address-ambiguous",
    [],
  ],
  [
    "P05",
    "5555555999",
    "50 N MAPLE AVE",
    "90005",
    null,
    null,
    null,
    "apn-not-in-roll/zip-or-direction-disagrees",
    [],
  ],
  [
    "P06",
    "5555555999",
    "50 MAPLE AVE",
    "90005",
    null,
    null,
    "address",
    null,
    ["5555555001"],
  ],
  [
    "P07",
    "2222222999",
    "20 W ELM ST",
    "90099",
    null,
    null,
    null,
    "apn-not-in-roll/zip-or-direction-disagrees",
    [],
  ],
  [
    "P08",
    "6661234***",
    "60 BIRCH ST",
    "90006",
    null,
    null,
    "address",
    null,
    ["6661234001"],
  ],
  [
    "P09",
    "",
    "60 BIRCH ST",
    "90006",
    null,
    null,
    null,
    "apn-missing/address-ambiguous",
    [],
  ],
  [
    "P10",
    "1231234***",
    "60 BIRCH ST",
    "90006",
    null,
    null,
    null,
    "apn-masked/book-page-disagrees",
    [],
  ],
  [
    "P11",
    "8888888***",
    "80 ASH ST",
    "90008",
    null,
    null,
    null,
    "apn-masked/address-ambiguous",
    [],
  ],
  [
    "P12",
    "9999999***",
    "90 FIR ST",
    "90009",
    null,
    null,
    null,
    "apn-masked/address-ambiguous",
    [],
  ],
  // The fraction agrees where both carry one: a parcel without a fraction also agrees.
  [
    "P13",
    "12121219",
    "12 1/2 YEW ST",
    "90012",
    null,
    null,
    null,
    "apn-malformed/address-ambiguous",
    [],
  ],
  [
    "P14",
    "1212121---",
    "12 YEW ST",
    "90012",
    null,
    null,
    null,
    "apn-malformed/address-ambiguous",
    [],
  ],
  [
    "P15",
    "----------",
    "77 ELM ST",
    "90002",
    null,
    null,
    null,
    "apn-malformed/no-address-match",
    [],
  ],
  // A different fraction excludes the "12 1/2" parcel; the one without a fraction remains.
  [
    "P18",
    null,
    "12 3/4 YEW ST",
    "90012",
    null,
    null,
    "address",
    null,
    ["1212121002"],
  ],
  // Coordinates equal to a parcel's centre never join a permit.
  [
    "P16",
    "0000000000",
    null,
    "90001",
    34.1,
    -118.1,
    null,
    "apn-not-in-roll/no-usable-address",
    [],
  ],
  [
    "P17",
    null,
    "20 W ELM ST",
    null,
    34.2,
    -118.2,
    null,
    "apn-missing/no-usable-address",
    [],
  ],
];

beforeAll(async () => {
  db = await DuckDBInstance.create(":memory:");
  c = await db.connect();
  await c.run(`create table property (parcel_identifier varchar, street_number varchar,
    street_pre_directional_text varchar, street_name varchar, postal_code varchar,
    source_use_code varchar, latitude double, longitude double)`);
  for (const p of PARCELS)
    await c.run(
      `insert into property values (${p
        .slice(0, 6)
        .map((x) => v(x as string | null))
        .join(", ")}, ${p[6]}, ${p[7]})`,
    );
  await c.run(`create table permit_raw (permit_nbr varchar, apn varchar, primary_address varchar,
    zip_code varchar, lat double, lon double)`);
  for (const k of CASES)
    await c.run(
      `insert into permit_raw values (${v(k[0])}, ${v(k[1])}, ${v(k[2])}, ${v(k[3])}, ${k[4] ?? "null"}, ${k[5] ?? "null"})`,
    );
  await joinPermits(c, "permit_raw", "property");
});
afterAll(() => {
  c.closeSync();
  db.closeSync();
});

test.each(CASES)(
  "%s: apn %j, address %j",
  async (nbr, _apn, _addr, _zip, _lat, _lon, method, cause, parcels) => {
    const [j] = await rows(
      `select * from permit_join where permit_number = ${lit(nbr)}`,
    );
    expect({ method: j!.join_method, cause: j!.unjoined_cause }).toEqual({
      method,
      cause,
    });
    const links = await rows(
      `select * from permit_parcel where permit_number = ${lit(nbr)} order by parcel_identifier`,
    );
    expect(links.map((l) => l.parcel_identifier)).toEqual(parcels);
    for (const l of links) {
      expect(l.join_method).toBe(method);
      expect(l.building_level).toBe(method === "condo-building");
      expect(l.join_rule_version).toBe(JOIN_RULE_VERSION);
    }
  },
);

test("every permit appears once in permit_join, and only the join tables remain", async () => {
  const [n] = await rows(
    "select count(*) n, count(distinct permit_number) d from permit_join",
  );
  expect(n).toEqual({ n: String(CASES.length), d: String(CASES.length) });
  const tables = await rows(
    "select table_name from information_schema.tables order by 1",
  );
  expect(tables.map((t) => t.table_name)).toEqual([
    "permit_join",
    "permit_parcel",
    "permit_raw",
    "property",
  ]);
});

test("counts by method and cause; condo buildings counted once", async () => {
  expect(await rows(JOIN_BY_METHOD_SQL)).toEqual([
    { join_method: "address", permits: "4" },
    { join_method: "condo-building", permits: "1" },
    { join_method: "direct", permits: "1" },
    { join_method: "unjoined", permits: "12" },
  ]);
  const causes = await rows(UNJOINED_BY_CAUSE_SQL);
  expect(causes.reduce((s, x) => s + Number(x.permits), 0)).toBe(12);
  expect(await rows(CONDO_BUILDINGS_SQL)).toEqual([
    { permits: "1", unit_links: "3", units: "3" },
  ]);
});
