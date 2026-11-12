import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { openDb } from "../src/db.ts";
import { appRouter } from "../src/routers/index.ts";
import type { Ctx } from "../src/trpc.ts";
import { FIXTURE, writeFixture } from "./fixture.ts";

/** Always runs: the routers over the synthetic fixture run (see fixture.ts for the rows). */
describe("routers on the synthetic fixture", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  const P = FIXTURE.point;
  beforeAll(async () => {
    const f = await writeFixture();
    const db = await openDb({
      runId: FIXTURE.runId,
      parquetSha256: f.parquetSha256,
      localDir: f.dir,
      tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
    });
    const ctx: Ctx = {
      db: async () => db,
      logger: { info() {}, warn() {} },
      metrics: { addMetric() {} },
    };
    caller = appRouter.createCaller(ctx);
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
