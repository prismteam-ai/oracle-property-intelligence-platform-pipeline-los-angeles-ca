import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { loadRunConfig, whereClause } from "../src/run-config.ts";
import {
  checkScope,
  exceptionScopesFromCatalog,
  guardOrThrow,
  matchException,
} from "../src/scope-guard.ts";

const scopes = exceptionScopesFromCatalog(
  readFileSync("docs/los-angeles-sources.yaml", "utf8"),
);
const countyEntry = scopes[0]!;
const pilotEntry = scopes[1]!;
const pilot = {
  jurisdiction: "Los Angeles",
  zips: ["91405", "91406", "91411"],
  roll_year: "2026",
  permits_harvested: false,
};
const county = {
  jurisdiction: "all",
  zips: [] as string[],
  roll_year: "2026",
  permits_harvested: false,
};

test("the catalog holds the county entry first and the pilot entry second", () => {
  expect(scopes).toHaveLength(2);
  expect(countyEntry).toEqual(county);
  expect(pilotEntry).toEqual(pilot);
});

test("pass: the approved pilot scope, under its own entry only", () => {
  expect(checkScope(pilot, pilotEntry)).toEqual([]);
  expect(checkScope(pilot, countyEntry)).not.toEqual([]);
  expect(matchException(pilot, scopes)).toBe(2);
  expect(
    guardOrThrow("config/la-pilot-run.json", "docs/los-angeles-sources.yaml"),
  ).toBe(2);
});

test("pass: the county config, under the county entry only", () => {
  expect(checkScope(county, countyEntry)).toEqual([]);
  expect(checkScope(county, pilotEntry).length).toBeGreaterThanOrEqual(2);
  expect(matchException(county, scopes)).toBe(1);
  expect(
    guardOrThrow("config/la-county-run.json", "docs/los-angeles-sources.yaml"),
  ).toBe(1);
});

test("fail: a county run when the catalog has only the pilot entry", () => {
  expect(() => matchException(county, [pilotEntry])).toThrow(
    /SCOPE GUARD FAILED[\s\S]*jurisdiction "all"[\s\S]*zips \[\]/,
  );
});

test("fail: full-county run under the pilot entry, other ZIP, other roll year, permits on", () => {
  const fullCounty = {
    jurisdiction: "",
    zips: [],
    roll_year: "2026",
    permits_harvested: false,
  };
  expect(checkScope(fullCounty, pilotEntry).length).toBeGreaterThanOrEqual(2);
  const otherZip = { ...pilot, zips: ["91405", "91406", "91402"] };
  expect(checkScope(otherZip, pilotEntry).join("\n")).toMatch(/zips/);
  expect(() => matchException(otherZip, scopes)).toThrow(/zips/);
  for (const run of [pilot, county]) {
    expect(() => matchException({ ...run, roll_year: "2025" }, scopes)).toThrow(
      /roll_year "2025"/,
    );
    expect(() =>
      matchException({ ...run, permits_harvested: true }, scopes),
    ).toThrow(/permits_harvested true/);
  }
});

test("fail: a county run with a ZIP filter", () => {
  expect(() => matchException({ ...county, zips: ["91405"] }, scopes)).toThrow(
    /zips \[91405\]/,
  );
});

test("where clauses: the county run filters on the roll year only; the pilot clause is unchanged", () => {
  expect(whereClause(loadRunConfig("config/la-county-run.json"))).toBe(
    "RollYear = '2026'",
  );
  expect(whereClause(loadRunConfig("config/la-pilot-run.json"))).toBe(
    "SitusZIP5 IN ('91405','91406','91411') AND TaxRateArea_CITY = 'LOS ANGELES' AND RollYear = '2026'",
  );
  expect(() => whereClause({ ...county, zips: ["91405"] })).toThrow(
    /no ZIP filter/,
  );
});
