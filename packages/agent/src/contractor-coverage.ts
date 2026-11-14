/**
 * The contractor rows' window, from the run's own sources: explorer.sources' contractor source and its coverage
 * (SourceRow.coverage: the first and last permit_issue_date of the contractor view). The "no contractor license
 * data after <month>" gap and the system prompt's contractor lines name that source and window instead of a fixed
 * date.
 */
import type { SourceCoverage } from "@oracle-la/api/contract";
import type { SourceList } from "./permit-api.ts";
import { GAP_CONTRACTOR_DEFAULT, STANDARD_GAPS } from "./policy.ts";

/** The contractor source(s) and their coverage window, as the run states them. */
export interface ContractorWindow {
  /** The contractor source's name ("; "-joined when the run lists several). */
  source_name: string;
  /** The field the window is taken over (permit_issue_date). */
  field: string;
  /** First and last date of the window, YYYY-MM-DD. */
  first: string;
  last: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "2023-05-19" → "May 2023"; null for anything that is not a YYYY-MM-DD date. */
export function monthYear(day: string): string | null {
  const m = DAY.exec(day);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${m[1]}` : null;
}

const isCoverage = (c: unknown): c is SourceCoverage =>
  !!c &&
  typeof c === "object" &&
  typeof (c as SourceCoverage).field === "string" &&
  typeof (c as SourceCoverage).first === "string" &&
  typeof (c as SourceCoverage).last === "string" &&
  monthYear((c as SourceCoverage).first) !== null &&
  monthYear((c as SourceCoverage).last) !== null;

/**
 * The contractor window of a run's sources: the contractor rows with a coverage, over their combined window (the
 * earliest first, the latest last); null when no contractor source states one (runs recorded before the field, or
 * no contractor source at all). Nothing is guessed.
 */
export function contractorWindow(src: SourceList): ContractorWindow | null {
  const rows = src.sources.filter(
    (s) => s.source_kind === "contractor" && isCoverage(s.coverage),
  );
  if (!rows.length) return null;
  const cov = rows.map((r) => r.coverage as SourceCoverage);
  const firsts = cov.map((c) => c.first).sort();
  const lasts = cov.map((c) => c.last).sort();
  return {
    source_name: [...new Set(rows.map((r) => r.source_name))].join("; "),
    field: [...new Set(cov.map((c) => c.field))].join("; "),
    first: firsts[0]!,
    last: lasts.at(-1)!,
  };
}

/** How the window was read for one answer: the window, none stated (null), or the read failed. */
export type WindowRead =
  | { status: "stated"; window: ContractorWindow }
  | { status: "none" }
  | { status: "failed" };

export const GAP_CONTRACTOR_NO_WINDOW =
  "The run's sources state no coverage window for the contractor rows: the end above is the documented one, not read from this run.";
export const GAP_CONTRACTOR_WINDOW_UNREAD =
  "The contractor rows' coverage window could not be read from the run's sources: the end above is the documented one, not read from this run.";

/**
 * The contractor gap of an answer. With a stated window: "No contractor license data after <month of the last
 * date>." (on the served runs exactly the standard gap's text, so the eval's gap check is unchanged) followed by
 * the source and its window. Without one: the standard gap and why no window is named.
 */
export function contractorGaps(read: WindowRead): string[] {
  if (read.status !== "stated")
    return [
      GAP_CONTRACTOR_DEFAULT,
      read.status === "none"
        ? GAP_CONTRACTOR_NO_WINDOW
        : GAP_CONTRACTOR_WINDOW_UNREAD,
    ];
  const w = read.window;
  return [
    `No contractor license data after ${monthYear(w.last)}.`,
    `The contractor rows (${w.source_name}) cover permits issued ${w.first} to ${w.last} (by ${w.field}).`,
  ];
}

/** The standard gaps of an answer: STANDARD_GAPS with the contractor gap from the run's window. */
export function answerStandardGaps(read: WindowRead): string[] {
  return STANDARD_GAPS.flatMap((g) =>
    g === GAP_CONTRACTOR_DEFAULT ? contractorGaps(read) : [g],
  );
}
