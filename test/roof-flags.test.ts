import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sqlLiteral as lit } from "../src/property-sql.ts";
import {
  neitherSampleSql,
  ROOF_FLAG_GROUPS_SQL,
  ROOF_FLAG_RULE_VERSION,
  createRoofFlagsTable,
  roofFlags,
} from "../src/roof-flags.ts";

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

type Row = {
  permit_nbr: string;
  work_desc: string | null;
  business_unit: string | null;
};
const rows = async (sql: string) =>
  (await c.runAndReadAll(sql)).getRowObjectsJson() as Array<
    Record<string, unknown>
  >;

async function flag(input: Row[]) {
  await c.run("drop table if exists src; drop table if exists flagged");
  await c.run(
    "create table src (permit_nbr varchar, work_desc varchar, business_unit varchar, permit_type varchar, permit_sub_type varchar)",
  );
  for (const r of input)
    await c.run(
      `insert into src values (${lit(r.permit_nbr)}, ${r.work_desc === null ? "null" : lit(r.work_desc)}, ${r.business_unit === null ? "null" : lit(r.business_unit)}, 'T', 'S')`,
    );
  await createRoofFlagsTable(c, "src", "flagged");
  return rows("select * from flagged order by permit_nbr");
}

const PC = "Plan Check";
const EX = "Express Permit";
// [work_desc, business unit, roof_r, roof_only]
const cases: Array<[string, string, boolean, boolean]> = [
  // roof_r phrases, whole words, any case, hyphen and space variants
  ["RE-ROOF EXISTING SFD", PC, true, false],
  ["reroof existing sfd", PC, true, false],
  ["Re Roof garage", PC, true, false],
  ["REROOFING OF DWELLING", PC, true, false],
  ["RE-ROOFED IN 2019, ADD DECK", PC, true, false],
  ["NEW ROOF COVERING", PC, true, false],
  ["ROOF COVER REPLACEMENT", PC, true, false],
  ["ROOFING PER PLANS", PC, true, false],
  ["CLAY ROOF TILES", PC, true, false],
  ["roof tile", PC, true, false],
  ["COATING TO AN EXISTING ROOF", PC, true, false],
  ["COATING  TO AN\nEXISTING ROOF", PC, true, false],
  // never roofing: the -PROOF words and their -ING forms, rooftop
  ["SOUNDPROOFING RETROFIT", PC, false, false],
  ["SOUNDPROOF WINDOWS", EX, false, false],
  ["WATERPROOFING OF DECK", PC, false, false],
  ["WATERPROOF MEMBRANE", EX, false, false],
  ["FIREPROOFING OF STEEL", PC, false, false],
  ["FIREPROOF DOORS", EX, false, false],
  ["DAMPPROOFING AT FOUNDATION", PC, false, false],
  ["DAMPPROOF WALL", EX, false, false],
  ["ROOFTOP SOLAR", EX, false, false],
  ["ROOFTOPS HVAC UNITS", EX, false, false],
  ["SOLAR ON ROOF TOP", EX, false, false],
  ["SOLAR ON ROOF-TOP", EX, false, false],
  ["MORE ROOF DRAINS", PC, false, false],
  ["PREROOF INSPECTION", PC, false, false],
  // roof_only: the two start patterns, any business unit
  ["RE-ROOF WITH CLASS A OR B ROOFING", PC, true, true],
  ["REROOF WITH 20 SQRS OF SHINGLES", PC, true, true],
  ["REROOF WITH 12.5 SQRS", PC, true, true],
  ["REROOF WITH SQRS", PC, true, false],
  ["ADD REROOF WITH 20 SQRS", PC, true, false],
  // roof_only: Express Permit with a whole roof word
  ["T/O (E) ROOF AND REPLACE", EX, false, true],
  ["NEW ROOFS ON GARAGE", EX, false, true],
  ["ROOFED PATIO", EX, false, true],
  ["RE ROOF", EX, true, true],
  ["SOLAR ON ROOF TOP AND ROOF REPAIR", EX, false, true],
  ["T/O (E) ROOF", PC, false, false],
  ["ROOFTOP DECK, ROOF", EX, false, true],
  // a) underscore, digits and every other non-letter separate words, also in the exclusions
  ["REROOFING_ GARAGE", PC, true, false],
  ["ROOFING_SHINGLES", PC, true, false],
  ["2ROOFING LAYERS", PC, true, false],
  ["ROOF_COVER", PC, true, false],
  ["RE_ROOF", PC, true, false],
  ["(E)ROOF REPAIR", EX, false, true],
  ["ROOF3 LAYERS", EX, false, true],
  ["SOUNDPROOFING_", PC, false, false],
  ["WATERPROOF_DECK", EX, false, false],
  ["FIREPROOFING1", PC, false, false],
  ["DAMPPROOF_WALL", EX, false, false],
  ["ROOFTOP_SOLAR", EX, false, false],
  ["SOLAR ON ROOF_TOP", EX, false, false],
  ["ROOFTOPS2 HVAC", EX, false, false],
  // b) a word starting with REROOF or RE-ROOF is a re-roof word; letters before it are not a start
  ["REROOFWITH COMP SHINGLES", PC, true, false],
  ["RE-ROOFWITH CLASS A", PC, true, false],
  ["REROOFW/COMP", PC, true, false],
  ["RE-ROOFINGCOMPLY", PC, true, false],
  ["REROOF99SQRS", PC, true, false],
  ["99999-99999-99999RE-ROOF", PC, true, false],
  ["REROOFWITH", EX, true, true],
  ["BATHREROOF", PC, false, false],
  ["GRE-ROOF", PC, false, false],
  // c) ENTIRE ROOF and RESTRUCTURE / RECONFIGURE / RESTORE ROOF are not re-roof words
  ["REPLACE ENTIRE ROOF", PC, false, false],
  ["RESTRUCTURE ROOF", PC, false, false],
  ["RECONFIGURE ROOF FRAMING", PC, false, false],
  ["RESTORE ROOF", PC, false, false],
  ["ENTIRE ROOF REROOF", PC, true, false],
  ["RESTORE ROOFING", PC, true, false],
  ["REPLACE ENTIRE ROOF", EX, false, true],
];

test.each(cases)("%s (%s)", async (desc, bu, roofR, roofOnly) => {
  const [r] = await flag([
    { permit_nbr: "1", work_desc: desc, business_unit: bu },
  ]);
  expect({ roof_r: r!.roof_r, roof_only: r!.roof_only }).toEqual({
    roof_r: roofR,
    roof_only: roofOnly,
  });
  expect(r!.roofing_work).toBe(roofR || roofOnly);
  expect(r!.roof_flag_rule_version).toBe(ROOF_FLAG_RULE_VERSION);
});

test("roof_coating_only: only when the coating phrase alone makes it roofing work", async () => {
  const r = await flag([
    {
      permit_nbr: "1",
      work_desc: "COATING TO AN EXISTING ROOF",
      business_unit: PC,
    },
    {
      permit_nbr: "2",
      work_desc: "COATING TO AN EXISTING ROOF",
      business_unit: EX,
    },
    {
      permit_nbr: "3",
      work_desc: "COATING TO AN EXISTING ROOF AND REROOF GARAGE",
      business_unit: PC,
    },
    {
      permit_nbr: "4",
      work_desc: "COATING TO AN EXISTING ROOF; NEW ROOF AT REAR",
      business_unit: EX,
    },
    { permit_nbr: "5", work_desc: "REROOF", business_unit: PC },
    { permit_nbr: "6", work_desc: "WATERPROOFING", business_unit: PC },
  ]);
  expect(r.map((x) => [x.roofing_work, x.roof_coating_only])).toEqual([
    [true, true],
    [true, true],
    [true, false],
    [true, false],
    [true, false],
    [false, false],
  ]);
});

test("the coating phrase with underscores, and next to a re-roof word", () => {
  expect(roofFlags("COATING_TO_AN_EXISTING_ROOF", PC)).toEqual({
    roof_r: true,
    roof_only: false,
    roof_coating_only: true,
  });
  expect(roofFlags("COATING TO AN EXISTING ROOF; REROOFWITH", PC)).toEqual({
    roof_r: true,
    roof_only: false,
    roof_coating_only: false,
  });
  expect(roofFlags("COATING TO AN EXISTING ROOFS", PC).roof_r).toBe(false);
});

test("null description and business unit flag nothing", async () => {
  const [r] = await flag([
    { permit_nbr: "1", work_desc: null, business_unit: null },
  ]);
  expect([
    r!.roof_r,
    r!.roof_only,
    r!.roofing_work,
    r!.roof_coating_only,
  ]).toEqual([false, false, false, false]);
});

test("the four groups count each permit once", async () => {
  await flag([
    { permit_nbr: "1", work_desc: "REROOF", business_unit: PC },
    { permit_nbr: "2", work_desc: "ROOF", business_unit: EX },
    { permit_nbr: "3", work_desc: "RE-ROOF", business_unit: EX },
    { permit_nbr: "4", work_desc: "SOUNDPROOFING", business_unit: EX },
    {
      permit_nbr: "5",
      work_desc: "COATING TO AN EXISTING ROOF",
      business_unit: PC,
    },
  ]);
  expect(await rows(ROOF_FLAG_GROUPS_SQL("flagged"))).toEqual([
    {
      roof_r_only: "2",
      roof_only_only: "1",
      both: "1",
      neither: "1",
      coating_only: "1",
      total: "5",
    },
  ]);
});

test("the neither sample is seeded, deterministic and limited", async () => {
  await flag(
    Array.from({ length: 30 }, (_, i) => ({
      permit_nbr: String(1000 + i),
      work_desc: i % 3 ? "WATERPROOFING" : "REROOF",
      business_unit: PC,
    })),
  );
  const a = await rows(neitherSampleSql("flagged", "seed-a", 5));
  const again = await rows(neitherSampleSql("flagged", "seed-a", 5));
  const b = await rows(neitherSampleSql("flagged", "seed-b", 5));
  expect(a).toHaveLength(5);
  expect(again).toEqual(a);
  expect(b.map((x) => x.permit_nbr)).not.toEqual(a.map((x) => x.permit_nbr));
  expect(a.every((x) => x.work_desc === "WATERPROOFING")).toBe(true);
  expect(() => neitherSampleSql("flagged", "s", 0)).toThrow(/sample size/);
});
