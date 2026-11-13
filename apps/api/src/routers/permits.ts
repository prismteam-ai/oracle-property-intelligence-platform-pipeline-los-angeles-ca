import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { longOpenRule, roofAgeRule } from "@oracle-la/views";
import {
  DEFAULT_MIN_OPEN_DAYS,
  LA_BOUNDS,
  MAX_OPEN_DAYS,
  MAX_RESPONSE_BYTES,
  type LongOpenResult,
  type ParcelPermit,
  type ParcelPermits,
  type PermitContractor,
} from "../contract.ts";
import { procedure, router } from "../trpc.ts";

/** The open-duration window (days) shared by permits.longOpen and parcels.points. */
export const openWindow = {
  min_open_days: z
    .number()
    .int()
    .min(0)
    .max(MAX_OPEN_DAYS)
    .default(DEFAULT_MIN_OPEN_DAYS),
  max_open_days: z.number().int().min(0).max(MAX_OPEN_DAYS).optional(),
};
/** A maximum below the minimum is refused (BAD_REQUEST). */
export const maxNotBelowMin = (i: {
  min_open_days: number;
  max_open_days?: number | undefined;
}) => i.max_open_days === undefined || i.max_open_days >= i.min_open_days;
const MAX_BELOW_MIN = {
  message: "max_open_days must not be below min_open_days",
  path: ["max_open_days"],
};

/** Refuse a response over the size guard (the Lambda sync limit is 6 MB). */
export function guardSize<T>(route: string, out: T): T {
  const bytes = Buffer.byteLength(JSON.stringify(out));
  if (bytes > MAX_RESPONSE_BYTES)
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `${route} response ${bytes} B exceeds ${MAX_RESPONSE_BYTES} B`,
    });
  return out;
}

/** The permit fields served by both routes (stored column names). `p` is v_permit, `pp` v_permit_parcel. */
const PERMIT_COLUMNS = `p.permit_number, p.address, p.postal_code, p.source_permit_type,
  p.source_permit_sub_type, p.source_status_desc, p.permit_status_class, p.application_received_date,
  p.permit_issue_date, p.status_date, p.open_since, p.open_days, p.roofing_work, p.roof_coating_only,
  p.join_method, pp.building_level`;
const CONTRACTOR_COLUMNS = `contractors_business_name, license_identifier, source_license_type, license_class,
  license_class_note, is_owner_builder, license_expiration_date, city_name, state_code`;

const BBB_REASON =
  "BBB ratings are not in this data: no BBB source is ingested.";

export const permitsRouter = router({
  /**
   * Long-open permits around a point: open-issued permits open for min_open_days to max_open_days days,
   * each counted once at its nearest linked parcel in the circle (and, with threshold_years, only where
   * that parcel's effective roof year is older than the threshold).
   */
  longOpen: procedure
    .input(
      z
        .object({
          lat: z.number().min(LA_BOUNDS.minLat).max(LA_BOUNDS.maxLat),
          lon: z.number().min(LA_BOUNDS.minLon).max(LA_BOUNDS.maxLon),
          radius_miles: z.number().min(0.1).max(10).default(1),
          threshold_years: z.number().int().min(1).max(120).optional(),
          ...openWindow,
          sort: z.enum(["open_days", "distance"]).default("open_days"),
          offset: z.number().int().min(0).max(1_000_000).default(0),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .refine(maxNotBelowMin, MAX_BELOW_MIN),
    )
    .query(async ({ ctx, input }): Promise<LongOpenResult> => {
      const db = await ctx.db();
      const args = [
        input.min_open_days,
        input.max_open_days ?? null,
        input.threshold_years ?? null,
        input.lat,
        input.lon,
        input.radius_miles,
      ];
      const from =
        "oracle.long_open_permits($1::integer, $2::integer, $3::integer, $4, $5, $6)";
      // Longest open first or nearest first; ties by permit number either way.
      const order =
        input.sort === "distance"
          ? "distance_miles, permit_number"
          : "open_days desc, permit_number";
      const rows = await db.rows(
        `select permit_number, address, postal_code, source_permit_type, source_permit_sub_type,
           source_status_desc, permit_status_class, application_received_date, permit_issue_date, status_date,
           open_since, open_days, roofing_work, roof_coating_only, join_method, building_level, parcel_count,
           parcel_id, round(distance_miles, 3) as distance_miles, effective_roof_year, roof_age_basis,
           roof_year_permit_number, count(*) over () as total
         from ${from} order by ${order} limit ${input.limit} offset ${input.offset}`,
        args,
      );
      // An empty page (offset past the end) has no row to carry the total: count separately.
      const count = rows.length
        ? Number(rows[0]!.total)
        : Number(
            (
              await db.rows(`select count(*)::integer as n from ${from}`, args)
            )[0]?.n ?? 0,
          );
      const items = rows.map((r) => {
        const item: Record<string, unknown> = {
          ...r,
          parcel_count: Number(r.parcel_count),
        };
        delete item.total;
        return item;
      }) as unknown as LongOpenResult["items"];
      const rule = longOpenRule(
        db.referenceDate,
        input.min_open_days,
        input.max_open_days ?? null,
      );
      return guardSize("permits.longOpen", {
        count,
        rule: {
          ...rule,
          roof_age:
            input.threshold_years === undefined
              ? null
              : roofAgeRule(db.rollYear, input.threshold_years),
        },
        items,
        next_offset:
          input.offset + items.length < count
            ? input.offset + items.length
            : null,
      });
    }),
  /** A parcel's permits with their contractors, and whether permit data covers the parcel at all. */
  forParcel: procedure
    .input(z.object({ parcel_id: z.string().regex(/^\d{10}$/) }))
    .query(async ({ ctx, input }): Promise<ParcelPermits> => {
      const db = await ctx.db();
      const [parcel] = await db.rows(
        `select parcel_id, coalesce(permit_data_available, false) as permit_data_available, jurisdiction,
           effective_roof_year, roof_age_basis, roof_year_permit_number
         from oracle.v_property where parcel_id = $1`,
        [input.parcel_id],
      );
      if (!parcel)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `parcel ${input.parcel_id} not found`,
        });
      const permits = await db.rows(
        `with mine as (select permit_number, building_level from oracle.v_permit_parcel where parcel_id = $1),
         counts as (
           select permit_number, count(*)::integer as parcel_count from oracle.v_permit_parcel
           where permit_number in (select permit_number from mine) group by permit_number)
         select ${PERMIT_COLUMNS}, c.parcel_count
         from mine pp join oracle.v_permit p using (permit_number) join counts c using (permit_number)
         order by coalesce(p.permit_issue_date, p.application_received_date) desc nulls last, p.permit_number`,
        [input.parcel_id],
      );
      const contractors = permits.length
        ? await db.rows(
            `select permit_number, ${CONTRACTOR_COLUMNS} from oracle.v_permit_contractor
             where permit_number in (select unnest(string_split($1, ','))) order by permit_number, contractor_row`,
            [permits.map((p) => String(p.permit_number)).join(",")],
          )
        : [];
      const byPermit = new Map<string, PermitContractor[]>();
      for (const { permit_number, ...c } of contractors) {
        const k = String(permit_number);
        byPermit.set(k, [
          ...(byPermit.get(k) ?? []),
          c as unknown as PermitContractor,
        ]);
      }
      return guardSize("permits.forParcel", {
        ...(parcel as unknown as Omit<ParcelPermits, "permits" | "bbb">),
        permits: permits.map(
          (p) =>
            ({
              ...p,
              contractors: byPermit.get(String(p.permit_number)) ?? [],
            }) as unknown as ParcelPermit,
        ),
        bbb: { available: false, reason: BBB_REASON },
      });
    }),
});
