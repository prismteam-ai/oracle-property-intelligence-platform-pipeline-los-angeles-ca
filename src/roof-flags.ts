/**
 * Roofing flags for LADBS permits, from the work description (work_desc) and business unit.
 * work_desc is read here only; it is never written to a published table (src/permit-fields.ts).
 *
 * Words: the text is upper-cased and runs of whitespace become one space. A word is a run of the
 * letters A-Z: underscore, digits and every other character separate words. (DuckDB's RE2 `\b`
 * counts digits and "_" as word characters and has no lookaround, so the rules run here in
 * TypeScript, once per distinct description and business unit.)
 *
 * The cache's own flags (summary.json flag_definitions) used substring matching: ROOFING also
 * matched inside SOUNDPROOFING, WATERPROOFING, FIREPROOFING and DAMPPROOFING, "RE ROOF" inside
 * ENTIRE ROOF or RESTRUCTURE ROOF, and its roof_only flagged every Express Permit. Here:
 *  - a re-roof word: a word starting with REROOF or RE-ROOF (REROOFING, REROOFWITH, REROOF99SQRS,
 *    RE-ROOFED; letters before it, as in BATHREROOF, make it no word start), or the two words
 *    RE ROOF, RE ROOFS, RE ROOFED or RE ROOFING;
 *  - roof_r: a re-roof word, or the words ROOF COVER(S/ING/INGS), ROOFING, ROOF TILE(S), or the
 *    phrase COATING TO AN EXISTING ROOF; or the words ENTIRE ROOF(S), or ROOF SYSTEM (letters may
 *    follow SYSTEM, as in ROOF SYSTEMS), when the description also holds a word starting with
 *    REPLAC, REFRAM, REBUIL, RECONSTRUCT (each with or without a hyphen after RE), SHEATH or
 *    SHEATING, or the word NEW (whole-roof replacements and reframes);
 *  - roof_only: the cache's two start patterns ("RE-ROOF WITH CLASS A OR B"; "REROOF WITH <n> SQRS"),
 *    or an Express Permit whose description holds a re-roof word or the word ROOF, ROOFS, ROOFED or
 *    ROOFING. ROOFTOP(S), and ROOF and TOP(S) joined by one separator, are not a roof word;
 *  - so SOUNDPROOF, WATERPROOF, FIREPROOF, DAMPPROOF (and their -ING forms), ENTIRE ROOF or ROOF
 *    SYSTEM without such a word, and RESTRUCTURE, RECONFIGURE or RESTORE ROOF are not roofing on
 *    their own;
 *  - roofing_work = roof_r OR roof_only. Partial repairs stay in (a stated limitation);
 *  - roof_coating_only: roofing_work holds only because of the phrase COATING TO AN EXISTING ROOF
 *    (with the phrase removed, neither flag holds). Such a permit stays in the permit lists but does
 *    not set the effective roof year.
 * Words in a phrase may be separated by a space or "_".
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import { sqlLiteral } from "./property-sql.ts";

export const ROOF_FLAG_RULE_VERSION = "roof-flags-4";
export const EXPRESS_PERMIT = "Express Permit";

/** A whole word or phrase: no letter right before or right after it. */
const word = (body: string, flags = "") =>
  new RegExp(`(?<![A-Z])(?:${body})(?![A-Z])`, flags);
const S = "[ _]";
const REROOF_WORD = new RegExp(
  `(?<![A-Z])(?:RE-?ROOF|RE${S}ROOF(?:S|ED|ING)?(?![A-Z]))`,
);
const COATING = word(`COATING${S}TO${S}AN${S}EXISTING${S}ROOF`);
const COATING_ALL = word(`COATING${S}TO${S}AN${S}EXISTING${S}ROOF`, "g");
const ROOF_R_WORDS = word(
  [`ROOF${S}COVER(?:S|ING|INGS)?`, "ROOFING", `ROOF${S}TILES?`].join("|"),
);
const WHOLE_ROOF = new RegExp(
  `(?<![A-Z])(?:ENTIRE${S}ROOFS?(?![A-Z])|ROOF${S}SYSTEM)`,
);
const WHOLE_ROOF_WORK = new RegExp(
  `(?<![A-Z])(?:RE-?(?:PLAC|FRAM|BUIL|CONSTRUCT)|SHEATH|SHEATING|NEW(?![A-Z]))`,
);
const START_PATTERNS =
  /^(?:RE-ROOF WITH CLASS A OR B|REROOF WITH [0-9]+(?:\.[0-9]+)? SQRS(?![A-Z]))/;
const ROOFTOP_ALL = word("ROOF[^A-Z]?TOPS?", "g");
const ROOF_WORD = word("ROOF(?:S|ED|ING)?");

export interface RoofFlags {
  roof_r: boolean;
  roof_only: boolean;
  roof_coating_only: boolean;
}

/** The description as matched: upper case, whitespace runs as one space, trimmed. */
export const roofText = (workDesc: string | null | undefined) =>
  (workDesc ?? "").toUpperCase().replace(/\s+/g, " ").trim();

function flagsOfText(t: string, businessUnit: string | null | undefined) {
  const roofR =
    REROOF_WORD.test(t) ||
    ROOF_R_WORDS.test(t) ||
    COATING.test(t) ||
    (WHOLE_ROOF.test(t) && WHOLE_ROOF_WORK.test(t));
  const roofOnly =
    START_PATTERNS.test(t) ||
    (businessUnit === EXPRESS_PERMIT &&
      (REROOF_WORD.test(t) || ROOF_WORD.test(t.replace(ROOFTOP_ALL, " "))));
  return { roofR, roofOnly };
}

/** The flags of one permit. */
export function roofFlags(
  workDesc: string | null | undefined,
  businessUnit: string | null | undefined,
): RoofFlags {
  const t = roofText(workDesc);
  const { roofR, roofOnly } = flagsOfText(t, businessUnit);
  const without = flagsOfText(
    t.replace(COATING_ALL, " ").replace(/ +/g, " ").trim(),
    businessUnit,
  );
  return {
    roof_r: roofR,
    roof_only: roofOnly,
    roof_coating_only:
      (roofR || roofOnly) && !(without.roofR || without.roofOnly),
  };
}

/**
 * Create table <target>: every column of <source> (which has work_desc and business_unit) plus
 * roof_r, roof_only, roofing_work, roof_coating_only and roof_flag_rule_version. The rules run once
 * per distinct (work_desc, business_unit) and are joined back.
 */
export async function createRoofFlagsTable(
  c: DuckDBConnection,
  source: string,
  target: string,
): Promise<void> {
  const pairs = (
    await c.runAndReadAll(
      `select distinct work_desc, business_unit from ${source}`,
    )
  ).getRowObjectsJson() as Array<{
    work_desc: string | null;
    business_unit: string | null;
  }>;
  await c.run(`create temp table _roof_flag_map (work_desc varchar, business_unit varchar,
    roof_r boolean, roof_only boolean, roof_coating_only boolean)`);
  const a = await c.createAppender("_roof_flag_map");
  for (const p of pairs) {
    const f = roofFlags(p.work_desc, p.business_unit);
    for (const v of [p.work_desc, p.business_unit])
      if (v === null) a.appendNull();
      else a.appendVarchar(v);
    a.appendBoolean(f.roof_r);
    a.appendBoolean(f.roof_only);
    a.appendBoolean(f.roof_coating_only);
    a.endRow();
  }
  a.closeSync();
  await c.run(`
create table ${target} as
select s.*, m.roof_r, m.roof_only, m.roof_r or m.roof_only as roofing_work, m.roof_coating_only,
  ${sqlLiteral(ROOF_FLAG_RULE_VERSION)} as roof_flag_rule_version
from ${source} s
join _roof_flag_map m
  on m.work_desc is not distinct from s.work_desc
 and m.business_unit is not distinct from s.business_unit;
drop table _roof_flag_map`);
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
