/**
 * Strict permit-to-parcel join over the run's roll (the built property table, src/property-sql.ts).
 *
 * Stage 1, direct: the permit's APN is 10 digits and equals a parcel_identifier (AIN).
 * Stage 2, address, only for stage-1 misses, on a full address match:
 *  - the house number equals the roll's; the normalized street name equals the roll's
 *    (src/address-normalize.ts); the 5-digit ZIP equals the roll's postal_code;
 *  - the pre-direction must agree where both carry one, and so must the fraction (e.g. "1/2");
 *  - when the permit APN starts with 7 digits (map book + page), candidates are narrowed to parcels
 *    whose AIN starts with them. This only narrows; it never replaces the street match.
 * Accepted: exactly one parcel (method "address"), or two or more parcels that share one full
 * address and all carry a condominium use code (UseCode ending in C or E; method "condo-building":
 * the permit attaches to every unit, building_level true). Anything else stays unjoined.
 * There is no coordinate matching: the nearest parcel centre can be a neighbour's parcel.
 *
 * Unjoined permits get a cause "<apn>/<address>":
 *  - apn: apn-missing (null or blank), apn-masked (holds "*"), apn-not-in-roll (10 digits, no such
 *    AIN), apn-malformed (anything else);
 *  - address: no-usable-address (no house number, street or 5-digit ZIP), no-address-match (no parcel
 *    with that house number and street), zip-or-direction-disagrees, book-page-disagrees,
 *    address-ambiguous (several parcels, not one condo building).
 *
 * Creates two tables: permit_parcel (permit_number, parcel_identifier, join_method, building_level,
 * join_rule_version), one row per permit and parcel, and permit_join (permit_number, join_method,
 * unjoined_cause, join_rule_version), one row per permit.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import {
  ADDRESS_RULE_VERSION,
  normalizeStreet,
  parsePermitAddress,
  parseRollHouse,
} from "./address-normalize.ts";
import { sqlLiteral as lit } from "./property-sql.ts";

export const JOIN_RULE_VERSION = `permit-join-1+${ADDRESS_RULE_VERSION}`;

type Cell = string | number | null;

/** Fill a new temporary table from JS rows (all columns varchar, or integer where named). */
async function fill(
  c: DuckDBConnection,
  table: string,
  columns: Array<[string, "varchar" | "integer"]>,
  rows: Cell[][],
): Promise<void> {
  await c.run(
    `create temp table ${table} (${columns.map(([n, t]) => `${n} ${t}`).join(", ")})`,
  );
  const a = await c.createAppender(table);
  for (const r of rows) {
    r.forEach((v, i) => {
      if (v === null) a.appendNull();
      else if (columns[i]![1] === "integer") a.appendInteger(Number(v));
      else a.appendVarchar(String(v));
    });
    a.endRow();
  }
  a.closeSync();
}

async function distinct(
  c: DuckDBConnection,
  table: string,
  column: string,
): Promise<string[]> {
  const r = await c.runAndReadAll(
    `select distinct ${column} v from ${table} where ${column} is not null order by 1`,
  );
  return (r.getRowObjectsJson() as Array<{ v: string }>).map((x) => x.v);
}

/**
 * Join the permits table (permit_nbr, apn, primary_address, zip_code) to the property table
 * (parcel_identifier, street_number, street_pre_directional_text, street_name, postal_code,
 * source_use_code). Writes permit_parcel and permit_join.
 */
export async function joinPermits(
  c: DuckDBConnection,
  permits: string,
  property: string,
): Promise<void> {
  // The address rules run once per distinct string, in TypeScript, for both sides.
  await fill(
    c,
    "_roll_street",
    [
      ["street_name", "varchar"],
      ["street_key", "varchar"],
    ],
    (await distinct(c, property, "street_name")).map((s) => [
      s,
      normalizeStreet(s),
    ]),
  );
  await fill(
    c,
    "_roll_house",
    [
      ["street_number", "varchar"],
      ["house", "integer"],
      ["fraction", "varchar"],
    ],
    (await distinct(c, property, "street_number")).map((s) => {
      const h = parseRollHouse(s);
      return [s, h?.house ?? null, h?.fraction ?? null];
    }),
  );
  await fill(
    c,
    "_permit_address",
    [
      ["primary_address", "varchar"],
      ["house", "integer"],
      ["fraction", "varchar"],
      ["direction", "varchar"],
      ["street_key", "varchar"],
    ],
    (await distinct(c, permits, "primary_address")).map((s) => {
      const a = parsePermitAddress(s);
      return [
        s,
        a?.house ?? null,
        a?.fraction ?? null,
        a?.direction ?? null,
        a?.street ?? null,
      ];
    }),
  );
  const v = lit(JOIN_RULE_VERSION);
  await c.run(`
create temp table _roll_address as
select p.parcel_identifier, h.house, h.fraction, s.street_key, p.postal_code as zip,
  nullif(upper(trim(p.street_pre_directional_text)), '') as direction,
  coalesce(right(p.source_use_code, 1) in ('C', 'E'), false) as condo_use
from ${property} p
join _roll_house h on h.street_number = p.street_number
join _roll_street s on s.street_name = p.street_name
where h.house is not null and s.street_key is not null;

create temp table _permit as
select x.permit_nbr,
  case when regexp_full_match(trim(x.apn), '[0-9]{10}') then trim(x.apn) end as apn10,
  case when regexp_matches(trim(x.apn), '^[0-9]{7}') then left(trim(x.apn), 7) end as book_page,
  case
    when x.apn is null or trim(x.apn) = '' then 'apn-missing'
    when regexp_full_match(trim(x.apn), '[0-9]{10}') then 'apn-not-in-roll'
    when contains(x.apn, '*') then 'apn-masked'
    else 'apn-malformed'
  end as apn_cause,
  a.house, a.fraction, a.direction, a.street_key,
  case when regexp_full_match(trim(x.zip_code), '[0-9]{5}') then trim(x.zip_code) end as zip
from ${permits} x
left join _permit_address a on a.primary_address = x.primary_address;

create temp table _direct as
select x.permit_nbr, r.parcel_identifier
from _permit x join ${property} r on r.parcel_identifier = x.apn10;

create temp table _candidate as
select x.permit_nbr, r.parcel_identifier, r.direction, r.fraction, r.zip, r.condo_use,
  r.zip = x.zip
    and (x.direction is null or r.direction is null or x.direction = r.direction)
    and (x.fraction is null or r.fraction is null or x.fraction = r.fraction) as agrees,
  x.book_page is null or left(r.parcel_identifier, 7) = x.book_page as in_book_page
from _permit x
join _roll_address r on r.house = x.house and r.street_key = x.street_key
where x.zip is not null
  and x.permit_nbr not in (select permit_nbr from _direct);

create temp table _outcome as
select permit_nbr,
  count(*) as n_street,
  count(*) filter (where agrees) as n_agree,
  count(*) filter (where agrees and in_book_page) as n_final,
  coalesce(bool_and(condo_use) filter (where agrees and in_book_page), false) as all_condo,
  count(distinct concat_ws('|', coalesce(direction, ''), coalesce(fraction, ''), zip))
    filter (where agrees and in_book_page) as n_full_address
from _candidate group by permit_nbr;

create table permit_parcel as
select permit_nbr as permit_number, parcel_identifier, 'direct' as join_method,
  false as building_level, ${v} as join_rule_version
from _direct
union all
select c.permit_nbr, c.parcel_identifier,
  case when o.n_final = 1 then 'address' else 'condo-building' end,
  o.n_final > 1, ${v}
from _candidate c join _outcome o using (permit_nbr)
where c.agrees and c.in_book_page
  and (o.n_final = 1 or (o.all_condo and o.n_full_address = 1))
order by permit_number, parcel_identifier;

create table permit_join as
select x.permit_nbr as permit_number,
  case
    when d.permit_nbr is not null then 'direct'
    when o.n_final = 1 then 'address'
    when o.n_final > 1 and o.all_condo and o.n_full_address = 1 then 'condo-building'
  end as join_method,
  case
    when d.permit_nbr is not null or o.n_final = 1
      or (o.n_final > 1 and o.all_condo and o.n_full_address = 1) then null
    else x.apn_cause || '/' || case
      when x.house is null or x.street_key is null or x.zip is null then 'no-usable-address'
      when o.permit_nbr is null then 'no-address-match'
      when o.n_agree = 0 then 'zip-or-direction-disagrees'
      when o.n_final = 0 then 'book-page-disagrees'
      else 'address-ambiguous'
    end
  end as unjoined_cause,
  ${v} as join_rule_version
from _permit x
left join _direct d on d.permit_nbr = x.permit_nbr
left join _outcome o on o.permit_nbr = x.permit_nbr
order by permit_number;

drop table _roll_street; drop table _roll_house; drop table _permit_address;
drop table _roll_address; drop table _permit; drop table _direct;
drop table _candidate; drop table _outcome;
`);
}

/** Join counts: permits by method and unjoined by cause (each permit once). */
export const JOIN_BY_METHOD_SQL = `
select coalesce(join_method, 'unjoined') as join_method, count(*) as permits
from permit_join group by 1 order by 1`;
export const UNJOINED_BY_CAUSE_SQL = `
select unjoined_cause, count(*) as permits
from permit_join where join_method is null group by 1 order by 1`;
/** Condo buildings: permits attached at building level and the unit links they make. */
export const CONDO_BUILDINGS_SQL = `
select count(distinct permit_number) as permits, count(*) as unit_links,
  count(distinct parcel_identifier) as units
from permit_parcel where building_level`;
