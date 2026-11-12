import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { MAX_RESPONSE_BYTES } from "../src/contract.ts";
import { openDb, type Db } from "../src/db.ts";
import { appRouter } from "../src/routers/index.ts";
import type { Ctx } from "../src/trpc.ts";
import {
  hasRealData,
  PARQUET_SHA256,
  RUN_ID,
  stageRealData,
} from "./helpers.ts";

const VAN_NUYS = { lat: 34.199, lon: -118.487 };

describe.skipIf(!hasRealData)("routers on the real increment-1 slice", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  const metrics: Array<[string, number]> = [];
  beforeAll(async () => {
    const db: Db = await openDb({
      runId: RUN_ID,
      parquetSha256: PARQUET_SHA256,
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
  test("explorer.runSummary: 22,313 parcels, roll 2026, history has the run", async () => {
    const s = await caller.explorer.runSummary();
    expect(s.run).toMatchObject({ run_id: RUN_ID, roll_year: "2026" });
    expect((s.run.row_counts as Record<string, number>).parquet).toBe(22313);
    expect(s.history.map((h) => h.run_id)).toContain(RUN_ID);
  });
  test("explorer.sources: one source, 23 pages with request URL, time and sha256", async () => {
    const s = await caller.explorer.sources();
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]).toMatchObject({
      source_name: "LA County Assessor - Assessor Parcel Data Roll 2026",
      record_count: 22313,
      page_count: 23,
    });
    expect(s.pages).toHaveLength(23);
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
      source_name: "LA County Assessor - Assessor Parcel Data Roll 2026",
      limit: 50,
    });
    expect(a.total).toBe(22313);
    const b = await caller.explorer.records({
      source_name: "LA County Assessor - Assessor Parcel Data Roll 2026",
      after: a.next_after!,
      limit: 50,
    });
    expect(b.items[0]!.parcel_id > a.items.at(-1)!.parcel_id).toBe(true);
  });
  test("parcels.search: 21,388 at 5 mi / 15 y; every item inside the radius; rule text", async () => {
    const r = await caller.parcels.search({
      ...VAN_NUYS,
      radius_miles: 5,
      threshold_years: 15,
      limit: 100,
    });
    expect(r.count).toBe(21388);
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
    ).toBe(5110);
    expect(
      (
        await caller.parcels.search({
          ...VAN_NUYS,
          radius_miles: 5,
          threshold_years: 30,
        })
      ).count,
    ).toBe(20548);
    expect(
      (
        await caller.parcels.search({
          ...VAN_NUYS,
          radius_miles: 5,
          threshold_years: 80,
        })
      ).count,
    ).toBe(1649);
  });
  test("parcels.points: all 21,388 points, well under the response limit", async () => {
    const p = await caller.parcels.points({
      ...VAN_NUYS,
      radius_miles: 5,
      threshold_years: 15,
    });
    expect(p.count).toBe(21388);
    expect(p.id).toHaveLength(21388);
    expect(p.truncated).toBe(false);
    const bytes = Buffer.byteLength(JSON.stringify(p));
    expect(bytes).toBeLessThan(MAX_RESPONSE_BYTES / 3);
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
});
