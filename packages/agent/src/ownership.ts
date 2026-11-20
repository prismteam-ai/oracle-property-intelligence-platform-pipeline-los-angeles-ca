/**
 * The ownership filter of search_aged_roofs (parcels.search ownership_basis): its three bases and the texts the
 * answer states with each. The texts are the contract's OWNERSHIP_BASIS and OWNERSHIP_PROXY_NOTE, typed against
 * them (a type-only import, as tools.ts does for DEFAULT_MIN_OPEN_DAYS), so a different wording here or in the
 * API fails the typecheck.
 */
import type {
  OWNERSHIP_BASIS as API_OWNERSHIP_BASIS,
  OWNERSHIP_PROXY_NOTE as API_OWNERSHIP_PROXY_NOTE,
  OwnershipBasis,
} from "@oracle-la/api/contract";

/** The bases parcels.search accepts, in the order the tool offers them. */
export const OWNERSHIP_BASES = [
  "recording",
  "base_year",
  "both",
] as const satisfies readonly OwnershipBasis[];
/** The basis when the filter is on and no basis is named (as the CRM and the Explorer preselect it). */
export const DEFAULT_OWNERSHIP_BASIS = "both" satisfies OwnershipBasis;

/** Every basis of the contract is offered: a basis added there and not here fails the typecheck. */
const ALL_BASES: Record<
  Exclude<OwnershipBasis, (typeof OWNERSHIP_BASES)[number]>,
  never
> = {};
void ALL_BASES;

/** What each basis means and its weakness, in plain words (the contract's OWNERSHIP_BASIS). */
export const OWNERSHIP_TEXTS: typeof API_OWNERSHIP_BASIS = {
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

/** Stated with every basis: what all three are (the contract's OWNERSHIP_PROXY_NOTE). */
export const OWNERSHIP_PROXY_NOTE: typeof API_OWNERSHIP_PROXY_NOTE =
  "All three bases are proxies from the County assessor roll, not sales records: neither date is a sale date.";

/** The ownership filter a search applied, as the tool returns it. */
export interface OwnershipStated {
  basis: OwnershipBasis;
  text: string;
  weakness: string;
  proxy_note: string;
}

export function ownershipStated(basis: OwnershipBasis): OwnershipStated {
  return {
    basis,
    text: OWNERSHIP_TEXTS[basis].text,
    weakness: OWNERSHIP_TEXTS[basis].weakness,
    proxy_note: OWNERSHIP_PROXY_NOTE,
  };
}

/** The rule line of an answer whose search used an ownership basis: the basis, its text, weakness and proxy note. */
export function ownershipRuleLine(basis: OwnershipBasis): string {
  const o = ownershipStated(basis);
  return `Ownership filter (basis "${basis}"): ${o.text} Weakness: ${o.weakness} ${o.proxy_note}`;
}
