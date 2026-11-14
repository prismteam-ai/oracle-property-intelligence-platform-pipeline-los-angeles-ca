import { z } from "zod";
import { placeIndexFor } from "@oracle-la/views";
import { MAX_PLACE_NAME_LENGTH, type PlaceResolution } from "../contract.ts";
import { procedure, router } from "../trpc.ts";

export const placesRouter = router({
  /**
   * A place name (a jurisdiction or a postal city of the run's parcels) to a center: resolved, ambiguous or
   * unknown, never a guess (packages/views/src/place-index.ts). The index is built on the first call of a
   * container, not at init, and kept with the container's Db.
   */
  resolve: procedure
    .input(z.object({ name: z.string().min(1).max(MAX_PLACE_NAME_LENGTH) }))
    .query(async ({ ctx, input }): Promise<PlaceResolution> => {
      const db = await ctx.db();
      return placeIndexFor(db).resolve({ name: input.name });
    }),
});
