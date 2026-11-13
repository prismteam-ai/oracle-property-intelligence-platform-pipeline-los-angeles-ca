import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { roofAgeRule } from "@oracle-la/views";
import {
  LA_BOUNDS,
  MAX_MATCH_IDS,
  MAX_POINTS,
  MAX_RESPONSE_BYTES,
  type MatchResult,
  type ParcelDetail,
  type PointsResult,
  type SearchResult,
} from "../contract.ts";
import { procedure, router } from "../trpc.ts";
import { maxNotBelowMin, openWindow } from "./permits.ts";

const filter = z.object({
  lat: z.number().min(LA_BOUNDS.minLat).max(LA_BOUNDS.maxLat),
  lon: z.number().min(LA_BOUNDS.minLon).max(LA_BOUNDS.maxLon),
  radius_miles: z.number().min(0.1).max(10).default(1),
  threshold_years: z.number().int().min(1).max(120).default(15),
});
const parcelId = z.string().regex(/^\d{10}$/);
const args = (f: z.infer<typeof filter>) => [
  f.threshold_years,
  f.lat,
  f.lon,
  f.radius_miles,
];

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
        "select count(*)::integer as n from oracle.roof_age_candidates($1, $2, $3, $4)",
        args(input),
      );
      const items = (await db.rows(
        `select parcel_id, address, year_built, roll_year - year_built as roof_age_years_proxy, effective_roof_year,
           roll_year - effective_roof_year as roof_age_years, roof_age_basis, roof_year_permit_number,
           coalesce(permit_data_available, false) as permit_data_available, round(distance_miles, 3) as distance_miles,
           latitude, longitude
         from oracle.roof_age_candidates($1, $2, $3, $4) order by distance_miles, parcel_id limit ${input.limit} offset ${input.offset}`,
        args(input),
      )) as unknown as SearchResult["items"];
      const count = Number(c?.n ?? 0);
      return {
        count,
        rule: roofAgeRule(db.rollYear, input.threshold_years),
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
         from oracle.roof_age_candidates($1, $2, $3, $4) c
         left join (select distinct parcel_id from oracle.long_open_parcels($5::integer, $6::integer)) lo
           on lo.parcel_id = c.parcel_id
         order by c.distance_miles, c.parcel_id limit ${MAX_POINTS + 1}`,
        [...args(input), input.min_open_days, input.max_open_days ?? null],
      );
      const [c] = await db.rows(
        "select count(*)::integer as n from oracle.roof_age_candidates($1, $2, $3, $4)",
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
  /** Read-only: which of the given parcels the search matches (for "Leads in this search" when points are capped). */
  match: procedure
    .input(
      filter.extend({
        parcel_ids: z.array(parcelId).min(1).max(MAX_MATCH_IDS),
      }),
    )
    .query(async ({ ctx, input }): Promise<MatchResult> => {
      const db = await ctx.db();
      // The IDs go in as one parameter (10-digit strings joined by commas), never spliced into the SQL.
      const rows = await db.rows(
        `select distinct parcel_id from oracle.roof_age_candidates($1, $2, $3, $4)
         where parcel_id in (select unnest(string_split($5, ','))) order by parcel_id`,
        [...args(input), input.parcel_ids.join(",")],
      );
      return { parcel_ids: rows.map((r) => String(r.parcel_id)) };
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
