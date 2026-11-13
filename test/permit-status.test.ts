import { DuckDBInstance } from "@duckdb/node-api";
import { expect, test } from "vitest";
import {
  LONG_OPEN_CLASSES,
  openDaysSql,
  openSinceSql,
  PERMIT_STATUS_CLASSES,
  permitStatusClassSql,
} from "../src/permit-status.ts";
import { sqlLiteral as lit } from "../src/property-sql.ts";

// Every status_desc value in the permit cache's summary, with its class.
const STATUSES: Array<[string, string]> = [
  ["Permit Finaled", "closed"],
  ["Issued", "open-issued"],
  ["Permit Expired", "closed"],
  ["Permit Closed", "closed"],
  ["CofO Issued", "closed"],
  ["Quality Review Completed", "unclear"],
  ["PC Info Complete", "open-application"],
  ["Corrections Issued", "open-application"],
  ["Verifications in Progress", "open-application"],
  ["PC Approved", "open-application"],
  ["Reviewed by Supervisor", "open-application"],
  ["Refund in Progress", "closed"],
  ["CofO Corrected", "closed"],
  ["Not Ready to Issue", "open-application"],
  ["Re-Activate Permit", "open-issued"],
  ["CofO in Progress", "unclear"],
  ["Ready to Issue", "open-application"],
  ["PC Assigned", "open-application"],
  ["Submitted", "open-application"],
  ["No Progress", "open-application"],
  ["PC in Progress", "open-application"],
  ["PC Fees Paid", "open-application"],
  ["Plans on Hold", "open-application"],
  ["Submitted for Quality Review", "open-application"],
  ["Re-Submittal Required", "open-application"],
  ["CofO Superseded", "closed"],
  ["PC Unassigned", "open-application"],
  ["PC Extended", "open-application"],
  ["CofC Issued", "closed"],
  ["Intent to Revoke", "open-issued"],
  ["Pre-Insp Required", "open-issued"],
  ["Hold Released", "open-application"],
  ["Fees Due", "open-application"],
  ["Recheck", "open-application"],
  ["Insp Scheduled", "open-issued"],
  ["OK for CofC", "closed"],
  ["Permit Extended", "open-issued"],
  ["Re-Activate Application", "open-application"],
  ["Re-activate Application", "open-application"],
  ["Pre-Insp Completed", "open-issued"],
  ["PC not Required", "open-application"],
  ["Additional Fees Due", "open-application"],
];

async function evalSql(expr: string): Promise<unknown> {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  const r = (await c.runAndReadAll(`select ${expr} as v`)).getRowObjectsJson();
  c.closeSync();
  db.closeSync();
  return r[0]!.v;
}

test("the table holds exactly the 42 statuses of the cache", () => {
  expect(STATUSES).toHaveLength(42);
  expect(Object.keys(PERMIT_STATUS_CLASSES).sort()).toEqual(
    STATUSES.map((s) => s[0]).sort(),
  );
});

test.each(STATUSES)("%s → %s (in SQL)", async (raw, cls) => {
  expect(await evalSql(permitStatusClassSql(lit(` ${raw} `)))).toBe(cls);
});

test.each([["Permit Revoked"], ["issued"], [""]])(
  "unknown status %j → unmapped",
  async (raw) => {
    expect(await evalSql(permitStatusClassSql(lit(raw)))).toBe("unmapped");
  },
);

test("a null status is unmapped", async () => {
  expect(await evalSql(permitStatusClassSql("null::varchar"))).toBe("unmapped");
});

test("only open-issued counts as open for long-open", () => {
  expect(LONG_OPEN_CLASSES).toEqual(["open-issued"]);
});

test.each([
  ["open-issued", "2020-01-01"],
  ["open-application", "2019-06-30"],
  ["closed", null],
  ["unclear", null],
  ["unmapped", null],
])("open_since for %s", async (cls, since) => {
  const v = await evalSql(
    `${openSinceSql(lit(cls), "date '2020-01-01'", "date '2019-06-30'")}::varchar`,
  );
  expect(v).toBe(since);
});

test("open_days counts to the reference date, never past it", async () => {
  expect(await evalSql(openDaysSql("date '2021-11-12'", "2026-11-12"))).toBe(
    1826,
  );
  expect(await evalSql(openDaysSql("date '2026-11-12'", "2026-11-12"))).toBe(0);
  expect(await evalSql(openDaysSql("date '2026-11-13'", "2026-11-12"))).toBe(
    null,
  );
  expect(await evalSql(openDaysSql("null::date", "2026-11-12"))).toBe(null);
  expect(() => openDaysSql("x", "now")).toThrow(/not YYYY-MM-DD/);
});
