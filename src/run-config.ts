import { readFileSync } from "node:fs";

export interface RunScope {
  jurisdiction: string;
  zips: string[];
  roll_year: string;
  permits_harvested: boolean;
  /** Jurisdictions whose permits the run builds (absent or empty: none). */
  permit_jurisdictions?: string[];
}

/** One permit source of a run (config permit_sources). */
export interface PermitSource {
  name: string;
  /** data.lacity.org dataset or view IDs the cache must hold, exactly. */
  datasets: string[];
  terms_of_use: string;
  licence: string;
  attribution: string;
}

export interface RunConfig extends RunScope {
  /** "roll-cache": build from the whole-roll cache (src/stage-cache.ts); default: the pilot's raw pages. */
  input?: "raw-pages" | "roll-cache";
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
  /** Permit runs: the LADBS permit datasets and the contractor view. */
  permit_sources?: { permits: PermitSource; contractors: PermitSource };
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

const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/**
 * Run ID of a build from several caches: the latest of their summary generated_at times, with ":"
 * and "." replaced (as for one cache).
 */
export function runIdFromCaches(generatedAts: string[]): string {
  if (generatedAts.length === 0) throw new Error("no cache times");
  for (const t of generatedAts)
    if (!ISO_MS.test(t))
      throw new Error(`cache generated_at "${t}" is not an ISO time`);
  return [...generatedAts].sort().at(-1)!.replace(/[:.]/g, "-");
}

/** Reference date (YYYY-MM-DD) for every derived duration: the date of the permit cache's generated_at. */
export function referenceDateOf(generatedAt: string): string {
  if (!ISO_MS.test(generatedAt))
    throw new Error(`cache generated_at "${generatedAt}" is not an ISO time`);
  return generatedAt.slice(0, 10);
}
