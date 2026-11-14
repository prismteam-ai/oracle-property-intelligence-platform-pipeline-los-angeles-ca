/**
 * Place names → coordinates from the run's own parcels. No network, no gazetteer, never fuzzy. Served by the
 * data API's places.resolve; the same module as packages/agent/src/place-index.ts (same rules, field names and
 * notes), shared here so the API and the agent resolve a name the same way.
 *
 * Source: the contract view oracle.v_property, columns `jurisdiction` (tax-rate-area city, incl. UNINCORPORATED)
 * and `city` (situs/postal city). Works over any `{ rows(sql, params?) }` (the data API's Db shape, structural).
 * - First use: one aggregate query lists the distinct values of both columns with their parcel counts; the
 *   match key is computed here, in one place (placeKey), so the user's words and the stored values share a rule.
 * - Per matched name: one aggregate query (bound parameters only) gives the median center, the parcel count and
 *   the 90th-percentile distance from that center; cached per key.
 * Nothing runs until the first resolve: the index is built lazily and kept per Db (placeIndexFor).
 */
import { EARTH_RADIUS_MILES } from "./sql.ts";

export interface RowsDb {
  rows(
    sql: string,
    params?: unknown[],
  ): Promise<Array<Record<string, unknown>>>;
}

export type PlaceBasis = "jurisdiction" | "postal_city";

export interface PlaceCandidate {
  basis: PlaceBasis;
  center: { lat: number; lon: number };
  /** Matched parcels with coordinates (the median's population). */
  parcel_count: number;
  /** The stored spellings pooled under the key. */
  raw_values: string[];
  /** 90th-percentile distance of those parcels from the center, miles. */
  spread_miles: number;
}

/** A resolved place: one candidate's fields plus how it was chosen. */
export type ResolvedPlace = {
  status: "resolved";
  name: string;
  center_reliable: boolean;
  /** The other basis, when both matched within AMBIGUITY_MILES (the jurisdiction center is used). */
  also_matched: PlaceCandidate | null;
} & PlaceCandidate;

/** Two candidates too far apart: no center is chosen. */
export interface AmbiguousPlace {
  status: "ambiguous";
  name: string;
  candidates: PlaceCandidate[];
}

export type PlaceResolution =
  | (ResolvedPlace & { note: string })
  | (AmbiguousPlace & { note: string })
  | { status: "unknown"; name: string; note: string };

export interface PlaceQueries {
  resolve(input: { name: string }): Promise<PlaceResolution>;
}

/** A jurisdiction and a postal city with centers further apart than this are ambiguous. */
export const AMBIGUITY_MILES = 2;
/** A place whose spread exceeds this has no meaningful "within N miles of" center. */
export const UNRELIABLE_SPREAD_MILES = 10;

/**
 * Match key: diacritics removed, uppercase, a trailing state suffix (CA, CALIF, CALIFORNIA, with or without a
 * comma) dropped, then every non-letter removed. "Van Nuys", "VAN NUYS," and "VAN NUYS CALIF" share a key;
 * "La Cañada Flintridge" matches "LA CANADA-FLINTRIDGE"; "Westlake Village" matches "WEST LAKE VILLAGE".
 */
export function placeKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[\s,]+(?:CA|CALIF|CALIFORNIA)[\s.,]*$/, "")
    .replace(/[^A-Z]/g, "");
}

export function haversineMiles(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) *
      Math.cos(rad(b.lat)) *
      Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(h));
}

const round = (x: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

/** The distinct stored values of both columns (contract view only). */
export const PLACE_VALUES_SQL = `select 'jurisdiction' as basis, jurisdiction as raw, count(*)::integer as n
from oracle.v_property where jurisdiction is not null group by jurisdiction
union all
select 'postal_city' as basis, city as raw, count(*)::integer as n
from oracle.v_property where city is not null group by city`;

/** Column per basis: a fixed map, never user input. */
const COLUMN: Record<PlaceBasis, "jurisdiction" | "city"> = {
  jurisdiction: "jurisdiction",
  postal_city: "city",
};

/** Median center, count and 90th-percentile spread of the parcels whose column is one of the bound values. */
export function placeCenterSql(basis: PlaceBasis, valueCount: number): string {
  const list = Array.from({ length: valueCount }, (_, i) => `$${i + 1}`).join(
    ", ",
  );
  return `with p as (
  select latitude, longitude from oracle.v_property
  where ${COLUMN[basis]} in (${list}) and latitude is not null and longitude is not null
), c as (
  select median(latitude) as lat, median(longitude) as lon, count(*)::integer as n from p
)
select c.lat, c.lon, c.n, quantile_cont(oracle.haversine_miles(c.lat, c.lon, p.latitude, p.longitude), 0.9) as spread_miles
from c, p group by c.lat, c.lon, c.n`;
}

export const BASIS_LABEL: Record<PlaceBasis, string> = {
  jurisdiction: "jurisdiction",
  postal_city: "postal city",
};

/**
 * Coordinates are stated, served by resolve_place and compared at 5 decimals (about 1 m), always through this one
 * formatter (toFixed(5)), so the number a tool returns, the digits a note states and the center the agent
 * attributes a search to cannot disagree in the last digit.
 */
export const COORD_DECIMALS = 5;
/** A coordinate as text at 5 decimals: "34.15279". */
export const coordText = (x: number): string => x.toFixed(COORD_DECIMALS);
/** A coordinate rounded to 5 decimals (the number coordText prints). */
export const roundCoord = (x: number): number => Number(coordText(x));
/** A center with both coordinates rounded to 5 decimals. */
export const roundCenter = (c: { lat: number; lon: number }) => ({
  lat: roundCoord(c.lat),
  lon: roundCoord(c.lon),
});
/** True when two coordinates print the same at 5 decimals. */
export const sameCoord = (a: number, b: number): boolean =>
  coordText(a) === coordText(b);

const coord = coordText;
const count = (n: number) => n.toLocaleString("en-US");

/** "median center 34.20155, -118.45361 of 456 parcels": the center (5 decimals) and its parcel count. */
function medianCenter(c: PlaceCandidate): string {
  return `median center ${coord(c.center.lat)}, ${coord(c.center.lon)} of ${count(c.parcel_count)} parcels`;
}

/** "the median center 34.20155, -118.45361 of 456 parcels". */
export function centerPhrase(c: PlaceCandidate): string {
  return `the ${medianCenter(c)}`;
}

/** "'Van Nuys' (postal city) to the median center 34.20155, -118.45361 of 456 parcels" (after "Resolved"). */
export function resolvedPhrase(name: string, c: PlaceCandidate): string {
  return `'${name}' (${BASIS_LABEL[c.basis]}) to ${centerPhrase(c)}`;
}

/** Each candidate's center and parcel count: "the jurisdiction's median center … of N parcels and the …". */
export function candidatesPhrase(
  candidates: readonly PlaceCandidate[],
): string {
  return candidates
    .map((c) => `the ${BASIS_LABEL[c.basis]}'s ${medianCenter(c)}`)
    .join(" and ");
}

/**
 * The note of a resolved or ambiguous resolution, built from its fields only (PlaceIndex and the resolve_place tool
 * share it). It always states the center(s) with 5 decimals and the parcel count(s).
 */
export function resolutionNote(r: ResolvedPlace | AmbiguousPlace): string {
  if (r.status === "ambiguous") {
    const [a, b, ...rest] = r.candidates;
    const apart =
      a && b && rest.length === 0
        ? ` are ${round(haversineMiles(a.center, b.center), 1)} mi apart`
        : "";
    return `'${r.name}' is ambiguous: ${candidatesPhrase(r.candidates)}${apart}; no center was chosen.`;
  }
  let note = `Resolved ${resolvedPhrase(r.name, r)}. Stored ${BASIS_LABEL[r.basis]} names: ${r.raw_values.join(" | ")}.`;
  if (r.also_matched)
    note += ` It also matches a ${BASIS_LABEL[r.also_matched.basis]} with ${centerPhrase(r.also_matched)}, ${round(haversineMiles(r.center, r.also_matched.center), 1)} mi away; the ${BASIS_LABEL[r.basis]} center is used.`;
  if (!r.center_reliable)
    note += ` The area is too spread out (90% of its parcels lie within ${r.spread_miles} mi of the center) for "within N miles of" to be meaningful.`;
  return note;
}

export class PlaceIndex implements PlaceQueries {
  private readonly db: RowsDb;
  private values: Promise<Map<string, Map<PlaceBasis, string[]>>> | null = null;
  private readonly centers = new Map<string, Promise<PlaceCandidate | null>>();

  constructor(db: RowsDb) {
    this.db = db;
  }

  /** key → basis → stored spellings (one aggregate query at first use). */
  private index(): Promise<Map<string, Map<PlaceBasis, string[]>>> {
    this.values ??= this.db.rows(PLACE_VALUES_SQL).then((rows) => {
      const byKey = new Map<string, Map<PlaceBasis, string[]>>();
      for (const r of rows) {
        const basis = r.basis as PlaceBasis;
        const raw = String(r.raw);
        const key = placeKey(raw);
        if (!key) continue;
        const entry = byKey.get(key) ?? new Map<PlaceBasis, string[]>();
        entry.set(basis, [...(entry.get(basis) ?? []), raw].sort());
        byKey.set(key, entry);
      }
      return byKey;
    });
    return this.values;
  }

  private candidate(
    key: string,
    basis: PlaceBasis,
    raws: string[],
  ): Promise<PlaceCandidate | null> {
    const cacheKey = `${basis}:${key}`;
    let p = this.centers.get(cacheKey);
    if (!p) {
      p = this.db
        .rows(placeCenterSql(basis, raws.length), raws)
        .then((rows) => {
          const r = rows[0];
          const n = Number(r?.n ?? 0);
          if (!r || n === 0 || r.lat == null || r.lon == null) return null;
          return {
            basis,
            // 5 decimals, the precision every note states and resolve_place serves.
            center: roundCenter({ lat: Number(r.lat), lon: Number(r.lon) }),
            parcel_count: n,
            raw_values: raws,
            spread_miles: round(Number(r.spread_miles ?? 0), 2),
          };
        });
      this.centers.set(cacheKey, p);
    }
    return p;
  }

  async resolve({ name }: { name: string }): Promise<PlaceResolution> {
    const key = placeKey(name);
    const unknown: PlaceResolution = {
      status: "unknown",
      name,
      note: `"${name}" matches no jurisdiction or postal city in this run; no center was chosen.`,
    };
    if (!key) return unknown;
    const entry = (await this.index()).get(key);
    if (!entry) return unknown;
    const found: PlaceCandidate[] = [];
    for (const basis of ["jurisdiction", "postal_city"] as const) {
      const raws = entry.get(basis);
      if (!raws) continue;
      const c = await this.candidate(key, basis, raws);
      if (c) found.push(c);
    }
    if (found.length === 0)
      return {
        ...unknown,
        note: `"${name}" matches stored place names, but none of their parcels has coordinates; no center was chosen.`,
      };
    const [first, second] = found as [PlaceCandidate, PlaceCandidate?];
    if (
      second &&
      haversineMiles(first.center, second.center) > AMBIGUITY_MILES
    ) {
      const ambiguous: AmbiguousPlace = {
        status: "ambiguous",
        name,
        candidates: found,
      };
      return { ...ambiguous, note: resolutionNote(ambiguous) };
    }
    // One match, or both within AMBIGUITY_MILES: the jurisdiction (first) center is used.
    const unreliable =
      (first.basis === "jurisdiction" &&
        first.raw_values.includes("UNINCORPORATED")) ||
      first.spread_miles > UNRELIABLE_SPREAD_MILES;
    const resolved: ResolvedPlace = {
      status: "resolved",
      name,
      ...first,
      center_reliable: !unreliable,
      also_matched: second ?? null,
    };
    return { ...resolved, note: resolutionNote(resolved) };
  }
}

const indexes = new WeakMap<RowsDb, PlaceIndex>();

/** The PlaceIndex of a Db, created once per Db. */
export function placeIndexFor(db: RowsDb): PlaceIndex {
  let idx = indexes.get(db);
  if (!idx) {
    idx = new PlaceIndex(db);
    indexes.set(db, idx);
  }
  return idx;
}
