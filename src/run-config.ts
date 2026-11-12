import { readFileSync } from "node:fs";

export interface RunScope {
  jurisdiction: string;
  zips: string[];
  roll_year: string;
  permits_harvested: boolean;
}

export interface RunConfig extends RunScope {
  run_name: string;
  county: string;
  state: string;
  increment: number;
  data: string;
  source: {
    name: string;
    hub_item_id: string;
    query_url: string;
    page_size: number;
    min_request_interval_ms: number;
  };
  sources_catalog: string;
}

export function loadRunConfig(path: string): RunConfig {
  return JSON.parse(readFileSync(path, "utf8")) as RunConfig;
}

/** The jurisdiction value of a county-wide run: every jurisdiction, no ZIP filter. */
export const ALL_JURISDICTIONS = "all";

export function isCountyWide(scope: RunScope): boolean {
  return scope.jurisdiction.trim().toLowerCase() === ALL_JURISDICTIONS;
}

/**
 * ArcGIS where clause for the run scope. A county-wide run filters on the roll year only (the
 * roll cache's own filter). Otherwise jurisdiction uses the tax-rate-area city (space-padded in
 * the source) and the ZIP set.
 */
export function whereClause(scope: RunScope): string {
  const rollYear = `RollYear = '${scope.roll_year.replace(/'/g, "")}'`;
  if (isCountyWide(scope)) {
    if (scope.zips.length > 0)
      throw new Error("a county-wide run has no ZIP filter");
    return rollYear;
  }
  const zips = scope.zips.map((z) => `'${z.replace(/'/g, "")}'`).join(",");
  const city = scope.jurisdiction.toUpperCase().replace(/'/g, "");
  return `SitusZIP5 IN (${zips}) AND TaxRateArea_CITY = '${city}' AND ${rollYear}`;
}
