import { createHash } from "node:crypto";
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
  license: string;
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
 * The time part <T> of a run ID: the latest of the caches' summary generated_at times, with ":"
 * and "." replaced (as for one cache).
 */
export function runTimeFromCaches(generatedAts: string[]): string {
  if (generatedAts.length === 0) throw new Error("no cache times");
  for (const t of generatedAts)
    if (!ISO_MS.test(t))
      throw new Error(`cache generated_at "${t}" is not an ISO time`);
  return [...generatedAts].sort().at(-1)!.replace(/[:.]/g, "-");
}

/**
 * A run ID: <T> alone (runs recorded before the build digest) or <T>-b<D>, D the first 12 hex
 * characters of the build digest. Letters, digits and "-" only, so it is safe as a path segment and
 * an S3 key.
 */
export const RUN_ID_PATTERN =
  /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z(-b[0-9a-f]{12})?$/;

/** Stands for the run ID in the manifest text the build digest hashes (the ID depends on it). */
export const RUN_ID_PLACEHOLDER = "@RUN_ID@";

/** Manifest keys left out of the build digest: the clock time and the digest itself. */
export const UNHASHED_MANIFEST_KEYS = ["generated_at", "build_digest"] as const;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * sha256 of a run manifest as the build digest sees it: the recorded manifest (paths under
 * data/out/<ID>/ and runs/<ID>/, also in a dry run) without generated_at and build_digest, written
 * as the build writes it, with every occurrence of the run ID replaced by RUN_ID_PLACEHOLDER.
 */
export function manifestDigestSha256(
  manifest: Record<string, unknown>,
  runId: string,
): string {
  const kept = Object.fromEntries(
    Object.entries(manifest).filter(
      ([k]) => !(UNHASHED_MANIFEST_KEYS as readonly string[]).includes(k),
    ),
  );
  return sha256(
    (JSON.stringify(kept, null, 2) + "\n")
      .split(runId)
      .join(RUN_ID_PLACEHOLDER),
  );
}

/** One data file a build writes: its role and sha256. */
export interface BuildOutput {
  role: string;
  sha256: string;
}

/**
 * The build digest: sha256 over the sorted lines "output <role> <sha256>" (the property Parquet and
 * the permit Parquets) and "manifest <sha256>" (manifestDigestSha256). The manifest lists every
 * input cache file's sha256, so the inputs are covered through it.
 */
export function buildDigest(
  outputs: BuildOutput[],
  manifestSha256: string,
): string {
  const roles = outputs.map((o) => o.role);
  if (new Set(roles).size !== roles.length)
    throw new Error(`an output role appears twice: ${roles.join(", ")}`);
  for (const h of [manifestSha256, ...outputs.map((o) => o.sha256)])
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`not a sha256: ${h}`);
  const lines = [
    ...outputs.map((o) => `output ${o.role} ${o.sha256}`),
    `manifest ${manifestSha256}`,
  ].sort();
  return sha256(lines.join("\n") + "\n");
}

/** A run ID from its time part and the build digest: <T>-b<first 12 hex of the digest>. */
export function runIdOf(runTime: string, digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest))
    throw new Error(`not a build digest: ${digest}`);
  const id = `${runTime}-b${digest.slice(0, 12)}`;
  if (!RUN_ID_PATTERN.test(id)) throw new Error(`not a run ID: ${id}`);
  return id;
}

/** True when path lies inside dir (compared with a trailing "/", so run ID prefixes never match). */
export function isUnder(path: string, dir: string): boolean {
  return path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/** Reference date (YYYY-MM-DD) for every derived duration: the date of the permit cache's generated_at. */
export function referenceDateOf(generatedAt: string): string {
  if (!ISO_MS.test(generatedAt))
    throw new Error(`cache generated_at "${generatedAt}" is not an ISO time`);
  return generatedAt.slice(0, 10);
}
