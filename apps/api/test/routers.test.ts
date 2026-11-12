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
import { appRouter } from "../src/routers/index.ts";
import type { Ctx } from "../src/trpc.ts";
import {
  hasRealData,
  PARQUET_FILE,
  PARQUET_PATH,
  PARQUET_SHA256,
  RUN_ID,
  stageRealData,
} from "./helpers.ts";

const VAN_NUYS = { lat: 34.199, lon: -118.487 };
const SOURCE = "LA County Assessor - Assessor Parcel Data Roll 2026";
// Measured on the county run 2026-11-12T01-44-04-047Z (sha256 44dab72e...) with plain SQL on the Parquet
// columns, without the views or the macro. That check also showed the bounding-box prefilter gives rows
// identical to a plain haversine scan at 1, 5 and 10 mi and in every other case checked.
const ROWS = 2_428_433;
const PAGES = 2_429;

/** REQUIRE_REAL_DATA=1: a missing data/ is a failure, not a skip (for runs that must check the real data). */
const REQUIRE_REAL_DATA = process.env.REQUIRE_REAL_DATA === "1";
/** The real-data checks, counted as they are declared, so a run without data/ can say how many it skipped. */
let realChecks = 0;
/** Vitest's test, counting each real-data check (every test in this file except the REQUIRE_REAL_DATA one). */
const test = (name: string, fn: () => Promise<void>) => {
  realChecks++;
  vitestTest(name, fn);
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
  test("explorer.runSummary: 2,428,433 parcels, roll 2026, history has the run", async () => {
    const s = await caller.explorer.runSummary();
    expect(s.run).toMatchObject({ run_id: RUN_ID, roll_year: "2026" });
    expect((s.run.row_counts as Record<string, number>).parquet).toBe(ROWS);
    expect(s.history.map((h) => h.run_id)).toContain(RUN_ID);
  });
  test("explorer.sources: one source, 2,429 pages with request URL, time and sha256", async () => {
    const s = await caller.explorer.sources();
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]).toMatchObject({
      source_name: SOURCE,
      record_count: ROWS,
      page_count: PAGES,
    });
    expect(s.pages).toHaveLength(PAGES);
    for (const p of s.pages) {
      expect(p.source_request_url).toMatch(
        /^https:\/\/services\.arcgis\.com\/.+\/FeatureServer\/0\/query\?/,
      );
      expect(p.source_retrieved_at).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      );
      expect(p.source_page_sha256).toMatch(/^[0-9a-f]{64}$/);
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
    expect(b.items[0]!.parcel_id > a.items.at(-1)!.parcel_id).toBe(true);
  });
  test("parcels.search: 143,389 at 5 mi / 15 y; every item inside the radius; rule text", async () => {
    const r = await caller.parcels.search({
      ...VAN_NUYS,
      radius_miles: 5,
      threshold_years: 15,
      limit: 100,
    });
    expect(r.count).toBe(143389);
    expect(r.rule.built_before_year).toBe(2011);
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
    ).toBe(5114);
    expect(
      (
        await caller.parcels.search({
          ...VAN_NUYS,
          radius_miles: 5,
          threshold_years: 30,
        })
      ).count,
    ).toBe(137789);
    expect(
      (
        await caller.parcels.search({
          ...VAN_NUYS,
          radius_miles: 5,
          threshold_years: 80,
        })
      ).count,
    ).toBe(7616);
  });
  test("parcels.points at 1 mi: all 5,114 points, not truncated, well under the response limit", async () => {
    const p = await caller.parcels.points({
      ...VAN_NUYS,
      radius_miles: 1,
      threshold_years: 15,
    });
    expect(p.count).toBe(5114);
    expect(p.id).toHaveLength(5114);
    expect(p.truncated).toBe(false);
    const bytes = Buffer.byteLength(JSON.stringify(p));
    expect(bytes).toBeLessThan(MAX_RESPONSE_BYTES / 3);
  });
  test("parcels.points at 10 mi: count 373,785, the nearest 25,000 points, truncated, under 3,000,000 bytes", async () => {
    metrics.length = 0;
    const p = await caller.parcels.points({
      ...VAN_NUYS,
      radius_miles: 10,
      threshold_years: 15,
    });
    expect(p.count).toBe(373785);
    expect(p.id).toHaveLength(MAX_POINTS);
    expect(p.id.length).toBe(25_000);
    expect(p.truncated).toBe(true);
    expect(p.max_points).toBe(MAX_POINTS);
    // The 25,000th nearest (distance, then parcel ID) is 2654041044, about 2.309 mi away.
    expect(p.id.at(-1)).toBe("2654041044");
    const bytes = Buffer.byteLength(JSON.stringify(p));
    expect(bytes).toBeLessThan(3_000_000);
    expect(metrics).toEqual([["PointsResponseBytes", bytes]]);
  });
  test("the bounding-box prefilter changes nothing: the macro equals a plain haversine scan at 1, 5 and 10 mi", async () => {
    for (const miles of [1, 5, 10]) {
      const a = [15, VAN_NUYS.lat, VAN_NUYS.lon, miles];
      const plain = `select parcel_id from oracle.v_property
        where latitude is not null and longitude is not null and year_built < roll_year - $1
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
        n_plain: { 1: 5114, 5: 143389, 10: 373785 }[miles],
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
    // The points are ordered by distance: the first 40 are within 1 mi, the last 40 about 2.3 mi away.
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
