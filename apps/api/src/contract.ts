/**
 * Public API contract: response shapes and limits. Self-contained on purpose (no imports), so the
 * AppRouter type that clients compile against does not drag server dependencies along.
 */
export const API_VERSION = "1";
/*
 * Fields added with the rebuild run (ownership, land_base_year, long_open on match, the contractor identity,
 * SourceRow.coverage) are optional in these types only: the API always sends them (null where there is none).
 * Optional so that clients and test fakes written for the earlier shapes keep compiling until they adopt them.
 */
/** Most map points returned by parcels.points before it truncates. */
export const MAX_POINTS = 25_000;
/**
 * Most parcel IDs per parcels.match call. A GET with this many IDs and the longest input (the filter values,
 * the ownership basis, the long-open toggle and window) stays at or under 1,800 characters, under the shared
 * client's maxURLLength (2,000 characters, packages/api-client), which is far below the HTTP API limit of
 * 10,240 bytes for the request line and headers together (test: apps/api/test/match-url.test.ts).
 */
export const MAX_MATCH_IDS = 72;
/** Longest place name places.resolve accepts (characters). */
export const MAX_PLACE_NAME_LENGTH = 100;
/** Serialized-size guard for any response (Lambda sync limit is 6 MB). */
export const MAX_RESPONSE_BYTES = 3_000_000;
/** Default minimum open duration of a long-open permit, in days: 5 years x 365.25, rounded. */
export const DEFAULT_MIN_OPEN_DAYS = 1_826;
/** Largest open duration accepted as a minimum or maximum, in days (100 years). */
export const MAX_OPEN_DAYS = 36_525;
/** Bounding box accepted for search centres (LA County with a margin). */
export const LA_BOUNDS = {
  minLat: 33.2,
  maxLat: 34.9,
  minLon: -119.0,
  maxLon: -117.6,
} as const;

export interface RoofAgeRuleOut {
  roll_year: number;
  threshold_years: number;
  built_before_year: number;
  text: string;
}

/**
 * A parcel's roof-age basis, as stored (roof_age_basis): the year-built PROXY label, or the PERMIT label
 * where a finaled roofing permit sets the effective roof year. Clients may test the first word.
 */
export const ROOF_AGE_BASIS = {
  proxy:
    "PROXY: assessor year built / effective year built; not a roof installation date",
  permit:
    "PERMIT: latest finaled LADBS roofing permit (status date); a roof coating alone does not count",
} as const;
export type RoofAgeBasis = (typeof ROOF_AGE_BASIS)[keyof typeof ROOF_AGE_BASIS];

/**
 * The ownership filter's bases (parcels.search, points and match): "recording" = no recorded document in the
 * 10 years before the run's reference date (owner_unchanged_10y_proxy); "base_year" = no reassessment in those
 * 10 years by the roll's land base year (ownership_base_year_10y_proxy); "both" = the two. Without a basis
 * there is no ownership filter.
 */
export type OwnershipBasis = "recording" | "base_year" | "both";
/**
 * What each basis means and its weakness, in plain words. Literal-typed: the Explorer and the CRM type their
 * copies of these texts against them, so a different wording fails their typecheck.
 */
export const OWNERSHIP_BASIS = {
  recording: {
    text: "Owner unchanged for 10 years or more, by recorded documents: no document recorded on the parcel in the 10 years before the run's reference date.",
    weakness:
      "Any recorded document resets it, not only a sale: a refinance or a lien drops a long-time owner.",
  },
  base_year: {
    text: "Owner unchanged for 10 years or more, by reassessment: the parcel's land base year is 10 or more years before the run's reference date (no reassessment since).",
    weakness:
      "Transfers that do not reassess escape it: a transfer between spouses or from parent to child keeps the old base year, so a new owner can pass.",
  },
  both: {
    text: "Owner unchanged for 10 years or more, by both: no recorded document and no reassessment in the 10 years before the run's reference date.",
    weakness:
      "The strictest of the three: a parcel must pass both, so a refinance or a lien still drops a long-time owner, and the fewest parcels pass.",
  },
} as const;
/** Stated with every basis: what all three are. */
export const OWNERSHIP_PROXY_NOTE =
  "All three bases are proxies from the County assessor roll, not sales records: neither date is a sale date.";
/** The ownership filter a result applied: its basis, text, weakness and the proxy note (from the constants above). */
export type OwnershipRuleOut = {
  [B in OwnershipBasis]: {
    basis: B;
    text: (typeof OWNERSHIP_BASIS)[B]["text"];
    weakness: (typeof OWNERSHIP_BASIS)[B]["weakness"];
    proxy_note: typeof OWNERSHIP_PROXY_NOTE;
  };
}[OwnershipBasis];

/** The long-open rule a permits.longOpen response applies (durations in days). */
export interface LongOpenRuleOut {
  /** The run's reference date (YYYY-MM-DD): open_days counts to it. */
  reference_date: string;
  /** The only status class counted as open. */
  status_class: "open-issued";
  min_open_days: number;
  /** null: no maximum. */
  max_open_days: number | null;
  /** The roof-age filter, when threshold_years was given; null otherwise. */
  roof_age: RoofAgeRuleOut | null;
  text: string;
}

export interface MetaInfo {
  api_version: string;
  run_id: string;
  parquet_sha256: string;
  /** The permit Parquet files' sha256, verified at load like parquet_sha256. */
  permit_files: Array<{ role: string; sha256: string }>;
  /** The run's reference date (YYYY-MM-DD). */
  reference_date: string;
  sha256_verified: boolean;
  views: string[];
  macros: string[];
}

/** How a run relates to the previous one (v_run and v_run_history); null on runs recorded before these fields. */
export interface RunRelation {
  /** "rebuild": every input cache equals the previous run's; "new data" otherwise; null: not recorded. */
  run_kind: "rebuild" | "new data" | null;
  /** The previous run's ID for a rebuild, else null. */
  rebuild_of: string | null;
  /** "none" for a rebuild, else null. */
  source_changes: "none" | null;
}
/** run: v_run (the run manifest's fields, with RunRelation's); history: v_run_history, one row per run. */
export interface RunSummary {
  run: Record<string, unknown>;
  history: Array<Record<string, unknown>>;
}

/** A source's window in the data: the first and last value of one field (dates YYYY-MM-DD). */
export interface SourceCoverage {
  field: string;
  first: string;
  last: string;
}

/** What a source's records are: parcels (the roll), LADBS permits, or LADBS contractor rows. */
export type SourceKind = "parcel" | "permit" | "contractor";

export interface SourceRow {
  source_kind: SourceKind;
  source_name: string;
  record_count: number;
  page_count: number;
  first_retrieved_at: string;
  last_retrieved_at: string;
  role: string | null;
  hub_page: string | null;
  /** The roll's query URL; null for the LADBS sources, which list query_urls. */
  query_url: string | null;
  query_urls: string[] | null;
  terms_of_use: string | null;
  /** The LADBS sources' license and attribution as recorded in the run manifest; null for the roll. */
  license: string | null;
  attribution: string | null;
  access: string | null;
  /** The contractor view's permit_issue_date window; null for the roll and the permit datasets. */
  coverage?: SourceCoverage | null;
}
export interface SourcePageRow {
  source_kind: SourceKind;
  source_name: string;
  source_page_file: string;
  source_request_url: string;
  source_retrieved_at: string;
  source_page_sha256: string;
  record_count: number;
}
export interface Sources {
  sources: SourceRow[];
  pages: SourcePageRow[];
}

/** Where one record came from (every record row carries it). */
export interface RecordProvenance {
  source_name: string;
  source_request_url: string;
  source_retrieved_at: string;
  source_page_sha256: string;
  source_page_file: string;
}
/** A roll record. record_key is its parcel ID, the cursor for `after`. */
export interface ParcelRecordRow extends RecordProvenance {
  kind: "parcel";
  record_key: string;
  parcel_id: string;
  address: string | null;
  year_built: number | null;
}
/** A permit record. record_key is its permit number; address is the permit's own address. */
export interface PermitRecordRow extends RecordProvenance {
  kind: "permit";
  record_key: string;
  parcel_id: null;
  address: string | null;
  year_built: null;
  permit_number: string;
  source_status_desc: string | null;
  permit_status_class: PermitStatusClass;
  permit_issue_date: string | null;
  join_method: JoinMethod | null;
  /** Parcels the permit links (0 when unjoined). */
  parcel_count: number;
}
/** A contractor record. record_key is "<permit_number>:<contractor_row>". */
export interface ContractorRecordRow extends RecordProvenance {
  kind: "contractor";
  record_key: string;
  parcel_id: null;
  address: null;
  year_built: null;
  permit_number: string;
  contractor_row: number;
  contractors_business_name: string | null;
  license_identifier: string | null;
  source_license_type: string | null;
  license_class: string | null;
  license_class_note: string | null;
  is_owner_builder: boolean | null;
  contractor_identity_key?: ContractorIdentity["contractor_identity_key"];
  canonical_business_name?: ContractorIdentity["canonical_business_name"];
  name_variant_count?: ContractorIdentity["name_variant_count"];
  identity_permit_count?: ContractorIdentity["identity_permit_count"];
}
export type RecordRow = ParcelRecordRow | PermitRecordRow | ContractorRecordRow;
export interface Records {
  /** The kind of the requested source; null when no source has that name. */
  source_kind: SourceKind | null;
  total: number;
  items: RecordRow[];
  /** The record_key to pass as `after` for the next page; null on the last page. */
  next_after: string | null;
}

/**
 * A contractor row's identity: one per license number (not verified against CSLB). All null on a row
 * without a license number; such rows are never merged.
 */
export interface ContractorIdentity {
  /** The row's license number, trimmed; null without one. */
  contractor_identity_key?: string | null;
  /** The license's latest non-null business name; null when no row of the license has a name (never guessed). */
  canonical_business_name?: string | null;
  /** How many distinct names the license carries (counted, never listed); 0 when none. */
  name_variant_count?: number | null;
  /** How many distinct permits the license is on. */
  identity_permit_count?: number | null;
}

export interface SearchItem {
  parcel_id: string;
  address: string | null;
  /** null where only a permit gives the parcel a roof year. */
  year_built: number | null;
  /** Roll year minus year built (the year-built proxy); null without a year built. */
  roof_age_years_proxy: number | null;
  /** The year roof age counts from (see the rule text). */
  effective_roof_year: number;
  /** Roll year minus effective roof year: the age the filter uses. */
  roof_age_years: number;
  roof_age_basis: RoofAgeBasis;
  /** The finaled roofing permit that set the roof year (PERMIT basis); null otherwise. */
  roof_year_permit_number: string | null;
  /** Whether the parcel is in the City of Los Angeles, the only jurisdiction with permit data. */
  permit_data_available: boolean;
  /** The roll's land base year (a fiscal-year label); null where the roll has 0 or an out-of-range year. */
  land_base_year?: number | null;
  distance_miles: number;
  latitude: number;
  longitude: number;
}
export interface SearchResult {
  count: number;
  rule: RoofAgeRuleOut;
  /** The ownership filter applied; null: none. */
  ownership?: OwnershipRuleOut | null;
  items: SearchItem[];
  next_offset: number | null;
}

export interface PointsResult {
  count: number;
  encoding: "columnar-v1";
  precision: 5;
  id: string[];
  lat: number[];
  lon: number[];
  /** Per point: 1 if the parcel is in the City of Los Angeles (has permit data), else 0. */
  permit_data_available: Array<0 | 1>;
  /**
   * Per point: 1 if the parcel has a long-open permit under long_open (a building-level permit marks every
   * unit it links), else 0.
   */
  long_open_permit: Array<0 | 1>;
  /** The open-duration window long_open_permit uses, in days. */
  long_open: LongOpenWindow;
  /** The ownership filter applied; null: none. */
  ownership?: OwnershipRuleOut | null;
  truncated: boolean;
  max_points: number;
}

/** An open-duration window in days; max_open_days null: no maximum. */
export interface LongOpenWindow {
  min_open_days: number;
  max_open_days: number | null;
}

/**
 * parcels.match: the given parcel IDs that pass, sorted, without duplicates: the search filter (when given)
 * and, with long_open_permit, a long-open roofing permit under the window (the map's rule).
 */
export interface MatchResult {
  parcel_ids: string[];
  /** The long-open window applied; null when long_open_permit was off. */
  long_open?: LongOpenWindow | null;
  /** The ownership filter applied; null: none. */
  ownership?: OwnershipRuleOut | null;
}

/** Permit status classes (closed covers finaled, expired and closed permits). */
export type PermitStatusClass =
  "open-issued" | "open-application" | "closed" | "unclear" | "unmapped";
/** How a permit was joined to its parcels; null: not joined. */
export type JoinMethod = "direct" | "address" | "condo-building";

/**
 * A permit's fields as served by the permits routes: the stored column names, except address (the stored
 * address column, named as the parcel's address is); dates YYYY-MM-DD.
 */
export interface PermitFields {
  permit_number: string;
  /** The permit's own address as LADBS records it. */
  address: string | null;
  postal_code: string | null;
  source_permit_type: string | null;
  source_permit_sub_type: string | null;
  /** LADBS's status as recorded. */
  source_status_desc: string | null;
  permit_status_class: PermitStatusClass;
  application_received_date: string | null;
  permit_issue_date: string | null;
  status_date: string | null;
  /** Issue date for open-issued, submitted date for open-application; null otherwise. */
  open_since: string | null;
  /** Days from open_since to the run's reference date; null when not open or no such date. */
  open_days: number | null;
  /** The roofing flag: the permit is roofing work. */
  roofing_work: boolean;
  /** Roofing work only through the roof-coating phrase (never sets the roof year). */
  roof_coating_only: boolean;
  join_method: JoinMethod | null;
  /** A condominium building's permit, linked to every unit of the building. */
  building_level: boolean;
  /** How many parcels the permit links. */
  parcel_count: number;
}

/** A long-open permit at its nearest qualifying parcel. */
export interface LongOpenItem extends PermitFields {
  /** The parcel (AIN) the item is counted at: for a building-level permit, its nearest unit. */
  parcel_id: string;
  distance_miles: number;
  /** That parcel's effective roof year; null when it has none. */
  effective_roof_year: number | null;
  roof_age_basis: RoofAgeBasis;
  roof_year_permit_number: string | null;
}
export interface LongOpenResult {
  count: number;
  rule: LongOpenRuleOut;
  items: LongOpenItem[];
  next_offset: number | null;
}

/** A contractor row of a permit (LADBS contractor view), under the stored column names. */
export interface PermitContractor extends ContractorIdentity {
  contractors_business_name: string | null;
  license_identifier: string | null;
  /** The license type as printed on the permit. */
  source_license_type: string | null;
  /** Normalized to the CSLB form (e.g. C-39); null when none. */
  license_class: string | null;
  /** owner-builder, certification or unmapped; null otherwise. */
  license_class_note: string | null;
  is_owner_builder: boolean | null;
  license_expiration_date: string | null;
  city_name: string | null;
  state_code: string | null;
}
export interface ParcelPermit extends PermitFields {
  contractors: PermitContractor[];
}
export interface ParcelPermits {
  parcel_id: string;
  /** false outside the City of Los Angeles: no permit source covers the parcel's jurisdiction. */
  permit_data_available: boolean;
  /** The parcel's tax-rate-area city. */
  jurisdiction: string | null;
  effective_roof_year: number | null;
  roof_age_basis: RoofAgeBasis;
  roof_year_permit_number: string | null;
  /** Newest first (issue date, else submitted date), then by permit number. */
  permits: ParcelPermit[];
  bbb: { available: false; reason: string };
}

export interface ParcelDetail {
  property: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

/** places.resolve: which column a place name matched (the tax-rate-area city, or the postal city). */
export type PlaceBasis = "jurisdiction" | "postal_city";
export interface PlaceCandidate {
  basis: PlaceBasis;
  center: { lat: number; lon: number };
  /** Matched parcels with coordinates (the median's population). */
  parcel_count: number;
  /** The stored spellings pooled under the key. */
  raw_values: string[];
  /** 90th-percentile distance of those parcels from the center, miles. */
  spread_miles: number;
}
/** A resolved place: one candidate's fields plus how it was chosen. */
export type ResolvedPlace = {
  status: "resolved";
  name: string;
  center_reliable: boolean;
  /** The other basis, when both matched within 2 miles (the jurisdiction center is used). */
  also_matched: PlaceCandidate | null;
} & PlaceCandidate;
/** Two candidates too far apart: no center is chosen. */
export interface AmbiguousPlace {
  status: "ambiguous";
  name: string;
  candidates: PlaceCandidate[];
}
/** A place name resolved against the run's own parcels: resolved, ambiguous or unknown (never a guess). */
export type PlaceResolution =
  | (ResolvedPlace & { note: string })
  | (AmbiguousPlace & { note: string })
  | { status: "unknown"; name: string; note: string };
