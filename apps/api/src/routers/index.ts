import { router } from "../trpc.ts";
import { explorerRouter } from "./explorer.ts";
import { metaRouter } from "./meta.ts";
import { parcelsRouter } from "./parcels.ts";
import { permitsRouter } from "./permits.ts";

export const appRouter = router({
  meta: metaRouter,
  explorer: explorerRouter,
  parcels: parcelsRouter,
  permits: permitsRouter,
});
export type AppRouter = typeof appRouter;
