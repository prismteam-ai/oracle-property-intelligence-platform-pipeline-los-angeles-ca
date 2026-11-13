import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import {
  loadRunConfig,
  referenceDateOf,
  runIdFromCaches,
} from "../src/run-config.ts";

test("the run ID is the latest cache time, in the run-ID form", () => {
  // The three caches' generated_at: roll, permits, contractors.
  expect(
    runIdFromCaches([
      "2026-11-12T01:44:04.047Z",
      "2026-11-12T13:14:56.570Z",
      "2026-11-12T14:00:51.383Z",
    ]),
  ).toBe("2026-11-12T14-00-51-383Z");
  expect(
    runIdFromCaches(["2026-11-13T00:00:00.000Z", "2026-11-12T23:59:59.999Z"]),
  ).toBe("2026-11-13T00-00-00-000Z");
  expect(runIdFromCaches(["2026-11-12T01:44:04.047Z"])).toBe(
    "2026-11-12T01-44-04-047Z",
  );
});

test("run ID and reference date refuse anything but an ISO time", () => {
  expect(() => runIdFromCaches([])).toThrow(/no cache times/);
  expect(() =>
    runIdFromCaches(["2026-11-12T01:44:04.047Z", "2026-11-12 14:00"]),
  ).toThrow(/not an ISO time/);
  expect(() => referenceDateOf("12 Nov 2026")).toThrow(/not an ISO time/);
});

test("the reference date is the permit cache's date, never the build date", () => {
  expect(referenceDateOf("2026-11-12T13:14:56.570Z")).toBe("2026-11-12");
  expect(readFileSync("src/build-outputs.ts", "utf8")).toMatch(
    /referenceDateOf\(permitCache\.summary\.generated_at\)/,
  );
});

test("the permits config names the catalog's City of LA datasets and the contractor view", () => {
  const cfg = loadRunConfig("config/la-county-permits-run.json");
  const catalog = parse(readFileSync(cfg.sources_catalog, "utf8")) as {
    permits: {
      jurisdictions: Array<{ jurisdiction: string; datasets?: string[] }>;
    };
  };
  const la = catalog.permits.jurisdictions.find(
    (j) => j.jurisdiction === "Los Angeles",
  )!;
  expect(cfg.permit_sources!.permits.datasets).toEqual(la.datasets);
  expect(cfg.permit_sources!.contractors.datasets).toEqual(["8guu-8f5m"]);
  expect(cfg).toMatchObject({
    permits_harvested: true,
    permit_jurisdictions: ["Los Angeles"],
    input: "roll-cache",
    jurisdiction: "all",
    zips: [],
  });
});
