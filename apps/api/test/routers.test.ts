import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test as vitestTest } from "vitest";
import {
  MAX_MATCH_IDS,
  MAX_POINTS,
  MAX_RESPONSE_BYTES,
} from "../src/contract.ts";
import { openDb, type Db } from "../src/db.ts";
import { PAGE_FILE } from "../src/routers/explorer.ts";
import { appRouter } from "../src/routers/index.ts";
import type { Ctx } from "../src/trpc.ts";
import {
  hasRealData,
  PARQUET_FILE,
  PARQUET_PATH,
  PARQUET_SHA256,
  PERMIT_FILES,
  RUN_ID,
  stageRealData,
} from "./helpers.ts";

const VAN_NUYS = { lat: 34.199, lon: -118.487 };
const SOURCE = "LA County Assessor - Assessor Parcel Data Roll 2026";
const PERMIT_SOURCE =
  "LADBS building permits (City of Los Angeles, data.lacity.org)";
const CONTRACTOR_SOURCE =
  "LADBS roofing permits, contractor view (data.lacity.org 8guu-8f5m)";
// Parcel and page counts measured on the county run 2026-11-12T01-44-04-047Z (sha256 44dab72e...) with plain
// SQL on the Parquet columns, without the views or the macro; the permits run has the same roll rows. That
// check also showed the bounding-box prefilter gives rows identical to a plain haversine scan at 1, 5 and
// 10 mi and in every other case checked. The roof-age and permit counts below were measured on the permits
// run 2026-11-12T14-00-51-383Z through the API (and checked against plain SQL on the views where a test says so).
const ROWS = 2_428_433;
const PAGES = 2_429;
const PERMITS = 296_909;
const CONTRACTOR_ROWS = 113_642;

/** REQUIRE_REAL_DATA=1: a missing data/ is a failure, not a skip (for runs that must check the real data). */
const REQUIRE_REAL_DATA = process.env.REQUIRE_REAL_DATA === "1";
/** The real-data checks, counted as they are declared, so a run without data/ can say how many it skipped. */
let realChecks = 0;
/**
 * Vitest's test, counting each real-data check (every test in this file except the REQUIRE_REAL_DATA one).
 * Each check gets 30 s: alone, none takes 2 s, but the full suite runs every test file in parallel.
 */
const test = (name: string, fn: () => Promise<void>) => {
  realChecks++;
  vitestTest(name, fn, 30_000);
};

describe.skipIf(!hasRealData)("routers on the real latest run", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  let db: Db;
  const metrics: Array<[string, number]> = [];
  beforeAll(async () => {
    db = await openDb({
      runId: RUN_ID,
      parquetSha256: PARQUET_SHA256,
      parquetFile: PARQUET_FILE,
      permitFiles: PERMIT_FILES,
      localDir: stageRealData(),
      tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
    });
    const ctx: Ctx = {
      db: async () => db,
      logger: { info() {}, warn() {} },
      metrics: { addMetric: (n, _u, v) => void metrics.push([n, v]) },
    };
    caller = appRouter.createCaller(ctx);
  });

  test("meta.info reports the run and a verified sha256", async () => {
    expect(await caller.meta.info()).toMatchObject({
      run_id: RUN_ID,
      parquet_sha256: PARQUET_SHA256,
      sha256_verified: true,
    });
  });
  test("meta.info: the permit files' verified sha256 equal the history row's, and the reference date", async () => {
    const m = await caller.meta.info();
    expect(m.permit_files).toEqual(
      PERMIT_FILES.map((f) => ({ role: f.role, sha256: f.sha256 })),
    );
    expect(m.reference_date).toBe("2026-11-12");
  });
  test("explorer.runSummary: 2,428,433 parcels, roll 2026, history has the run", async () => {
    const s = await caller.explorer.runSummary();
    expect(s.run).toMatchObject({ run_id: RUN_ID, roll_year: "2026" });
    expect((s.run.row_counts as Record<string, number>).parquet).toBe(ROWS);
    expect(s.history.map((h) => h.run_id)).toContain(RUN_ID);
  });
  test("explorer.runSummary: permit coverage, 805,901 parcels with permit data", async () => {
    const s = await caller.explorer.runSummary();
    expect(s.run.coverage).toMatchObject({
      permit_data: {
        parcels_with_permit_data: 805_901,
        parcels_without_permit_data: 1_622_532,
        parcels_with_permits: 279_900,
      },
    });
  });
  test("explorer.sources: three sources; 2,429 roll, 10 permit and 3 contractor pages, each with request URL, time and sha256", async () => {
    const s = await caller.explorer.sources();
    expect(
      s.sources.map((x) => [
        x.source_kind,
        x.source_name,
        x.record_count,
        x.page_count,
      ]),
    ).toEqual([
      ["parcel", SOURCE, ROWS, PAGES],
      ["permit", PERMIT_SOURCE, PERMITS, 10],
      ["contractor", CONTRACTOR_SOURCE, CONTRACTOR_ROWS, 3],
    ]);
    expect(s.sources[2]).toMatchObject({
      license: "CC BY 4.0",
      attribution: "LADBS",
    });
    expect(s.pages).toHaveLength(PAGES + 13);
    for (const p of s.pages) {
      expect(p.source_request_url).toMatch(
        p.source_kind === "parcel"
          ? /^https:\/\/services\.arcgis\.com\/.+\/FeatureServer\/0\/query\?/
          : /^https:\/\/data\.lacity\.org\/resource\/[a-z0-9]{4}-[a-z0-9]{4}\.json\?/,
      );
      expect(p.source_retrieved_at).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      );
      expect(p.source_page_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
  test("explorer.records pages permits and contractor rows with their cursors; page files filter", async () => {
    const p = await caller.explorer.records({
      source_name: PERMIT_SOURCE,
      limit: 50,
    });
    expect(p).toMatchObject({ source_kind: "permit", total: PERMITS });
    const p2 = await caller.explorer.records({
      source_name: PERMIT_SOURCE,
      after: p.next_after!,
      limit: 50,
    });
    expect(p2.items[0]!.record_key > p.items.at(-1)!.record_key).toBe(true);
    const c = await caller.explorer.records({
      source_name: CONTRACTOR_SOURCE,
      limit: 100,
    });
    expect(c).toMatchObject({
      source_kind: "contractor",
      total: CONTRACTOR_ROWS,
    });
    const c2 = await caller.explorer.records({
      source_name: CONTRACTOR_SOURCE,
      after: c.next_after!,
      limit: 100,
    });
    expect(c2.items).toHaveLength(100);
    expect(
      new Set([...c.items, ...c2.items].map((i) => i.record_key)).size,
    ).toBe(200);
    // Every page file of the run passes the page_file pattern; one page per kind filters to its own records.
    const s = await caller.explorer.sources();
    for (const pg of s.pages)
      expect(PAGE_FILE.test(pg.source_page_file), pg.source_page_file).toBe(
        true,
      );
    for (const kind of ["parcel", "permit", "contractor"]) {
      const pg = s.pages.find((x) => x.source_kind === kind)!;
      const r = await caller.explorer.records({
        source_name: pg.source_name,
        page_file: pg.source_page_file,
        limit: 1,
      });
      expect(r.total, pg.source_page_file).toBe(pg.record_count);
    }
  });
  test("explorer.records pages by parcel id", async () => {
    const a = await caller.explorer.records({
      source_name: SOURCE,
      limit: 50,
    });
    expect(a.total).toBe(ROWS);
    const b = await caller.explorer.records({
      source_name: SOURCE,
      after: a.next_after!,
      limit: 50,
    });
    expect(b.items[0]!.parcel_id! > a.items.at(-1)!.parcel_id!).toBe(true);
  });
  test("parcels.search on the effective roof year: 113,632 at 5 mi / 15 y; every item inside the radius; rule text", async () => {
    const r = await caller.parcels.search({
      ...VAN_NUYS,
      radius_miles: 5,
      threshold_years: 15,
      limit: 100,
    });
    expect(r.count).toBe(113632);
    expect(r.rule.built_before_year).toBe(2011);
    expect(r.rule.text).toMatch(/PERMIT.*PROXY|PROXY.*PERMIT/s);
    for (const i of r.items) expect(i.effective_roof_year).toBeLessThan(2011);
    expect(
      Math.max(...r.items.map((i) => i.distance_miles)),
    ).toBeLessThanOrEqual(5);
    expect(
      (
        await caller.parcels.search({
          ...VAN_NUYS,
          radius_miles: 1,
          threshold_years: 15,
        })
      ).count,
    ).toBe(4183);
    expect(
      (
        await caller.parcels.search({
          ...VAN_NUYS,
          radius_miles: 5,
          threshold_years: 30,
        })
      ).count,
    ).toBe(97350);
    expect(
      (
        await caller.parcels.search({
          ...VAN_NUYS,
          radius_miles: 5,
          threshold_years: 80,
        })
      ).count,
    ).toBe(6059);
  });
  test("parcels.points at 1 mi: all 4,183 points, not truncated, well under the response limit", async () => {
    const p = await caller.parcels.points({
      ...VAN_NUYS,
      radius_miles: 1,
      threshold_years: 15,
    });
    expect(p.count).toBe(4183);
    expect(p.id).toHaveLength(4183);
    expect(p.truncated).toBe(false);
    const bytes = Buffer.byteLength(JSON.stringify(p));
    expect(bytes).toBeLessThan(MAX_RESPONSE_BYTES / 3);
  });
  test("parcels.points at 10 mi: count 309,117, the nearest 25,000 points with both 0/1 columns, truncated, under 3,000,000 bytes", async () => {
    metrics.length = 0;
    const p = await caller.parcels.points({
      ...VAN_NUYS,
      radius_miles: 10,
      threshold_years: 15,
    });
    expect(p.count).toBe(309117);
    expect(p.id).toHaveLength(MAX_POINTS);
    expect(p.id.length).toBe(25_000);
    expect(p.truncated).toBe(true);
    expect(p.max_points).toBe(MAX_POINTS);
    // The 25,000th nearest (distance, then parcel ID) is 2259006029, about 2.524 mi away.
    expect(p.id.at(-1)).toBe("2259006029");
    // All 25,000 nearest are in the City of Los Angeles; 806 have a long-open roofing permit (default window;
    // 858 before long-open counted roofing work only).
    expect(p.permit_data_available.filter((x) => x === 1)).toHaveLength(25_000);
    expect(p.long_open_permit.filter((x) => x === 1)).toHaveLength(806);
    const bytes = Buffer.byteLength(JSON.stringify(p));
    expect(bytes).toBeLessThan(3_000_000);
    expect(metrics).toEqual([["PointsResponseBytes", bytes]]);
  });
  test("the bounding-box prefilter changes nothing: the macro equals a plain haversine scan at 1, 5 and 10 mi", async () => {
    for (const miles of [1, 5, 10]) {
      const a = [15, VAN_NUYS.lat, VAN_NUYS.lon, miles];
      const plain = `select parcel_id from oracle.v_property
        where latitude is not null and longitude is not null and effective_roof_year < roll_year - $1
          and oracle.haversine_miles($2, $3, latitude, longitude) <= $4`;
      const macro =
        "select parcel_id from oracle.roof_age_candidates($1, $2, $3, $4)";
      const [r] = await db.rows(
        `select (select count(*) from (${macro}))::integer n_macro, (select count(*) from (${plain}))::integer n_plain,
                (select count(*) from (${macro} except all ${plain}))::integer only_macro,
                (select count(*) from (${plain} except all ${macro}))::integer only_plain`,
        a,
      );
      expect(r, `${miles} mi`).toEqual({
        n_macro: r!.n_plain,
        n_plain: { 1: 4183, 5: 113632, 10: 309117 }[miles],
        only_macro: 0,
        only_plain: 0,
      });
    }
  });
  test("parcels.match: the near half of a points list matches at 1 mi, the far half does not", async () => {
    const p = await caller.parcels.points({
      ...VAN_NUYS,
      radius_miles: 10,
      threshold_years: 15,
    });
    // The points are ordered by distance: the first 40 are within 1 mi, the last 40 about 2.5 mi away.
    const near = p.id.slice(0, MAX_MATCH_IDS / 2);
    const far = p.id.slice(-MAX_MATCH_IDS / 2);
    const m = await caller.parcels.match({
      ...VAN_NUYS,
      radius_miles: 1,
      threshold_years: 15,
      parcel_ids: [...far, ...near],
    });
    expect(m.parcel_ids).toEqual([...near].sort());
    const all = await caller.parcels.match({
      ...VAN_NUYS,
      radius_miles: 10,
      threshold_years: 15,
      parcel_ids: [...far, ...near],
    });
    expect(all.parcel_ids).toEqual([...far, ...near].sort());
  });
  test("parcels.detail returns property and provenance, no personal fields; unknown id is NOT_FOUND", async () => {
    const d = await caller.parcels.detail({ parcel_id: "2224012045" });
    expect(d.property).toMatchObject({
      parcel_id: "2224012045",
      roll_year: 2026,
    });
    expect(d.provenance).toMatchObject({
      parcel_id: "2224012045",
      source_request_method: "GET",
    });
    expect(
      Object.keys(d.property).filter((k) =>
        /owner_?name|mail|contact|phone|email/i.test(k),
      ),
    ).toEqual([]);
    await expect(
      caller.parcels.detail({ parcel_id: "0000000000" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  test("permits.longOpen: 112 / 2,409 / 5,614 long-open roofing permits at 1 / 5 / 10 mi (default 1,826 days), equal to plain SQL on the views", async () => {
    // Roofing work only: 126 / 2,759 / 6,614 without that condition.
    for (const [miles, n] of [
      [1, 112],
      [5, 2409],
      [10, 5614],
    ] as const) {
      expect(
        (await caller.permits.longOpen({ ...VAN_NUYS, radius_miles: miles }))
          .count,
        `${miles} mi`,
      ).toBe(n);
      // Without the macro: distinct open-issued roofing-work permits of at least 1,826 days with a linked
      // parcel inside.
      const [r] = await db.rows(
        `select count(distinct p.permit_number)::integer n
         from oracle.v_permit p join oracle.v_permit_parcel pp using (permit_number)
         join oracle.v_property v using (parcel_id)
         where p.roofing_work and p.permit_status_class = 'open-issued' and p.open_days >= 1826
           and v.latitude is not null
           and oracle.haversine_miles($1, $2, v.latitude, v.longitude) <= $3`,
        [VAN_NUYS.lat, VAN_NUYS.lon, miles],
      );
      expect(r, `${miles} mi plain`).toEqual({ n });
    }
  });
  test("permits.longOpen at 10 mi: each permit once (388 building-level), sorted, max and threshold, first page under 3,000,000 bytes", async () => {
    const r = await caller.permits.longOpen({
      ...VAN_NUYS,
      radius_miles: 10,
      limit: 100,
    });
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(
      MAX_RESPONSE_BYTES,
    );
    const days = r.items.map((i) => i.open_days!);
    expect(days).toEqual([...days].sort((a, b) => b - a));
    for (const i of r.items) {
      expect(i.permit_status_class).toBe("open-issued");
      expect(i.roofing_work).toBe(true);
      expect(i.open_days!).toBeGreaterThanOrEqual(1826);
      expect(i.parcel_id).toMatch(/^\d{10}$/);
    }
    const [once] = await db.rows(
      `select count(*)::integer n, count(distinct permit_number)::integer d,
         count(*) filter (where building_level)::integer bl
       from oracle.long_open_permits(1826, null, null, $1, $2, 10)`,
      [VAN_NUYS.lat, VAN_NUYS.lon],
    );
    expect(once).toEqual({ n: 5614, d: 5614, bl: 388 });
    const near = await caller.permits.longOpen({
      ...VAN_NUYS,
      radius_miles: 10,
      sort: "distance",
      limit: 100,
    });
    const miles = near.items.map((i) => i.distance_miles);
    expect(miles).toEqual([...miles].sort((a, b) => a - b));
    expect(
      (
        await caller.permits.longOpen({
          ...VAN_NUYS,
          radius_miles: 10,
          max_open_days: 3652,
        })
      ).count,
    ).toBe(4167);
    expect(
      (
        await caller.permits.longOpen({
          ...VAN_NUYS,
          radius_miles: 10,
          threshold_years: 15,
        })
      ).count,
    ).toBe(4662);
  });
  test("long-open counts roofing work only: 10,974 joined long-open roofing permits city-wide, 2,318 of 13,292 left out; coating-only permits are roofing work", async () => {
    // Default window (at least 1,826 days to the reference date), permits linked to at least one parcel.
    const split = await db.rows(
      `select p.roofing_work, count(distinct p.permit_number)::integer n
       from oracle.v_permit p join oracle.v_permit_parcel pp using (permit_number)
       where p.permit_status_class = 'open-issued' and p.open_days >= 1826 group by 1 order by 1`,
    );
    expect(split).toEqual([
      { roofing_work: false, n: 2318 },
      { roofing_work: true, n: 10974 },
    ]);
    const [macro] = await db.rows(
      `select count(distinct permit_number)::integer n,
         count(distinct permit_number) filter (where not roofing_work)::integer non_roofing
       from oracle.long_open_parcels(1826, null) join oracle.v_permit using (permit_number)`,
    );
    expect(macro).toEqual({ n: 10974, non_roofing: 0 });
    // Every one of the 574 coating-only permits is roofing work, so the filter keeps them.
    const [coating] = await db.rows(
      `select count(*)::integer n, count(*) filter (where roofing_work)::integer roofing
       from oracle.v_permit where roof_coating_only`,
    );
    expect(coating).toEqual({ n: 574, roofing: 574 });
    const r = await caller.permits.longOpen({ ...VAN_NUYS, radius_miles: 1 });
    expect(r.rule.text).toContain("Roofing work only");
  });
  test("permits.forParcel: the parcel with the most permits (174) under 3,000,000 bytes; outside-LA parcels keep their 60 joined permits", async () => {
    const [top] = await db.rows(
      "select parcel_id, count(*)::integer n from oracle.v_permit_parcel group by 1 order by n desc, parcel_id limit 1",
    );
    const r = await caller.permits.forParcel({
      parcel_id: String(top!.parcel_id),
    });
    expect(r.permits).toHaveLength(174);
    expect(r.bbb.available).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(
      MAX_RESPONSE_BYTES,
    );
    const outside = await db.rows(
      `select pp.parcel_id, count(*)::integer n from oracle.v_permit_parcel pp join oracle.v_property v using (parcel_id)
       where not v.permit_data_available group by 1 order by 1`,
    );
    expect(outside).toHaveLength(61);
    const o = await caller.permits.forParcel({
      parcel_id: String(outside[0]!.parcel_id),
    });
    expect(o.permit_data_available).toBe(false);
    expect(o.jurisdiction).not.toBe("LOS ANGELES");
    expect(o.permits).toHaveLength(Number(outside[0]!.n));
  });
  test("no work description in any view", async () => {
    const cols = await db.rows(
      "select column_name from information_schema.columns where table_schema = 'oracle'",
    );
    expect(
      cols.filter((c) => /work_?desc/i.test(String(c.column_name))),
    ).toEqual([]);
  });
  test("inputs outside LA County or the threshold range are rejected", async () => {
    await expect(
      caller.parcels.search({ lat: 40.7, lon: -74.0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.parcels.search({ ...VAN_NUYS, threshold_years: 121 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // Vitest runs this callback (also when the block is skipped) after the file's top level, so the count
  // is complete only here.
  if (!hasRealData) {
    const rule = "=".repeat(78);
    console.warn(
      [
        rule,
        `REAL-DATA CHECKS SKIPPED: ${realChecks} checks in apps/api/test/routers.test.ts did not run.`,
        `Reason: ${PARQUET_PATH} (run ${RUN_ID}, the latest row of runs/run_history.jsonl) is not in data/,`,
        "which is gitignored and holds the build output. The synthetic tests still ran.",
        REQUIRE_REAL_DATA
          ? "REQUIRE_REAL_DATA=1 is set, so this run fails."
          : "Set REQUIRE_REAL_DATA=1 to make a missing data/ fail the run.",
        rule,
      ].join("\n"),
    );
  }
});

// A missing data/ fails the run when REQUIRE_REAL_DATA=1 (the count is read when the test runs).
if (!hasRealData && REQUIRE_REAL_DATA)
  vitestTest("real data is present (REQUIRE_REAL_DATA=1)", () => {
    expect.fail(
      `${realChecks} real-data checks cannot run: ${PARQUET_PATH} is missing`,
    );
  });
