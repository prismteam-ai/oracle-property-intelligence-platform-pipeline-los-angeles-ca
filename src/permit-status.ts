/**
 * Status classes for LADBS permits, from the raw status_desc (trimmed, exact match):
 *  - open-issued: issued and not finished. The only class that counts as open for long-open;
 *  - open-application: plan check and application stages; shown in details only;
 *  - closed: finaled, expired, closed, certificate of occupancy or completion issued, refunded;
 *  - unclear: neither open nor closed (Quality Review Completed, CofO in Progress); counted;
 *  - unmapped: any status not in the table below (new values are counted and reported).
 * open_since is the issue date for open-issued and the submitted date for open-application; the
 * open duration is counted from it to the run's reference date (a parameter, never "now").
 */
import { sqlLiteral as lit } from "./property-sql.ts";

export const PERMIT_STATUS_RULE_VERSION = "permit-status-1";

export type PermitStatusClass =
  "open-issued" | "open-application" | "closed" | "unclear";
export const UNMAPPED_STATUS = "unmapped";

/** Every status_desc value in the permit cache, with its class. */
export const PERMIT_STATUS_CLASSES: Readonly<
  Record<string, PermitStatusClass>
> = {
  Issued: "open-issued",
  "Re-Activate Permit": "open-issued",
  "Permit Extended": "open-issued",
  "Insp Scheduled": "open-issued",
  "Pre-Insp Required": "open-issued",
  "Pre-Insp Completed": "open-issued",
  "Intent to Revoke": "open-issued",

  "PC Info Complete": "open-application",
  "Corrections Issued": "open-application",
  "Verifications in Progress": "open-application",
  "PC Approved": "open-application",
  "Reviewed by Supervisor": "open-application",
  "Not Ready to Issue": "open-application",
  "Ready to Issue": "open-application",
  "PC Assigned": "open-application",
  Submitted: "open-application",
  "No Progress": "open-application",
  "PC in Progress": "open-application",
  "PC Fees Paid": "open-application",
  "Plans on Hold": "open-application",
  "Submitted for Quality Review": "open-application",
  "Re-Submittal Required": "open-application",
  "PC Unassigned": "open-application",
  "PC Extended": "open-application",
  "Hold Released": "open-application",
  "Fees Due": "open-application",
  Recheck: "open-application",
  "Re-Activate Application": "open-application",
  "Re-activate Application": "open-application",
  "PC not Required": "open-application",
  "Additional Fees Due": "open-application",

  "Permit Finaled": "closed",
  "Permit Expired": "closed",
  "Permit Closed": "closed",
  "CofO Issued": "closed",
  "Refund in Progress": "closed",
  "CofO Corrected": "closed",
  "CofO Superseded": "closed",
  "CofC Issued": "closed",
  "OK for CofC": "closed",

  "Quality Review Completed": "unclear",
  "CofO in Progress": "unclear",
};

/** The status that makes a roofing permit set the effective roof year (its status date). */
export const FINALED_STATUS = "Permit Finaled";
/** Classes that count as open for long-open. */
export const LONG_OPEN_CLASSES: readonly PermitStatusClass[] = ["open-issued"];

/** SQL: the class of a status_desc expression ('unmapped' for unknown or null). */
export function permitStatusClassSql(statusExpr: string): string {
  const whens = Object.entries(PERMIT_STATUS_CLASSES)
    .map(([raw, cls]) => `when ${lit(raw)} then ${lit(cls)}`)
    .join(" ");
  return `case trim(${statusExpr}) ${whens} else ${lit(UNMAPPED_STATUS)} end`;
}

/** SQL: open_since from the class, issue date and submitted date expressions (dates). */
export function openSinceSql(
  classExpr: string,
  issueDateExpr: string,
  submittedDateExpr: string,
): string {
  return `case ${classExpr} when 'open-issued' then ${issueDateExpr} when 'open-application' then ${submittedDateExpr} end`;
}

/**
 * SQL: days from open_since to the reference date (YYYY-MM-DD); null when open_since is null or
 * later than the reference date.
 */
export function openDaysSql(
  openSinceExpr: string,
  referenceDate: string,
): string {
  if (!/^\d{4}-\d\d-\d\d$/.test(referenceDate))
    throw new Error(`reference date "${referenceDate}" is not YYYY-MM-DD`);
  const ref = `date ${lit(referenceDate)}`;
  return `case when ${openSinceExpr} <= ${ref} then cast(date_diff('day', ${openSinceExpr}, ${ref}) as integer) end`;
}
