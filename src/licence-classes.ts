/**
 * Licence classes for LADBS contractor rows (license_type, view 8guu-8f5m), as California CSLB
 * classifications. Rules, on upper(trim(raw)):
 *  - "NA": no class; an owner-builder placeholder (is_owner_builder true);
 *  - "N/A", blank or null: no class, no note;
 *  - "ASB", "HAZ": certifications, not classes (cert:ASB, cert:HAZ);
 *  - C plus one or two digits, or the digits alone ("39"): C-<n> (leading zeros dropped);
 *  - "C-<n>": kept;
 *  - D plus two digits: limited specialty C-61/D-<nn>;
 *  - "A", "B": kept;
 *  - a code produced by these rules but not in LICENSE_CLASS_NAMES (e.g. C93), and anything else
 *    (e.g. 2B): unmapped, raw value kept and counted.
 * Column names follow the bundled lexicon's spelling ("license"); license_class* are not lexicon
 * fields (the lexicon's license has no class).
 */
import type { DuckDBConnection } from "@duckdb/node-api";

export const LICENSE_CLASS_RULE_VERSION = "license-class-1";

/** Class names (CSLB classifications; the two certifications are not classes). */
export const LICENSE_CLASS_NAMES: Readonly<Record<string, string>> = {
  A: "General engineering",
  B: "General building",
  "C-2": "Insulation and acoustical",
  "C-4": "Boiler",
  "C-5": "Framing",
  "C-6": "Cabinet, millwork",
  "C-7": "Low voltage",
  "C-8": "Concrete",
  "C-9": "Drywall",
  "C-10": "Electrical",
  "C-11": "Elevator",
  "C-12": "Earthwork and paving",
  "C-13": "Fencing",
  "C-15": "Flooring",
  "C-16": "Fire protection",
  "C-17": "Glazing",
  "C-20": "HVAC",
  "C-21": "Building moving/demolition",
  "C-23": "Ornamental metal",
  "C-27": "Landscaping",
  "C-29": "Masonry",
  "C-33": "Painting",
  "C-35": "Lathing and plastering",
  "C-36": "Plumbing",
  "C-38": "Refrigeration",
  "C-39": "Roofing",
  "C-43": "Sheet metal",
  "C-45": "Signs",
  "C-46": "Solar",
  "C-47": "General manufactured housing",
  "C-50": "Reinforcing steel",
  "C-51": "Structural steel",
  "C-53": "Swimming pool",
  "C-54": "Ceramic tile",
  "C-61/D-03": "Limited specialty: awnings",
  "C-61/D-24": "Limited specialty: metal products",
  "C-61/D-34": "Limited specialty: prefabricated equipment",
  "C-61/D-39": "Limited specialty: scaffolding",
  "C-61/D-41": "Limited specialty: siding and decking",
  "C-61/D-42": "Limited specialty: non-electrical signs",
  "C-61/D-51": "Limited specialty: waterproofing and weatherproofing",
  "C-61/D-59": "Limited specialty: hydroseed spraying",
  "cert:ASB": "Asbestos certification",
  "cert:HAZ": "Hazardous substance removal certification",
};

export type LicenseClassNote =
  "certification" | "unmapped" | "owner-builder" | null;

export interface LicenseClass {
  license_class: string | null;
  license_class_name: string | null;
  license_class_note: LicenseClassNote;
  is_owner_builder: boolean;
}

function code(u: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^C?(\d{1,2})$/.exec(u))) return `C-${Number(m[1])}`;
  if ((m = /^C-(\d+)$/.exec(u))) return `C-${Number(m[1])}`;
  if ((m = /^D(\d{2})$/.exec(u))) return `C-61/D-${m[1]}`;
  if (u === "A" || u === "B") return u;
  if (u === "ASB" || u === "HAZ") return `cert:${u}`;
  return null;
}

/** The class of one raw license_type value. */
export function classifyLicense(raw: string | null | undefined): LicenseClass {
  const u = (raw ?? "").trim().toUpperCase();
  const none = {
    license_class: null,
    license_class_name: null,
    is_owner_builder: false,
  };
  if (u === "" || u === "N/A") return { ...none, license_class_note: null };
  if (u === "NA")
    return {
      ...none,
      license_class_note: "owner-builder",
      is_owner_builder: true,
    };
  const c = code(u);
  const name = c === null ? undefined : LICENSE_CLASS_NAMES[c];
  if (c === null || name === undefined)
    return { ...none, license_class_note: "unmapped" };
  return {
    license_class: c,
    license_class_name: name,
    license_class_note: c.startsWith("cert:") ? "certification" : null,
    is_owner_builder: false,
  };
}

/**
 * Create table <target>(source_license_type, license_class, license_class_name, license_class_note,
 * is_owner_builder) with one row per distinct raw value of <column> in <source> (null included), to
 * be joined with "is not distinct from".
 */
export async function createLicenseClassTable(
  c: DuckDBConnection,
  source: string,
  column: string,
  target: string,
): Promise<void> {
  const raws = (
    (
      await c.runAndReadAll(
        `select distinct ${column} v from ${source} order by 1`,
      )
    ).getRowObjectsJson() as Array<{ v: string | null }>
  ).map((x) => x.v);
  await c.run(`create table ${target} (source_license_type varchar, license_class varchar,
    license_class_name varchar, license_class_note varchar, is_owner_builder boolean)`);
  const a = await c.createAppender(target);
  for (const raw of raws) {
    const k = classifyLicense(raw);
    for (const v of [
      raw,
      k.license_class,
      k.license_class_name,
      k.license_class_note,
    ])
      if (v === null) a.appendNull();
      else a.appendVarchar(v);
    a.appendBoolean(k.is_owner_builder);
    a.endRow();
  }
  a.closeSync();
}
