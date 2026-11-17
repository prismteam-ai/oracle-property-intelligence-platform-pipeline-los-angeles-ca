/**
 * coverage.json of a run's publish folder: a pure function of the recorded run manifest, the run config
 * and the permits Parquet's row count. No build time, no path, no row: rebuilding gives the same bytes
 * and the same CID.
 *
 * It holds only, in this key order:
 *   run_id, generated_at        the run manifest's own values
 *   run_kind, rebuild_of        exactly as the run manifest records them (null stays null)
 *   county, roll_year           the run manifest's values
 *   parcels                     { total, with_coordinates, with_year_built }: the manifest's
 *                               row_counts.parquet, coverage.with_coordinates, coverage.with_year_built
 *   permits                     the permits Parquet's row count
 *   sample                      the published 5-mile sample: { center_latitude, center_longitude,
 *                               radius_miles, rows }, from publish-named-objects.ts PUBLISHED_SAMPLE
 *                               (its recorded build's center and radius; rows checked against the
 *                               sample Parquet by the build)
 *   sources                     the County Assessor roll, then the City of Los Angeles building permits,
 *                               each { name, download_finished_at, pages_sha256, terms_of_use }:
 *                               terms_of_use is the source's terms-of-use address as the run config
 *                               records it (roll: source.terms_of_use; permits:
 *                               permit_sources.permits.terms_of_use)
 *
 * download_finished_at: the generated_at of the download's own summary as the run manifest records it
 * (roll: cache.summary.generated_at; permits: permit_caches.permits.generated_at). Each download tool
 * writes it after its last page; it is checked to be no earlier than the last recorded page time.
 *
 * pages_sha256: SHA-256 over the digests of the source's downloaded pages as the run manifest records
 * them, in recorded order (roll: cache.pages[].body_sha256; permits: permit_caches.permits.pages[]
 * .json_sha256, the digest of each response body as downloaded). Byte form: each digest as 64 lowercase
 * hex characters followed by one line feed (0x0a), concatenated in recorded order, ASCII; e.g. two pages
 * hash the 130 bytes "<digest 1>\n<digest 2>\n".
 *
 * A value missing from the recorded files, or recorded files that disagree, stop the build with an
 * error naming it; nothing is filled in.
 */
import { createHash } from "node:crypto";
import type { SampleSpec } from "./publish-named-objects.ts";
import type { RunConfig } from "./run-config.ts";

type RecordedSource = {
  name?: unknown;
  datasets?: unknown;
  terms_of_use?: unknown;
};
type RecordedPage = Record<string, unknown>;

/** The parts of a recorded run manifest that coverage.json reads. */
export type RunManifestLike = {
  run_id: string;
  generated_at?: unknown;
  run_kind?: unknown;
  rebuild_of?: unknown;
  county?: unknown;
  roll_year?: unknown;
  sources?: RecordedSource[];
  cache?: { summary?: { generated_at?: unknown }; pages?: RecordedPage[] };
  permit_caches?: {
    permits?: { generated_at?: unknown; pages?: RecordedPage[] };
  };
  row_counts?: { parquet?: unknown };
  coverage?: { with_coordinates?: unknown; with_year_built?: unknown };
};

export type CoverageSource = {
  name: string;
  download_finished_at: string;
  pages_sha256: string;
  terms_of_use: string;
};

export type Coverage = {
  run_id: string;
  generated_at: string;
  run_kind: string | null;
  rebuild_of: string | null;
  county: string;
  roll_year: string;
  parcels: { total: number; with_coordinates: number; with_year_built: number };
  permits: number;
  sample: {
    center_latitude: number;
    center_longitude: number;
    radius_miles: number;
    rows: number;
  };
  sources: [CoverageSource, CoverageSource];
};

export class NotRecorded extends Error {}

const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || !v)
    throw new NotRecorded(`${what} is not recorded`);
  return v;
}
function iso(v: unknown, what: string): string {
  const s = str(v, what);
  if (!ISO.test(s)) throw new NotRecorded(`${what} is not an ISO time: ${s}`);
  return s;
}
function count(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new NotRecorded(`${what} is not recorded as a count`);
  return v;
}
function nullableStr(m: object, key: string): string | null {
  if (!Object.hasOwn(m, key))
    throw new NotRecorded(`${key} is not recorded in the run manifest`);
  const v = (m as Record<string, unknown>)[key];
  if (v === null || (typeof v === "string" && v)) return v;
  throw new NotRecorded(`${key} is neither a string nor null`);
}

/** SHA-256 over the ordered digests, each as lowercase hex plus "\n" (the byte form above). */
export function pagesSha256(digests: string[]): string {
  if (!digests.length) throw new NotRecorded("no page digests are recorded");
  for (const d of digests)
    if (!HEX64.test(d))
      throw new NotRecorded(`a page digest is not 64 lowercase hex: ${d}`);
  return createHash("sha256")
    .update(digests.map((d) => `${d}\n`).join(""), "ascii")
    .digest("hex");
}

function downloadedSource(
  name: string,
  finishedAt: unknown,
  pages: RecordedPage[] | undefined,
  digestKey: string,
  timeKey: string,
  what: string,
): Omit<CoverageSource, "terms_of_use"> {
  const finished = iso(finishedAt, `${what} download summary generated_at`);
  if (!Array.isArray(pages) || !pages.length)
    throw new NotRecorded(`${what} pages are not recorded`);
  const times = pages.map((p, i) =>
    iso(p[timeKey], `${what} page ${i} ${timeKey}`),
  );
  const last = times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  if (Date.parse(finished) < Date.parse(last))
    throw new NotRecorded(
      `${what} download summary (${finished}) is earlier than its last page (${last})`,
    );
  return {
    name,
    download_finished_at: finished,
    pages_sha256: pagesSha256(
      pages.map((p, i) => str(p[digestKey], `${what} page ${i} ${digestKey}`)),
    ),
  };
}

export function buildCoverage(
  m: RunManifestLike,
  config: RunConfig,
  permitParquetRows: number,
  sample: SampleSpec,
): Coverage {
  const county = str(m.county, "county");
  const rollYear = str(m.roll_year, "roll_year");
  if (config.county !== county || config.roll_year !== rollYear)
    throw new NotRecorded(
      `the run config (${config.county}, ${config.roll_year}) is not this run's (${county}, ${rollYear})`,
    );
  const recorded = (name: string) => {
    const hits = (m.sources ?? []).filter((s) => s.name === name);
    if (hits.length !== 1)
      throw new NotRecorded(
        `the run manifest records ${hits.length} sources named "${name}"`,
      );
    return hits[0];
  };
  const rollName = str(config.source?.name, "run config source.name");
  const rollRecorded = recorded(rollName);
  const termsOfUse = str(
    config.source?.terms_of_use,
    "run config source.terms_of_use",
  );
  if (
    rollRecorded.terms_of_use !== undefined &&
    rollRecorded.terms_of_use !== termsOfUse
  )
    throw new NotRecorded(
      "the roll's terms_of_use differs between the run config and the run manifest",
    );
  const permitsConfig = config.permit_sources?.permits;
  if (!permitsConfig)
    throw new NotRecorded("the run config has no permit_sources.permits");
  const permitsRecorded = recorded(permitsConfig.name);
  if (
    JSON.stringify(permitsRecorded.datasets) !==
    JSON.stringify(permitsConfig.datasets)
  )
    throw new NotRecorded(
      "the permit datasets differ between the run config and the run manifest",
    );

  const permitsTerms = str(
    permitsConfig.terms_of_use,
    "run config permit_sources.permits.terms_of_use",
  );
  if (
    permitsRecorded.terms_of_use !== undefined &&
    permitsRecorded.terms_of_use !== permitsTerms
  )
    throw new NotRecorded(
      "the permits' terms_of_use differs between the run config and the run manifest",
    );

  const roll = downloadedSource(
    rollName,
    m.cache?.summary?.generated_at,
    m.cache?.pages,
    "body_sha256",
    "fetched_at",
    "roll",
  );
  const permits = downloadedSource(
    permitsConfig.name,
    m.permit_caches?.permits?.generated_at,
    m.permit_caches?.permits?.pages,
    "json_sha256",
    "retrieved_at",
    "permits",
  );
  return {
    run_id: str(m.run_id, "run_id"),
    generated_at: iso(m.generated_at, "generated_at"),
    run_kind: nullableStr(m, "run_kind"),
    rebuild_of: nullableStr(m, "rebuild_of"),
    county,
    roll_year: rollYear,
    parcels: {
      total: count(m.row_counts?.parquet, "row_counts.parquet"),
      with_coordinates: count(
        m.coverage?.with_coordinates,
        "coverage.with_coordinates",
      ),
      with_year_built: count(
        m.coverage?.with_year_built,
        "coverage.with_year_built",
      ),
    },
    permits: count(permitParquetRows, "the permits Parquet row count"),
    sample: {
      center_latitude: sample.center_latitude,
      center_longitude: sample.center_longitude,
      radius_miles: sample.radius_miles,
      rows: count(sample.rows, "the sample's row count"),
    },
    sources: [
      { ...roll, terms_of_use: termsOfUse },
      { ...permits, terms_of_use: permitsTerms },
    ],
  };
}
