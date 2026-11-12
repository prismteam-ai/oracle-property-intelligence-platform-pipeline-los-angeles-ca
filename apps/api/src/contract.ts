/**
 * Public API contract: response shapes and limits. Self-contained on purpose (no imports), so the
 * AppRouter type that clients compile against does not drag server dependencies along.
 */
export const API_VERSION = "1";
/** Most map points returned by parcels.points before it truncates. */
export const MAX_POINTS = 25_000;
/** Serialized-size guard for any response (Lambda sync limit is 6 MB). */
export const MAX_RESPONSE_BYTES = 3_000_000;
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

export interface MetaInfo {
  api_version: string;
  run_id: string;
  parquet_sha256: string;
  sha256_verified: boolean;
  views: string[];
  macros: string[];
}

export interface RunSummary {
  run: Record<string, unknown>;
  history: Array<Record<string, unknown>>;
}

export interface SourceRow {
  source_name: string;
  record_count: number;
  page_count: number;
  first_retrieved_at: string;
  last_retrieved_at: string;
  role: string | null;
  hub_page: string | null;
  query_url: string | null;
  terms_of_use: string | null;
  access: string | null;
}
export interface SourcePageRow {
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

export interface RecordRow {
  parcel_id: string;
  address: string | null;
  year_built: number | null;
  source_name: string;
  source_request_url: string;
  source_retrieved_at: string;
  source_page_sha256: string;
  source_page_file: string;
}
export interface Records {
  total: number;
  items: RecordRow[];
  next_after: string | null;
}

export interface SearchItem {
  parcel_id: string;
  address: string | null;
  year_built: number;
  roof_age_years_proxy: number;
  distance_miles: number;
  latitude: number;
  longitude: number;
}
export interface SearchResult {
  count: number;
  rule: RoofAgeRuleOut;
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
  truncated: boolean;
  max_points: number;
}

export interface ParcelDetail {
  property: Record<string, unknown>;
  provenance: Record<string, unknown>;
}
