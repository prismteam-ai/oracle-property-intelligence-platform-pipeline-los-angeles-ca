import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { loadRunConfig, whereClause } from "../src/run-config.ts";
import {
  checkScope,
  exceptionScopesFromCatalog,
  guardOrThrow,
  matchException,
} from "../src/scope-guard.ts";

const CATALOG = "docs/los-angeles-sources.yaml";
const catalogYaml = readFileSync(CATALOG, "utf8");
const scopes = exceptionScopesFromCatalog(catalogYaml);
const permitsEntry = scopes[0]!;
const permitRun = {
  jurisdiction: "all",
  zips: [] as string[],
  roll_year: "2026",
  permits_harvested: true,
  permit_jurisdictions: ["Los Angeles"],
};
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

test("the catalog holds one entry: county parcels plus City of LA permits", () => {
  expect(scopes).toEqual([permitRun]);
});

test("pass: the permits config, under that entry", () => {
  expect(checkScope(permitRun, permitsEntry)).toEqual([]);
  expect(guardOrThrow("config/la-county-permits-run.json", CATALOG)).toBe(1);
});

test("the increment-1 and increment-4 configs are refused: their entries have expired", () => {
  expect(() => guardOrThrow("config/la-pilot-run.json", CATALOG)).toThrow(
    /SCOPE GUARD FAILED[\s\S]*permits_harvested false/,
  );
  expect(() => guardOrThrow("config/la-county-run.json", CATALOG)).toThrow(
    /SCOPE GUARD FAILED[\s\S]*permit_jurisdictions \[\] are not the approved \[Los Angeles\]/,
  );
  for (const run of [pilot, county])
    expect(() => matchException(run, scopes)).toThrow(/SCOPE GUARD FAILED/);
});

test("expired entries are kept in the catalog but never read", () => {
  const catalog = parse(catalogYaml) as {
    expired_exceptions: Array<{
      expired: string;
      scope: { increment: number };
    }>;
  };
  expect(
    catalog.expired_exceptions.map((e) => [e.scope.increment, e.expired]),
  ).toEqual([
    [4, "2026-11-13"],
    [1, "2026-11-13"],
  ]);
  const onlyExpired = catalogYaml.replace(
    /^approved_exceptions:[\s\S]*?(?=^expired_exceptions:)/m,
    "",
  );
  expect(() => exceptionScopesFromCatalog(onlyExpired)).toThrow(
    /no approved permit-gate exception/,
  );
});

test.each([
  [
    "other permit jurisdictions",
    { permit_jurisdictions: ["Los Angeles", "Burbank"] },
    /permit_jurisdictions \[Los Angeles, Burbank\]/,
  ],
  [
    "no permit jurisdictions",
    { permit_jurisdictions: [] },
    /permit_jurisdictions \[\]/,
  ],
  ["permits off", { permits_harvested: false }, /permits_harvested false/],
  ["a ZIP filter", { zips: ["91405"] }, /zips \[91405\]/],
  [
    "one city's parcels",
    { jurisdiction: "Los Angeles" },
    /jurisdiction "Los Angeles"/,
  ],
  ["another roll year", { roll_year: "2025" }, /roll_year "2025"/],
])("fail: the permits run with %s", (_n, change, msg) => {
  expect(() => matchException({ ...permitRun, ...change }, scopes)).toThrow(
    msg,
  );
});

test("permit jurisdictions match by name, ignoring case and spacing", () => {
  expect(
    matchException(
      { ...permitRun, permit_jurisdictions: [" los angeles "] },
      scopes,
    ),
  ).toBe(1);
});

test("an exception must name its permit jurisdictions exactly when it harvests permits", () => {
  const entry = (permits: boolean, juris: string) => `approved_exceptions:
  - gate: permit
    scope: { jurisdiction: all, zips: [], roll_year: "2026"${juris} }
    permits_harvested: ${permits}
`;
  expect(() => exceptionScopesFromCatalog(entry(true, ""))).toThrow(
    /must name its permit_jurisdictions/,
  );
  expect(() =>
    exceptionScopesFromCatalog(
      entry(false, ", permit_jurisdictions: [Los Angeles]"),
    ),
  ).toThrow(/must name its permit_jurisdictions/);
  expect(exceptionScopesFromCatalog(entry(false, ""))).toEqual([
    { ...county, permit_jurisdictions: [] },
  ]);
});

test("where clauses: the county runs filter on the roll year only; the pilot clause is unchanged", () => {
  for (const c of [
    "config/la-county-run.json",
    "config/la-county-permits-run.json",
  ])
    expect(whereClause(loadRunConfig(c))).toBe("RollYear = '2026'");
  expect(whereClause(loadRunConfig("config/la-pilot-run.json"))).toBe(
    "SitusZIP5 IN ('91405','91406','91411') AND TaxRateArea_CITY = 'LOS ANGELES' AND RollYear = '2026'",
  );
  expect(() => whereClause({ ...county, zips: ["91405"] })).toThrow(
    /no ZIP filter/,
  );
});
