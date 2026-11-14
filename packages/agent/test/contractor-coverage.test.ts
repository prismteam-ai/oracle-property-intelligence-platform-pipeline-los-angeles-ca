/** The contractor rows' window from explorer.sources (contractor-coverage.ts): pure functions, no network. */
import type { SourceRow, Sources } from "@oracle-la/api/contract";
import { beforeAll, describe, expect, test } from "vitest";
import {
  GAP_CONTRACTOR_NO_WINDOW,
  GAP_CONTRACTOR_WINDOW_UNREAD,
  answerStandardGaps,
  contractorGaps,
  contractorWindow,
  monthYear,
} from "../src/contractor-coverage.ts";
import { GAP_CONTRACTOR_DEFAULT, STANDARD_GAPS } from "../src/policy.ts";
import { CONTRACTOR_COVERAGE, blockNetwork, fakeQueries } from "./helpers.ts";

beforeAll(blockNetwork);

const fakeSources = () => fakeQueries().queries.explorer.sources();
const contractorRow = async (
  extra: Partial<SourceRow>,
): Promise<SourceRow> => ({
  ...(await fakeSources()).sources.find((s) => s.source_kind === "contractor")!,
  ...extra,
});
const only = (...rows: SourceRow[]): Sources => ({ sources: rows, pages: [] });

describe("monthYear", () => {
  test("a YYYY-MM-DD date to its month and year; anything else null", () => {
    expect(monthYear("2023-05-19")).toBe("May 2023");
    expect(monthYear("2013-01-02")).toBe("January 2013");
    expect(monthYear("2024-12-31")).toBe("December 2024");
    for (const bad of ["2023-13-01", "2023-00-10", "2023-5-19", "May 2023", ""])
      expect(monthYear(bad), bad).toBeNull();
  });
});

describe("contractorWindow", () => {
  test("the contractor source and its coverage, as explorer.sources serves them", async () => {
    expect(contractorWindow(await fakeSources())).toEqual({
      source_name: "LADBS Contractors",
      ...CONTRACTOR_COVERAGE,
    });
  });
  test("several contractor sources: names joined, the earliest first and the latest last", async () => {
    const a = await contractorRow({});
    const b = await contractorRow({
      source_name: "LADBS Contractors (later)",
      coverage: {
        field: "permit_issue_date",
        first: "2020-06-01",
        last: "2024-02-29",
      },
    });
    expect(contractorWindow(only(b, a))).toEqual({
      source_name: "LADBS Contractors (later); LADBS Contractors",
      field: "permit_issue_date",
      first: "2013-01-02",
      last: "2024-02-29",
    });
  });
  test("null without a stated window: no coverage, a coverage that is not dates, or no contractor source; never a guess", async () => {
    expect(
      contractorWindow(only(await contractorRow({ coverage: null }))),
    ).toBeNull();
    const absent = await contractorRow({});
    delete absent.coverage;
    expect(contractorWindow(only(absent))).toBeNull();
    expect(
      contractorWindow(
        only(
          await contractorRow({
            coverage: { field: "permit_issue_date", first: "2013", last: "?" },
          }),
        ),
      ),
    ).toBeNull();
    const src = await fakeSources();
    expect(
      contractorWindow(
        only(...src.sources.filter((s) => s.source_kind !== "contractor")),
      ),
    ).toBeNull();
    // A permit source with a coverage is not the contractor window.
    const permit = src.sources.find((s) => s.source_kind === "permit")!;
    expect(
      contractorWindow(
        only({ ...permit, coverage: { ...CONTRACTOR_COVERAGE } }),
      ),
    ).toBeNull();
  });
});

describe("contractorGaps and answerStandardGaps", () => {
  const window = { source_name: "LADBS Contractors", ...CONTRACTOR_COVERAGE };
  test("a stated window: the standard sentence (from the data's month), then the source and its window", () => {
    expect(contractorGaps({ status: "stated", window })).toEqual([
      GAP_CONTRACTOR_DEFAULT,
      "The contractor rows (LADBS Contractors) cover permits issued 2013-01-02 to 2023-05-19 (by permit_issue_date).",
    ]);
  });
  test("no window, or the read failed: the documented end and why", () => {
    expect(contractorGaps({ status: "none" })).toEqual([
      GAP_CONTRACTOR_DEFAULT,
      GAP_CONTRACTOR_NO_WINDOW,
    ]);
    expect(contractorGaps({ status: "failed" })).toEqual([
      GAP_CONTRACTOR_DEFAULT,
      GAP_CONTRACTOR_WINDOW_UNREAD,
    ]);
  });
  test("the answer's standard gaps: STANDARD_GAPS in order, the contractor gap in place", () => {
    const gaps = answerStandardGaps({ status: "stated", window });
    expect(gaps).toHaveLength(STANDARD_GAPS.length + 1);
    expect(gaps.filter((g) => STANDARD_GAPS.includes(g))).toEqual([
      ...STANDARD_GAPS,
    ]);
    expect(gaps[STANDARD_GAPS.indexOf(GAP_CONTRACTOR_DEFAULT) + 1]).toMatch(
      /^The contractor rows \(LADBS Contractors\) cover permits issued 2013-01-02 to 2023-05-19/,
    );
  });
});
