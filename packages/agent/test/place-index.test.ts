/**
 * PlaceIndex on a synthetic parcel set (design brief §11.1). The fake `rows` implements the two aggregate queries'
 * semantics in JS (distinct values with counts; median center and 90th-percentile spread over bound values,
 * quantile_cont = linear interpolation). The same SQL runs on DuckDB in apps/agent-mcp/test.
 */
import { beforeAll, describe, expect, test } from "vitest";
import {
  PLACE_VALUES_SQL,
  PlaceIndex,
  haversineMiles,
  placeIndexFor,
  placeKey,
  type RowsDb,
} from "../src/place-index.ts";
import { blockNetwork } from "./helpers.ts";

beforeAll(blockNetwork);

interface P {
  jurisdiction: string;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

const at = (
  jurisdiction: string,
  city: string | null,
  lat: number | null,
  lon: number | null,
): P => ({
  jurisdiction,
  city,
  lat,
  lon,
});

const PARCELS: P[] = [
  // Van Nuys: three spellings of the postal city, jurisdiction LOS ANGELES (as in the served run).
  at("LOS ANGELES", "VAN NUYS", 34.186, -118.449),
  at("LOS ANGELES", "VAN NUYS", 34.187, -118.45),
  at("LOS ANGELES", "VAN NUYS", 34.189, -118.448),
  at("LOS ANGELES", "VAN NUYS,", 34.185, -118.451),
  at("LOS ANGELES", "VAN NUYS CALIF", 34.188, -118.447),
  at("LOS ANGELES", "VAN NUYS", null, null), // no coordinates: not in the median
  // Postal city LOS ANGELES far from the jurisdiction's center: ambiguous.
  at("LOS ANGELES", "LOS ANGELES", 33.74, -118.29),
  at("LOS ANGELES", "LOS ANGELES", 33.741, -118.291),
  at("LOS ANGELES", "LOS ANGELES", 33.742, -118.292),
  at("LOS ANGELES", "NORTH HOLLYWOOD", 34.17, -118.38),
  at("LOS ANGELES", "NORTH HOLLYWOOD", 34.171, -118.381),
  // Jurisdiction and postal city within 2 mi: resolved on the jurisdiction.
  at("BURBANK", "BURBANK", 34.18, -118.31),
  at("BURBANK", "BURBANK", 34.181, -118.311),
  at("BURBANK", "BURBANK", 34.182, -118.309),
  // Spellings with diacritics and joined words.
  at("LA CANADA-FLINTRIDGE", "LA CANADA FLINTRIDGE", 34.2, -118.2),
  at("LA CANADA-FLINTRIDGE", "LA CANADA FLINTRIDGE", 34.201, -118.201),
  at("WEST LAKE VILLAGE", "WESTLAKE VILLAGE", 34.146, -118.805),
  at("WEST LAKE VILLAGE", "WESTLAKE VILLAGE", 34.147, -118.806),
  // UNINCORPORATED: never a reliable center.
  at("UNINCORPORATED", "ACTON", 34.47, -118.19),
  at("UNINCORPORATED", "ACTON", 34.471, -118.191),
  at("UNINCORPORATED", "AVALON", 33.34, -118.33),
  // A postal city spread over ~40 miles.
  at("PALMDALE", "SPREADVILLE", 34.0, -118.0),
  at("PALMDALE", "SPREADVILLE", 34.0, -118.01),
  at("PALMDALE", "SPREADVILLE", 34.58, -118.0),
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function quantileCont(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Fake Db: answers PLACE_VALUES_SQL and placeCenterSql(); records every query. */
function fakeDb(parcels: P[]): RowsDb & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async rows(sql, params = []) {
      queries.push(sql);
      if (sql === PLACE_VALUES_SQL) {
        const counts = new Map<string, number>();
        for (const p of parcels) {
          counts.set(
            `jurisdiction\u0000${p.jurisdiction}`,
            (counts.get(`jurisdiction\u0000${p.jurisdiction}`) ?? 0) + 1,
          );
          if (p.city !== null)
            counts.set(
              `postal_city\u0000${p.city}`,
              (counts.get(`postal_city\u0000${p.city}`) ?? 0) + 1,
            );
        }
        return [...counts].map(([k, n]) => {
          const [basis, raw] = k.split("\u0000");
          return { basis, raw, n };
        });
      }
      expect(sql).toMatch(/oracle\.v_property/);
      expect(sql).toMatch(/oracle\.haversine_miles/);
      const col = /where jurisdiction in/.test(sql) ? "jurisdiction" : "city";
      const values = new Set(params as string[]);
      const pts = parcels.filter(
        (p) => values.has(p[col] as string) && p.lat !== null && p.lon !== null,
      ) as Array<P & { lat: number; lon: number }>;
      if (!pts.length) return [];
      const c = {
        lat: median(pts.map((p) => p.lat)),
        lon: median(pts.map((p) => p.lon)),
      };
      const spread = quantileCont(
        pts.map((p) => haversineMiles(c, p)),
        0.9,
      );
      return [{ lat: c.lat, lon: c.lon, n: pts.length, spread_miles: spread }];
    },
  };
}

describe("placeKey", () => {
  test("variants share a key; diacritics, state suffixes and punctuation are dropped", () => {
    expect(placeKey("Van Nuys")).toBe("VANNUYS");
    expect(placeKey("VAN NUYS,")).toBe("VANNUYS");
    expect(placeKey("VAN NUYS CALIF")).toBe("VANNUYS");
    expect(placeKey("Van Nuys, CA")).toBe("VANNUYS");
    expect(placeKey("van nuys california")).toBe("VANNUYS");
    expect(placeKey("La Cañada Flintridge")).toBe(
      placeKey("LA CANADA-FLINTRIDGE"),
    );
    expect(placeKey("Westlake Village")).toBe(placeKey("WEST LAKE VILLAGE"));
  });
  test("a CA inside a word is not a state suffix", () => {
    expect(placeKey("La Canada")).toBe("LACANADA");
    expect(placeKey("Santa Clarita")).toBe("SANTACLARITA");
  });
});

/** "median center <lat>, <lon> of <n> parcels" at 5 decimals, as the notes state it. */
const stated = (x: {
  center: { lat: number; lon: number };
  parcel_count: number;
}) =>
  `median center ${x.center.lat.toFixed(5)}, ${x.center.lon.toFixed(5)} of ${x.parcel_count} parcels`;

describe("PlaceIndex.resolve", () => {
  test("Van Nuys: the three stored spellings are pooled; median of the parcels with coordinates", async () => {
    const r = await new PlaceIndex(fakeDb(PARCELS)).resolve({
      name: "Van Nuys",
    });
    expect(r).toMatchObject({
      status: "resolved",
      basis: "postal_city",
      parcel_count: 5,
      raw_values: ["VAN NUYS", "VAN NUYS CALIF", "VAN NUYS,"],
      center: { lat: 34.187, lon: -118.449 },
      center_reliable: true,
      also_matched: null,
      note: "Resolved 'Van Nuys' (postal city) to the median center 34.18700, -118.44900 of 5 parcels. Stored postal city names: VAN NUYS | VAN NUYS CALIF | VAN NUYS,.",
    });
  });
  test("a jurisdiction and a postal city within 2 mi: the jurisdiction center, both stated", async () => {
    const r = await new PlaceIndex(fakeDb(PARCELS)).resolve({
      name: "Burbank",
    });
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.basis).toBe("jurisdiction");
    expect(r.also_matched?.basis).toBe("postal_city");
    expect(r.note).toMatch(/also matches a postal city/);
    expect(r.note).toContain(
      `Resolved 'Burbank' (jurisdiction) to the ${stated(r)}.`,
    );
    expect(r.note).toContain(`postal city with the ${stated(r.also_matched!)}`);
  });
  test("La Cañada and Westlake spellings match the stored jurisdictions", async () => {
    const idx = new PlaceIndex(fakeDb(PARCELS));
    const a = await idx.resolve({ name: "La Cañada Flintridge" });
    const b = await idx.resolve({ name: "Westlake Village" });
    expect(a).toMatchObject({
      status: "resolved",
      basis: "jurisdiction",
      raw_values: ["LA CANADA-FLINTRIDGE"],
    });
    expect(b).toMatchObject({
      status: "resolved",
      basis: "jurisdiction",
      raw_values: ["WEST LAKE VILLAGE"],
    });
  });
  test("ambiguous: a jurisdiction and a postal city more than 2 mi apart; no center chosen", async () => {
    const r = await new PlaceIndex(fakeDb(PARCELS)).resolve({
      name: "Los Angeles",
    });
    expect(r.status).toBe("ambiguous");
    if (r.status !== "ambiguous") return;
    expect(r.candidates.map((c) => c.basis)).toEqual([
      "jurisdiction",
      "postal_city",
    ]);
    expect(r).not.toHaveProperty("center");
    expect(r.note).toMatch(/no center was chosen/);
    // Each candidate's center (5 decimals) and parcel count.
    const [j, p] = r.candidates;
    expect(r.note).toMatch(
      new RegExp(
        `^'Los Angeles' is ambiguous: the jurisdiction's ${stated(j!).replace(/\./g, "\\.")} and the postal city's ${stated(p!).replace(/\./g, "\\.")} are [0-9.]+ mi apart; no center was chosen\\.$`,
      ),
    );
  });
  test("unknown: no match, no suggestions", async () => {
    const r = await new PlaceIndex(fakeDb(PARCELS)).resolve({
      name: "Van Nuyz",
    });
    expect(r).toEqual({
      status: "unknown",
      name: "Van Nuyz",
      note: '"Van Nuyz" matches no jurisdiction or postal city in this run; no center was chosen.',
    });
    expect(
      (await new PlaceIndex(fakeDb(PARCELS)).resolve({ name: "!!!" })).status,
    ).toBe("unknown");
  });
  test("UNINCORPORATED and a spread-out place resolve with center_reliable false", async () => {
    const idx = new PlaceIndex(fakeDb(PARCELS));
    const u = await idx.resolve({ name: "Unincorporated" });
    const s = await idx.resolve({ name: "Spreadville" });
    expect(u).toMatchObject({ status: "resolved", center_reliable: false });
    expect(s).toMatchObject({ status: "resolved", center_reliable: false });
    if (s.status === "resolved") {
      expect(s.spread_miles).toBeGreaterThan(10);
      expect(s.note).toMatch(/too spread out/);
    }
  });
  test("one values query per Db; centers cached per key", async () => {
    const db = fakeDb(PARCELS);
    const idx = placeIndexFor(db);
    expect(placeIndexFor(db)).toBe(idx);
    await idx.resolve({ name: "Van Nuys" });
    await idx.resolve({ name: "VAN NUYS, CA" });
    await idx.resolve({ name: "Burbank" });
    expect(db.queries.filter((q) => q === PLACE_VALUES_SQL)).toHaveLength(1);
    expect(db.queries).toHaveLength(1 + 1 + 2);
  });
});
