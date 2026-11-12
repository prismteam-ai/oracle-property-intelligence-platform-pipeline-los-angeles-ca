/**
 * The publishable property table, built from the staged raw roll rows (table raw), and the
 * personal-data column check. Shared by build-outputs.ts and the tests that hold RAW_FIELDS
 * (src/raw-fields.ts) to exactly the roll attributes read here.
 */

export const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

// Publishable table. Column names follow bundled lexicon (kit use-neutral-lexicon model-c) where one exists;
// source_* and *_proxy columns are not lexicon fields (see findings section 10).
export function propertyTableSql(
  referenceDate: string,
  sourceName: string,
): string {
  return `
create table property as
select
  AIN::varchar                                                    as parcel_identifier,
  AssessorID::varchar                                             as assessor_id_formatted,
  AIN::varchar                                                    as request_identifier,
  case when try_cast(YearBuilt as integer) between 1800 and 2100 then try_cast(YearBuilt as integer) end as property_structure_built_year,
  case when try_cast(EffectiveYearBuilt as integer) between 1800 and 2100 then try_cast(EffectiveYearBuilt as integer) end as property_effective_built_year,
  'PROXY: assessor year built / effective year built; not a roof installation date' as roof_age_basis,
  nullif(trim(UseType), '')                                       as source_use_type,
  nullif(trim(UseCode), '')                                       as source_use_code,
  concat_ws(' | ', nullif(trim(UseCodeDescChar1), ''), nullif(trim(UseCodeDescChar2), ''), nullif(trim(UseCodeDescChar3), ''), nullif(trim(UseCodeDescChar4), '')) as source_use_code_description,
  nullif(regexp_replace(trim(PropertyLocation), '\\s+', ' ', 'g'), '') as unnormalized_address,
  nullif(trim(concat_ws(' ', nullif(trim(SitusHouseNo::varchar), '0'), nullif(trim(SitusFraction), ''))), '') as street_number,
  nullif(trim(SitusDirection), '')                                as street_pre_directional_text,
  nullif(trim(SitusStreet), '')                                   as street_name,
  nullif(trim(SitusUnit), '')                                     as unit_identifier,
  nullif(trim(regexp_replace(trim(SitusCity), '\\s+CA$', '')), '') as city_name,
  nullif(trim(SitusZIP5), '')                                     as postal_code,
  nullif(split_part(trim(SitusZIP), '-', 2), '')                  as plus_four_postal_code,
  'Los Angeles'                                                   as county_name,
  'CA'                                                            as state_code,
  nullif(CENTER_LAT::double, 0)                                   as latitude,
  nullif(CENTER_LON::double, 0)                                   as longitude,
  'assessor parcel center point (CENTER_LAT/CENTER_LON)'          as coordinate_basis,
  trim(TaxRateArea_CITY)                                          as tax_rate_area_city,
  RollYear::varchar                                               as roll_year,
  case when RecordingDate is not null then cast(epoch_ms(RecordingDate::bigint) as date) end as last_recording_date,
  case when RecordingDate is null then null
       else cast(epoch_ms(RecordingDate::bigint) as date) <= (date ${sqlLiteral(referenceDate)} - interval 10 year) end as owner_unchanged_10y_proxy,
  cast(null as boolean)                                           as out_of_area_owner,
  _request_url                                                    as source_http_request,
  'GET'                                                           as source_http_method,
  cast(_retrieved_at as timestamptz)                              as source_retrieved_at,
  _page_sha256                                                    as source_page_sha256,
  _page_file                                                      as source_page_file,
  ${sqlLiteral(sourceName)}                                         as source_name
from raw
order by parcel_identifier`;
}

/** Column names that would carry owner, mailing or contact data. */
export const PERSONAL_DATA_PATTERN =
  /owner_?name|mail|contact|phone|email|grantee|grantor|taxpayer/i;
/** Derived booleans that match the pattern by name but hold no personal data. */
const ALLOWED_PROXY_COLUMNS = new Set([
  "owner_unchanged_10y_proxy",
  "out_of_area_owner",
]);

export function personalDataColumns(columns: string[]): string[] {
  return columns.filter(
    (n) => PERSONAL_DATA_PATTERN.test(n) && !ALLOWED_PROXY_COLUMNS.has(n),
  );
}
