import type {
  OWNERSHIP_BASIS,
  OWNERSHIP_PROXY_NOTE,
  OwnershipBasis,
} from "@oracle-la/api-client";

/**
 * The ownership filter's wording, the API contract's own (apps/api/src/contract.ts). Typed against its
 * literal-typed constants, so any other wording fails the typecheck; shown before a search, when a basis is
 * chosen. A result states the basis it applied with the same texts (SearchResult.ownership).
 */
export const OWNERSHIP_TEXTS: typeof OWNERSHIP_BASIS = {
  recording: {
    text: "Owner unchanged for 10 years or more, by recorded documents: no document recorded on the parcel in the 10 years before the run's reference date.",
    weakness:
      "Any recorded document resets it, not only a sale: a refinance or a lien drops a long-time owner.",
  },
  base_year: {
    text: "Owner unchanged for 10 years or more, by reassessment: the parcel's land base year is 10 or more years before the run's reference date (no reassessment since).",
    weakness:
      "Transfers that do not reassess escape it: a transfer between spouses or from parent to child keeps the old base year, so a new owner can pass.",
  },
  both: {
    text: "Owner unchanged for 10 years or more, by both: no recorded document and no reassessment in the 10 years before the run's reference date.",
    weakness:
      "The strictest of the three: a parcel must pass both, so a refinance or a lien still drops a long-time owner, and the fewest parcels pass.",
  },
};
export const PROXY_NOTE: typeof OWNERSHIP_PROXY_NOTE =
  "All three bases are proxies from the County assessor roll, not sales records: neither date is a sale date.";

/** The bases in the selector's order, with short labels; "both" is preselected when the filter is turned on. */
export const BASES: ReadonlyArray<[OwnershipBasis, string]> = [
  ["both", "Both (no recorded document and no reassessment)"],
  ["recording", "No recorded document in 10 years"],
  ["base_year", "No reassessment in 10 years (land base year)"],
];
export const DEFAULT_BASIS: OwnershipBasis = "both";
