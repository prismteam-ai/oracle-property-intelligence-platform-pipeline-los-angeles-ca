/**
 * coverage.json and schema.json of a run's publishable directory. Both are pure functions of the
 * recorded run manifest and the Parquet column lists: no build time, no paths, so rebuilding gives the
 * same bytes and the same CID.
 *
 * coverage.json holds counts only (the run manifest's row_counts, coverage, permits and delta), the
 * sources with their terms and attribution, and the run's limitations as recorded. No request URL list,
 * no file path, no row.
 */

type Source = {
  name?: string;
  role?: string;
  hub_page?: string;
  datasets?: string[];
  terms_of_use?: string;
  license?: string;
  attribution?: string;
};

export type RunManifestLike = {
  run_id: string;
  run_name?: string;
  county?: string;
  state?: string;
  fips?: string;
  roll_year?: string;
  scope?: Record<string, unknown>;
  sources?: Source[];
  row_counts?: unknown;
  coverage?: unknown;
  permits?: unknown;
  delta?: unknown;
  derived_field_reference_date?: string;
  limitations?: string[];
  permit_caches?: { contractors?: { exact_duplicate_rows?: number } };
};

const COUNTY_ATTRIBUTION =
  "Los Angeles County Office of the Assessor, Assessor Parcel Data Roll 2026 (LA County eGIS hub)";

function attributionFor(
  s: Source,
  m: RunManifestLike,
): Record<string, unknown> {
  const isCounty = !s.datasets;
  const contractorView = s.datasets?.includes("8guu-8f5m") ?? false;
  const out: Record<string, unknown> = {
    source: s.name ?? null,
    attribution: s.attribution ?? (isCounty ? COUNTY_ATTRIBUTION : null),
    terms_of_use: s.terms_of_use ?? null,
    license:
      s.license ??
      (isCounty
        ? "none stated; the terms describe the data as for informational purposes, and republication rights are unverified (docs/los-angeles-county-findings.md, section 7)"
        : null),
  };
  if (s.datasets) out.datasets = s.datasets;
  if (s.hub_page) out.hub_page = s.hub_page;
  if (contractorView) {
    const dups = m.permit_caches?.contractors?.exact_duplicate_rows;
    out.changes_made =
      "This file holds counts only, no rows. The counts are taken after the build's changes: " +
      (typeof dups === "number"
        ? `${dups} exact duplicate rows dropped; `
        : "") +
      "license classes normalized to the CSLB form (unknown values counted as unmapped).";
  }
  return out;
}

export function buildCoverage(m: RunManifestLike, runManifestSha256: string) {
  const out: Record<string, unknown> = {
    coverage_version: 1,
    run_id: m.run_id,
    run_name: m.run_name ?? null,
    county: m.county ?? null,
    state: m.state ?? null,
    fips: m.fips ?? null,
    roll_year: m.roll_year ?? null,
    content:
      "counts only: no rows, no addresses, no person or business names, no file paths",
    scope: m.scope ?? null,
    derived_field_reference_date: m.derived_field_reference_date ?? null,
    row_counts: m.row_counts ?? null,
    coverage: m.coverage ?? null,
  };
  if (m.permits !== undefined) out.permits = m.permits;
  out.delta = m.delta ?? null;
  out.attribution = (m.sources ?? []).map((s) => attributionFor(s, m));
  out.limitations = m.limitations ?? [];
  out.run_manifest_sha256 = runManifestSha256;
  return out;
}

/**
 * Lexicon labels, from docs/los-angeles-county-findings.md section 12 (bundled kit catalog,
 * use-neutral-lexicon model-c; not the live Elephant lexicon).
 */
const PROPERTY_LEXICON = new Set([
  "parcel_identifier",
  "property_structure_built_year",
  "property_effective_built_year",
  "unnormalized_address",
  "street_number",
  "street_pre_directional_text",
  "street_name",
  "unit_identifier",
  "city_name",
  "postal_code",
  "plus_four_postal_code",
  "county_name",
  "state_code",
  "latitude",
  "longitude",
]);
const TABLE_LEXICON: Record<string, Set<string>> = {
  property: PROPERTY_LEXICON,
  permit: new Set([
    "permit_number",
    "application_received_date",
    "permit_issue_date",
    "unnormalized_address",
    "postal_code",
  ]),
  permit_parcel: new Set(["permit_number", "parcel_identifier"]),
  permit_contractor: new Set([
    "permit_number",
    "permit_issue_date",
    "license_identifier",
    "license_expiration_date",
    "city_name",
    "state_code",
    "is_owner_builder",
  ]),
};
/** Used by the Oracle runtime, absent from the bundled catalog (docs/los-angeles-county-findings.md section 12, "Not verified"). */
const NOT_VERIFIED = new Set(["request_identifier", "source_http_request"]);

export function tableKind(fileName: string): keyof typeof TABLE_LEXICON {
  if (fileName.includes("permit_contractors")) return "permit_contractor";
  if (fileName.includes("permit_parcels")) return "permit_parcel";
  if (fileName.includes("ladbs_permits")) return "permit";
  if (fileName.includes("property_roll")) return "property";
  throw new Error(`unknown table file: ${fileName}`);
}

export type ParquetTable = {
  file: string;
  columns: { name: string; type: string }[];
};

export function buildSchema(runId: string, tables: ParquetTable[]) {
  return {
    schema_version: 1,
    run_id: runId,
    lexicon_source:
      "bundled kit catalog (use-neutral-lexicon model-c at kit 71b8341), not the live Elephant lexicon; docs/los-angeles-county-findings.md, section 12",
    labels: {
      lexicon: "the column name is a field of the bundled lexicon",
      "not verified":
        "used by the Oracle runtime but absent from the bundled catalog",
      "not lexicon":
        "a source, provenance, rule or derived column; documented, not a lexicon field",
    },
    tables: [...tables]
      .sort((a, b) => (a.file < b.file ? -1 : 1))
      .map((t) => {
        const kind = tableKind(t.file);
        return {
          file: t.file,
          table: kind,
          published: false,
          columns: t.columns.map((c) => ({
            name: c.name,
            type: c.type,
            label: TABLE_LEXICON[kind].has(c.name)
              ? "lexicon"
              : NOT_VERIFIED.has(c.name)
                ? "not verified"
                : "not lexicon",
          })),
        };
      }),
  };
}
