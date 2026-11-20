import type { RoofAgeBasis } from "@oracle-la/api-client";

/**
 * A roof-age basis label for a table cell, from the stored label's first word: "permit <number>" where a
 * finaled roofing permit set the roof year (PERMIT), "year built (proxy)" otherwise (PROXY).
 */
export const basisLabel = (
  basis: RoofAgeBasis | null,
  permitNumber: string | null,
): string =>
  basis?.startsWith("PERMIT")
    ? `permit ${permitNumber ?? ""}`.trim()
    : basis?.startsWith("PROXY")
      ? "year built (proxy)"
      : "—";
