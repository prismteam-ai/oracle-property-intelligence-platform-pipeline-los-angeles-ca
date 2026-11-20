import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  CONTRACTOR_FIELDS,
  PERMIT_FIELDS,
  PERMIT_FLAG_ONLY_FIELDS,
} from "../src/permit-fields.ts";
import { PERSONAL_DATA_PATTERN } from "../src/property-sql.ts";

test("field lists have no duplicates and hold the keys", () => {
  expect(new Set(PERMIT_FIELDS).size).toBe(PERMIT_FIELDS.length);
  expect(new Set(CONTRACTOR_FIELDS).size).toBe(CONTRACTOR_FIELDS.length);
  expect(PERMIT_FIELDS).toContain("permit_nbr");
  expect(CONTRACTOR_FIELDS).toContain("pcis_permit");
});

test("work_desc is staged only for the flags", () => {
  expect(PERMIT_FLAG_ONLY_FIELDS).toEqual(["work_desc"]);
  for (const f of PERMIT_FLAG_ONLY_FIELDS) expect(PERMIT_FIELDS).toContain(f);
});

test("dropped permit fields are not staged", () => {
  for (const f of [
    "pin_nbr",
    "lat",
    "lon",
    "type_lat_lon",
    "use_code",
    "use_desc",
    "valuation",
    "square_footage",
    "construction",
    "solar",
    "cofo_date",
    "refresh_time",
  ])
    expect(PERMIT_FIELDS as readonly string[]).not.toContain(f);
});

test("no staged field matches the personal-data column pattern", () => {
  expect(
    [...PERMIT_FIELDS, ...CONTRACTOR_FIELDS].filter((f) =>
      PERSONAL_DATA_PATTERN.test(f),
    ),
  ).toEqual([]);
});

test("the stagers read the field lists, not their own copies", () => {
  expect(readFileSync("src/stage-permits.ts", "utf8")).toMatch(
    /pickFields\(r, PERMIT_FIELDS, p\.file\)/,
  );
  expect(readFileSync("src/stage-contractors.ts", "utf8")).toMatch(
    /pickFields\(r, CONTRACTOR_FIELDS, p\.file\)/,
  );
});
