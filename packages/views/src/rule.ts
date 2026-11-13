/** Roof-age rule shared by the CLI, the API and the UIs (they show this text). */
export interface RoofAgeRule {
  roll_year: number;
  threshold_years: number;
  /** Parcels qualify when effective_roof_year < built_before_year. */
  built_before_year: number;
  text: string;
}

export function roofAgeRule(
  rollYear: number,
  thresholdYears: number,
): RoofAgeRule {
  if (
    !Number.isInteger(rollYear) ||
    !Number.isInteger(thresholdYears) ||
    thresholdYears < 0
  ) {
    throw new Error(
      `invalid roof-age rule input: roll year ${rollYear}, threshold ${thresholdYears}`,
    );
  }
  const builtBefore = rollYear - thresholdYears;
  return {
    roll_year: rollYear,
    threshold_years: thresholdYears,
    built_before_year: builtBefore,
    text:
      `Roof age counts from the effective roof year: the later of the assessor year built (basis PROXY: a proxy, ` +
      `not a roof installation date) and the year of the latest finaled LADBS roofing permit on the parcel ` +
      `(basis PERMIT; City of Los Angeles permits only; a roof coating alone does not count, and a permit dated ` +
      `before the year built is ignored). Older than ${thresholdYears} years means an effective roof year before ` +
      `${builtBefore} (roll year ${rollYear} - ${thresholdYears}), i.e. ${builtBefore - 1} or earlier. ` +
      `Parcels without coordinates or without a roof year are excluded.`,
  };
}

/** Long-open rule shared by the API and the UIs (they show this text). Durations are in days. */
export interface LongOpenRule {
  /** The run's reference date (YYYY-MM-DD): open durations count to it, never to today. */
  reference_date: string;
  /** The only status class counted as open. */
  status_class: "open-issued";
  min_open_days: number;
  /** null: no maximum. */
  max_open_days: number | null;
  text: string;
}

/** Days for a duration given in years: round(years x 365.25) (5 years = 1,826 days). */
export const daysFromYears = (years: number): number =>
  Math.round(years * 365.25);

export function longOpenRule(
  referenceDate: string,
  minOpenDays: number,
  maxOpenDays: number | null,
): LongOpenRule {
  if (
    !/^\d{4}-\d\d-\d\d$/.test(referenceDate) ||
    !Number.isInteger(minOpenDays) ||
    minOpenDays < 0 ||
    (maxOpenDays !== null &&
      (!Number.isInteger(maxOpenDays) || maxOpenDays < minOpenDays))
  ) {
    throw new Error(
      `invalid long-open rule input: ${referenceDate}, ${minOpenDays}, ${maxOpenDays}`,
    );
  }
  const n = (d: number) => d.toLocaleString("en-US");
  const range =
    maxOpenDays === null
      ? `at least ${n(minOpenDays)} days`
      : `between ${n(minOpenDays)} and ${n(maxOpenDays)} days`;
  return {
    reference_date: referenceDate,
    status_class: "open-issued",
    min_open_days: minOpenDays,
    max_open_days: maxOpenDays,
    text:
      `Long-open: an issued LADBS permit still open (status class open-issued) for ${range}, counted from its ` +
      `issue date to the run's reference date ${referenceDate}. Durations are in days; a number of years ` +
      `converts as round(years x 365.25), so 5 years is 1,826 days (the default minimum). Application-stage ` +
      `permits and permits without an issue date do not count. A building-level (condominium) permit counts once, ` +
      `at its nearest unit.`,
  };
}
