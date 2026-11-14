/** Shared fakes for the agent tests: data queries that record their inputs, a fake clock, no network. */
import { vi } from "vitest";
import type {
  LongOpenItem,
  ParcelDetail,
  ParcelPermit,
  ParcelPermits,
  PermitContractor,
  PermitFields,
  RoofAgeBasis,
  RunSummary,
  SearchItem,
  SearchResult,
  SourceKind,
  SourceRow,
  Sources,
} from "@oracle-la/api/contract";
import type { AgentSettings } from "../src/config.ts";
import type {
  ClientConstructors,
  MessagesClient,
} from "../src/model-client.ts";
import type { DataQueries, PermitQueries } from "../src/permit-api.ts";
import { placeKey, type PlaceResolution } from "../src/place-index.ts";
import { textReply } from "../src/testing/scripted-model.ts";

/** Any fetch in a test is a bug: the stub throws. */
export function blockNetwork(): void {
  vi.stubGlobal("fetch", () => {
    throw new Error("network is disabled in tests");
  });
}

export const SETTINGS: AgentSettings = {
  modelId: "claude-test-model",
  maxToolTurns: 5,
  maxTokens: 40_000,
  maxOutputTokens: 2_048,
  timeBudgetMs: 25_000,
  effort: "low",
};

export const VAN_NUYS = { lat: 34.199, lon: -118.487, label: "Van Nuys" };
/**
 * The center the fake resolve_place returns for "Van Nuys" (deliberately not VAN_NUYS), at 5 decimals as
 * places.resolve serves centers since design brief §17 A2 (PlaceIndex rounds them; the tool rounds them again).
 */
export const VAN_NUYS_RESOLVED = { lat: 34.18651, lon: -118.44891 };
/** The center the fake resolve_place returns for "Pasadena" (a jurisdiction outside the City of Los Angeles). */
export const PASADENA_RESOLVED = { lat: 34.1478, lon: -118.1445 };
/** A parcel the fake permits.forParcel serves outside the City of Los Angeles (jurisdiction PASADENA). */
export const OUTSIDE_PARCEL = "5700000001";

/** The two candidates the fake resolve_place returns for "Los Angeles" (5.7 mi apart: ambiguous). */
export const LOS_ANGELES_CANDIDATES = [
  {
    basis: "jurisdiction" as const,
    center: { lat: 34.052235, lon: -118.243683 },
    parcel_count: 1234,
    raw_values: ["LOS ANGELES"],
    spread_miles: 9.1,
  },
  {
    basis: "postal_city" as const,
    center: { lat: 34.098001, lon: -118.326742 },
    parcel_count: 987,
    raw_values: ["LOS ANGELES"],
    spread_miles: 4.2,
  },
];

/** SDK constructors that record their options and never touch the network. */
export function recordingConstructors(): {
  constructors: ClientConstructors;
  built: Array<{ provider: string; opts: unknown }>;
  calls: Array<{ params: unknown; options: unknown }>;
} {
  const built: Array<{ provider: string; opts: unknown }> = [];
  const calls: Array<{ params: unknown; options: unknown }> = [];
  const client = (): MessagesClient => ({
    messages: {
      create: async (params, options) => {
        calls.push({ params, options });
        return textReply("ok");
      },
    },
  });
  const constructors: ClientConstructors = {
    anthropic: class {
      messages = client().messages;
      constructor(opts: unknown) {
        built.push({ provider: "anthropic", opts });
      }
    },
    bedrock: class {
      messages = client().messages;
      constructor(opts: unknown) {
        built.push({ provider: "bedrock", opts });
      }
    },
  };
  return { constructors, built, calls };
}

/** Text that must never leave a tool (permit descriptions). */
export const SECRET_DESCRIPTION = "SECRET-WORK-DESCRIPTION-TEXT";

/**
 * The contract's two stored roof-age basis labels (ROOF_AGE_BASIS), typed with `satisfies RoofAgeBasis` so a
 * changed label fails the typecheck (packages/agent imports @oracle-la/api for types only).
 */
export const ROOF_AGE_BASIS = {
  proxy:
    "PROXY: assessor year built / effective year built; not a roof installation date",
  permit:
    "PERMIT: latest finaled LADBS roofing permit (status date); a roof coating alone does not count",
} as const satisfies Record<"proxy" | "permit", RoofAgeBasis>;

export const FAKE_PARCELS = ["1000000001", "1000000002", "1000000003"];
export const FAKE_PERMITS = [
  "16010-10000-00001",
  "16010-10000-00002",
  "16010-10000-00003",
];

export interface Call {
  fn: string;
  input: unknown;
}

/** The fake run's sources (explorer.sources), one per kind. */
export const FAKE_SOURCES = {
  parcel: "LA County Assessor Roll",
  permit: "LADBS Permits",
  contractor: "LADBS Contractors",
} as const;
/** The permit source's retrieval window as cited (first to last page). */
export const PERMIT_RETRIEVED =
  "2026-11-12T10:00:00.000Z to 2026-11-12T11:30:00.000Z";
export const CONTRACTOR_RETRIEVED = "2026-11-12T14:00:51.383Z";

const sourceRow = (
  source_kind: SourceKind,
  first: string,
  last: string,
  extra: Partial<SourceRow> = {},
): SourceRow => ({
  source_kind,
  source_name: FAKE_SOURCES[source_kind],
  record_count: 3,
  page_count: 1,
  first_retrieved_at: first,
  last_retrieved_at: last,
  role: source_kind,
  hub_page: null,
  query_url: null,
  query_urls: null,
  terms_of_use: null,
  license: null,
  attribution: null,
  access: null,
  ...extra,
});

/** Contract-typed permit fields (drift in the contract fails the typecheck). */
function permitFields(i: number, roofing: boolean): PermitFields {
  return {
    permit_number: FAKE_PERMITS[i]!,
    address: `${i + 1} PERMIT ST`,
    postal_code: "91406",
    source_permit_type: "Bldg-Alter/Repair",
    source_permit_sub_type: "1 or 2 Family Dwelling",
    source_status_desc: "Issued",
    permit_status_class: "open-issued",
    application_received_date: "2015-01-01",
    permit_issue_date: "2015-02-01",
    status_date: "2015-02-01",
    open_since: "2015-02-01",
    open_days: 4000 - i * 100,
    roofing_work: roofing,
    roof_coating_only: false,
    join_method: "direct",
    building_level: false,
    parcel_count: 1,
  };
}

/** Keys outside the contract that must never reach a tool result (permit descriptions). */
const DESCRIPTIONS = {
  work_desc: SECRET_DESCRIPTION,
  description: SECRET_DESCRIPTION,
};

export function fakeQueries(): {
  queries: DataQueries;
  calls: Call[];
} {
  const calls: Call[] = [];
  const rec = (fn: string, input: unknown) =>
    calls.push({ fn, input: structuredClone(input) });

  const permits: PermitQueries = {
    async longOpen(input) {
      rec("permits.longOpen", input);
      const all = FAKE_PERMITS.map((_, i): LongOpenItem => ({
        ...permitFields(i, i !== 1),
        parcel_id: FAKE_PARCELS[i]!,
        distance_miles: 0.5 + i,
        effective_roof_year: 1990 + i,
        roof_age_basis: i === 2 ? ROOF_AGE_BASIS.permit : ROOF_AGE_BASIS.proxy,
        roof_year_permit_number: i === 2 ? FAKE_PERMITS[0]! : null,
      }));
      // Like the server since 68c697b: roofing work only (permit 1, not roofing work, is left out).
      const items = all
        .filter((p) => p.roofing_work)
        .map((p) => Object.assign({}, p, DESCRIPTIONS));
      return {
        count: 57,
        rule: {
          reference_date: "2026-11-12",
          status_class: "open-issued",
          min_open_days: input.min_open_days ?? 1826,
          max_open_days: input.max_open_days ?? null,
          roof_age: null,
          text: "Open at least min_open_days days (fake rule).",
        },
        items,
        next_offset: items.length,
      };
    },
    async forParcel(input) {
      rec("permits.forParcel", input);
      if (input.parcel_id === OUTSIDE_PARCEL)
        return {
          parcel_id: input.parcel_id,
          permit_data_available: false,
          jurisdiction: "PASADENA",
          effective_roof_year: 1950,
          roof_age_basis: ROOF_AGE_BASIS.proxy,
          roof_year_permit_number: null,
          permits: [],
          bbb: { available: false, reason: "BBB ratings are not available." },
        };
      const contractor: PermitContractor = {
        contractors_business_name: "ACME ROOFING INC",
        license_identifier: "123456",
        source_license_type: "C39",
        license_class: "C-39",
        license_class_note: null,
        is_owner_builder: false,
        license_expiration_date: "2024-01-31",
        city_name: "VAN NUYS",
        state_code: "CA",
      };
      const withContractor: ParcelPermit = {
        ...permitFields(0, true),
        contractors: [Object.assign({}, contractor, DESCRIPTIONS)],
      };
      const without: ParcelPermit = {
        ...permitFields(1, false),
        contractors: [],
      };
      const out: ParcelPermits = {
        parcel_id: input.parcel_id,
        permit_data_available: true,
        jurisdiction: "LOS ANGELES",
        effective_roof_year: 2016,
        roof_age_basis: ROOF_AGE_BASIS.permit,
        roof_year_permit_number: FAKE_PERMITS[2]!,
        permits: [Object.assign({}, withContractor, DESCRIPTIONS), without],
        bbb: {
          available: false,
          reason: "BBB ratings are not available.",
        },
      };
      return out;
    },
  };

  const queries: DataQueries = {
    parcels: {
      async search(input): Promise<SearchResult> {
        rec("parcels.search", input);
        const t = input.threshold_years ?? 15;
        // Around the Pasadena center no parcel has permit data (outside the City of Los Angeles).
        const covered = !(
          input.lat === PASADENA_RESOLVED.lat &&
          input.lon === PASADENA_RESOLVED.lon
        );
        const items = FAKE_PARCELS.slice(0, input.limit ?? 50).map(
          (parcel_id, i): SearchItem => ({
            parcel_id,
            address: `${i + 1} TEST ST`,
            year_built: 1950 + i,
            roof_age_years_proxy: 2026 - (1950 + i),
            effective_roof_year: 1950 + i,
            roof_age_years: 2026 - (1950 + i),
            roof_age_basis: ROOF_AGE_BASIS.proxy,
            roof_year_permit_number: null,
            permit_data_available: covered,
            distance_miles: 0.1 * (i + 1),
            latitude: input.lat,
            longitude: input.lon,
          }),
        );
        return {
          count: 42,
          rule: {
            roll_year: 2026,
            threshold_years: t,
            built_before_year: 2026 - t,
            text: `Roof age is a proxy: older than ${t} years means built before ${2026 - t}.`,
          },
          items,
          next_offset: items.length,
        };
      },
      async detail(input): Promise<ParcelDetail> {
        rec("parcels.detail", input);
        return {
          property: {
            parcel_id: input.parcel_id,
            address: "1 TEST ST",
            city: "VAN NUYS",
            postal_code: "91406",
            jurisdiction: "LOS ANGELES",
            year_built: 1950,
            effective_year_built: 1960,
            roof_age_basis: ROOF_AGE_BASIS.proxy,
            effective_roof_year: 1950,
            roof_year_permit_number: null,
            permit_data_available: true,
            use_type: "SFR",
            use_description: "Single",
            roll_year: 2026,
            latitude: 34.2,
            longitude: -118.48,
            // owner columns that exist in v_property: never projected
            owner_unchanged_10y_proxy: true,
            out_of_area_owner: false,
            last_recording_date: "2010-01-01",
          },
          provenance: {
            parcel_id: input.parcel_id,
            source_name: FAKE_SOURCES.parcel,
            source_request_url: "https://example.test/query?page=1",
            source_request_method: "GET",
            source_retrieved_at: "2026-11-11T16:17:40.932Z",
            source_page_sha256: "abc",
            source_page_file: "page-0001.json",
          },
        };
      },
    },
    explorer: {
      async runSummary(): Promise<RunSummary> {
        rec("explorer.runSummary", undefined);
        return {
          run: {
            run_id: "run-1",
            generated_at: "2026-11-12T01:44:04.047Z",
            roll_year: "2026",
            row_counts: { parquet: 3, note: "x" },
            limitations: ["fixture only"],
            secret_field: "never",
          },
          history: [
            {
              run_id: "run-1",
              finished_at: "2026-11-12T02:00:00Z",
              row_counts: { parquet: 3 },
            },
          ],
        };
      },
      async sources(): Promise<Sources> {
        rec("explorer.sources", undefined);
        return {
          sources: [
            sourceRow(
              "contractor",
              CONTRACTOR_RETRIEVED,
              CONTRACTOR_RETRIEVED,
              { license: "CC BY 4.0", attribution: "LADBS" },
            ),
            sourceRow(
              "permit",
              "2026-11-12T10:00:00.000Z",
              "2026-11-12T11:30:00.000Z",
              {
                attribution: "LADBS",
                query_urls: [
                  "https://example.test/permits?a=1",
                  "https://example.test/permits?a=2",
                ],
              },
            ),
            sourceRow(
              "parcel",
              "2026-11-11T16:17:40.932Z",
              "2026-11-11T16:17:40.932Z",
              {
                terms_of_use: "https://example.test/terms",
                hub_page: "https://example.test/hub",
                query_url: "https://example.test/query",
              },
            ),
          ],
          pages: [],
        };
      },
    },
    permits,
    places: {
      async resolve({ name }): Promise<PlaceResolution> {
        rec("places.resolve", { name });
        if (placeKey(name) === "VANNUYS")
          return {
            status: "resolved",
            name,
            basis: "postal_city",
            center: VAN_NUYS_RESOLVED,
            parcel_count: 467,
            raw_values: ["VAN NUYS", "VAN NUYS CALIF", "VAN NUYS,"],
            spread_miles: 1.8,
            center_reliable: true,
            also_matched: null,
            note: `"${name}" resolved (fake).`,
          };
        if (placeKey(name) === "PASADENA")
          return {
            status: "resolved",
            name,
            basis: "jurisdiction",
            center: PASADENA_RESOLVED,
            parcel_count: 39990,
            raw_values: ["PASADENA"],
            spread_miles: 2.4,
            center_reliable: true,
            also_matched: null,
            note: `"${name}" resolved (fake).`,
          };
        if (placeKey(name) === "LOSANGELES")
          return {
            status: "ambiguous",
            name,
            candidates: LOS_ANGELES_CANDIDATES,
            note: `"${name}" is ambiguous (fake).`,
          };
        return {
          status: "unknown",
          name,
          // PlaceIndex's own wording for an unknown name (place-index.ts).
          note: `"${name}" matches no jurisdiction or postal city in this run; no center was chosen.`,
        };
      },
    },
  };
  return { queries, calls };
}

/** A clock tests move by hand. */
export function fakeClock(start = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}
