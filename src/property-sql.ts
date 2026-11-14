/**
 * The publishable property table, built from the staged raw roll rows (table raw), and the
 * personal-data column check. Shared by build-outputs.ts and the tests that hold RAW_FIELDS
 * (src/raw-fields.ts) to exactly the roll attributes read here.
 */

export const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The roof-age basis of a parcel, one label per basis. The year-built proxy is every parcel's basis
 * in this table; src/permit-sql.ts replaces it with the permit label where a finaled roofing permit
 * sets the effective roof year.
 */
export const ROOF_AGE_BASIS = {
  yearBuilt:
    "PROXY: assessor year built / effective year built; not a roof installation date",
  permit:
    "PERMIT: latest finaled LADBS roofing permit (status date); a roof coating alone does not count",
} as const;

/** The tax-rate-area city whose permits the LADBS caches hold (the City of Los Angeles). */
export const PERMIT_JURISDICTION = "LOS ANGELES";

/** The first possible land base year: the 1975 lien date set the base of every property (Prop 13). */
export const FIRST_BASE_YEAR = 1975;

/**
 * The latest land base year label that means "no reassessment in 10 years" at the reference date.
 * In this roll the label is a fiscal year ending on 30 June (an event from 1 July of Y-1 to 30 June
 * of Y is labelled Y), so label Y qualifies when 30 June of Y is on or before the reference date
 * minus 10 years, the same inclusive bound as owner_unchanged_10y_proxy. For 2026-11-12: 2016.
 */
export function baseYearCutoff(referenceDate: string): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(referenceDate);
  if (!m)
    throw new Error(`reference date "${referenceDate}" is not YYYY-MM-DD`);
  const y = Number(m[1]) - 10;
  return `${m[2]}-${m[3]}` >= "06-30" ? y : y - 1;
}

/** The roll's land base year as an integer, before the possible-years rule. */
const RAW_BASE_YEAR = "try_cast(trim(Roll_LandBaseYear::varchar) as integer)";
/** A possible land base year: from 1975 to the roll year; 0 and anything else is null. */
const LAND_BASE_YEAR = `case when ${RAW_BASE_YEAR} between ${FIRST_BASE_YEAR} and try_cast(RollYear as integer) then ${RAW_BASE_YEAR} end`;

/** Counts of the land base year for the run manifest, over the staged roll rows (table raw). */
export const LAND_BASE_YEAR_STATS_SQL = `
select count(${LAND_BASE_YEAR}) with_land_base_year,
  count(*) filter (where ${RAW_BASE_YEAR} = 0) null_zero,
  count(*) filter (where ${RAW_BASE_YEAR} between 1 and ${FIRST_BASE_YEAR - 1}) null_before_${FIRST_BASE_YEAR},
  count(*) filter (where ${RAW_BASE_YEAR} > try_cast(RollYear as integer)) null_after_roll_year,
  count(*) filter (where ${RAW_BASE_YEAR} is null or ${RAW_BASE_YEAR} < 0) null_missing,
  min(${LAND_BASE_YEAR}) min_year, max(${LAND_BASE_YEAR}) max_year
from raw`;

// Publishable table. Column names follow bundled lexicon (kit use-neutral-lexicon model-c) where one exists;
// source_* and *_proxy columns, roof_age_basis, permit_data_available and land_base_year are not lexicon
// fields (see findings section 12). land_base_year is the roll's Roll_LandBaseYear (0, before 1975 or
// after the roll year: null); ownership_base_year_10y_proxy compares it with baseYearCutoff.
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
  ${sqlLiteral(ROOF_AGE_BASIS.yearBuilt)} as roof_age_basis,
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
  trim(TaxRateArea_CITY) = ${sqlLiteral(PERMIT_JURISDICTION)}          as permit_data_available,
  RollYear::varchar                                               as roll_year,
  case when RecordingDate is not null then cast(epoch_ms(RecordingDate::bigint) as date) end as last_recording_date,
  case when RecordingDate is null then null
       else cast(epoch_ms(RecordingDate::bigint) as date) <= (date ${sqlLiteral(referenceDate)} - interval 10 year) end as owner_unchanged_10y_proxy,
  ${LAND_BASE_YEAR}                                               as land_base_year,
  ${LAND_BASE_YEAR} <= ${baseYearCutoff(referenceDate)}           as ownership_base_year_10y_proxy,
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
