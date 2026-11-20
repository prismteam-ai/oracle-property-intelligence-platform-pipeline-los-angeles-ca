/**
 * The view contract. Apps and the CLI query only the oracle.v_* views and the oracle.* macros listed in
 * CONTRACT; only the oracle.src_* views name files, and only this file names Parquet columns. When the
 * Parquet is replaced by Lexicon tables, only this file changes.
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

/** The permit Parquet files of a permit run (the permit_files of its runs/run_history.jsonl row). */
export interface PermitPaths {
  /** One row per LADBS permit. */
  permitsParquet: string;
  /** One row per permit-to-parcel link (a building-level permit links every unit). */
  permitParcelsParquet: string;
  /** One row per contractor row of the LADBS contractor view. */
  permitContractorsParquet: string;
}

/** The status class that counts as open for long-open permits (issued, not finaled or closed). */
export const OPEN_ISSUED = "open-issued";

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
  effective_roof_year,
  roof_year_permit_number,
  roof_year_rule_version,
  permit_data_available,
  source_use_type                           as use_type,
  source_use_code                           as use_code,
  source_use_code_description               as use_description,
  tax_rate_area_city                        as jurisdiction,
  try_cast(roll_year as integer)            as roll_year,
  last_recording_date,
  owner_unchanged_10y_proxy,
  land_base_year,
  ownership_base_year_10y_proxy
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
select 'parcel' as source_kind, source_name, source_page_file, source_request_url, source_retrieved_at,
       source_page_sha256, count(*) as record_count
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
-- effective_roof_year < roll_year - N. The effective roof year is the later of the year built and the
-- year of the latest finaled roofing permit (roof_age_basis says which; the build sets it). Parcels
-- without coordinates or without any roof year are excluded.
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
  and effective_roof_year < roll_year - threshold_years;

-- Ownership filter (shared by every route that takes the search filter): true when the parcel passes the
-- basis. basis null: no filter. 'recording': owner_unchanged_10y_proxy (no recorded document in the 10 years
-- before the reference date); 'base_year': ownership_base_year_10y_proxy (no reassessment in those 10 years,
-- by the roll's land base year); 'both': the two. A null proxy never passes. Any other basis is an error.
create or replace macro oracle.ownership_passes(basis, recording_proxy, base_year_proxy) as
  case when basis is null then true
       when basis = 'recording' then coalesce(recording_proxy, false)
       when basis = 'base_year' then coalesce(base_year_proxy, false)
       when basis = 'both' then coalesce(recording_proxy and base_year_proxy, false)
       else error('unknown ownership basis: ' || basis) end;
`;
}

/** Provenance columns under the names oracle.v_property_provenance uses. */
const provenanceColumns = `
  source_name,
  source_http_request                       as source_request_url,
  source_http_method                        as source_request_method,
  strftime(timezone('UTC', source_retrieved_at), '%Y-%m-%dT%H:%M:%S.%gZ') as source_retrieved_at,
  source_page_sha256,
  source_page_file`;

/**
 * Permit views and macros, over a permit run's three permit Parquet files. Created after propertyViewsSql
 * (they join oracle.v_property) and before runViewsSql (v_source reads v_source_page, which this widens
 * to all three sources). Permit and contractor fields keep the stored tables' column names (the bundled
 * lexicon's where one exists), except the permit's unnormalized_address, served as address like the
 * parcel's in v_property; dates are served as YYYY-MM-DD text. The permits' work descriptions are in
 * no Parquet and in no view.
 */
export function permitViewsSql(p: PermitPaths): string {
  return `
create schema if not exists oracle;

create or replace view oracle.src_permit as
select * from read_parquet(${lit(p.permitsParquet)});
create or replace view oracle.src_permit_parcel as
select * from read_parquet(${lit(p.permitParcelsParquet)});
-- contractor_row numbers a permit's contractor rows 1, 2, ... in the order of all their values (the build
-- keeps no exact duplicates, so the order is total): (permit_number, contractor_row) names one row.
create or replace view oracle.src_permit_contractor as
select *, row_number() over (
    partition by permit_number
    order by contractors_business_name, license_identifier, source_license_type, license_class,
             license_class_name, license_class_note, is_owner_builder, license_expiration_date, city_name,
             state_code, permit_issue_date, source_page_file, source_page_sha256, source_http_request,
             source_retrieved_at) as contractor_row
from read_parquet(${lit(p.permitContractorsParquet)});

create or replace view oracle.v_permit as
select
  permit_number,
  source_apn,
  unnormalized_address                       as address,
  postal_code,
  source_permit_type,
  source_permit_sub_type,
  source_business_unit,
  cast(application_received_date as varchar) as application_received_date,
  cast(permit_issue_date as varchar)         as permit_issue_date,
  source_status_desc,
  cast(status_date as varchar)               as status_date,
  permit_status_class,
  cast(open_since as varchar)                as open_since,
  open_days,
  roofing_work,
  roof_coating_only,
  roof_r,
  roof_only,
  join_method,
  unjoined_cause,
  source_dataset,
  source_dataset_kind,
  roof_flag_rule_version,
  permit_status_rule_version,
  join_rule_version
from oracle.src_permit;

create or replace view oracle.v_permit_parcel as
select
  permit_number,
  parcel_identifier                          as parcel_id,
  join_method,
  building_level,
  join_rule_version
from oracle.src_permit_parcel;

create or replace view oracle.v_permit_contractor as
select
  permit_number,
  contractor_row,
  contractors_business_name,
  license_identifier,
  source_license_type,
  license_class,
  license_class_name,
  license_class_note,
  is_owner_builder,
  cast(license_expiration_date as varchar)   as license_expiration_date,
  city_name,
  state_code,
  cast(permit_issue_date as varchar)         as permit_issue_date,
  license_class_rule_version,
  contractor_identity_key,
  canonical_business_name,
  name_variant_count,
  identity_permit_count,
  contractor_identity_rule_version
from oracle.src_permit_contractor;

-- One row per permit record and per contractor record, with the page it came from.
create or replace view oracle.v_permit_provenance as
select 'permit' as source_kind, permit_number, null::integer as contractor_row,${provenanceColumns}
from oracle.src_permit
union all
select 'contractor' as source_kind, permit_number, contractor_row,${provenanceColumns}
from oracle.src_permit_contractor;

create or replace view oracle.v_source_page as
select source_kind, source_name, source_page_file, source_request_url, source_retrieved_at, source_page_sha256,
       count(*) as record_count
from (
  select 'parcel' as source_kind, source_name, source_page_file, source_request_url, source_retrieved_at,
         source_page_sha256
  from oracle.v_property_provenance
  union all
  select source_kind, source_name, source_page_file, source_request_url, source_retrieved_at, source_page_sha256
  from oracle.v_permit_provenance
)
group by all
order by source_page_file;

-- Permit-to-parcel links of the long-open permits: roofing work only (roofing_work; a roof-coating-only
-- permit is roofing work and stays in), open-issued, open for at least min_open_days and, when
-- max_open_days is not null, at most max_open_days (open_days counts from the issue date to the run's
-- reference date). A building-level permit gives one row per unit. long_open_permits and the points
-- highlight both read this macro.
create or replace macro oracle.long_open_parcels(min_open_days, max_open_days) as table
select pp.permit_number, pp.parcel_id
from oracle.v_permit p
join oracle.v_permit_parcel pp using (permit_number)
where p.roofing_work
  and p.permit_status_class = ${lit(OPEN_ISSUED)}
  and p.open_days >= min_open_days
  and (max_open_days is null or p.open_days <= max_open_days);

-- Long-open (roofing work) permits with a linked parcel inside the circle (and, when threshold_years is not null, whose
-- parcel's effective roof year is older than the threshold, as in roof_age_candidates). Each permit is one
-- row at its nearest qualifying parcel (distance, then parcel ID), so a building-level permit counts once.
-- The parcel columns (parcel_id, distance_miles, effective roof year and basis) describe that parcel;
-- parcel_count is the number of parcels the permit links. Bounding-box prefilter as in roof_age_candidates.
create or replace macro oracle.long_open_permits(min_open_days, max_open_days, threshold_years, center_lat, center_lon, radius_miles) as table
with links as (
  select l.permit_number, v.parcel_id, v.effective_roof_year, v.roof_age_basis, v.roof_year_permit_number,
         oracle.haversine_miles(center_lat, center_lon, v.latitude, v.longitude) as distance_miles
  from oracle.long_open_parcels(min_open_days, max_open_days) l
  join oracle.v_property v using (parcel_id)
  where v.latitude is not null and v.longitude is not null
    and v.latitude between center_lat - oracle.box_dlat(radius_miles) and center_lat + oracle.box_dlat(radius_miles)
    and v.longitude between center_lon - oracle.box_dlon(center_lat, radius_miles)
                        and center_lon + oracle.box_dlon(center_lat, radius_miles)
    and (threshold_years is null or v.effective_roof_year < v.roll_year - threshold_years)
), nearest as (
  select * from links
  where distance_miles <= radius_miles
  qualify row_number() over (partition by permit_number order by distance_miles, parcel_id) = 1
), counts as (
  select permit_number, count(*) as parcel_count
  from oracle.v_permit_parcel
  where permit_number in (select permit_number from nearest)
  group by permit_number
)
select p.*, n.parcel_id, n.distance_miles, pp.building_level, c.parcel_count,
       n.effective_roof_year, n.roof_age_basis, n.roof_year_permit_number
from nearest n
join oracle.v_permit p using (permit_number)
join oracle.v_permit_parcel pp on pp.permit_number = n.permit_number and pp.parcel_id = n.parcel_id
join counts c on c.permit_number = n.permit_number;
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

-- run_kind ("rebuild" or "new data"), rebuild_of and source_changes are read as JSON, so a manifest or
-- history line written before them (the first three runs) gives null, never a binder error or a guess.
create or replace view oracle.v_run as
select run_id, run_name, generated_at, county, state, fips, roll_year, scope, readiness,
       row_counts, coverage, delta, limitations, derived_field_reference_date,
       to_json(m)->>'run_kind' as run_kind, to_json(m)->>'rebuild_of' as rebuild_of,
       to_json(m)->>'source_changes' as source_changes
from oracle.src_run_manifest m;

create or replace view oracle.v_run_history as
select run_id, finished_at, row_counts, delta, parquet_sha256, manifest_sha256, published,
       to_json(h)->>'run_kind' as run_kind, to_json(h)->>'rebuild_of' as rebuild_of,
       to_json(h)->>'source_changes' as source_changes
from oracle.src_run_history h
order by finished_at;

-- Source metadata read as JSON, so a key one source lacks (hub_page, query_urls, license, coverage) is null.
-- coverage is the source's window in the data ({field, first, last}: the contractor view's permit issue
-- dates); null where the manifest records none (the roll and the permit datasets, and older manifests).
create or replace view oracle.v_source as
with pages as (
  select source_kind, source_name, count(*) as page_count, sum(record_count) as record_count,
         min(source_retrieved_at) as first_retrieved_at, max(source_retrieved_at) as last_retrieved_at
  from oracle.v_source_page group by source_kind, source_name
), meta as (
  select s->>'name' as source_name, s->>'role' as role, s->>'hub_page' as hub_page,
         s->>'query_url' as query_url, cast(s->'query_urls' as varchar[]) as query_urls,
         s->>'terms_of_use' as terms_of_use, s->>'license' as license, s->>'attribution' as attribution,
         s->>'access' as access,
         case when json_type(s->'coverage') = 'OBJECT'
              then {'field': s->'coverage'->>'field', 'first': s->'coverage'->>'first', 'last': s->'coverage'->>'last'}
         end as coverage
  from (select unnest(from_json(to_json(sources), '["json"]')) as s from oracle.src_run_manifest)
)
select pages.*, meta.role, meta.hub_page, meta.query_url, meta.query_urls, meta.terms_of_use, meta.license,
       meta.attribution, meta.access, meta.coverage
from pages left join meta using (source_name);
`;
}
