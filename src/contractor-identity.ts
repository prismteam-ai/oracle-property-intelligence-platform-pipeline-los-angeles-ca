/**
 * Contractor identity on permit_contractor: one identity per license number (src/permit-sql.ts
 * builds the table; this adds the identity columns in place).
 *
 * - contractor_identity_key: the row's license number (license_identifier: the source value,
 *   trimmed); null without one (owner-builder and N/A rows), and such rows are never merged.
 * - canonical_business_name: the key's latest non-null business name by the row's own
 *   permit_issue_date; a tie on that date goes to the name on most of the key's rows, then to the
 *   lowest name in byte order. Null when no row of the key has a name.
 * - name_variant_count: the key's distinct non-null names (names are trimmed in the table). The
 *   variants are counted, never listed.
 * - identity_permit_count: the key's distinct permits.
 * - contractor_identity_rule_version on every row.
 *
 * A name shared by several license numbers stays several identities. The identity is not checked
 * against CSLB; one license number is one identity over all permit years (license_expiration_date
 * is not used).
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import { sqlLiteral as lit } from "./property-sql.ts";

export const CONTRACTOR_IDENTITY_RULE_VERSION = "contractor-identity-1";

/** The identity columns, in the order they follow the existing permit_contractor columns. */
export const CONTRACTOR_IDENTITY_COLUMNS = [
  "contractor_identity_key",
  "canonical_business_name",
  "name_variant_count",
  "identity_permit_count",
  "contractor_identity_rule_version",
] as const;

export const CONTRACTOR_IDENTITY_SQL = `
create temp table _identity_name as
select license_identifier as k, contractors_business_name as name,
  max(permit_issue_date) as latest, count(*) as n_rows
from permit_contractor
where license_identifier is not null and contractors_business_name is not null
group by 1, 2;

create temp table _identity_ranked as
select *,
  row_number() over (partition by k order by latest desc nulls last, n_rows desc, name asc) as rn,
  count(*) over (partition by k) as variants,
  count(*) over (partition by k, latest) as on_latest,
  count(*) over (partition by k, latest, n_rows) as on_latest_and_n
from _identity_name;

create temp table _identity as
select keys.k, keys.permits,
  r.name as canonical_business_name,
  coalesce(r.variants, 0) as name_variant_count,
  case when r.on_latest > 1 and r.on_latest_and_n = 1 then 'frequency'
       when r.on_latest > 1 then 'byte-order' end as settled_by
from (
  select license_identifier as k, count(distinct permit_number) as permits
  from permit_contractor where license_identifier is not null group by 1
) keys
left join _identity_ranked r on r.k = keys.k and r.rn = 1;

alter table permit_contractor rename to _permit_contractor_base;
create table permit_contractor as
select b.*,
  b.license_identifier                              as contractor_identity_key,
  i.canonical_business_name,
  cast(i.name_variant_count as integer)             as name_variant_count,
  cast(i.permits as integer)                        as identity_permit_count,
  ${lit(CONTRACTOR_IDENTITY_RULE_VERSION)}          as contractor_identity_rule_version
from _permit_contractor_base b
left join _identity i on i.k = b.license_identifier
order by all;
drop table _permit_contractor_base`;

/** Counts for the run manifest (no names). Run after CONTRACTOR_IDENTITY_SQL, before the cleanup. */
export const CONTRACTOR_IDENTITY_STATS_SQL = `
select
  (select count(*) from _identity) keys,
  (select count(*) from _identity where not regexp_full_match(k, '[0-9]+')) keys_not_all_digits,
  (select count(*) from permit_contractor where contractor_identity_key is not null) rows_with_key,
  (select count(*) from permit_contractor where contractor_identity_key is null) rows_without_key,
  (select count(*) from permit_contractor where contractor_identity_key is null and is_owner_builder) rows_without_key_owner_builder,
  (select count(*) from permit_contractor where contractor_identity_key is null and not is_owner_builder) rows_without_key_other,
  (select count(*) from permit_contractor where contractor_identity_key is not null and contractors_business_name is null) keyed_rows_without_name,
  (select count(*) from _identity where name_variant_count > 1) keys_with_several_names,
  (select coalesce(max(name_variant_count), 0) from _identity) max_names_per_key,
  (select count(*) from _identity where name_variant_count = 0) keys_without_name,
  (select count(*) from (select name from _identity_name group by name having count(*) > 1)) names_under_several_keys,
  (select count(*) from _identity where settled_by = 'frequency') ties_settled_by_frequency,
  (select count(*) from _identity where settled_by = 'byte-order') ties_settled_by_byte_order`;

export const CONTRACTOR_IDENTITY_CLEANUP_SQL =
  "drop table _identity_name; drop table _identity_ranked; drop table _identity";

/** Add the identity columns to permit_contractor; returns the counts. */
export async function addContractorIdentity(
  c: DuckDBConnection,
): Promise<Record<string, number>> {
  await c.run(CONTRACTOR_IDENTITY_SQL);
  const [r] = (
    await c.runAndReadAll(CONTRACTOR_IDENTITY_STATS_SQL)
  ).getRowObjectsJson();
  await c.run(CONTRACTOR_IDENTITY_CLEANUP_SQL);
  return Object.fromEntries(Object.entries(r!).map(([k, v]) => [k, Number(v)]));
}

/** The contractor rows' permit_issue_date window (min, max), as the manifest's source coverage. */
export interface ContractorWindow {
  first: string | null;
  last: string | null;
}

export const CONTRACTOR_WINDOW_SQL = `select min(permit_issue_date)::varchar first, max(permit_issue_date)::varchar last from permit_contractor`;

/** The contractor source's coverage field: the same window the limitations sentence states. */
export const contractorCoverage = (w: ContractorWindow) => ({
  field: "permit_issue_date" as const,
  first: w.first,
  last: w.last,
});

/** The manifest's sentence on contractor rows; it states the same window as the coverage field. */
export const contractorRowsLimitation = (w: ContractorWindow) =>
  `Contractor rows: business names and license numbers as LADBS publishes them; the license class is normalized to the CSLB form, and unknown values are unmapped and counted; owner-builder and N/A rows carry no license number. Contractor rows exist only for permits issued ${w.first} to ${w.last}.`;

/** The manifest's sentence on the contractor identity, with its counts (no names). */
export const contractorIdentityLimitation = (s: Record<string, number>) =>
  `Contractor identity (${CONTRACTOR_IDENTITY_RULE_VERSION}): one identity per license number. contractor_identity_key is the row's license number as LADBS publishes it, trimmed (${s.keys} license numbers, ${s.keys_not_all_digits} with a character other than a digit, so no further normalization); canonical_business_name is the latest non-null business name by the row's permit_issue_date (ties on that date: the most frequent name, ${s.ties_settled_by_frequency} licenses; then the lowest in byte order, ${s.ties_settled_by_byte_order}); name_variant_count counts the distinct names of a license, which are never listed. ${s.rows_with_key} rows carry a license number; ${s.rows_without_key} rows without one (${s.rows_without_key_owner_builder} owner-builder, ${s.rows_without_key_other} N/A or blank) have no identity and are never merged. ${s.keys_with_several_names} licenses carry more than one name (at most ${s.max_names_per_key}); ${s.names_under_several_keys} names appear under several licenses and stay separate identities; ${s.keys_without_name} licenses have no name on any row (no canonical name). The identity is not verified against CSLB: one license number is one identity across all permit years, and license_expiration_date is not used to split it.`;
