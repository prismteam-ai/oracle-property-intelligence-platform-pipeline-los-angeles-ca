import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { roofAgeRule } from "@oracle-la/views";
import {
  LA_BOUNDS,
  MAX_POINTS,
  MAX_RESPONSE_BYTES,
  type ParcelDetail,
  type PointsResult,
  type SearchResult,
} from "../contract.ts";
import { procedure, router } from "../trpc.ts";

const filter = z.object({
  lat: z.number().min(LA_BOUNDS.minLat).max(LA_BOUNDS.maxLat),
  lon: z.number().min(LA_BOUNDS.minLon).max(LA_BOUNDS.maxLon),
  radius_miles: z.number().min(0.1).max(10).default(1),
  threshold_years: z.number().int().min(1).max(120).default(15),
});
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
        `select parcel_id, address, year_built, roll_year - year_built as roof_age_years_proxy, round(distance_miles, 3) as distance_miles, latitude, longitude
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
  points: procedure
    .input(filter)
    .query(async ({ ctx, input }): Promise<PointsResult> => {
      const db = await ctx.db();
      const rows = await db.rows(
        `select parcel_id, round(latitude, 5) as lat, round(longitude, 5) as lon from oracle.roof_age_candidates($1, $2, $3, $4)
       order by distance_miles, parcel_id limit ${MAX_POINTS + 1}`,
        args(input),
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
  detail: procedure
    .input(z.object({ parcel_id: z.string().regex(/^\d{10}$/) }))
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
