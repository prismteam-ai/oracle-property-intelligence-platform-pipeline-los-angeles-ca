/**
 * The data-query interface the tools use, wired to the data API's real routes (P9: apps/api/src/routers/permits.ts,
 * response types in apps/api/src/contract.ts).
 *
 * `DataQueries` is shaped like the data API's tRPC caller, so `appRouter.createCaller(ctx)` satisfies it
 * structurally (checked at compile time in apps/agent-mcp/test/local.fixture.test.ts). Every response type is the
 * contract's own, imported as a type, so drift in the API fails the typecheck here. The members are function-typed
 * properties (not methods) so their inputs are checked contravariantly: an input the API would not accept fails.
 * The contract exports no input types, so the two inputs below are the lane's, copied from the routers' zod inputs.
 */
import type {
  LongOpenResult,
  OwnershipBasis,
  ParcelDetail,
  ParcelPermits,
  RoofAgeBasis,
  RunSummary,
  SearchResult,
  Sources,
} from "@oracle-la/api/contract";
import type { PlaceQueries } from "../../views/src/place-index.ts";

/** Input of parcels.search (apps/api/src/routers/parcels.ts; the API applies its own defaults and bounds). */
export interface SearchInput {
  lat: number;
  lon: number;
  radius_miles?: number;
  threshold_years?: number;
  /** The ownership filter's basis; absent: no ownership filter. */
  ownership_basis?: OwnershipBasis;
  offset?: number;
  limit?: number;
}

/**
 * Input of permits.longOpen (apps/api/src/routers/permits.ts: radius ≤ 10, durations in days ≤ 36,525, the
 * maximum not below the minimum, sort default open_days, limit ≤ 100). The tools never send threshold_years.
 */
export interface LongOpenInput {
  lat: number;
  lon: number;
  radius_miles?: number;
  threshold_years?: number;
  min_open_days?: number;
  max_open_days?: number;
  sort?: "open_days" | "distance";
  offset?: number;
  limit?: number;
}

/** The served procedures the tools read (a structural subset of the tRPC caller). */
export interface ApiQueries {
  parcels: {
    search: (input: SearchInput) => Promise<SearchResult>;
    detail: (input: { parcel_id: string }) => Promise<ParcelDetail>;
  };
  explorer: {
    runSummary: () => Promise<RunSummary>;
    sources: () => Promise<Sources>;
  };
  permits: PermitQueries;
}

/** permits.longOpen and permits.forParcel, as the data API serves them. */
export interface PermitQueries {
  longOpen: (input: LongOpenInput) => Promise<LongOpenResult>;
  forParcel: (input: { parcel_id: string }) => Promise<ParcelPermits>;
}

/**
 * Everything the tools read: the API's procedures, including `places` (the data API's places.resolve, or a
 * PlaceIndex over the same Db: both are packages/views/src/place-index.ts).
 */
export interface DataQueries extends ApiQueries {
  places: PlaceQueries;
}

type FirstWord<T> = T extends `${infer W}:${string}` ? W : never;
/**
 * The first word of a stored roof-age basis label (ROOF_AGE_BASIS in the contract): "PROXY" or "PERMIT". Derived
 * from the contract's labels, so basisWord below stops compiling if a label's first word changes.
 */
export type BasisWord = FirstWord<RoofAgeBasis>;

/**
 * The basis word of a stored label, compared on its first word as the contract says clients may; null for
 * anything else (a missing or unrecognized label).
 */
export function basisWord(label: unknown): BasisWord | null {
  const w = typeof label === "string" ? /^[A-Z]+/.exec(label)?.[0] : undefined;
  return w === "PROXY" || w === "PERMIT" ? w : null;
}

/** One answer's queries: explorer.sources() runs at most once, however many tools cite from it. */
export function onceSources(q: DataQueries): DataQueries {
  let sources: Promise<Sources> | undefined;
  // Explicit members, never a spread: the tRPC caller is a proxy with no own keys.
  return {
    parcels: q.parcels,
    explorer: {
      runSummary: () => q.explorer.runSummary(),
      sources: () => (sources ??= q.explorer.sources()),
    },
    permits: q.permits,
    places: q.places,
  };
}
