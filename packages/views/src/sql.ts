/**
 * The view contract. Apps and the CLI query only the oracle.v_* views and the
 * oracle.roof_age_candidates macro; only the oracle.src_* views name files or
 * Parquet columns. When the Parquet is replaced by Lexicon tables, only this file changes.
 */

/** SQL string literal. */
export const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export interface DataPaths {
  /** Property roll Parquet (one row per parcel). */
  propertyParquet: string;
  /** runs/<run_id>/run_manifest.json (optional; needed for v_run and v_source metadata). */
  runManifest?: string;
  /** runs/run_history.jsonl (optional; needed for v_run_history). */
  runHistory?: string;
}

/** Mean Earth radius in miles, as in increment 1 (src/query-radius.ts). */
export const EARTH_RADIUS_MILES = 3958.8;

export function propertyViewsSql(p: DataPaths): string {
  return `
create schema if not exists oracle;

create or replace view oracle.src_property_roll as
select * from read_parquet(${lit(p.propertyParquet)});

create or replace view oracle.v_property as
select
  parcel_identifier                         as parcel_id,
  assessor_id_formatted                     as assessor_id,
  unnormalized_address                      as address,
  street_number,
  street_pre_directional_text               as street_direction,
  street_name,
  unit_identifier                           as unit,
  city_name                                 as city,
  postal_code,
  plus_four_postal_code                     as plus_four,
  county_name                               as county,
  state_code                                as state,
  latitude,
  longitude,
  coordinate_basis,
  property_structure_built_year             as year_built,
  property_effective_built_year             as effective_year_built,
  roof_age_basis,
  source_use_type                           as use_type,
  source_use_code                           as use_code,
  source_use_code_description               as use_description,
  tax_rate_area_city                        as jurisdiction,
  try_cast(roll_year as integer)            as roll_year,
  last_recording_date,
  owner_unchanged_10y_proxy
from oracle.src_property_roll;

create or replace view oracle.v_property_provenance as
select
  parcel_identifier                         as parcel_id,
  source_name,
  source_http_request                       as source_request_url,
  source_http_method                        as source_request_method,
  strftime(timezone('UTC', source_retrieved_at), '%Y-%m-%dT%H:%M:%S.%gZ') as source_retrieved_at,
  source_page_sha256,
  source_page_file
from oracle.src_property_roll;

create or replace view oracle.v_source_page as
select source_name, source_page_file, source_request_url, source_retrieved_at, source_page_sha256,
       count(*) as record_count
from oracle.v_property_provenance
group by all
order by source_page_file;

-- Great-circle distance in miles (haversine), as in increment 1.
create or replace macro oracle.haversine_miles(lat1, lon1, lat2, lon2) as
  ${EARTH_RADIUS_MILES} * 2 * asin(sqrt(
      pow(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)));

-- Half-sizes in degrees of the bounding box around a circle (see roof_age_candidates). Internal helpers,
-- not part of CONTRACT.
create or replace macro oracle.box_dlat(radius_miles) as
  1.001 * degrees(radius_miles / ${EARTH_RADIUS_MILES});
create or replace macro oracle.box_dlon(center_lat, radius_miles) as
  case when sin(radius_miles / ${EARTH_RADIUS_MILES}) >= cos(radians(center_lat)) then 360
       else 1.001 * degrees(asin(sin(radius_miles / ${EARTH_RADIUS_MILES}) / cos(radians(center_lat)))) end;

-- Roof-age rule (shared by the CLI and the API): older than N years means
-- year_built < roll_year - N. Parcels without coordinates or year built are excluded.
-- Bounding-box prefilter: only parcels inside the box around the circle get a haversine distance. The box
-- is never smaller than the circle: latitude +/- radius/R; longitude +/- asin(sin(radius/R) / cos(lat)),
-- the circle's widest longitude (any longitude once the circle reaches a pole); both widened by 0.1%
-- against rounding. The exact haversine filter below still decides. The box does not wrap at
-- +/-180 degrees longitude (the API and CLI only take LA County centres).
create or replace macro oracle.roof_age_candidates(threshold_years, center_lat, center_lon, radius_miles) as table
select * from (
  select p.*, oracle.haversine_miles(center_lat, center_lon, p.latitude, p.longitude) as distance_miles
  from oracle.v_property p
  where p.latitude is not null and p.longitude is not null
    and p.latitude between center_lat - oracle.box_dlat(radius_miles) and center_lat + oracle.box_dlat(radius_miles)
    and p.longitude between center_lon - oracle.box_dlon(center_lat, radius_miles)
                        and center_lon + oracle.box_dlon(center_lat, radius_miles)
)
where distance_miles <= radius_miles
  and year_built < roll_year - threshold_years;
`;
}

export function runViewsSql(
  p: Required<Pick<DataPaths, "runManifest" | "runHistory">>,
): string {
  return `
create schema if not exists oracle;

create or replace view oracle.src_run_manifest as
select * from read_json(${lit(p.runManifest)}, format = 'auto');

create or replace view oracle.src_run_history as
select * from read_json(${lit(p.runHistory)}, format = 'newline_delimited');

create or replace view oracle.v_run as
select run_id, run_name, generated_at, county, state, fips, roll_year, scope, readiness,
       row_counts, coverage, delta, limitations, derived_field_reference_date
from oracle.src_run_manifest;

create or replace view oracle.v_run_history as
select run_id, finished_at, row_counts, delta, parquet_sha256, manifest_sha256, published
from oracle.src_run_history
order by finished_at;

create or replace view oracle.v_source as
with pages as (
  select source_name, count(*) as page_count, sum(record_count) as record_count,
         min(source_retrieved_at) as first_retrieved_at, max(source_retrieved_at) as last_retrieved_at
  from oracle.v_source_page group by source_name
), meta as (
  select s.name as source_name, s.role, s.hub_page, s.query_url, s.terms_of_use, s.access
  from (select unnest(sources) as s from oracle.src_run_manifest)
)
select pages.*, meta.role, meta.hub_page, meta.query_url, meta.terms_of_use, meta.access
from pages left join meta using (source_name);
`;
}
