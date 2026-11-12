import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import {
  MAX_MATCH_IDS,
  MAX_POINTS,
  MAX_RESPONSE_BYTES,
} from "../src/contract.ts";
import { openDb } from "../src/db.ts";
import { appRouter } from "../src/routers/index.ts";
import type { Ctx } from "../src/trpc.ts";
import {
  FIXTURE,
  NEAREST,
  writeFixture,
  writeNearestFixture,
} from "./fixture.ts";

/** A caller over a fixture run; metrics are collected into `metrics`. */
async function callerFor(
  f: { dir: string; parquetSha256: string },
  metrics: Array<[string, number]> = [],
) {
  const db = await openDb({
    runId: FIXTURE.runId,
    parquetSha256: f.parquetSha256,
    parquetFile: FIXTURE.parquetFile,
    localDir: f.dir,
    tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
  });
  const ctx: Ctx = {
    db: async () => db,
    logger: { info() {}, warn() {} },
    metrics: { addMetric: (n, _u, v) => void metrics.push([n, v]) },
  };
  return appRouter.createCaller(ctx);
}

/** Always runs: the routers over the synthetic fixture run (see fixture.ts for the rows). */
describe("routers on the synthetic fixture", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  const P = FIXTURE.point;
  beforeAll(async () => {
    caller = await callerFor(await writeFixture());
  });

  test("meta.info and runSummary", async () => {
    expect(await caller.meta.info()).toMatchObject({
      run_id: FIXTURE.runId,
      sha256_verified: true,
    });
    const s = await caller.explorer.runSummary();
    expect(s.run).toMatchObject({
      run_id: FIXTURE.runId,
      roll_year: "2026",
      limitations: ["fixture only"],
    });
    expect((s.run.row_counts as Record<string, number>).parquet).toBe(
      FIXTURE.rows,
    );
    expect(s.history.map((h) => h.run_id)).toEqual([FIXTURE.runId]);
  });
  test("sources and pages with provenance", async () => {
    const s = await caller.explorer.sources();
    expect(s.sources).toEqual([
      expect.objectContaining({
        source_name: FIXTURE.source,
        record_count: 7,
        page_count: 2,
        terms_of_use: "https://example.test/terms",
      }),
    ]);
    expect(
      s.pages.map((p) => [
        p.source_page_file,
        p.record_count,
        p.source_retrieved_at,
      ]),
    ).toEqual([
      ["page-0000.json", 4, "2026-11-11T16:17:40.932Z"],
      ["page-0001.json", 3, "2026-11-11T16:17:40.932Z"],
    ]);
  });
  test("records page by parcel id", async () => {
    const a = await caller.explorer.records({
      source_name: FIXTURE.source,
      limit: 4,
    });
    expect(a.total).toBe(7);
    expect(a.items.map((i) => i.parcel_id)).toEqual([
      "0000000001",
      "0000000002",
      "0000000003",
      "0000000004",
    ]);
    const b = await caller.explorer.records({
      source_name: FIXTURE.source,
      after: a.next_after!,
      limit: 4,
    });
    expect(b.items.map((i) => i.parcel_id)).toEqual([
      "0000000005",
      "0000000006",
      "0000000007",
    ]);
    expect(b.next_after).toBeNull();
  });
  test("search: inside vs outside the radius, threshold rule, missing data excluded", async () => {
    const r5 = await caller.parcels.search({
      ...P,
      radius_miles: 5,
      threshold_years: 15,
    });
    expect(r5.items.map((i) => i.parcel_id)).toEqual([
      "0000000001",
      "0000000007",
      "0000000002",
    ]); // 2011, no year, no coords, ~9 mi: out
    expect(r5.count).toBe(3);
    expect(r5.rule).toMatchObject({ roll_year: 2026, built_before_year: 2011 });
    expect(
      Math.max(...r5.items.map((i) => i.distance_miles)),
    ).toBeLessThanOrEqual(5);
    expect(
      (
        await caller.parcels.search({
          ...P,
          radius_miles: 10,
          threshold_years: 15,
        })
      ).count,
    ).toBe(4); // + the parcel ~9 mi away
    const r80 = await caller.parcels.search({
      ...P,
      radius_miles: 5,
      threshold_years: 80,
    });
    expect(r80.items.map((i) => i.parcel_id)).toEqual(["0000000007"]);
    expect(r80.rule.built_before_year).toBe(1946);
    expect(
      r5.items.find((i) => i.parcel_id === "0000000002")!.roof_age_years_proxy,
    ).toBe(36);
  });
  test("points: columnar, same set as search", async () => {
    const p = await caller.parcels.points({
      ...P,
      radius_miles: 5,
      threshold_years: 15,
    });
    expect(p).toMatchObject({
      count: 3,
      encoding: "columnar-v1",
      truncated: false,
    });
    expect(p.id).toEqual(["0000000001", "0000000007", "0000000002"]);
    expect(p.lat).toHaveLength(3);
  });
  test("match: only the given parcels that the search matches, sorted, no duplicates", async () => {
    const ids = [
      "0000000006", // ~9 mi: outside 5 mi
      "0000000002",
      "0000000003", // built 2011: not older than 15 years
      "0000000001",
      "0000000004", // no year built
      "0000000005", // no coordinates
      "0000000007",
      "0000000001", // duplicate
      "0000000099", // unknown
    ];
    expect(
      await caller.parcels.match({
        ...P,
        radius_miles: 5,
        threshold_years: 15,
        parcel_ids: ids,
      }),
    ).toEqual({ parcel_ids: ["0000000001", "0000000002", "0000000007"] });
    expect(
      await caller.parcels.match({
        ...P,
        radius_miles: 10,
        threshold_years: 80,
        parcel_ids: ids,
      }),
    ).toEqual({ parcel_ids: ["0000000007"] });
    // The same set as search, whatever IDs are asked.
    const all = Array.from({ length: 7 }, (_, i) =>
      String(i + 1).padStart(10, "0"),
    );
    const s10 = await caller.parcels.search({
      ...P,
      radius_miles: 10,
      threshold_years: 15,
    });
    expect(
      (
        await caller.parcels.match({
          ...P,
          radius_miles: 10,
          threshold_years: 15,
          parcel_ids: all,
        })
      ).parcel_ids,
    ).toEqual(s10.items.map((i) => i.parcel_id).sort());
  });
  test("match: inputs are validated (ID format, 1 to MAX_MATCH_IDS IDs, the search filter)", async () => {
    const ok = { ...P, parcel_ids: ["0000000001"] };
    expect((await caller.parcels.match(ok)).parcel_ids).toEqual(["0000000001"]); // defaults: 1 mi, 15 years
    for (const bad of [
      { ...ok, parcel_ids: [] },
      { ...ok, parcel_ids: ["123"] },
      { ...ok, parcel_ids: ["0000000001,0000000002"] },
      { ...ok, parcel_ids: ["000000000' or 1=1 --"] },
      {
        ...ok,
        parcel_ids: Array.from({ length: MAX_MATCH_IDS + 1 }, (_, i) =>
          String(i).padStart(10, "0"),
        ),
      },
      { ...ok, lat: 40.7, lon: -74 },
      { ...ok, radius_miles: 10.5 },
      { ...ok, threshold_years: 0 },
    ])
      await expect(caller.parcels.match(bad)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    expect(
      (
        await caller.parcels.match({
          ...ok,
          parcel_ids: Array.from({ length: MAX_MATCH_IDS }, (_, i) =>
            String(i + 1).padStart(10, "0"),
          ),
        })
      ).parcel_ids,
    ).toEqual(["0000000001", "0000000002", "0000000007"]); // 1 mi, 15 years
  });
  test("detail, unknown parcel 404, bad input 400", async () => {
    const d = await caller.parcels.detail({ parcel_id: "0000000002" });
    expect(d.property).toMatchObject({
      parcel_id: "0000000002",
      year_built: 1990,
      roll_year: 2026,
      address: "2 TEST ST",
    });
    expect(d.provenance).toMatchObject({
      source_request_url: "https://example.test/query?page=page-0000.json",
      source_page_sha256: "sha-page-0000.json",
    });
    await expect(
      caller.parcels.detail({ parcel_id: "0000000099" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.parcels.detail({ parcel_id: "12" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.parcels.search({ lat: 40.7, lon: -74 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.parcels.search({ ...P, threshold_years: 121 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

/** Always runs: the points cap over a generated run of NEAREST.rows parcels (see fixture.ts). */
describe("points cap on a generated run", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  const metrics: Array<[string, number]> = [];
  const P = FIXTURE.point;
  beforeAll(async () => {
    caller = await callerFor(await writeNearestFixture(), metrics);
  });
  const ids = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) =>
      String(from + i).padStart(10, "0"),
    );

  test("over the cap: the nearest 25,000 by distance, ties by parcel ID; count stays complete", async () => {
    expect(NEAREST.rows).toBeGreaterThan(MAX_POINTS);
    const p = await caller.parcels.points({
      ...P,
      radius_miles: 10,
      threshold_years: 15,
    });
    expect(p.count).toBe(NEAREST.rows);
    expect(p.truncated).toBe(true);
    expect(p.max_points).toBe(MAX_POINTS);
    expect(p.lat).toHaveLength(MAX_POINTS);
    expect(p.lon).toHaveLength(MAX_POINTS);
    // IDs 1..25,000: the cut runs through the pair (25,000, 25,001) on one spot, and the lower ID is kept.
    expect(p.id).toEqual(ids(1, MAX_POINTS));
    const bytes = Buffer.byteLength(JSON.stringify(p));
    expect(bytes).toBeLessThan(MAX_RESPONSE_BYTES);
    expect(metrics.filter(([n]) => n === "PointsResponseBytes")).toEqual([
      ["PointsResponseBytes", bytes],
    ]);
  });
  test("exactly at the cap, and under it: not truncated, every point", async () => {
    // At 60 years only the pairs qualify. Pair k sits k * 1e-5 degree north: pair 12,500 at about
    // 8.63676 mi, pair 12,501 at about 8.63745 mi; 8.637 mi keeps pairs 1..12,500 (IDs 2..25,001).
    const at = await caller.parcels.points({
      ...P,
      radius_miles: 8.637,
      threshold_years: 60,
    });
    expect(at.count).toBe(MAX_POINTS);
    expect(at.truncated).toBe(false);
    expect(at.id).toEqual(ids(2, MAX_POINTS + 1));
    const under = await caller.parcels.points({
      ...P,
      radius_miles: 0.1,
      threshold_years: 15,
    });
    expect(under.truncated).toBe(false);
    expect(under.id).toHaveLength(under.count);
    // The point and pairs 1..144 (one step is about 0.000691 mi: 144 steps 0.0995 mi, 145 steps 0.1002 mi).
    expect(under.count).toBe(289);
  });
});
