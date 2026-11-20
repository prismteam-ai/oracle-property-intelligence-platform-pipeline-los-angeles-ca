import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { roofAgeRule } from "@oracle-la/views";
import {
  DEFAULT_MIN_OPEN_DAYS,
  LA_BOUNDS,
  MAX_MATCH_IDS,
  MAX_OPEN_DAYS,
  MAX_POINTS,
  MAX_RESPONSE_BYTES,
  OWNERSHIP_BASIS,
  OWNERSHIP_PROXY_NOTE,
  type MatchResult,
  type OwnershipBasis,
  type OwnershipRuleOut,
  type ParcelDetail,
  type PointsResult,
  type SearchResult,
} from "../contract.ts";
import { procedure, router } from "../trpc.ts";
import { maxNotBelowMin, openWindow } from "./permits.ts";

const OWNERSHIP_BASES = [
  "recording",
  "base_year",
  "both",
] as const satisfies readonly OwnershipBasis[];
const lat = z.number().min(LA_BOUNDS.minLat).max(LA_BOUNDS.maxLat);
const lon = z.number().min(LA_BOUNDS.minLon).max(LA_BOUNDS.maxLon);
const radiusMiles = z.number().min(0.1).max(10);
const thresholdYears = z.number().int().min(1).max(120);
/** The ownership filter: absent = none. */
const ownershipBasis = z.enum(OWNERSHIP_BASES).optional();
/** The search filter shared by search, points and match, so all three keep the same set. */
const filter = z.object({
  lat,
  lon,
  radius_miles: radiusMiles.default(1),
  threshold_years: thresholdYears.default(15),
  ownership_basis: ownershipBasis,
});
type Filter = z.infer<typeof filter>;
const parcelId = z.string().regex(/^\d{10}$/);

/**
 * The parcels the filter matches, as a SQL table expression over parameters $1-$5: the roof-age candidates
 * in the circle ($1 threshold, $2 lat, $3 lon, $4 radius) that pass the ownership basis ($5; null: no filter).
 */
const CANDIDATES = `(select * from oracle.roof_age_candidates($1, $2, $3, $4)
  where oracle.ownership_passes($5::varchar, owner_unchanged_10y_proxy, ownership_base_year_10y_proxy))`;
const args = (f: Filter) => [
  f.threshold_years,
  f.lat,
  f.lon,
  f.radius_miles,
  f.ownership_basis ?? null,
];

/** The ownership rule a result states: the basis with its text, weakness and the proxy note; null without one. */
export function ownershipRule(
  basis: OwnershipBasis | undefined,
): OwnershipRuleOut | null {
  if (basis === undefined) return null;
  return {
    basis,
    text: OWNERSHIP_BASIS[basis].text,
    weakness: OWNERSHIP_BASIS[basis].weakness,
    proxy_note: OWNERSHIP_PROXY_NOTE,
  } as OwnershipRuleOut;
}

const FILTER_FIELDS = [
  "radius_miles",
  "threshold_years",
  "ownership_basis",
] as const;
const WINDOW_FIELDS = ["min_open_days", "max_open_days"] as const;
/**
 * parcels.match input. The search filter (lat and lon, with radius, roof age and ownership) is required unless
 * long_open_permit is on; then it is optional, and without it the given IDs are checked for a long-open
 * roofing permit only. The window is sent only with long_open_permit. Filter fields without lat and lon, or
 * one of lat and lon alone, are refused rather than ignored.
 */
const matchInput = z
  .object({
    lat: lat.optional(),
    lon: lon.optional(),
    radius_miles: radiusMiles.optional(),
    threshold_years: thresholdYears.optional(),
    ownership_basis: ownershipBasis,
    long_open_permit: z.boolean().default(false),
    min_open_days: z.number().int().min(0).max(MAX_OPEN_DAYS).optional(),
    max_open_days: z.number().int().min(0).max(MAX_OPEN_DAYS).optional(),
    parcel_ids: z.array(parcelId).min(1).max(MAX_MATCH_IDS),
  })
  .superRefine((i, ctx) => {
    const hasFilter = i.lat !== undefined || i.lon !== undefined;
    if (hasFilter && (i.lat === undefined || i.lon === undefined))
      ctx.addIssue({
        code: "custom",
        message: "lat and lon go together",
        path: [i.lat === undefined ? "lat" : "lon"],
      });
    if (!hasFilter && !i.long_open_permit)
      ctx.addIssue({
        code: "custom",
        message:
          "the search filter (lat, lon) is required unless long_open_permit is true",
        path: ["lat"],
      });
    if (!hasFilter)
      for (const k of FILTER_FIELDS)
        if (i[k] !== undefined)
          ctx.addIssue({
            code: "custom",
            message: `${k} needs the search filter (lat, lon)`,
            path: [k],
          });
    if (!i.long_open_permit)
      for (const k of WINDOW_FIELDS)
        if (i[k] !== undefined)
          ctx.addIssue({
            code: "custom",
            message: `${k} needs long_open_permit`,
            path: [k],
          });
    if (
      !maxNotBelowMin({
        min_open_days: i.min_open_days ?? DEFAULT_MIN_OPEN_DAYS,
        max_open_days: i.max_open_days,
      })
    )
      ctx.addIssue({
        code: "custom",
        message: "max_open_days must not be below min_open_days",
        path: ["max_open_days"],
      });
  });

export const parcelsRouter = router({
  search: procedure
    .input(
      filter.extend({
        offset: z.number().int().min(0).max(1_000_000).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }): Promise<SearchResult> => {
      const db = await ctx.db();
      const [c] = await db.rows(
        `select count(*)::integer as n from ${CANDIDATES}`,
        args(input),
      );
      const items = (await db.rows(
        `select parcel_id, address, year_built, roll_year - year_built as roof_age_years_proxy, effective_roof_year,
           roll_year - effective_roof_year as roof_age_years, roof_age_basis, roof_year_permit_number,
           coalesce(permit_data_available, false) as permit_data_available, land_base_year,
           round(distance_miles, 3) as distance_miles, latitude, longitude
         from ${CANDIDATES} order by distance_miles, parcel_id limit ${input.limit} offset ${input.offset}`,
        args(input),
      )) as unknown as SearchResult["items"];
      const count = Number(c?.n ?? 0);
      return {
        count,
        rule: roofAgeRule(db.rollYear, input.threshold_years),
        ownership: ownershipRule(input.ownership_basis),
        items,
        next_offset:
          input.offset + items.length < count
            ? input.offset + items.length
            : null,
      };
    }),
  /**
   * Map points: columnar, nearest first, capped at MAX_POINTS. Each point is marked for permit data and for
   * a long-open permit under the same open-duration window as permits.longOpen.
   */
  points: procedure
    .input(
      filter.extend(openWindow).refine(maxNotBelowMin, {
        message: "max_open_days must not be below min_open_days",
        path: ["max_open_days"],
      }),
    )
    .query(async ({ ctx, input }): Promise<PointsResult> => {
      const db = await ctx.db();
      // long_open_parcels counts roofing work only (roofing_work), the same rule as permits.longOpen.
      const rows = await db.rows(
        `select c.parcel_id, round(c.latitude, 5) as lat, round(c.longitude, 5) as lon,
           coalesce(c.permit_data_available, false) as permit_data, lo.parcel_id is not null as long_open
         from ${CANDIDATES} c
         left join (select distinct parcel_id from oracle.long_open_parcels($6::integer, $7::integer)) lo
           on lo.parcel_id = c.parcel_id
         order by c.distance_miles, c.parcel_id limit ${MAX_POINTS + 1}`,
        [...args(input), input.min_open_days, input.max_open_days ?? null],
      );
      const [c] = await db.rows(
        `select count(*)::integer as n from ${CANDIDATES}`,
        args(input),
      );
      const kept = rows.slice(0, MAX_POINTS);
      const out: PointsResult = {
        count: Number(c?.n ?? 0),
        encoding: "columnar-v1",
        precision: 5,
        id: kept.map((r) => String(r.parcel_id)),
        lat: kept.map((r) => Number(r.lat)),
        lon: kept.map((r) => Number(r.lon)),
        permit_data_available: kept.map((r) => (r.permit_data ? 1 : 0)),
        long_open_permit: kept.map((r) => (r.long_open ? 1 : 0)),
        long_open: {
          min_open_days: input.min_open_days,
          max_open_days: input.max_open_days ?? null,
        },
        ownership: ownershipRule(input.ownership_basis),
        truncated: rows.length > MAX_POINTS,
        max_points: MAX_POINTS,
      };
      const bytes = Buffer.byteLength(JSON.stringify(out));
      ctx.metrics.addMetric("PointsResponseBytes", "Bytes", bytes);
      if (bytes > MAX_RESPONSE_BYTES)
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: `points response ${bytes} B exceeds ${MAX_RESPONSE_BYTES} B`,
        });
      return out;
    }),
  /**
   * Read-only: which of the given parcels pass (the lead list's "Leads in this search" and "has a long-open
   * roofing permit"). With the search filter: the parcels the search matches. With long_open_permit: only
   * those with a long-open roofing permit under the window, the rule of the map's highlight
   * (oracle.long_open_parcels); without a filter, the given IDs are checked for that alone.
   */
  match: procedure
    .input(matchInput)
    .query(async ({ ctx, input }): Promise<MatchResult> => {
      const db = await ctx.db();
      const window = input.long_open_permit
        ? {
            min_open_days: input.min_open_days ?? DEFAULT_MIN_OPEN_DAYS,
            max_open_days: input.max_open_days ?? null,
          }
        : null;
      const f: Filter | null =
        input.lat !== undefined && input.lon !== undefined
          ? {
              lat: input.lat,
              lon: input.lon,
              radius_miles: input.radius_miles ?? 1,
              threshold_years: input.threshold_years ?? 15,
              ownership_basis: input.ownership_basis,
            }
          : null;
      // The IDs go in as one parameter (10-digit strings joined by commas), never spliced into the SQL.
      const ids = input.parcel_ids.join(",");
      const LONG_OPEN = (min: string, max: string) =>
        `select parcel_id from oracle.long_open_parcels(${min}::integer, ${max}::integer)`;
      let rows: Array<Record<string, unknown>>;
      if (f)
        // $1-$5 the filter (see CANDIDATES), $6 the IDs, $7-$8 the window.
        rows = await db.rows(
          `select distinct c.parcel_id from ${CANDIDATES} c
           where c.parcel_id in (select unnest(string_split($6, ',')))
             ${window ? `and c.parcel_id in (${LONG_OPEN("$7", "$8")})` : ""}
           order by c.parcel_id`,
          [
            ...args(f),
            ids,
            ...(window ? [window.min_open_days, window.max_open_days] : []),
          ],
        );
      else if (window)
        // No filter (the input refuses this without long_open_permit): the given IDs with a long-open permit.
        rows = await db.rows(
          `select distinct parcel_id from (${LONG_OPEN("$1", "$2")})
           where parcel_id in (select unnest(string_split($3, ','))) order by parcel_id`,
          [window.min_open_days, window.max_open_days, ids],
        );
      else
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "the search filter (lat, lon) is required unless long_open_permit is true",
        });
      return {
        parcel_ids: rows.map((r) => String(r.parcel_id)),
        long_open: window,
        ownership: ownershipRule(f?.ownership_basis),
      };
    }),
  detail: procedure
    .input(z.object({ parcel_id: parcelId }))
    .query(async ({ ctx, input }): Promise<ParcelDetail> => {
      const db = await ctx.db();
      const [property] = await db.rows(
        "select * from oracle.v_property where parcel_id = $1",
        [input.parcel_id],
      );
      const [provenance] = await db.rows(
        "select * from oracle.v_property_provenance where parcel_id = $1",
        [input.parcel_id],
      );
      if (!property || !provenance)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `parcel ${input.parcel_id} not found`,
        });
      return { property, provenance };
    }),
});
