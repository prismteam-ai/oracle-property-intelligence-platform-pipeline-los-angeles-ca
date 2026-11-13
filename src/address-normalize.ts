/**
 * Address normalization for the permit-to-parcel join (src/permit-join.ts). One function per side,
 * sharing one street-name rule, so the permit's printed address and the roll's situs fields meet in
 * the same form. Versioned: a change to any rule here changes ADDRESS_RULE_VERSION.
 *
 * Street name (normalizeStreet), applied to both sides:
 *  1. upper case; "." and "," removed; a "#" starts a new word; runs of whitespace become one space;
 *  2. the unit part is cut: from the first word starting with "#", or the first unit word
 *     (UNIT, UNITS, APT, APARTMENT, SUITE, SPC, SPACE, BLDG, RM, ROOM), to the end;
 *  3. suffix words take one form from a fixed table (STREET → ST, AVENUE → AVE, …);
 *  4. everything after the first suffix that is not the first word is cut (unit numbers, ranges,
 *     a trailing direction or other trailing words), so "MAIN ST 1-4" is "MAIN ST" while
 *     "AVENUE 50" stays "AVE 50".
 * Permit address (parsePermitAddress): the house number is the leading integer (a range such as
 * "1234-1240" keeps 1234); a following fraction token (e.g. "1/2") is the fraction; then one
 * direction word N, S, E or W if more words follow; the rest is the street name.
 * Roll house (parseRollHouse): the leading integer of street_number and what follows it.
 */
export const ADDRESS_RULE_VERSION = "address-normalize-1";

export const STREET_SUFFIXES: Readonly<Record<string, string>> = {
  ST: "ST",
  STREET: "ST",
  AVE: "AVE",
  AV: "AVE",
  AVENUE: "AVE",
  BLVD: "BLVD",
  BOULEVARD: "BLVD",
  DR: "DR",
  DRIVE: "DR",
  RD: "RD",
  ROAD: "RD",
  PL: "PL",
  PLACE: "PL",
  LN: "LN",
  LANE: "LN",
  CT: "CT",
  COURT: "CT",
  TER: "TER",
  TERRACE: "TER",
  CIR: "CIR",
  CIRCLE: "CIR",
  WAY: "WAY",
  WY: "WAY",
  HWY: "HWY",
  HIGHWAY: "HWY",
  PKWY: "PKWY",
  PARKWAY: "PKWY",
  TRL: "TRL",
  TRAIL: "TRL",
  WALK: "WALK",
};

const UNIT_WORDS = new Set([
  "UNIT",
  "UNITS",
  "APT",
  "APARTMENT",
  "SUITE",
  "SPC",
  "SPACE",
  "BLDG",
  "RM",
  "ROOM",
]);
const DIRECTIONS = new Set(["N", "S", "E", "W"]);

const tokens = (s: string) =>
  s
    .toUpperCase()
    .replace(/[.,]/g, "")
    .replace(/#/g, " #")
    .split(/\s+/)
    .filter((t) => t !== "");

/** The street-name key, or null when nothing is left. */
export function normalizeStreet(
  street: string | null | undefined,
): string | null {
  if (!street) return null;
  const out: string[] = [];
  for (const t of tokens(street)) {
    if (t.startsWith("#") || UNIT_WORDS.has(t)) break;
    const suffix = STREET_SUFFIXES[t];
    out.push(suffix ?? t);
    if (suffix && out.length > 1) break;
  }
  return out.length ? out.join(" ") : null;
}

export interface PermitAddress {
  house: number;
  fraction: string | null;
  direction: string | null;
  street: string;
}

/** House number, fraction, direction and street key of a printed permit address, or null. */
export function parsePermitAddress(
  address: string | null | undefined,
): PermitAddress | null {
  if (!address) return null;
  const t = tokens(address);
  const m = /^(\d+)(?:-\d+)?$/.exec(t[0] ?? "");
  if (!m) return null;
  let i = 1;
  let fraction: string | null = null;
  if (/^\d+\/\d+$/.test(t[i] ?? "")) fraction = t[i++]!;
  let direction: string | null = null;
  if (DIRECTIONS.has(t[i] ?? "") && t.length > i + 1) direction = t[i++]!;
  const street = normalizeStreet(t.slice(i).join(" "));
  if (!street) return null;
  return { house: Number(m[1]), fraction, direction, street };
}

/**
 * House number and fraction of the roll's street_number (src/property-sql.ts: SitusHouseNo, then
 * SitusFraction, e.g. "1234 1/2"), or null without a leading integer.
 */
export function parseRollHouse(
  streetNumber: string | null | undefined,
): { house: number; fraction: string | null } | null {
  const m = /^(\d+)\s*(.*)$/.exec(streetNumber?.trim().toUpperCase() ?? "");
  if (!m) return null;
  return { house: Number(m[1]), fraction: m[2] || null };
}
