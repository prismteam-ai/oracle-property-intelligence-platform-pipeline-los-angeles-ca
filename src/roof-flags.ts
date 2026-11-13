/**
 * Roofing flags for LADBS permits, from the work description (work_desc) and business unit, with
 * whole-word matching (DuckDB regular expressions, RE2 syntax, `\b` word boundaries). work_desc is
 * read here only; it is never written to a published table (src/permit-fields.ts).
 *
 * The cache's own flags (summary.json flag_definitions) used substring matching, so ROOFING also
 * matched inside SOUNDPROOFING, WATERPROOFING, FIREPROOFING and DAMPPROOFING, and its roof_only
 * flagged every Express Permit. Here:
 *  - roof_r: a whole-word roofing phrase: RE-ROOF / REROOF / RE ROOF (with -S, -ED, -ING),
 *    ROOF COVER(S/ING/INGS), ROOFING, ROOF TILE(S), or COATING TO AN EXISTING ROOF;
 *  - roof_only: the cache's two start patterns ("RE-ROOF WITH CLASS A OR B"; "REROOF WITH <n> SQRS"),
 *    or an Express Permit whose description holds a whole roof word: ROOF(S/ED/ING) or a re-roof
 *    form. ROOFTOP(S), ROOF TOP(S) and ROOF-TOP(S) are not a roof word;
 *  - roofing_work = roof_r OR roof_only. Partial repairs stay in (a stated limitation);
 *  - roof_coating_only: roofing_work holds only because of the phrase COATING TO AN EXISTING ROOF
 *    (with the phrase removed, neither flag holds). Such a permit stays in the permit lists but does
 *    not set the effective roof year.
 * Text is upper-cased and runs of whitespace become one space before matching.
 */
import { sqlLiteral } from "./property-sql.ts";

export const ROOF_FLAG_RULE_VERSION = "roof-flags-1";

const REROOF = String.raw`\bRE[- ]?ROOF(S|ED|ING)?\b`;
export const COATING_PHRASE = String.raw`\bCOATING TO AN EXISTING ROOF\b`;
const ROOF_R = [
  REROOF,
  String.raw`\bROOF COVER(S|ING|INGS)?\b`,
  String.raw`\bROOFING\b`,
  String.raw`\bROOF TILES?\b`,
  COATING_PHRASE,
].join("|");
const START_PATTERNS = [
  String.raw`^RE-ROOF WITH CLASS A OR B`,
  String.raw`^REROOF WITH [0-9]+(\.[0-9]+)? SQRS\b`,
].join("|");
const ROOFTOP = String.raw`\bROOF[- ]?TOPS?\b`;
const ROOF_WORD = String.raw`\bROOF(S|ED|ING)?\b`;
export const EXPRESS_PERMIT = "Express Permit";

const re = (s: string) => sqlLiteral(s);
const roofR = (t: string) => `regexp_matches(${t}, ${re(ROOF_R)})`;
const roofOnly = (t: string, bu: string) =>
  `(regexp_matches(${t}, ${re(START_PATTERNS)}) or (${bu} is not distinct from ${sqlLiteral(EXPRESS_PERMIT)} and (regexp_matches(${t}, ${re(REROOF)}) or regexp_matches(regexp_replace(${t}, ${re(ROOFTOP)}, ' ', 'g'), ${re(ROOF_WORD)}))))`;

/**
 * SQL: create table <target> as every column of <source> plus roof_r, roof_only, roofing_work,
 * roof_coating_only and roof_flag_rule_version. <source> has columns work_desc and business_unit.
 */
export function roofFlagsTableSql(source: string, target: string): string {
  return `
create table ${target} as
with t as (
  select *,
    trim(regexp_replace(upper(coalesce(work_desc, '')), '\\s+', ' ', 'g')) as _roof_text
  from ${source}
), f as (
  select *,
    ${roofR("_roof_text")} as roof_r,
    ${roofOnly("_roof_text", "business_unit")} as roof_only,
    trim(regexp_replace(_roof_text, ${re(COATING_PHRASE)}, ' ', 'g')) as _roof_text_nc
  from t
)
select * exclude (_roof_text, _roof_text_nc),
  roof_r or roof_only as roofing_work,
  (roof_r or roof_only) and not (${roofR("_roof_text_nc")} or ${roofOnly("_roof_text_nc", "business_unit")}) as roof_coating_only,
  ${sqlLiteral(ROOF_FLAG_RULE_VERSION)} as roof_flag_rule_version
from f`;
}

/** The four flag groups (each permit once). */
export const ROOF_FLAG_GROUPS_SQL = (table: string) => `
select
  count(*) filter (where roof_r and not roof_only) as roof_r_only,
  count(*) filter (where roof_only and not roof_r) as roof_only_only,
  count(*) filter (where roof_r and roof_only) as both,
  count(*) filter (where not roof_r and not roof_only) as neither,
  count(*) filter (where roof_coating_only) as coating_only,
  count(*) as total
from ${table}`;

/**
 * A seeded sample of n permits flagged neither, for review: ordered by md5(permit_nbr || ':' || seed),
 * then permit_nbr. md5 rather than DuckDB's hash(), whose values may change between DuckDB versions.
 * The output holds free text: it is written only under the ignored data/ folder, never committed.
 */
export function neitherSampleSql(
  table: string,
  seed: string,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 1) throw new Error("sample size");
  return `
select permit_nbr, permit_type, permit_sub_type, business_unit, work_desc
from ${table}
where not roofing_work
order by md5(permit_nbr || ':' || ${sqlLiteral(seed)}), permit_nbr
limit ${n}`;
}
