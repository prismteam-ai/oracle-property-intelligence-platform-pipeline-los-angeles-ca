import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { PlaceIndex as AgentPlaceIndex } from "../../../packages/agent/src/place-index.ts";
import {
  DEFAULT_MIN_OPEN_DAYS,
  MAX_MATCH_IDS,
  MAX_PLACE_NAME_LENGTH,
  MAX_POINTS,
  MAX_RESPONSE_BYTES,
  OWNERSHIP_BASIS,
  OWNERSHIP_PROXY_NOTE,
  ROOF_AGE_BASIS,
  type OwnershipBasis,
} from "../src/contract.ts";
import { openDb } from "../src/db.ts";
import { PAGE_FILE } from "../src/routers/explorer.ts";
import { appRouter } from "../src/routers/index.ts";
import type { Ctx } from "../src/trpc.ts";
import {
  FIXTURE,
  type FixtureRun,
  NEAREST,
  PERMIT_FIXTURE,
  PERMIT_WORK_DESC,
  writeFixture,
  writeNearestFixture,
  writePermitFixture,
  writePlacesFixture,
} from "./fixture.ts";

/** A caller over a fixture run; metrics are collected into `metrics`; every SQL statement run is in `queries`. */
async function callerFor(
  f: FixtureRun,
  metrics: Array<[string, number]> = [],
  queries: string[] = [],
) {
  const opened = await openDb({
    runId: FIXTURE.runId,
    parquetSha256: f.parquetSha256,
    parquetFile: FIXTURE.parquetFile,
    permitFiles: f.permitFiles,
    localDir: f.dir,
    tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
  });
  const db: typeof opened = {
    ...opened,
    rows: (sql, params) => (queries.push(sql), opened.rows(sql, params)),
  };
  const ctx: Ctx = {
    db: async () => db,
    logger: { info() {}, warn() {} },
    metrics: { addMetric: (n, _u, v) => void metrics.push([n, v]) },
  };
  return appRouter.createCaller(ctx);
}

/** The ownership rule a result states for a basis: the contract's texts, verbatim. */
const ownershipOut = (basis: OwnershipBasis) => ({
  basis,
  text: OWNERSHIP_BASIS[basis].text,
  weakness: OWNERSHIP_BASIS[basis].weakness,
  proxy_note: OWNERSHIP_PROXY_NOTE,
});
const BASES = ["recording", "base_year", "both"] as const;

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
    ).toEqual({
      parcel_ids: ["0000000001", "0000000002", "0000000007"],
      long_open: null,
      ownership: null,
    });
    expect(
      await caller.parcels.match({
        ...P,
        radius_miles: 10,
        threshold_years: 80,
        parcel_ids: ids,
      }),
    ).toEqual({ parcel_ids: ["0000000007"], long_open: null, ownership: null });
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
  test("ownership: each basis filters search, points and match to the same set; both is the intersection; a null proxy never passes", async () => {
    const f = { ...P, radius_miles: 10, threshold_years: 15 };
    const all = Array.from({ length: 7 }, (_, i) =>
      String(i + 1).padStart(10, "0"),
    );
    const sets: Record<string, string[]> = {};
    for (const basis of [undefined, ...BASES]) {
      const i = basis === undefined ? f : { ...f, ownership_basis: basis };
      const s = await caller.parcels.search(i);
      const p = await caller.parcels.points(i);
      const m = await caller.parcels.match({ ...i, parcel_ids: all });
      const ids = s.items.map((x) => x.parcel_id);
      expect(p.id, String(basis)).toEqual(ids);
      expect(p.count).toBe(s.count);
      expect(m.parcel_ids).toEqual([...ids].sort());
      const rule = basis === undefined ? null : ownershipOut(basis);
      expect(s.ownership).toEqual(rule);
      expect(p.ownership).toEqual(rule);
      expect(m.ownership).toEqual(rule);
      sets[String(basis)] = ids;
    }
    // Nearest first: 1 (at the point), 7 (0.2 mi), 2 (0.5 mi), 6 (~9 mi). 2 was reassessed in 2020, 6 has a
    // recent recorded document, 7 has neither proxy.
    expect(sets).toEqual({
      undefined: ["0000000001", "0000000007", "0000000002", "0000000006"],
      recording: ["0000000001", "0000000002"],
      base_year: ["0000000001", "0000000006"],
      both: ["0000000001"],
    });
    expect(sets.both).toEqual(
      sets.recording!.filter((i) => sets.base_year!.includes(i)),
    );
    for (const bad of ["owner", "", "BOTH"])
      await expect(
        caller.parcels.search({ ...f, ownership_basis: bad as "both" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  test("ownership: the basis texts, each weakness in plain words and the proxy note", () => {
    expect(OWNERSHIP_BASIS.recording.weakness).toMatch(/refinance/);
    expect(OWNERSHIP_BASIS.recording.weakness).toMatch(/lien/);
    expect(OWNERSHIP_BASIS.base_year.weakness).toMatch(/spouses/);
    expect(OWNERSHIP_BASIS.base_year.weakness).toMatch(/parent to child/);
    expect(OWNERSHIP_BASIS.both.weakness).toMatch(/^The strictest/);
    expect(OWNERSHIP_PROXY_NOTE).toMatch(
      /^All three bases are proxies from the County assessor roll, not sales records/,
    );
    for (const b of BASES) expect(OWNERSHIP_BASIS[b].text).toMatch(/10 years/);
  });
  test("search items carry the land base year (null where the roll has none)", async () => {
    const s = await caller.parcels.search({
      ...P,
      radius_miles: 10,
      threshold_years: 15,
    });
    expect(
      Object.fromEntries(s.items.map((i) => [i.parcel_id, i.land_base_year])),
    ).toEqual({
      "0000000001": 2000,
      "0000000002": 2020,
      "0000000006": 1990,
      "0000000007": null,
    });
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

/** The permit fields every permit item carries (stored column names), in no particular order. */
const PERMIT_KEYS = [
  "permit_number",
  "address",
  "postal_code",
  "source_permit_type",
  "source_permit_sub_type",
  "source_status_desc",
  "permit_status_class",
  "application_received_date",
  "permit_issue_date",
  "status_date",
  "open_since",
  "open_days",
  "roofing_work",
  "roof_coating_only",
  "join_method",
  "building_level",
  "parcel_count",
];
const CONTRACTOR_KEYS = [
  "contractors_business_name",
  "license_identifier",
  "source_license_type",
  "license_class",
  "license_class_note",
  "is_owner_builder",
  "license_expiration_date",
  "city_name",
  "state_code",
  "contractor_identity_key",
  "canonical_business_name",
  "name_variant_count",
  "identity_permit_count",
];
const sorted = (a: string[]) => [...a].sort();

/** Always runs: the permit routes, roof age on the effective roof year, and the per-source records (fixture.ts). */
describe("permit routes on the synthetic permit run", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  const P = FIXTURE.point;
  const N = PERMIT_FIXTURE.p;
  /** Every response of this block, to check that no work description is served. */
  const seen: unknown[] = [];
  const keep = <T>(x: T): T => (seen.push(x), x);
  beforeAll(async () => {
    caller = await callerFor(await writePermitFixture());
  });
  const longOpen = async (
    i: Partial<Parameters<typeof caller.permits.longOpen>[0]> = {},
  ) => keep(await caller.permits.longOpen({ ...P, radius_miles: 5, ...i }));
  const nums = (r: { items: Array<{ permit_number: string }> }) =>
    r.items.map((i) => i.permit_number);

  test("longOpen: open-issued only, default minimum 1,826 days, longest open first, ties by permit number", async () => {
    const r = await longOpen();
    // P5 (1,000 days) is under the minimum; P8 is application-stage; P10 has no parcel.
    expect(nums(r)).toEqual([N.P7, N.P2, N.P3, N.P9, N.P6]);
    expect(r.count).toBe(5);
    expect(r.next_offset).toBeNull();
    expect(r.items.map((i) => i.open_days)).toEqual([
      4000, 3237, 2500, 2000, 2000,
    ]);
    expect(r.rule).toMatchObject({
      reference_date: PERMIT_FIXTURE.referenceDate,
      status_class: "open-issued",
      min_open_days: DEFAULT_MIN_OPEN_DAYS,
      max_open_days: null,
      roof_age: null,
    });
    expect(DEFAULT_MIN_OPEN_DAYS).toBe(Math.round(5 * 365.25));
    expect(r.rule.text).toContain("at least 1,826 days");
    expect(r.rule.text).toContain("round(years x 365.25)");
    expect(r.rule.text).toContain("Roofing work only");
  });
  test("longOpen and the points highlight count roofing work only: a long-open permit that is not roofing work is left out; a coating-only one counts, flagged", async () => {
    // P11 (B, 3,000 days, not roofing work) is inside every window below; P9 (E) is roofing work only through
    // the roof-coating phrase.
    for (const window of [
      {},
      { min_open_days: 0 },
      { min_open_days: 3000, max_open_days: 3000 },
    ]) {
      const r = await longOpen({ ...window, limit: 100 });
      expect(nums(r)).not.toContain(N.P11);
      expect(r.items.every((i) => i.roofing_work)).toBe(true);
    }
    expect(nums(await longOpen({ radius_miles: 0.15 }))).toEqual([N.P2, N.P9]);
    const p9 = (await longOpen()).items.find((i) => i.permit_number === N.P9);
    expect(p9).toMatchObject({
      parcel_id: "0000000041",
      roofing_work: true,
      roof_coating_only: true,
    });
    const r = await longOpen();
    expect(r.rule.text).toContain("Roofing work only");
    expect(r.rule.text).toContain(
      "roof-coating-only permit is roofing work and counts",
    );
    // The points highlight: B (only P11 in the window) is not marked, E (only P9) is.
    for (const window of [{}, { min_open_days: 3000, max_open_days: 3000 }]) {
      const p = keep(
        await caller.parcels.points({
          ...P,
          radius_miles: 5,
          threshold_years: 15,
          ...window,
        }),
      );
      const at = Object.fromEntries(
        p.id.map((id, i) => [id, p.long_open_permit[i]]),
      );
      expect(at["0000000012"]).toBe(0);
    }
    const all = keep(
      await caller.parcels.points({
        ...P,
        radius_miles: 5,
        threshold_years: 15,
      }),
    );
    expect(all.long_open_permit[all.id.indexOf("0000000041")]).toBe(1);
  });
  test("longOpen: sort by distance, ties by permit number; offset and limit page through", async () => {
    const r = await longOpen({ sort: "distance" });
    // P7 and P6 share parcel F (2 mi): the lower permit number first.
    expect(nums(r)).toEqual([N.P2, N.P9, N.P3, N.P7, N.P6]);
    expect(r.items.map((i) => i.distance_miles)).toEqual(
      [...r.items.map((i) => i.distance_miles)].sort((a, b) => a - b),
    );
    const a = await longOpen({ limit: 2 });
    expect(nums(a)).toEqual([N.P7, N.P2]);
    expect(a.next_offset).toBe(2);
    const b = await longOpen({ limit: 2, offset: 4 });
    expect(nums(b)).toEqual([N.P6]);
    expect(b.next_offset).toBeNull();
    const past = await longOpen({ offset: 10 });
    expect(past).toMatchObject({ count: 5, items: [], next_offset: null });
  });
  test("longOpen: a building-level permit counts once, at its nearest unit, with the unit's parcel and roof year", async () => {
    const r = await longOpen();
    const p3 = r.items.filter((i) => i.permit_number === N.P3);
    expect(p3).toHaveLength(1);
    expect(p3[0]).toMatchObject({
      parcel_id: "0000000022", // 0.2 mi; the other units are 0.3 and 0.4 mi away
      building_level: true,
      join_method: "condo-building",
      parcel_count: 3,
      effective_roof_year: 1980,
      roof_age_basis: ROOF_AGE_BASIS.proxy,
      roof_year_permit_number: null,
    });
    // A radius that reaches only the nearest unit still gives the permit once.
    expect(nums(await longOpen({ radius_miles: 0.25 }))).toEqual([
      N.P2,
      N.P3,
      N.P9,
    ]);
    expect(sorted(Object.keys(p3[0]!))).toEqual(
      sorted([
        ...PERMIT_KEYS,
        "parcel_id",
        "distance_miles",
        "effective_roof_year",
        "roof_age_basis",
        "roof_year_permit_number",
      ]),
    );
  });
  test("longOpen: max_open_days, min_open_days, radius and the roof-age threshold", async () => {
    expect(nums(await longOpen({ max_open_days: 3000 }))).toEqual([
      N.P3,
      N.P9,
      N.P6,
    ]);
    expect((await longOpen({ max_open_days: 3000 })).rule.max_open_days).toBe(
      3000,
    );
    expect(nums(await longOpen({ min_open_days: 0 }))).toEqual([
      N.P7,
      N.P2,
      N.P3,
      N.P9,
      N.P6,
      N.P5,
    ]);
    expect(
      nums(await longOpen({ min_open_days: 2000, max_open_days: 2000 })),
    ).toEqual([N.P9, N.P6]);
    expect(nums(await longOpen({ radius_miles: 1 }))).toEqual([
      N.P2,
      N.P3,
      N.P9,
    ]);
    // At 15 years parcel A (roof year 2020 from a permit) drops out, and with it P2.
    const t = await longOpen({ threshold_years: 15 });
    expect(nums(t)).toEqual([N.P7, N.P3, N.P9, N.P6]);
    expect(t.rule.roof_age).toMatchObject({ built_before_year: 2011 });
    const a = (await longOpen()).items.find((i) => i.permit_number === N.P2)!;
    expect(a).toMatchObject({
      parcel_id: "0000000011",
      effective_roof_year: 2020,
      roof_age_basis: ROOF_AGE_BASIS.permit,
      roof_year_permit_number: N.P1,
    });
  });
  test("longOpen: inputs are validated", async () => {
    for (const bad of [
      { radius_miles: 10.5 },
      { min_open_days: -1 },
      { min_open_days: 2000, max_open_days: 1999 },
      { limit: 101 },
      { sort: "roof_year" as never },
      { lat: 40.7, lon: -74 },
      { threshold_years: 0 },
    ])
      await expect(longOpen(bad)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
  });

  test("forParcel: permits newest first with contractors under the license names; BBB not available", async () => {
    const r = keep(await caller.permits.forParcel({ parcel_id: "0000000011" }));
    expect(r).toMatchObject({
      parcel_id: "0000000011",
      permit_data_available: true,
      jurisdiction: "LOS ANGELES",
      effective_roof_year: 2020,
      roof_age_basis: ROOF_AGE_BASIS.permit,
      roof_year_permit_number: N.P1,
      bbb: { available: false },
    });
    expect(r.bbb.reason).toMatch(/not in this data/);
    expect(r.permits.map((p) => p.permit_number)).toEqual([N.P1, N.P2]);
    const [p1, p2] = r.permits;
    expect(p1).toMatchObject({
      roofing_work: true,
      roof_coating_only: false,
      permit_status_class: "closed",
      source_status_desc: "Permit Finaled",
      permit_issue_date: "2019-05-01",
      open_days: null,
      join_method: "direct",
      building_level: false,
      parcel_count: 1,
    });
    expect(p2).toMatchObject({
      roofing_work: true,
      roof_coating_only: false,
      open_days: 3237,
    });
    expect(sorted(Object.keys(p1!))).toEqual(
      sorted([...PERMIT_KEYS, "contractors"]),
    );
    expect(p1!.contractors).toEqual([
      {
        contractors_business_name: "FIXTURE ROOFING INC",
        license_identifier: "100001",
        source_license_type: "C39",
        license_class: "C-39",
        license_class_note: null,
        is_owner_builder: false,
        license_expiration_date: "2027-01-31",
        city_name: "VAN NUYS",
        state_code: "CA",
        contractor_identity_key: "100001",
        canonical_business_name: "FIXTURE ROOFING INC",
        name_variant_count: 1,
        identity_permit_count: 1,
      },
      // No license number: no identity at all, never a guessed name.
      expect.objectContaining({
        is_owner_builder: true,
        license_class_note: "owner-builder",
        license_identifier: null,
        contractor_identity_key: null,
        canonical_business_name: null,
        name_variant_count: null,
        identity_permit_count: null,
      }),
    ]);
    for (const c of p1!.contractors)
      expect(sorted(Object.keys(c))).toEqual(sorted(CONTRACTOR_KEYS));
    expect(p2!.contractors).toEqual([]);
  });
  test("forParcel still lists a long-open permit that is not roofing work, tagged roofing_work false", async () => {
    const b = keep(await caller.permits.forParcel({ parcel_id: "0000000012" }));
    // Same issue date: by permit number.
    expect(b.permits.map((p) => p.permit_number)).toEqual([N.P8, N.P11]);
    expect(b.permits[1]).toMatchObject({
      permit_status_class: "open-issued",
      open_days: 3000,
      roofing_work: false,
      roof_coating_only: false,
    });
    const e = keep(await caller.permits.forParcel({ parcel_id: "0000000041" }));
    expect(e.permits).toEqual([
      expect.objectContaining({
        permit_number: N.P9,
        roofing_work: true,
        roof_coating_only: true,
      }),
    ]);
  });
  test("forParcel: a building-level permit on a unit; a parcel without permits; outside the City of Los Angeles", async () => {
    const c1 = keep(
      await caller.permits.forParcel({ parcel_id: "0000000021" }),
    );
    expect(c1.permits).toEqual([
      expect.objectContaining({
        permit_number: N.P3,
        building_level: true,
        parcel_count: 3,
        join_method: "condo-building",
        contractors: [expect.objectContaining({ license_class: "B" })],
      }),
    ]);
    const h = keep(await caller.permits.forParcel({ parcel_id: "0000000042" }));
    expect(h).toMatchObject({ permit_data_available: true, permits: [] });
    const d = keep(await caller.permits.forParcel({ parcel_id: "0000000031" }));
    expect(d).toMatchObject({
      permit_data_available: false,
      jurisdiction: "PASADENA",
      bbb: { available: false },
    });
    // A permit joined to a parcel outside the City of Los Angeles is kept and shown.
    expect(d.permits.map((p) => p.permit_number)).toEqual([N.P4]);
    await expect(
      caller.permits.forParcel({ parcel_id: "0000000099" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.permits.forParcel({ parcel_id: "123" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("search, points and match use the effective roof year; search items carry the basis", async () => {
    const s = keep(
      await caller.parcels.search({
        ...P,
        radius_miles: 5,
        threshold_years: 15,
      }),
    );
    // A (built 1950, roof year 2020 from a permit) is not older than 15 years.
    expect(s.items.map((i) => i.parcel_id)).not.toContain("0000000011");
    expect(s.count).toBe(8);
    expect(s.rule.text).toContain("PERMIT");
    expect(s.rule.text).toContain("PROXY");
    const b = s.items.find((i) => i.parcel_id === "0000000012")!;
    expect(b).toMatchObject({
      year_built: 1950,
      roof_age_years_proxy: 76,
      effective_roof_year: 1950,
      roof_age_years: 76,
      roof_age_basis: ROOF_AGE_BASIS.proxy,
      roof_year_permit_number: null,
      permit_data_available: true,
    });
    expect(
      s.items.find((i) => i.parcel_id === "0000000031")!.permit_data_available,
    ).toBe(false);
    const s80 = await caller.parcels.search({
      ...P,
      radius_miles: 5,
      threshold_years: 70,
    });
    expect(s80.items.map((i) => i.parcel_id)).toEqual(["0000000012"]); // A: roof year 2020, not 1950
    expect(
      (
        await caller.parcels.match({
          ...P,
          radius_miles: 5,
          threshold_years: 70,
          parcel_ids: ["0000000011", "0000000012"],
        })
      ).parcel_ids,
    ).toEqual(["0000000012"]);
  });
  test("points: 0/1 columns for permit data and for a long-open permit under the same window", async () => {
    const p = keep(
      await caller.parcels.points({
        ...P,
        radius_miles: 5,
        threshold_years: 15,
      }),
    );
    const at = (col: Array<0 | 1>) =>
      Object.fromEntries(p.id.map((id, i) => [id, col[i]]));
    expect(p.permit_data_available).toHaveLength(p.id.length);
    expect(p.long_open_permit).toHaveLength(p.id.length);
    expect(p.long_open).toEqual({
      min_open_days: DEFAULT_MIN_OPEN_DAYS,
      max_open_days: null,
    });
    expect(at(p.permit_data_available)).toEqual({
      "0000000012": 1,
      "0000000021": 1,
      "0000000022": 1,
      "0000000023": 1,
      "0000000031": 0,
      "0000000041": 1,
      "0000000042": 1,
      "0000000051": 1,
    });
    // Every unit of the building-level permit P3 is marked; B's permits are application-stage (P8) and not
    // roofing work (P11).
    expect(at(p.long_open_permit)).toEqual({
      "0000000012": 0,
      "0000000021": 1,
      "0000000022": 1,
      "0000000023": 1,
      "0000000031": 0,
      "0000000041": 1,
      "0000000042": 0,
      "0000000051": 1,
    });
    const narrow = await caller.parcels.points({
      ...P,
      radius_miles: 5,
      threshold_years: 15,
      min_open_days: 2100,
      max_open_days: 3000,
    });
    // Only P3 (2,500 days) is in the window: E (P9, 2,000) and F (2,000 / 4,000 / 1,000) drop out.
    expect(
      narrow.id.filter((_, i) => narrow.long_open_permit[i] === 1),
    ).toEqual(["0000000022", "0000000021", "0000000023"]);
    await expect(
      caller.parcels.points({
        ...P,
        min_open_days: 2000,
        max_open_days: 10,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("sources: three sources by kind, with license and attribution from the manifest", async () => {
    const s = keep(await caller.explorer.sources());
    expect(
      s.sources.map((x) => [
        x.source_kind,
        x.source_name,
        x.record_count,
        x.page_count,
      ]),
    ).toEqual([
      [
        "contractor",
        PERMIT_FIXTURE.contractorSource,
        PERMIT_FIXTURE.contractorRows,
        1,
      ],
      ["permit", PERMIT_FIXTURE.permitSource, PERMIT_FIXTURE.permits, 3],
      ["parcel", FIXTURE.source, PERMIT_FIXTURE.parcels, 2],
    ]);
    // Ordered by source name.
    expect(s.sources[0]).toMatchObject({
      license: "CC BY 4.0",
      attribution: "LADBS",
      query_url: null,
      query_urls: ["https://example.test/contractors"],
    });
    expect(s.sources[2]).toMatchObject({ license: null, query_urls: null });
    expect(s.pages.map((p) => [p.source_kind, p.source_page_file])).toEqual([
      ["contractor", "pages/8guu-8f5m_p000.json.gz"],
      ["permit", "pages/gwh9-jnip_p000.json.gz"],
      ["parcel", "pages/page-00000.json.gz"],
      ["parcel", "pages/page-00001.json.gz"],
      ["permit", "pages/pi9x-tg5x_p000.json.gz"],
      ["permit", "pages/pi9x-tg5x_p001.json.gz"],
    ]);
  });
  test("records per source: permits by permit number, contractor rows by (permit number, row), each with its cursor", async () => {
    const a = keep(
      await caller.explorer.records({
        source_name: PERMIT_FIXTURE.permitSource,
        limit: 4,
      }),
    );
    expect(a.source_kind).toBe("permit");
    expect(a.total).toBe(PERMIT_FIXTURE.permits);
    expect(a.items.map((i) => i.record_key)).toEqual([N.P9, N.P7, N.P1, N.P2]);
    expect(a.next_after).toBe(N.P2);
    const all = keep(
      await caller.explorer.records({
        source_name: PERMIT_FIXTURE.permitSource,
        limit: 100,
      }),
    );
    const byKey = Object.fromEntries(all.items.map((i) => [i.record_key, i]));
    expect(byKey[N.P3]).toMatchObject({
      kind: "permit",
      parcel_count: 3,
      join_method: "condo-building",
      parcel_id: null,
      year_built: null,
    });
    expect(byKey[N.P10]).toMatchObject({ parcel_count: 0, join_method: null });
    const b = await caller.explorer.records({
      source_name: PERMIT_FIXTURE.permitSource,
      after: a.next_after!,
      limit: 100,
    });
    expect(b.items.map((i) => i.record_key)).toEqual([
      N.P3,
      N.P4,
      N.P5,
      N.P6,
      N.P8,
      N.P10,
      N.P11,
    ]);
    const c = keep(
      await caller.explorer.records({
        source_name: PERMIT_FIXTURE.contractorSource,
        limit: 3,
      }),
    );
    expect(c.source_kind).toBe("contractor");
    expect(c.total).toBe(PERMIT_FIXTURE.contractorRows);
    expect(c.items.map((i) => i.record_key)).toEqual([
      "12016-10000-00099:1", // a contractor row whose permit is not in the permit table
      `${N.P1}:1`,
      `${N.P1}:2`,
    ]);
    expect(c.items[1]).toMatchObject({
      kind: "contractor",
      license_class: "C-39",
      contractors_business_name: "FIXTURE ROOFING INC",
      source_page_file: "pages/8guu-8f5m_p000.json.gz",
    });
    const d = await caller.explorer.records({
      source_name: PERMIT_FIXTURE.contractorSource,
      after: c.next_after!,
      limit: 3,
    });
    expect(d.items.map((i) => i.record_key)).toEqual([`${N.P3}:1`]);
    expect(d.next_after).toBeNull();
    // Parcels page as before, with their kind and key.
    const p = await caller.explorer.records({
      source_name: FIXTURE.source,
      page_file: "pages/page-00001.json.gz",
    });
    expect(p).toMatchObject({ source_kind: "parcel", total: 1 });
    expect(p.items[0]).toMatchObject({
      kind: "parcel",
      record_key: "0000000051",
      parcel_id: "0000000051",
    });
    const one = await caller.explorer.records({
      source_name: PERMIT_FIXTURE.permitSource,
      page_file: "pages/pi9x-tg5x_p001.json.gz",
    });
    expect(one.items.map((i) => i.record_key)).toEqual([N.P7, N.P5, N.P6]);
    // A cursor of another kind, and an unknown source.
    await expect(
      caller.explorer.records({
        source_name: PERMIT_FIXTURE.permitSource,
        after: "0000000011",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await caller.explorer.records({ source_name: "no such source" }),
    ).toEqual({ source_kind: null, total: 0, items: [], next_after: null });
  });
  test("records.page_file accepts the three page-file shapes the sources record, and nothing else", async () => {
    for (const ok of [
      "page-0000.json",
      "pages/page-00000.json.gz",
      "pages/pi9x-tg5x_p000.json.gz",
      "pages/8guu-8f5m_p002.json.gz",
    ])
      expect(PAGE_FILE.test(ok), ok).toBe(true);
    for (const bad of [
      "page-00000.json.gz",
      "pages/page-0000.json",
      "pi9x-tg5x_p000.json.gz",
      "pages/../pi9x-tg5x_p000.json.gz",
      "pages/PI9X-TG5X_p000.json.gz",
      "pages/pi9x-tg5x_p0000.json.gz",
      "/etc/passwd",
    ]) {
      expect(PAGE_FILE.test(bad), bad).toBe(false);
      await expect(
        caller.explorer.records({
          source_name: FIXTURE.source,
          page_file: bad,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });
  test("meta.info lists the permit views and the verified permit files; runSummary carries permit coverage", async () => {
    const m = keep(await caller.meta.info());
    expect(m.views).toEqual(
      expect.arrayContaining([
        "oracle.v_permit",
        "oracle.v_permit_parcel",
        "oracle.v_permit_contractor",
        "oracle.v_permit_provenance",
      ]),
    );
    expect(m.macros).toEqual(
      expect.arrayContaining([
        "oracle.long_open_permits",
        "oracle.long_open_parcels",
      ]),
    );
    expect(m.reference_date).toBe(PERMIT_FIXTURE.referenceDate);
    expect(m.permit_files.map((f) => f.role)).toEqual([
      "permits",
      "permit_parcels",
      "permit_contractors",
    ]);
    for (const f of m.permit_files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    const s = keep(await caller.explorer.runSummary());
    expect(s.run.coverage).toMatchObject({
      permit_data: { parcels_with_permit_data: 8 },
    });
  });
  test("match with long_open_permit: the IDs with a long-open roofing permit under the window, with and without the search filter, the same rule as the points highlight", async () => {
    const f = { ...P, radius_miles: 5, threshold_years: 15 };
    const ids = [
      "0000000011", // A: P2 long-open, but roof year 2020 (not a 15-year candidate)
      "0000000012", // B: application-stage and not-roofing permits only
      "0000000021",
      "0000000022",
      "0000000023", // the building-level P3 marks every unit
      "0000000031", // D: outside the City, one closed permit
      "0000000041", // E: coating-only P9 counts
      "0000000042", // H: no permit
      "0000000051", // F: P6 and P7
      "0000000099", // unknown
    ];
    const window = {
      min_open_days: DEFAULT_MIN_OPEN_DAYS,
      max_open_days: null,
    };
    const on = keep(
      await caller.parcels.match({
        ...f,
        long_open_permit: true,
        parcel_ids: ids,
      }),
    );
    expect(on).toEqual({
      parcel_ids: [
        "0000000021",
        "0000000022",
        "0000000023",
        "0000000041",
        "0000000051",
      ],
      long_open: window,
      ownership: null,
    });
    // Parity with the map: the points marked long_open_permit under the same window.
    const pts = await caller.parcels.points(f);
    expect(on.parcel_ids).toEqual(
      pts.id.filter((_, i) => pts.long_open_permit[i] === 1).sort(),
    );
    // The toggle off: the search filter alone, as before.
    const off = await caller.parcels.match({ ...f, parcel_ids: ids });
    expect(off.long_open).toBeNull();
    expect(off.parcel_ids).toEqual([...pts.id].sort());
    // Without the search filter ("leads in this search" off): every given lead with a long-open roofing
    // permit, wherever it is and whatever its roof age (A is back).
    const leads = keep(
      await caller.parcels.match({ long_open_permit: true, parcel_ids: ids }),
    );
    expect(leads).toEqual({
      parcel_ids: [
        "0000000011",
        "0000000021",
        "0000000022",
        "0000000023",
        "0000000041",
        "0000000051",
      ],
      long_open: window,
      ownership: null,
    });
    // A window: only P3 (2,500 days) is inside 2,100-3,000; with the filter, again the points' marks.
    const narrow = { min_open_days: 2100, max_open_days: 3000 };
    const m = await caller.parcels.match({
      ...f,
      long_open_permit: true,
      ...narrow,
      parcel_ids: ids,
    });
    const np = await caller.parcels.points({ ...f, ...narrow });
    expect(m.parcel_ids).toEqual(
      np.id.filter((_, i) => np.long_open_permit[i] === 1).sort(),
    );
    expect(m).toMatchObject({
      parcel_ids: ["0000000021", "0000000022", "0000000023"],
      long_open: narrow,
    });
    expect(
      (
        await caller.parcels.match({
          long_open_permit: true,
          min_open_days: 3000,
          parcel_ids: ids,
        })
      ).parcel_ids,
    ).toEqual(["0000000011", "0000000051"]); // P2 3,237 and P7 4,000 days
    // With the ownership basis too: the same set as search with that basis, then the long-open marks.
    const own = await caller.parcels.match({
      ...f,
      ownership_basis: "both",
      long_open_permit: true,
      parcel_ids: ids,
    });
    expect(own.ownership).toEqual(ownershipOut("both"));
    expect(own.parcel_ids).toEqual(on.parcel_ids); // every fixture parcel passes both
  });
  test("match inputs: the window needs the toggle, the toggle makes the filter optional, filter fields need lat and lon, max not below min", async () => {
    const ids = ["0000000021"];
    const ok = await caller.parcels.match({ ...P, parcel_ids: ids });
    expect(ok.parcel_ids).toEqual(["0000000021"]);
    for (const bad of [
      { parcel_ids: ids }, // no filter and no toggle: refused as before
      { long_open_permit: false, parcel_ids: ids },
      { ...P, min_open_days: 2000, parcel_ids: ids }, // a window without the toggle
      { ...P, max_open_days: 3000, parcel_ids: ids },
      { lat: P.lat, long_open_permit: true, parcel_ids: ids }, // lat without lon
      { lon: P.lon, parcel_ids: ids },
      { long_open_permit: true, radius_miles: 5, parcel_ids: ids }, // filter fields without lat and lon
      { long_open_permit: true, threshold_years: 15, parcel_ids: ids },
      { long_open_permit: true, ownership_basis: "both", parcel_ids: ids },
      {
        ...P,
        long_open_permit: true,
        min_open_days: 3000,
        max_open_days: 2000,
        parcel_ids: ids,
      },
      { long_open_permit: true, max_open_days: 1000, parcel_ids: ids }, // below the default minimum
      { long_open_permit: true, min_open_days: -1, parcel_ids: ids },
      { long_open_permit: true, min_open_days: 36_526, parcel_ids: ids },
      { long_open_permit: "yes", parcel_ids: ids },
      { long_open_permit: true, parcel_ids: [] },
      {
        long_open_permit: true,
        parcel_ids: Array.from({ length: MAX_MATCH_IDS + 1 }, (_, i) =>
          String(i).padStart(10, "0"),
        ),
      },
    ])
      await expect(
        caller.parcels.match(bad as Parameters<typeof caller.parcels.match>[0]),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (
        await caller.parcels.match({
          long_open_permit: true,
          parcel_ids: Array.from({ length: MAX_MATCH_IDS }, (_, i) =>
            String(i + 1).padStart(10, "0"),
          ),
        })
      ).parcel_ids,
    ).toEqual([
      "0000000011",
      "0000000021",
      "0000000022",
      "0000000023",
      "0000000041",
      "0000000051",
    ]); // MAX_MATCH_IDS IDs (0000000001-0000000072): the fixture's parcels with a long-open roofing permit
  });
  test("contractor identity: key, canonical name and counts in records and forParcel; a license without a name has no canonical name; no name variant is ever listed", async () => {
    const c = keep(
      await caller.explorer.records({
        source_name: PERMIT_FIXTURE.contractorSource,
        limit: 10,
      }),
    );
    const byKey = Object.fromEntries(c.items.map((i) => [i.record_key, i]));
    expect(byKey["12016-10000-00099:1"]).toMatchObject({
      contractors_business_name: null,
      license_identifier: "100003",
      contractor_identity_key: "100003",
      canonical_business_name: null,
      name_variant_count: 0,
      identity_permit_count: 1,
    });
    expect(byKey[`${N.P1}:2`]).toMatchObject({
      is_owner_builder: true,
      contractor_identity_key: null,
      canonical_business_name: null,
      name_variant_count: null,
      identity_permit_count: null,
    });
    expect(byKey[`${N.P3}:1`]).toMatchObject({
      contractors_business_name: "FIXTURE BUILDERS",
      contractor_identity_key: "100002",
      canonical_business_name: "FIXTURE BUILDERS",
      name_variant_count: 2,
      identity_permit_count: 2,
    });
    const units = keep(
      await caller.permits.forParcel({ parcel_id: "0000000021" }),
    );
    expect(units.permits[0]!.contractors).toEqual([
      expect.objectContaining({
        contractor_identity_key: "100002",
        canonical_business_name: "FIXTURE BUILDERS",
        name_variant_count: 2,
        identity_permit_count: 2,
      }),
    ]);
    // Variants are counted, never listed: no field but the count names them.
    const keys = new Set<string>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object")
        for (const [k, v] of Object.entries(x)) {
          keys.add(k);
          walk(v);
        }
    };
    walk([c, units]);
    expect([...keys].filter((k) => /variant|alias|names/i.test(k))).toEqual([
      "name_variant_count",
    ]);
  });
  test("sources: the contractor source's coverage window, null for the others; runSummary run kind fields null for a manifest without them", async () => {
    const s = keep(await caller.explorer.sources());
    expect(
      Object.fromEntries(s.sources.map((x) => [x.source_kind, x.coverage])),
    ).toEqual({ contractor: null, permit: null, parcel: null });
    const r = keep(await caller.explorer.runSummary());
    expect(r.run).toMatchObject({
      run_kind: null,
      rebuild_of: null,
      source_changes: null,
    });
    expect(r.history).toEqual([
      expect.objectContaining({
        run_id: FIXTURE.runId,
        run_kind: null,
        rebuild_of: null,
        source_changes: null,
      }),
    ]);
  });
  test("no work description anywhere: not in any view, not in any response", async () => {
    const db = await openDb({
      runId: FIXTURE.runId,
      ...(await (async () => {
        const f = await writePermitFixture();
        return {
          parquetSha256: f.parquetSha256,
          permitFiles: f.permitFiles,
          localDir: f.dir,
        };
      })()),
      parquetFile: FIXTURE.parquetFile,
      tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
    });
    const cols = (await db.rows(
      "select table_name, column_name from information_schema.columns where table_schema = 'oracle' and table_name like 'v_%'",
    )) as Array<{ table_name: string; column_name: string }>;
    expect(cols.filter((c) => /work_?desc/i.test(c.column_name))).toEqual([]);
    expect(
      cols.filter(
        (c) =>
          c.table_name.startsWith("v_permit") && /descr/i.test(c.column_name),
      ),
    ).toEqual([]);
    expect(seen.length).toBeGreaterThan(10);
    const text = JSON.stringify(seen);
    expect(text).not.toContain(PERMIT_WORK_DESC);
    expect(text).not.toMatch(/work_?desc/i);
  });
});

/** Always runs: places.resolve over the places run (fixture.ts PLACES), the agent's place-index cases. */
describe("places.resolve on the synthetic places run", () => {
  let caller: ReturnType<typeof appRouter.createCaller>;
  let run: FixtureRun;
  const queries: string[] = [];
  const PLACE_VALUES = /^select 'jurisdiction' as basis/;
  beforeAll(async () => {
    run = await writePlacesFixture();
    caller = await callerFor(run, [], queries);
  });
  const resolve = (name: string) => caller.places.resolve({ name });

  test("the index is built on the first places.resolve call, not before, and once per Db; centers once per name", async () => {
    await caller.meta.info();
    await caller.parcels.search({ ...FIXTURE.point });
    expect(queries.filter((q) => PLACE_VALUES.test(q))).toHaveLength(0);
    const centers = () => queries.filter((q) => /median\(latitude\)/.test(q));
    await resolve("Van Nuys");
    expect(queries.filter((q) => PLACE_VALUES.test(q))).toHaveLength(1);
    expect(centers()).toHaveLength(1);
    await resolve("VAN NUYS, CA");
    await resolve("Burbank");
    expect(queries.filter((q) => PLACE_VALUES.test(q))).toHaveLength(1);
    expect(centers()).toHaveLength(3); // Van Nuys once, Burbank's two bases
  });
  test("resolved: Van Nuys pools the three stored spellings; median of the parcels with coordinates, 5 decimals", async () => {
    expect(await resolve("Van Nuys")).toEqual({
      status: "resolved",
      name: "Van Nuys",
      basis: "postal_city",
      center: { lat: 34.187, lon: -118.449 },
      parcel_count: 5,
      raw_values: ["VAN NUYS", "VAN NUYS CALIF", "VAN NUYS,"],
      spread_miles: expect.any(Number),
      center_reliable: true,
      also_matched: null,
      note: "Resolved 'Van Nuys' (postal city) to the median center 34.18700, -118.44900 of 5 parcels. Stored postal city names: VAN NUYS | VAN NUYS CALIF | VAN NUYS,.",
    });
  });
  test("a jurisdiction and a postal city within 2 mi: the jurisdiction center, the other stated", async () => {
    const r = await resolve("Burbank");
    expect(r).toMatchObject({
      status: "resolved",
      basis: "jurisdiction",
      also_matched: { basis: "postal_city" },
    });
    expect(r.note).toMatch(/also matches a postal city/);
  });
  test("ambiguous: a jurisdiction and a postal city more than 2 mi apart; no center", async () => {
    const r = await resolve("Los Angeles");
    expect(r.status).toBe("ambiguous");
    if (r.status !== "ambiguous") return;
    expect(r.candidates.map((c) => c.basis)).toEqual([
      "jurisdiction",
      "postal_city",
    ]);
    expect(r).not.toHaveProperty("center");
    expect(r.note).toMatch(
      /is ambiguous: .* mi apart; no center was chosen\.$/,
    );
  });
  test("spellings with diacritics and joined words; UNINCORPORATED and a spread-out place are not reliable centers", async () => {
    expect(await resolve("La Cañada Flintridge")).toMatchObject({
      status: "resolved",
      basis: "jurisdiction",
      raw_values: ["LA CANADA-FLINTRIDGE"],
    });
    expect(await resolve("Westlake Village")).toMatchObject({
      status: "resolved",
      raw_values: ["WEST LAKE VILLAGE"],
    });
    expect(await resolve("Unincorporated")).toMatchObject({
      status: "resolved",
      center_reliable: false,
    });
    const s = await resolve("Spreadville");
    expect(s).toMatchObject({ status: "resolved", center_reliable: false });
    if (s.status === "resolved") expect(s.spread_miles).toBeGreaterThan(10);
  });
  test("unknown: no match and no suggestion", async () => {
    expect(await resolve("Van Nuyz")).toEqual({
      status: "unknown",
      name: "Van Nuyz",
      note: '"Van Nuyz" matches no jurisdiction or postal city in this run; no center was chosen.',
    });
    expect((await resolve("!!!")).status).toBe("unknown");
  });
  test("input bounds: 1 to MAX_PLACE_NAME_LENGTH characters", async () => {
    expect(MAX_PLACE_NAME_LENGTH).toBe(100);
    expect((await resolve("x".repeat(MAX_PLACE_NAME_LENGTH))).status).toBe(
      "unknown",
    );
    for (const bad of [
      { name: "" },
      { name: "x".repeat(MAX_PLACE_NAME_LENGTH + 1) },
      {},
      { name: 7 },
    ])
      await expect(
        caller.places.resolve(bad as { name: string }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  test("parity: the route answers exactly as the agent's own PlaceIndex over the same Db", async () => {
    const db = await openDb({
      runId: FIXTURE.runId,
      parquetSha256: run.parquetSha256,
      parquetFile: FIXTURE.parquetFile,
      permitFiles: run.permitFiles,
      localDir: run.dir,
      tmpDir: mkdtempSync(join(tmpdir(), "api-tmp-")),
    });
    const agent = new AgentPlaceIndex(db);
    for (const name of [
      "Van Nuys",
      "van nuys california",
      "Burbank",
      "Los Angeles",
      "North Hollywood",
      "La Cañada Flintridge",
      "Westlake Village",
      "Unincorporated",
      "Acton",
      "Spreadville",
      "Springfield",
      "!!!",
    ])
      expect(await resolve(name), name).toEqual(await agent.resolve({ name }));
  });
});
