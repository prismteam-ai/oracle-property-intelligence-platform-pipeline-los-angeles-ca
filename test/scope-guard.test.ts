import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { checkScope, exceptionScopeFromCatalog } from "../src/scope-guard.ts";

const allowed = exceptionScopeFromCatalog(
  readFileSync("docs/los-angeles-sources.yaml", "utf8"),
);
const pilot = {
  jurisdiction: "Los Angeles",
  zips: ["91405", "91406", "91411"],
  roll_year: "2026",
  permits_harvested: false,
};

test("pass: the approved pilot scope", () => {
  expect(checkScope(pilot, allowed)).toEqual([]);
});

test("fail: full-county run, other ZIP, other roll year, permits on", () => {
  const fullCounty = {
    jurisdiction: "",
    zips: [],
    roll_year: "2026",
    permits_harvested: false,
  };
  expect(checkScope(fullCounty, allowed).length).toBeGreaterThanOrEqual(2);
  const otherZip = { ...pilot, zips: ["91405", "91406", "91402"] };
  expect(checkScope(otherZip, allowed).join("\n")).toMatch(/zips/);
  expect(
    checkScope({ ...pilot, roll_year: "2025" }, allowed).join("\n"),
  ).toMatch(/roll_year/);
  expect(
    checkScope({ ...pilot, permits_harvested: true }, allowed).join("\n"),
  ).toMatch(/permits_harvested/);
});
