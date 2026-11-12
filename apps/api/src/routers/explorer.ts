import { z } from "zod";
import type {
  Records,
  RunSummary,
  SourcePageRow,
  SourceRow,
  Sources,
} from "../contract.ts";
import { procedure, router } from "../trpc.ts";

export const explorerRouter = router({
  runSummary: procedure.query(async ({ ctx }): Promise<RunSummary> => {
    const db = await ctx.db();
    const [run] = await db.rows("select * from oracle.v_run");
    const history = await db.rows("select * from oracle.v_run_history");
    return { run: run ?? {}, history };
  }),
  sources: procedure.query(async ({ ctx }): Promise<Sources> => {
    const db = await ctx.db();
    const sources = (
      await db.rows("select * from oracle.v_source order by source_name")
    ).map((r) => ({
      ...r,
      record_count: Number(r.record_count),
      page_count: Number(r.page_count),
    })) as unknown as SourceRow[];
    const pages = (
      await db.rows(
        "select * from oracle.v_source_page order by source_page_file",
      )
    ).map((r) => ({
      ...r,
      record_count: Number(r.record_count),
    })) as unknown as SourcePageRow[];
    return { sources, pages };
  }),
  records: procedure
    .input(
      z.object({
        source_name: z.string().min(1).max(200),
        page_file: z
          .string()
          .regex(/^page-\d{4}\.json$/)
          .optional(),
        after: z
          .string()
          .regex(/^\d{10}$/)
          .optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }): Promise<Records> => {
      const db = await ctx.db();
      const where =
        "p.source_name = $1 and ($2::varchar is null or p.source_page_file = $2)";
      const params = [input.source_name, input.page_file ?? null];
      const [t] = await db.rows(
        `select count(*)::integer as n from oracle.v_property_provenance p where ${where}`,
        params,
      );
      const items = await db.rows(
        `select p.parcel_id, v.address, v.year_built, p.source_name, p.source_request_url, p.source_retrieved_at, p.source_page_sha256, p.source_page_file
         from oracle.v_property_provenance p join oracle.v_property v using (parcel_id)
         where ${where} and ($3::varchar is null or p.parcel_id > $3) order by p.parcel_id limit ${input.limit + 1}`,
        [...params, input.after ?? null],
      );
      const page = items.slice(0, input.limit) as unknown as Records["items"];
      return {
        total: Number(t?.n ?? 0),
        items: page,
        next_after: items.length > input.limit ? page.at(-1)!.parcel_id : null,
      };
    }),
});
