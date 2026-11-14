import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  MAX_SOURCE_PAGES_LIMIT,
  MAX_SOURCE_PAGES_OFFSET,
  type RecordRow,
  type Records,
  type RunSummary,
  type SourceKind,
  type SourcePageRow,
  type SourcePages,
  type SourceRow,
  type Sources,
} from "../contract.ts";
import { procedure, router } from "../trpc.ts";

/**
 * Page file names as the sources record them: the pilot's page-0000.json, the county roll's
 * pages/page-00000.json.gz, and the LADBS pages pages/<dataset id>_p000.json.gz.
 */
export const PAGE_FILE =
  /^(page-\d{4}\.json|pages\/page-\d{5}\.json\.gz|pages\/[a-z0-9]{4}-[a-z0-9]{4}_p\d{3}\.json\.gz)$/;
/** Cursors (`after`), one shape per source kind: parcel ID, permit number, "<permit number>:<contractor row>". */
const CURSOR: Record<SourceKind, RegExp> = {
  parcel: /^\d{10}$/,
  permit: /^\d{5}-\d{5}-\d{5}$/,
  contractor: /^\d{5}-\d{5}-\d{5}:\d{1,3}$/,
};
const PROVENANCE =
  "pr.source_name, pr.source_request_url, pr.source_retrieved_at, pr.source_page_sha256, pr.source_page_file";

export const explorerRouter = router({
  runSummary: procedure.query(async ({ ctx }): Promise<RunSummary> => {
    const db = await ctx.db();
    const [run] = await db.rows("select * from oracle.v_run");
    const history = await db.rows("select * from oracle.v_run_history");
    // v_run and v_run_history always select run_kind, rebuild_of and source_changes (null where not recorded).
    return {
      run: (run ?? {}) as RunSummary["run"],
      history: history as RunSummary["history"],
    };
  }),
  /** The sources with their record and page counts; the page list is explorer.sourcePages. */
  sources: procedure.query(async ({ ctx }): Promise<Sources> => {
    const db = await ctx.db();
    const sources = (
      await db.rows("select * from oracle.v_source order by source_name")
    ).map((r) => ({
      ...r,
      record_count: Number(r.record_count),
      page_count: Number(r.page_count),
    })) as unknown as SourceRow[];
    return { sources };
  }),
  /**
   * One source's pages (request URL, retrieval time, page sha256, record count) in page-file order, `limit`
   * from `offset`, with the source's page count.
   */
  sourcePages: procedure
    .input(
      z.object({
        source_name: z.string().min(1).max(200),
        offset: z.number().int().min(0).max(MAX_SOURCE_PAGES_OFFSET).default(0),
        limit: z.number().int().min(1).max(MAX_SOURCE_PAGES_LIMIT).default(50),
      }),
    )
    .query(async ({ ctx, input }): Promise<SourcePages> => {
      const db = await ctx.db();
      // One pass over the source's pages: the window count is the source's page count, taken before the limit.
      // offset and limit are integers checked above. The page file orders the pages; the other columns only
      // break ties, so the order is total.
      const rows = await db.rows(
        `select source_kind, source_name, source_page_file, source_request_url, source_retrieved_at,
           source_page_sha256, record_count, count(*) over () as total
         from oracle.v_source_page where source_name = $1
         order by source_page_file, source_request_url, source_retrieved_at, source_page_sha256
         limit ${input.limit} offset ${input.offset}`,
        [input.source_name],
      );
      // No row: an unknown source, or an offset past the end (then the count alone says how many there are).
      const total = rows.length
        ? Number(rows[0]!.total)
        : Number(
            (
              await db.rows(
                "select count(*)::integer as n from oracle.v_source_page where source_name = $1",
                [input.source_name],
              )
            )[0]?.n ?? 0,
          );
      const items: SourcePageRow[] = rows.map((r) => ({
        source_kind: r.source_kind as SourceKind,
        source_name: String(r.source_name),
        source_page_file: String(r.source_page_file),
        source_request_url: String(r.source_request_url),
        source_retrieved_at: String(r.source_retrieved_at),
        source_page_sha256: String(r.source_page_sha256),
        record_count: Number(r.record_count),
      }));
      const next = input.offset + items.length;
      return {
        total,
        items,
        next_offset: items.length && next < total ? next : null,
      };
    }),
  /**
   * One source's records in key order, with their provenance: parcels by parcel ID, permits by permit
   * number, contractor rows by (permit number, contractor row). Optionally one page file only.
   */
  records: procedure
    .input(
      z.object({
        source_name: z.string().min(1).max(200),
        page_file: z.string().regex(PAGE_FILE).optional(),
        after: z
          .string()
          .regex(
            new RegExp(
              Object.values(CURSOR)
                .map((r) => `(${r.source})`)
                .join("|"),
            ),
          )
          .optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }): Promise<Records> => {
      const db = await ctx.db();
      const page = input.page_file ?? null;
      const kinds = await db.rows(
        `select 'parcel' as k, count(*)::integer as n_all,
           count(*) filter (where $2::varchar is null or source_page_file = $2)::integer as n
         from oracle.v_property_provenance where source_name = $1
         union all
         select source_kind, count(*)::integer, count(*) filter (where $2::varchar is null or source_page_file = $2)::integer
         from oracle.v_permit_provenance where source_name = $1 group by source_kind`,
        [input.source_name, page],
      );
      const found = kinds.find((k) => Number(k.n_all) > 0);
      if (!found)
        return { source_kind: null, total: 0, items: [], next_after: null };
      const kind = String(found.k) as SourceKind;
      if (input.after !== undefined && !CURSOR[kind].test(input.after))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `after must be a ${kind} cursor`,
        });
      const where =
        "pr.source_name = $1 and ($2::varchar is null or pr.source_page_file = $2)";
      const n = input.limit + 1;
      let rows: Array<Record<string, unknown>>;
      if (kind === "parcel")
        rows = (
          await db.rows(
            `select v.parcel_id, v.address, v.year_built, ${PROVENANCE}
             from oracle.v_property_provenance pr join oracle.v_property v using (parcel_id)
             where ${where} and ($3::varchar is null or pr.parcel_id > $3) order by pr.parcel_id limit ${n}`,
            [input.source_name, page, input.after ?? null],
          )
        ).map((r) => ({ kind, record_key: r.parcel_id, ...r }));
      else if (kind === "permit")
        rows = (
          await db.rows(
            `select p.permit_number, p.address, p.source_status_desc, p.permit_status_class,
               p.permit_issue_date, p.join_method, coalesce(c.parcel_count, 0)::integer as parcel_count, ${PROVENANCE}
             from oracle.v_permit_provenance pr join oracle.v_permit p using (permit_number)
             left join (select permit_number, count(*) as parcel_count from oracle.v_permit_parcel group by 1) c
               using (permit_number)
             where pr.source_kind = 'permit' and ${where} and ($3::varchar is null or pr.permit_number > $3)
             order by pr.permit_number limit ${n}`,
            [input.source_name, page, input.after ?? null],
          )
        ).map((r) => ({
          kind,
          record_key: r.permit_number,
          parcel_id: null,
          year_built: null,
          ...r,
        }));
      else {
        const [afterPermit, afterRow] = input.after?.split(":") ?? [];
        rows = (
          await db.rows(
            `select c.permit_number, c.contractor_row, c.contractors_business_name, c.license_identifier,
               c.source_license_type, c.license_class, c.license_class_note, c.is_owner_builder,
               c.contractor_identity_key, c.canonical_business_name, c.name_variant_count, c.identity_permit_count,
               ${PROVENANCE}
             from oracle.v_permit_provenance pr
             join oracle.v_permit_contractor c using (permit_number, contractor_row)
             where pr.source_kind = 'contractor' and ${where}
               and ($3::varchar is null or pr.permit_number > $3 or (pr.permit_number = $3 and pr.contractor_row > $4::integer))
             order by pr.permit_number, pr.contractor_row limit ${n}`,
            [input.source_name, page, afterPermit ?? null, afterRow ?? null],
          )
        ).map((r) => ({
          kind,
          record_key: `${String(r.permit_number)}:${Number(r.contractor_row)}`,
          parcel_id: null,
          address: null,
          year_built: null,
          ...r,
        }));
      }
      const items = rows.slice(0, input.limit) as unknown as RecordRow[];
      return {
        source_kind: kind,
        total: Number(found.n),
        items,
        next_after: rows.length > input.limit ? items.at(-1)!.record_key : null,
      };
    }),
});
