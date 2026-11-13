/**
 * The published LADBS permit tables and the effective roof year, built in one DuckDB connection from
 * three tables already there:
 *  - permit_raw: rows staged by src/stage-permits.ts (PERMIT_FIELDS plus provenance);
 *  - contractor_raw: rows staged by src/stage-contractors.ts;
 *  - property: the built property table (src/property-sql.ts).
 * It creates permit, permit_parcel and permit_contractor, and rebuilds property with the effective
 * roof year. work_desc is read only by the roofing flags and is in no table this leaves behind.
 *
 * Column names follow the bundled lexicon (kit use-neutral-lexicon model-c) where one fits:
 * permit_number, application_received_date, permit_issue_date, unnormalized_address, postal_code
 * (property_improvement and address); license_identifier, license_expiration_date, city_name,
 * state_code, is_owner_builder (license, address, property_improvement). Raw LADBS values keep
 * source_* names because they are not lexicon enum values; the provenance columns are named as in
 * the property table.
 *
 * Effective roof year: the year of the status date of the latest roofing permit with status
 * Permit Finaled linked to the parcel (building-level links count for every unit), else the year
 * built. A permit that is roofing work only through the roof-coating phrase never counts. A permit
 * dated after the reference date, or in a year before the parcel's year built, is ignored and counted.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import {
  createLicenseClassTable,
  LICENSE_CLASS_RULE_VERSION,
} from "./licence-classes.ts";
import { joinPermits } from "./permit-join.ts";
import {
  FINALED_STATUS,
  openDaysSql,
  openSinceSql,
  PERMIT_STATUS_RULE_VERSION,
  permitStatusClassSql,
} from "./permit-status.ts";
import { ROOF_AGE_BASIS, sqlLiteral as lit } from "./property-sql.ts";
import { ROOF_FLAG_GROUPS_SQL, roofFlagsTableSql } from "./roof-flags.ts";

export const ROOF_YEAR_RULE_VERSION = "roof-year-1";
/** The tables a build publishes after buildPermitTables. */
export const PUBLISHED_TABLES = [
  "property",
  "permit",
  "permit_parcel",
  "permit_contractor",
] as const;

export interface PermitTableOptions {
  /** YYYY-MM-DD: the permit cache's generated_at date. Every duration counts to it. */
  referenceDate: string;
  permitSourceName: string;
  contractorSourceName: string;
}

/** A source date-time text ("2016-01-04T00:00:00.000") as a date; a value that is not one fails. */
const asDate = (e: string) => `cast(cast(${e} as timestamp) as date)`;

const provenance = (sourceName: string) => `
  _request_url                       as source_http_request,
  'GET'                              as source_http_method,
  cast(_retrieved_at as timestamptz) as source_retrieved_at,
  _page_sha256                       as source_page_sha256,
  _page_file                         as source_page_file,
  ${lit(sourceName)}                 as source_name`;

export function permitTableSql(o: PermitTableOptions): string {
  const cls = permitStatusClassSql("status_desc");
  const since = openSinceSql(
    "permit_status_class",
    "permit_issue_date",
    "application_received_date",
  );
  return `
create table permit as
with p as (
  select f.*, j.join_method, j.unjoined_cause, j.join_rule_version,
    ${asDate("f.submitted_date")} as application_received_date,
    ${asDate("f.issue_date")} as permit_issue_date,
    ${cls} as permit_status_class
  from _permit_flagged f join permit_join j on j.permit_number = f.permit_nbr
), s as (
  select *, ${since} as open_since from p
)
select
  permit_nbr                                                      as permit_number,
  nullif(trim(apn), '')                                           as source_apn,
  nullif(regexp_replace(trim(primary_address), '\\s+', ' ', 'g'), '') as unnormalized_address,
  case when regexp_full_match(trim(zip_code), '[0-9]{5}') then trim(zip_code) end as postal_code,
  nullif(trim(permit_type), '')                                   as source_permit_type,
  nullif(trim(permit_sub_type), '')                               as source_permit_sub_type,
  nullif(trim(business_unit), '')                                 as source_business_unit,
  application_received_date,
  permit_issue_date,
  nullif(trim(status_desc), '')                                   as source_status_desc,
  ${asDate("status_date")}                                        as status_date,
  permit_status_class,
  open_since,
  ${openDaysSql("open_since", o.referenceDate)}                    as open_days,
  roof_r, roof_only, roofing_work, roof_coating_only,
  join_method, unjoined_cause,
  _dataset                                                        as source_dataset,
  _dataset_kind                                                   as source_dataset_kind,
  roof_flag_rule_version,
  ${lit(PERMIT_STATUS_RULE_VERSION)}                              as permit_status_rule_version,
  join_rule_version,${provenance(o.permitSourceName)}
from s
order by permit_number`;
}

export function contractorTableSql(o: PermitTableOptions): string {
  return `
create table permit_contractor as
select
  r.pcis_permit                                                   as permit_number,
  nullif(trim(r.contractors_business_name), '')                   as contractors_business_name,
  case when m.license_class_note = 'owner-builder' or upper(trim(r.license_type)) = 'N/A' then null
       else nullif(trim(r.license), '') end                       as license_identifier,
  m.source_license_type,
  m.license_class,
  m.license_class_name,
  m.license_class_note,
  m.is_owner_builder,
  ${asDate("r.license_expiration_date")}                          as license_expiration_date,
  nullif(upper(trim(r.contractor_city)), '')                      as city_name,
  nullif(upper(trim(r.contractor_state)), '')                     as state_code,
  ${asDate("r.issue_date")}                                       as permit_issue_date,
  ${lit(LICENSE_CLASS_RULE_VERSION)}                              as license_class_rule_version,${provenance(o.contractorSourceName)}
from contractor_raw r
join _license_class_map m on m.source_license_type is not distinct from r.license_type
order by all`;
}

/** Candidate roofing permits per parcel, with the reason a candidate is ignored (null if it counts). */
export function roofPermitSql(referenceDate: string): string {
  return `
create temp table _roof_permit as
select pp.parcel_identifier, p.permit_number, p.status_date,
  case
    when p.status_date > date ${lit(referenceDate)} then 'after-reference-date'
    when b.property_structure_built_year is not null
      and year(p.status_date) < b.property_structure_built_year then 'before-year-built'
  end as ignored_reason
from permit p
join permit_parcel pp on pp.permit_number = p.permit_number
join property b on b.parcel_identifier = pp.parcel_identifier
where p.roofing_work and not p.roof_coating_only
  and p.source_status_desc = ${lit(FINALED_STATUS)} and p.status_date is not null`;
}

export const PROPERTY_WITH_ROOF_YEAR_SQL = `
create temp table _parcel_roof_year as
select parcel_identifier, cast(year(status_date) as integer) as roof_year, permit_number
from (
  select *, row_number() over (
    partition by parcel_identifier order by status_date desc, permit_number desc) as rn
  from _roof_permit where ignored_reason is null
) where rn = 1;

alter table property rename to _property_base;
create table property as
select b.* replace (
    case when r.parcel_identifier is not null then ${lit(ROOF_AGE_BASIS.permit)}
         else b.roof_age_basis end as roof_age_basis),
  coalesce(r.roof_year, b.property_structure_built_year) as effective_roof_year,
  r.permit_number                                       as roof_year_permit_number,
  ${lit(ROOF_YEAR_RULE_VERSION)}                        as roof_year_rule_version
from _property_base b
left join _parcel_roof_year r on r.parcel_identifier = b.parcel_identifier
order by b.parcel_identifier;
drop table _property_base`;

type Counts = Record<string, number>;

/** Counts recorded in the run manifest (no row values). */
export interface PermitBuildStats {
  reference_date: string;
  permits: Counts;
  roof_flag_groups: Counts;
  join_by_method: Counts;
  join_by_method_roofing_work: Counts;
  unjoined_by_cause: Counts;
  condo_buildings: Counts;
  joined_outside_permit_jurisdiction: Counts;
  status_classes: Counts;
  unmapped_statuses: Counts;
  open_since_missing_by_class: Counts;
  open_since_after_reference_date: number;
  contractors: Counts;
  license_classes: Counts;
  license_class_notes: Counts;
  unmapped_license_types: Counts;
  roof_year: Counts;
  roof_permits_ignored: Counts;
  coverage: Counts;
}

/**
 * Build permit, permit_parcel, permit_contractor and the property table with the effective roof
 * year; returns the counts. Leaves no other new table behind.
 */
export async function buildPermitTables(
  c: DuckDBConnection,
  o: PermitTableOptions,
): Promise<PermitBuildStats> {
  const q = async (sql: string) =>
    (await c.runAndReadAll(sql)).getRowObjectsJson() as Array<
      Record<string, string | null>
    >;
  const pairs = async (sql: string): Promise<Counts> =>
    Object.fromEntries((await q(sql)).map((r) => [String(r.k), Number(r.n)]));
  const one = async (sql: string): Promise<Counts> =>
    Object.fromEntries(
      Object.entries((await q(sql))[0]!).map(([k, v]) => [k, Number(v)]),
    );

  await c.run(roofFlagsTableSql("permit_raw", "_permit_flagged"));
  await joinPermits(c, "permit_raw", "property");
  await c.run(permitTableSql(o));
  await createLicenseClassTable(
    c,
    "contractor_raw",
    "license_type",
    "_license_class_map",
  );
  await c.run(contractorTableSql(o));
  await c.run(roofPermitSql(o.referenceDate));
  const ignored = await pairs(
    `select ignored_reason k, count(distinct permit_number) n from _roof_permit where ignored_reason is not null group by 1 order by 1`,
  );
  await c.run(PROPERTY_WITH_ROOF_YEAR_SQL);

  const stats: PermitBuildStats = {
    reference_date: o.referenceDate,
    permits: await pairs(
      `select source_dataset_kind k, count(*) n from permit group by 1 order by 1`,
    ),
    roof_flag_groups: await one(ROOF_FLAG_GROUPS_SQL("permit")),
    join_by_method: await pairs(
      `select coalesce(join_method, 'unjoined') k, count(*) n from permit group by 1 order by 1`,
    ),
    join_by_method_roofing_work: await pairs(
      `select coalesce(join_method, 'unjoined') k, count(*) n from permit where roofing_work group by 1 order by 1`,
    ),
    unjoined_by_cause: await pairs(
      `select unjoined_cause k, count(*) n from permit where join_method is null group by 1 order by 1`,
    ),
    condo_buildings: await one(
      `select count(distinct permit_number) permits, count(*) unit_links, count(distinct parcel_identifier) units from permit_parcel where building_level`,
    ),
    joined_outside_permit_jurisdiction: await pairs(`
      select pp.join_method k, count(distinct pp.permit_number) n
      from permit_parcel pp join property b on b.parcel_identifier = pp.parcel_identifier
      where not b.permit_data_available group by 1 order by 1`),
    status_classes: await pairs(
      `select permit_status_class k, count(*) n from permit group by 1 order by 1`,
    ),
    unmapped_statuses: await pairs(
      `select coalesce(source_status_desc, '(null)') k, count(*) n from permit where permit_status_class = 'unmapped' group by 1 order by 1`,
    ),
    open_since_missing_by_class: await pairs(`
      select permit_status_class k, count(*) n from permit
      where permit_status_class in ('open-issued', 'open-application') and open_since is null
      group by 1 order by 1`),
    open_since_after_reference_date: Number(
      (
        await q(
          `select count(*) n from permit where open_since > date ${lit(o.referenceDate)}`,
        )
      )[0]!.n,
    ),
    contractors: await one(`
      select count(*) rows, count(distinct permit_number) permits,
        count(distinct permit_number) filter (where permit_number in (select permit_number from permit)) permits_in_permit_table,
        count(*) filter (where is_owner_builder) owner_builder_rows,
        count(*) filter (where license_identifier is null) rows_without_license_number
      from permit_contractor`),
    license_classes: await pairs(
      `select coalesce(license_class, '(none)') k, count(*) n from permit_contractor group by 1 order by 1`,
    ),
    license_class_notes: await pairs(
      `select coalesce(license_class_note, '(none)') k, count(*) n from permit_contractor group by 1 order by 1`,
    ),
    unmapped_license_types: await pairs(
      `select source_license_type k, count(*) n from permit_contractor where license_class_note = 'unmapped' group by 1 order by 1`,
    ),
    roof_year: await one(`
      select
        count(*) filter (where roof_age_basis = ${lit(ROOF_AGE_BASIS.permit)}) permit_basis,
        count(*) filter (where roof_age_basis = ${lit(ROOF_AGE_BASIS.yearBuilt)} and effective_roof_year is not null) year_built_basis,
        count(*) filter (where effective_roof_year is null) no_roof_year,
        count(*) filter (where roof_age_basis = ${lit(ROOF_AGE_BASIS.permit)} and property_structure_built_year is null) permit_year_without_year_built,
        count(*) filter (where roof_age_basis = ${lit(ROOF_AGE_BASIS.permit)} and permit_data_available) permit_basis_in_permit_jurisdiction,
        (select count(*) from permit where roofing_work and roof_coating_only and source_status_desc = ${lit(FINALED_STATUS)}) finaled_coating_only_permits
      from property`),
    roof_permits_ignored: ignored,
    coverage: await one(`
      select count(*) filter (where permit_data_available) parcels_with_permit_data,
        count(*) filter (where not permit_data_available) parcels_without_permit_data,
        (select count(distinct pp.parcel_identifier) from permit_parcel pp) parcels_with_permits
      from property`),
  };
  await c.run(
    "drop table _permit_flagged; drop table permit_join; drop table _license_class_map; drop table _roof_permit; drop table _parcel_roof_year",
  );
  return stats;
}
