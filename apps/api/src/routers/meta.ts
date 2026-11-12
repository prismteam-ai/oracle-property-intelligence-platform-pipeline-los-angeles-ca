import { CONTRACT } from "@oracle-la/views";
import { API_VERSION, type MetaInfo } from "../contract.ts";
import { procedure, router } from "../trpc.ts";

export const metaRouter = router({
  info: procedure.query(async ({ ctx }): Promise<MetaInfo> => {
    const db = await ctx.db();
    return {
      api_version: API_VERSION,
      run_id: db.runId,
      parquet_sha256: db.parquetSha256,
      sha256_verified: true,
      views: [...CONTRACT.views],
      macros: [...CONTRACT.macros],
    };
  }),
});
