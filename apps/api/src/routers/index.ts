import { router } from "../trpc.ts";
import { explorerRouter } from "./explorer.ts";
import { metaRouter } from "./meta.ts";
import { parcelsRouter } from "./parcels.ts";

export const appRouter = router({
  meta: metaRouter,
  explorer: explorerRouter,
  parcels: parcelsRouter,
});
export type AppRouter = typeof appRouter;
