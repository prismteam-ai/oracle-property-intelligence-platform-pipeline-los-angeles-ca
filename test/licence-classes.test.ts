import { DuckDBInstance } from "@duckdb/node-api";
import { expect, test } from "vitest";
import {
  classifyLicense,
  createLicenseClassTable,
  LICENSE_CLASS_NAMES,
} from "../src/licence-classes.ts";

// Every raw license_type value in the contractor cache's summary (52 values and null), with its
// expected class and note.
const RAW: Array<[string | null, string | null, string | null]> = [
  ["39", "C-39", null],
  ["C39", "C-39", null],
  ["c39", "C-39", null],
  ["B", "B", null],
  ["b", "B", null],
  ["A", "A", null],
  ["C10", "C-10", null],
  ["c10", "C-10", null],
  ["C46", "C-46", null],
  ["C20", "C-20", null],
  ["C36", "C-36", null],
  ["C16", "C-16", null],
  ["C45", "C-45", null],
  ["C53", "C-53", null],
  ["C27", "C-27", null],
  ["C43", "C-43", null],
  ["C51", "C-51", null],
  ["C33", "C-33", null],
  ["C29", "C-29", null],
  ["C15", "C-15", null],
  ["C23", "C-23", null],
  ["C17", "C-17", null],
  ["C21", "C-21", null],
  ["C38", "C-38", null],
  ["C13", "C-13", null],
  ["C11", "C-11", null],
  ["C54", "C-54", null],
  ["C47", "C-47", null],
  ["C35", "C-35", null],
  ["C50", "C-50", null],
  ["C12", "C-12", null],
  ["C-4", "C-4", null],
  ["C-7", "C-7", null],
  ["C-9", "C-9", null],
  ["C-2", "C-2", null],
  ["C-8", "C-8", null],
  ["C-6", "C-6", null],
  ["C-5", "C-5", null],
  ["D03", "C-61/D-03", null],
  ["D42", "C-61/D-42", null],
  ["D34", "C-61/D-34", null],
  ["D39", "C-61/D-39", null],
  ["D51", "C-61/D-51", null],
  ["D24", "C-61/D-24", null],
  ["D41", "C-61/D-41", null],
  ["D59", "C-61/D-59", null],
  ["ASB", "cert:ASB", "certification"],
  ["HAZ", "cert:HAZ", "certification"],
  ["C93", null, "unmapped"],
  ["2B", null, "unmapped"],
  ["NA", null, "owner-builder"],
  ["N/A", null, null],
  [null, null, null],
];

test("the table covers the 53 raw values of the cache summary", () => {
  expect(new Set(RAW.map((r) => r[0])).size).toBe(53);
});

test.each(RAW)("%j → %j (%j)", (raw, cls, note) => {
  const k = classifyLicense(raw);
  expect([k.license_class, k.license_class_note]).toEqual([cls, note]);
  expect(k.license_class_name).toBe(
    cls === null ? null : LICENSE_CLASS_NAMES[cls],
  );
  expect(k.is_owner_builder).toBe(raw === "NA");
});

test("named classes from the inputs", () => {
  expect(classifyLicense("D51").license_class_name).toBe(
    "Limited specialty: waterproofing and weatherproofing",
  );
  expect(classifyLicense("D59").license_class_name).toBe(
    "Limited specialty: hydroseed spraying",
  );
  expect(classifyLicense("C39").license_class_name).toBe("Roofing");
});

test.each([["Z9"], ["C-61"], ["D5"], ["C123"], ["owner"], ["C 39"]])(
  "a new raw value %j is unmapped",
  (raw) => {
    expect(classifyLicense(raw)).toEqual({
      license_class: null,
      license_class_name: null,
      license_class_note: "unmapped",
      is_owner_builder: false,
    });
  },
);

test.each([
  [" c39 ", "C-39"],
  ["C05", "C-5"],
  ["c-10", "C-10"],
  [" na ", null],
])("case and spacing: %j → %j", (raw, cls) => {
  expect(classifyLicense(raw).license_class).toBe(cls);
});

test("the lookup table has one row per distinct raw value, null included", async () => {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run("create table src (license_type varchar)");
  await c.run(
    "insert into src values ('C39'), ('C39'), ('NA'), (null), ('C93'), ('HAZ')",
  );
  await createLicenseClassTable(c, "src", "license_type", "license_class_map");
  const rows = (
    await c.runAndReadAll(`
      select s.license_type, m.license_class, m.license_class_note, m.is_owner_builder
      from src s join license_class_map m on m.source_license_type is not distinct from s.license_type
      order by all`)
  ).getRowObjectsJson();
  expect(rows).toEqual([
    {
      license_type: "C39",
      license_class: "C-39",
      license_class_note: null,
      is_owner_builder: false,
    },
    {
      license_type: "C39",
      license_class: "C-39",
      license_class_note: null,
      is_owner_builder: false,
    },
    {
      license_type: "C93",
      license_class: null,
      license_class_note: "unmapped",
      is_owner_builder: false,
    },
    {
      license_type: "HAZ",
      license_class: "cert:HAZ",
      license_class_note: "certification",
      is_owner_builder: false,
    },
    {
      license_type: "NA",
      license_class: null,
      license_class_note: "owner-builder",
      is_owner_builder: true,
    },
    {
      license_type: null,
      license_class: null,
      license_class_note: null,
      is_owner_builder: false,
    },
  ]);
  c.closeSync();
  db.closeSync();
});
