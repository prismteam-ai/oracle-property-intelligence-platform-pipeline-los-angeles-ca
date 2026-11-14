import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  addContractorIdentity,
  CONTRACTOR_IDENTITY_COLUMNS,
  CONTRACTOR_IDENTITY_RULE_VERSION,
  CONTRACTOR_WINDOW_SQL,
  contractorCoverage,
  contractorIdentityLimitation,
  contractorRowsLimitation,
} from "../src/contractor-identity.ts";
import { personalDataColumns } from "../src/property-sql.ts";

// Synthetic contractor rows (permit, name, license, issue date, owner-builder); no real names.
type R = [string, string | null, string | null, string | null, boolean?];
const ROWS: R[] = [
  // L1: the latest name wins over the more frequent older one.
  ["P01", "ALPHA ROOFING", "100", "2015-01-01"],
  ["P02", "ALPHA ROOFING", "100", "2016-01-01"],
  ["P03", "ALPHA ROOFING INC", "100", "2020-06-01"],
  ["P03", null, "100", "2021-01-01"], // a later row without a name does not count
  // L2: two names on the latest date; the more frequent one wins.
  ["P04", "BETA CO", "200", "2019-01-01"],
  ["P05", "BETA CO", "200", "2022-03-03"],
  ["P06", "BETA COMPANY", "200", "2022-03-03"],
  // L3: tied on date and frequency; the lowest in byte order wins ("Z" < "a").
  ["P07", "gamma roofing", "300", "2023-01-01"],
  ["P08", "Gamma Roofing", "300", "2023-01-01"],
  // L4: no name on any row.
  ["P09", null, "400", "2014-01-01"],
  ["P10", null, "400", "2015-01-01"],
  // L5 shares a name with L1: two identities, never merged.
  ["P11", "ALPHA ROOFING", "500", "2018-01-01"],
  // No license number: owner-builder and N/A rows stay without an identity.
  ["P12", "OWNER-BUILDER", null, "2017-01-01", true],
  ["P13", null, null, "2017-02-02"],
];

let db: DuckDBInstance;
let c: DuckDBConnection;
let stats: Record<string, number>;
const rows = async (sql: string) =>
  (await c.runAndReadAll(sql)).getRowObjectsJson() as Array<
    Record<string, unknown>
  >;

beforeAll(async () => {
  db = await DuckDBInstance.create(":memory:");
  c = await db.connect();
  await c.run(`create table permit_contractor (permit_number varchar, contractors_business_name varchar,
    license_identifier varchar, permit_issue_date date, is_owner_builder boolean)`);
  for (const [p, n, l, d, ob] of ROWS)
    await c.run(
      `insert into permit_contractor values (${[p, n, l, d].map((v) => (v === null ? "null" : `'${v}'`)).join(", ")}, ${ob ? "true" : "false"})`,
    );
  stats = await addContractorIdentity(c);
});
afterAll(() => {
  c.closeSync();
  db.closeSync();
});

const identityOf = async (permit: string) =>
  (
    await rows(`select contractor_identity_key k, canonical_business_name name, name_variant_count variants,
      identity_permit_count permits, contractor_identity_rule_version v
      from permit_contractor where permit_number = '${permit}' order by all limit 1`)
  )[0];

test("the identity columns follow the existing columns, with no personal-data name", async () => {
  const cols = (
    await rows(
      "select column_name from information_schema.columns where table_name = 'permit_contractor' order by ordinal_position",
    )
  ).map((r) => String(r.column_name));
  expect(cols.slice(-5)).toEqual([...CONTRACTOR_IDENTITY_COLUMNS]);
  expect(cols.slice(0, 5)).toEqual([
    "permit_number",
    "contractors_business_name",
    "license_identifier",
    "permit_issue_date",
    "is_owner_builder",
  ]);
  expect(personalDataColumns(cols)).toEqual([]);
  expect(
    (
      await rows("select table_name from information_schema.tables order by 1")
    ).map((r) => r.table_name),
  ).toEqual(["permit_contractor"]);
});

test("canonical name: the latest non-null name by the row's own issue date", async () => {
  expect(await identityOf("P01")).toEqual({
    k: "100",
    name: "ALPHA ROOFING INC",
    variants: 2,
    permits: 3,
    v: CONTRACTOR_IDENTITY_RULE_VERSION,
  });
  // Every row of the license points to the same identity, also the nameless one.
  expect(
    await rows(
      "select distinct canonical_business_name n from permit_contractor where contractor_identity_key = '100'",
    ),
  ).toEqual([{ n: "ALPHA ROOFING INC" }]);
});

test("a tie on the latest date: the most frequent name, then the lowest in byte order", async () => {
  expect((await identityOf("P06"))!.name).toBe("BETA CO");
  expect((await identityOf("P07"))!.name).toBe("Gamma Roofing");
  expect(stats.ties_settled_by_frequency).toBe(1);
  expect(stats.ties_settled_by_byte_order).toBe(1);
});

test("a license with no name has an identity but no canonical name", async () => {
  expect(await identityOf("P09")).toMatchObject({
    k: "400",
    name: null,
    variants: 0,
    permits: 2,
  });
  expect(stats.keys_without_name).toBe(1);
});

test("rows without a license number are never linked; shared names are never merged", async () => {
  for (const p of ["P12", "P13"])
    expect(await identityOf(p)).toEqual({
      k: null,
      name: null,
      variants: null,
      permits: null,
      v: CONTRACTOR_IDENTITY_RULE_VERSION,
    });
  expect(await identityOf("P11")).toMatchObject({
    k: "500",
    name: "ALPHA ROOFING",
    variants: 1,
    permits: 1,
  });
});

test("the counts", () => {
  expect(stats).toEqual({
    keys: 5,
    keys_not_all_digits: 0,
    rows_with_key: 12,
    rows_without_key: 2,
    rows_without_key_owner_builder: 1,
    rows_without_key_other: 1,
    keyed_rows_without_name: 3,
    keys_with_several_names: 3,
    max_names_per_key: 2,
    keys_without_name: 1,
    names_under_several_keys: 1,
    ties_settled_by_frequency: 1,
    ties_settled_by_byte_order: 1,
  });
  const text = contractorIdentityLimitation(stats);
  expect(text).toMatch(/not verified against CSLB/);
  expect(text).toMatch(/license_expiration_date is not used/);
  expect(text).toMatch(/5 license numbers/);
  // Counts only: no business name appears in the manifest sentence.
  expect(text).not.toMatch(/ALPHA|BETA|Gamma|OWNER-BUILDER/);
});

test("the contractor source's coverage window is the table's min/max, as the limitation states", async () => {
  const [w] = (await rows(CONTRACTOR_WINDOW_SQL)) as Array<{
    first: string;
    last: string;
  }>;
  expect(w).toEqual({ first: "2014-01-01", last: "2023-01-01" });
  expect(contractorCoverage(w!)).toEqual({
    field: "permit_issue_date",
    first: "2014-01-01",
    last: "2023-01-01",
  });
  expect(contractorRowsLimitation(w!)).toMatch(
    /only for permits issued 2014-01-01 to 2023-01-01\.$/,
  );
});
