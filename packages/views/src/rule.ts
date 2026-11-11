/** Roof-age rule shared by the CLI, the API and the UIs (they show this text). */
export interface RoofAgeRule {
  roll_year: number;
  threshold_years: number;
  /** Parcels qualify when year_built < built_before_year. */
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
      `Roof age is a proxy (assessor year built, not a roof installation date): older than ${thresholdYears} years ` +
      `means built before ${builtBefore} (roll year ${rollYear} - ${thresholdYears}), i.e. ${builtBefore - 1} or earlier. ` +
      `Parcels without a year built or coordinates are excluded.`,
  };
}
