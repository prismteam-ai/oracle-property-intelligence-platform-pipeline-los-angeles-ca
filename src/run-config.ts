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

/** ArcGIS where clause for the run scope. Jurisdiction uses the tax-rate-area city (space-padded in the source). */
export function whereClause(scope: RunScope): string {
  const zips = scope.zips.map((z) => `'${z.replace(/'/g, "")}'`).join(",");
  const city = scope.jurisdiction.toUpperCase().replace(/'/g, "");
  return `SitusZIP5 IN (${zips}) AND TaxRateArea_CITY = '${city}' AND RollYear = '${scope.roll_year.replace(/'/g, "")}'`;
}
