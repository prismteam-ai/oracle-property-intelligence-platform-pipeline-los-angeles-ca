/**
 * The agent's tools (design brief §6, §11.1, §13). One zod schema per tool: the model gets its JSON Schema
 * (z.toJSONSchema, then the SDK's strict-mode transform) and the MCP server registers the same zod object.
 * Every output is an explicit allowlist projection, then the description guard. Tool errors become results with
 * `ok: false`; nothing is thrown out of runTool.
 *
 * Permit fields keep the API's names (apps/api/src/contract.ts PermitFields), with one rename: LADBS's status text
 * `source_status_desc` is served as `source_status`, so the /desc/i guard (meant for permit descriptions, which
 * are never read) does not drop it; it is a status, not a description. Likewise v_property's `use_description` is
 * served as `use_label`. A stored roof-age basis label (ROOF_AGE_BASIS) is served as `roof_age_basis` = its first
 * word (PROXY or PERMIT) plus `roof_age_basis_label` = the full label.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type {
  DEFAULT_MIN_OPEN_DAYS as API_DEFAULT_MIN_OPEN_DAYS,
  MAX_OPEN_DAYS as API_MAX_OPEN_DAYS,
  LongOpenItem,
  ParcelPermit,
  SourceKind,
  Sources,
} from "@oracle-la/api/contract";
import { z } from "zod";
import { basisWord, type DataQueries } from "./permit-api.ts";
import { resolutionNote, type PlaceResolution } from "./place-index.ts";
import { dropDescriptions, fields, project, type Citation } from "./policy.ts";

/**
 * Default long-open minimum: 5 × 365.25 days, rounded. Typed as the contract's constant (a type-only import), so a
 * change of the API's default fails the typecheck here.
 */
export const DEFAULT_MIN_OPEN_DAYS: typeof API_DEFAULT_MIN_OPEN_DAYS = 1_826;
/** Largest open duration permits.longOpen accepts (100 years), typed as the contract's constant. */
export const MAX_OPEN_DAYS: typeof API_MAX_OPEN_DAYS = 36_525;

/**
 * permits.longOpen filters roofing work on the server (68c697b: no input parameter, same response shape; a permit
 * that is roofing work only through the roof-coating phrase is kept and flagged roof_coating_only). The tool sends
 * no roofing input and filters nothing itself; its reasoning says "roofing work only".
 */
export const LONG_OPEN_SCOPE = "roofing work only";

const lat = z
  .number()
  .min(-90)
  .max(90)
  .describe("Latitude of the center, WGS84 degrees");
const lon = z
  .number()
  .min(-180)
  .max(180)
  .describe("Longitude of the center, WGS84 degrees");
const radius = z
  .number()
  .min(0.1)
  .max(10)
  .default(5)
  .describe("Search radius in miles");
const parcelId = z
  .string()
  .regex(/^\d{10}$/)
  .describe("Parcel ID (AIN), exactly 10 digits");

export const toolSchemas = {
  resolve_place: z.strictObject({
    name: z
      .string()
      .min(1)
      .max(80)
      .describe("Place name as the user wrote it, e.g. a city or community"),
  }),
  search_aged_roofs: z.strictObject({
    lat,
    lon,
    radius_miles: radius,
    threshold_years: z
      .number()
      .int()
      .min(1)
      .max(120)
      .default(15)
      .describe(
        "Roof age threshold in years: parcels with roofs older than this",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Most items to return"),
  }),
  long_open_permits: z.strictObject({
    lat,
    lon,
    radius_miles: radius,
    min_open_days: z
      .number()
      .int()
      .min(0)
      .max(MAX_OPEN_DAYS)
      .default(DEFAULT_MIN_OPEN_DAYS)
      .describe(
        "Minimum open duration in days (N years = Math.round(N × 365.25); default 1826)",
      ),
    max_open_days: z
      .number()
      .int()
      .min(0)
      .max(MAX_OPEN_DAYS)
      .optional()
      .describe("Optional maximum open duration in days"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Most items to return"),
  }),
  parcel_detail: z.strictObject({ parcel_id: parcelId }),
  parcel_permits: z.strictObject({ parcel_id: parcelId }),
  run_summary: z.strictObject({}),
} as const;

export type ToolName = keyof typeof toolSchemas;
export const TOOL_NAMES = Object.keys(toolSchemas) as ToolName[];
export type ToolInput<N extends ToolName> = z.output<(typeof toolSchemas)[N]>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  resolve_place:
    "Resolve a place name (city, community or postal city) to a search center using only the run's own parcels: " +
    "the median of the matched parcels' coordinates. Exact names only, never fuzzy. Returns resolved, ambiguous " +
    "(two candidates, no center) or unknown; a resolved center may be marked unreliable when the area is too spread out.",
  search_aged_roofs:
    "Parcels within a radius of a center whose roof age is older than a threshold in years. Roof age counts from " +
    "the effective roof year: the assessor year-built proxy (roof_age_basis PROXY) or a finaled roofing permit " +
    "(PERMIT). Returns the count, the rule text and up to `limit` parcels nearest first, each with its source citation.",
  long_open_permits:
    "City of Los Angeles (LADBS) roofing-work permits, issued and still open, within a radius: open at least " +
    "min_open_days days (optionally at most max_open_days), longest open first, each counted once at its nearest " +
    "parcel. Durations are in days only. Each item has its permit number, parcel ID, status, open days, the " +
    "roofing_work and roof_coating_only flags and its parcel's roof year; the permit source is cited once.",
  parcel_detail:
    "One parcel's property facts (address, year built, effective roof year and basis, use type, coordinates, " +
    "whether permit data covers it) and its provenance: source name and collection time (the source's URLs, terms " +
    "and license are in run_summary; page files and hashes stay in the data API, explorer.sources pages and " +
    "explorer.records). No owner fields exist.",
  parcel_permits:
    "One parcel's roof-year facts and whether permit data covers it, then its permits (status class, LADBS status " +
    "text, dates, open days, roofing flags) with contractor businesses (business name, license number, license " +
    "class). BBB ratings are not available. Permit descriptions are never returned.",
  run_summary:
    "The served data run: run ID, timestamps, row counts, limitations, and each source once: kind, name, query " +
    "URL(s), hub page, terms of use, license, attribution, record and page counts and retrieval window. Records " +
    "carry only their source name and collection time; page-level files and hashes stay in the data API " +
    "(explorer.sources pages, explorer.records).",
};

/** What a tool call did, for the deterministic reasoning and assumptions (agent.ts). */
export type ToolFact =
  | { tool: "resolve_place"; resolution: PlaceResolution }
  | {
      tool: "search_aged_roofs";
      lat: number;
      lon: number;
      radius_miles: number;
      threshold_years: number;
      built_before_year: number;
      roll_year: number;
      count: number;
      returned: number;
      proxy_count: number;
      /** Listed parcels with permit_data_available false. */
      no_permit_data: number;
    }
  | {
      tool: "long_open_permits";
      lat: number;
      lon: number;
      radius_miles: number;
      min_open_days: number;
      max_open_days: number | null;
      count: number;
      returned: number;
    }
  | { tool: "parcel_detail"; parcel_id: string }
  | {
      tool: "parcel_permits";
      parcel_id: string;
      permits: number;
      contractor_rows: number;
      permit_data_available: boolean;
      jurisdiction: string | null;
    }
  | { tool: "run_summary"; run_id: string | null };

export interface ToolOutcome {
  name: string;
  ok: boolean;
  /** The parsed input (defaults applied); absent when the input did not parse. */
  input?: unknown;
  /** JSON-safe result for the model (or { error } when ok is false). */
  content: unknown;
  error?: string;
  /** Records the output cites. */
  records: Citation[];
  /** Parcel IDs and permit numbers that appear in the output. */
  ids: string[];
  gaps: string[];
  /** Keys removed by the description guard. */
  dropped: number;
  fact: ToolFact | null;
}

interface Produced {
  content: unknown;
  records?: Citation[];
  ids?: string[];
  gaps?: string[];
  fact: ToolFact;
}

const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

/** Citation of a parcel from its provenance row. */
function parcelCitation(
  parcel_id: string,
  prov: Record<string, unknown> | null | undefined,
): Citation | null {
  const source_name = str(prov?.source_name);
  const collected_at = str(prov?.source_retrieved_at);
  return source_name && collected_at
    ? { kind: "parcel", id: parcel_id, source_name, collected_at }
    : null;
}

/**
 * A source as cited once per answer: its name, its license and attribution as the run records them (null when the
 * run states none), and its retrieval time (a window when its pages differ).
 */
export interface SourceRef {
  source_name: string;
  license: string | null;
  attribution: string | null;
  retrieved: string;
}

/** Distinct non-empty values joined with "; ", or null when there are none. */
const joined = (values: ReadonlyArray<string | null | undefined>) => {
  const xs = [...new Set(values.filter((v): v is string => !!v))];
  return xs.length ? xs.join("; ") : null;
};

/**
 * The cited source of one kind from explorer.sources: its name, license, attribution and retrieval window, all from
 * that kind's own rows (so a contractor citation never takes the permit source's time). Several sources of the kind
 * are joined ("; ") over their combined window; null when the run lists none.
 */
export function sourceRef(src: Sources, kind: SourceKind): SourceRef | null {
  const rows = src.sources.filter((s) => s.source_kind === kind);
  if (!rows.length) return null;
  const firsts = rows.map((r) => String(r.first_retrieved_at)).sort();
  const lasts = rows.map((r) => String(r.last_retrieved_at)).sort();
  const first = firsts[0]!;
  const last = lasts.at(-1)!;
  return {
    source_name: rows.map((r) => r.source_name).join("; "),
    license: joined(rows.map((r) => r.license)),
    attribution: joined(rows.map((r) => r.attribution)),
    retrieved: first === last ? first : `${first} to ${last}`,
  };
}

const noSourceGap = (kind: "permit" | "contractor") =>
  `No ${kind} source is listed in the run's sources: the ${kind === "permit" ? "permits" : "contractor rows"} are listed without a citation.`;

const cite = (
  kind: Citation["kind"],
  ref: SourceRef,
  id: string,
): Citation => ({
  kind,
  id,
  source_name: ref.source_name,
  ...(ref.license !== null ? { license: ref.license } : {}),
  ...(ref.attribution !== null ? { attribution: ref.attribution } : {}),
  collected_at: ref.retrieved,
});

/** The basis word and the full stored label, from a roof_age_basis value. */
const basis = (label: unknown) => ({
  roof_age_basis: basisWord(label),
  roof_age_basis_label: str(label),
});

/** Allowlisted permit fields shared by long_open_permits and parcel_permits (the contract's PermitFields). */
const PERMIT_FIELDS: Record<string, string> = {
  ...fields("permit_number", "permit_status_class"),
  // LADBS's status text; renamed so the /desc/i guard keeps it (it is not a description).
  source_status: "source_status_desc",
  ...fields(
    "source_permit_type",
    "source_permit_sub_type",
    "address",
    "application_received_date",
    "permit_issue_date",
    "status_date",
    "open_since",
    "open_days",
    "roofing_work",
    "roof_coating_only",
    "join_method",
    "building_level",
    "parcel_count",
  ),
};
const CONTRACTOR_FIELDS = fields(
  "contractors_business_name",
  "license_identifier",
  "license_class",
  "source_license_type",
  "license_class_note",
  "is_owner_builder",
  "license_expiration_date",
  "city_name",
  "state_code",
);
/** parcel_detail property allowlist: no owner field at all. */
const PROPERTY_FIELDS: Record<string, string> = {
  ...fields(
    "parcel_id",
    "address",
    "street_number",
    "street_direction",
    "street_name",
    "unit",
    "city",
    "postal_code",
    "plus_four",
    "county",
    "state",
    "jurisdiction",
    "year_built",
    "effective_year_built",
    "effective_roof_year",
    "roof_year_permit_number",
    "permit_data_available",
    "use_type",
  ),
  use_label: "use_description",
  ...fields("roll_year", "latitude", "longitude"),
};
/**
 * Per record, the source name and collection time only (design brief §15.2). The request URL, page file and
 * sha256 are not repeated per record: run_summary states each source's URLs once, and the page-level files and
 * hashes stay in the data API (explorer.sources pages, explorer.records).
 */
const PROVENANCE_FIELDS = fields("source_name", "source_retrieved_at");

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const strings = (...xs: unknown[]): string[] =>
  xs.filter((x): x is string => typeof x === "string");

const run = {
  async resolve_place(
    q: DataQueries,
    input: ToolInput<"resolve_place">,
  ): Promise<Produced> {
    const found = await q.places.resolve({ name: input.name });
    // The note is rebuilt from the fields, so it always states each center (5 decimals) and parcel count.
    const r: PlaceResolution =
      found.status === "unknown"
        ? found
        : { ...found, note: resolutionNote(found) };
    const gaps: string[] = [];
    if (r.status !== "resolved" || !r.center_reliable) gaps.push(r.note);
    return { content: r, gaps, fact: { tool: "resolve_place", resolution: r } };
  },

  async search_aged_roofs(
    q: DataQueries,
    input: ToolInput<"search_aged_roofs">,
  ): Promise<Produced> {
    const res = await q.parcels.search({
      lat: input.lat,
      lon: input.lon,
      radius_miles: input.radius_miles,
      threshold_years: input.threshold_years,
      offset: 0,
      limit: input.limit,
    });
    // The roof-age facts come from the search item itself; the detail call is only for the provenance citation.
    const details = await Promise.all(
      res.items.map((it) =>
        q.parcels.detail({ parcel_id: it.parcel_id }).then(
          (d) => d,
          () => null,
        ),
      ),
    );
    const records: Citation[] = [];
    const gaps: string[] = [];
    let proxy = 0;
    let permit = 0;
    const items = res.items.map((it, i) => {
      const b = basis(it.roof_age_basis);
      if (b.roof_age_basis === "PROXY") proxy++;
      if (b.roof_age_basis === "PERMIT") permit++;
      const citation = parcelCitation(it.parcel_id, details[i]?.provenance);
      if (citation) records.push(citation);
      else
        gaps.push(
          `No source provenance was found for parcel ${it.parcel_id}; it is listed without a citation.`,
        );
      return {
        ...project(
          it as unknown as Record<string, unknown>,
          fields(
            "parcel_id",
            "address",
            "year_built",
            "effective_roof_year",
            "roof_age_years",
          ),
        ),
        ...b,
        ...project(
          it as unknown as Record<string, unknown>,
          fields(
            "roof_year_permit_number",
            "permit_data_available",
            "distance_miles",
          ),
        ),
        citation: citation
          ? {
              source_name: citation.source_name,
              collected_at: citation.collected_at,
            }
          : null,
      };
    });
    const unknown = items.length - proxy - permit;
    const truncated = res.count > items.length;
    if (truncated)
      gaps.push(
        `Results truncated: search_aged_roofs returned ${items.length} of ${res.count} matching parcels (nearest first).`,
      );
    if (proxy > 0)
      gaps.push(
        `Roof age is a proxy (assessor year built, not a roof installation date) for ${proxy} of ${items.length} listed parcels (basis PROXY).`,
      );
    if (unknown > 0)
      gaps.push(
        `${unknown} of ${items.length} listed parcels have no recognized roof-age basis (neither PROXY nor PERMIT).`,
      );
    const content = {
      count: res.count,
      returned: items.length,
      rule: res.rule.text,
      basis:
        proxy === items.length
          ? "PROXY (assessor year built, not a roof installation date)"
          : `per item: ${proxy} PROXY, ${permit} PERMIT${unknown ? `, ${unknown} unknown` : ""}`,
      items,
      truncated,
    };
    return {
      content,
      records,
      ids: res.items.flatMap((it) =>
        strings(it.parcel_id, it.roof_year_permit_number),
      ),
      gaps,
      fact: {
        tool: "search_aged_roofs",
        lat: input.lat,
        lon: input.lon,
        radius_miles: input.radius_miles,
        threshold_years: input.threshold_years,
        built_before_year: res.rule.built_before_year,
        roll_year: res.rule.roll_year,
        count: res.count,
        returned: items.length,
        proxy_count: proxy,
        no_permit_data: res.items.filter(
          (it) => it.permit_data_available === false,
        ).length,
      },
    };
  },

  async long_open_permits(
    q: DataQueries,
    input: ToolInput<"long_open_permits">,
  ): Promise<Produced> {
    if (
      input.max_open_days !== undefined &&
      input.max_open_days < input.min_open_days
    )
      throw new ToolInputError("max_open_days is below min_open_days");
    const [res, src] = await Promise.all([
      q.permits.longOpen({
        lat: input.lat,
        lon: input.lon,
        radius_miles: input.radius_miles,
        min_open_days: input.min_open_days,
        ...(input.max_open_days !== undefined
          ? { max_open_days: input.max_open_days }
          : {}),
        sort: "open_days",
        offset: 0,
        limit: input.limit,
      }),
      q.explorer.sources(),
    ]);
    const ref = sourceRef(src, "permit");
    const items = res.items.map((p: LongOpenItem) => ({
      ...project(p as unknown as Record<string, unknown>, {
        ...PERMIT_FIELDS,
        ...fields("parcel_id", "distance_miles", "effective_roof_year"),
      }),
      ...basis(p.roof_age_basis),
      ...project(
        p as unknown as Record<string, unknown>,
        fields("roof_year_permit_number"),
      ),
    }));
    const gaps: string[] = [];
    if (!ref && items.length) gaps.push(noSourceGap("permit"));
    const truncated = res.count > items.length;
    if (truncated)
      gaps.push(
        `Results truncated: long_open_permits returned ${items.length} of ${res.count} long-open permits (longest open first).`,
      );
    return {
      content: {
        count: res.count,
        returned: items.length,
        rule: res.rule.text,
        scope: LONG_OPEN_SCOPE,
        source: ref,
        items,
        truncated,
      },
      records: ref
        ? res.items.map((p) => cite("permit", ref, p.permit_number))
        : [],
      ids: res.items.flatMap((p) =>
        strings(p.permit_number, p.parcel_id, p.roof_year_permit_number),
      ),
      gaps,
      fact: {
        tool: "long_open_permits",
        lat: input.lat,
        lon: input.lon,
        radius_miles: input.radius_miles,
        min_open_days: input.min_open_days,
        max_open_days: input.max_open_days ?? null,
        count: res.count,
        returned: items.length,
      },
    };
  },

  async parcel_detail(
    q: DataQueries,
    input: ToolInput<"parcel_detail">,
  ): Promise<Produced> {
    const d = await q.parcels.detail({ parcel_id: input.parcel_id });
    const citation = parcelCitation(input.parcel_id, d.provenance);
    return {
      content: {
        property: {
          ...project(d.property, PROPERTY_FIELDS),
          ...basis(d.property.roof_age_basis),
        },
        provenance: project(d.provenance, PROVENANCE_FIELDS),
      },
      records: citation ? [citation] : [],
      ids: [input.parcel_id, ...strings(d.property.roof_year_permit_number)],
      gaps: [],
      fact: { tool: "parcel_detail", parcel_id: input.parcel_id },
    };
  },

  async parcel_permits(
    q: DataQueries,
    input: ToolInput<"parcel_permits">,
  ): Promise<Produced> {
    const [r, src] = await Promise.all([
      q.permits.forParcel({ parcel_id: input.parcel_id }),
      q.explorer.sources(),
    ]);
    const permitRef = sourceRef(src, "permit");
    const contractorRef = sourceRef(src, "contractor");
    const contractorsOf = (p: ParcelPermit) =>
      Array.isArray(p.contractors) ? p.contractors : [];
    const withContractors = r.permits.filter((p) => contractorsOf(p).length);
    const contractorRows = withContractors.reduce(
      (n, p) => n + contractorsOf(p).length,
      0,
    );
    const permits = r.permits.map((p) => ({
      ...project(p as unknown as Record<string, unknown>, PERMIT_FIELDS),
      contractors: contractorsOf(p).map((c) =>
        project(c as unknown as Record<string, unknown>, CONTRACTOR_FIELDS),
      ),
    }));
    const gaps: string[] = [];
    if (!permitRef && permits.length) gaps.push(noSourceGap("permit"));
    if (!contractorRef && contractorRows) gaps.push(noSourceGap("contractor"));
    return {
      content: {
        // The parcel's fields once, then its permits.
        parcel_id: str(r.parcel_id) ?? input.parcel_id,
        permit_data_available: r.permit_data_available === true,
        jurisdiction: str(r.jurisdiction),
        effective_roof_year: r.effective_roof_year ?? null,
        ...basis(r.roof_age_basis),
        roof_year_permit_number: str(r.roof_year_permit_number),
        permits,
        bbb: {
          available: false,
          reason: str(r.bbb?.reason) ?? "BBB ratings are not available.",
        },
        // Permits and contractor rows carry no provenance of their own: their sources, stated once.
        sources: {
          permits: permitRef,
          ...(contractorRows ? { contractors: contractorRef } : {}),
        },
      },
      records: [
        ...(permitRef
          ? r.permits.map((p) => cite("permit", permitRef, p.permit_number))
          : []),
        ...(contractorRef
          ? withContractors.map((p) =>
              cite("contractor", contractorRef, p.permit_number),
            )
          : []),
      ],
      ids: [
        input.parcel_id,
        ...strings(r.roof_year_permit_number),
        ...r.permits.flatMap((p) => strings(p.permit_number)),
      ],
      gaps,
      fact: {
        tool: "parcel_permits",
        parcel_id: input.parcel_id,
        permits: permits.length,
        contractor_rows: contractorRows,
        permit_data_available: r.permit_data_available === true,
        jurisdiction: str(r.jurisdiction),
      },
    };
  },

  async run_summary(q: DataQueries): Promise<Produced> {
    const [s, src] = await Promise.all([
      q.explorer.runSummary(),
      q.explorer.sources(),
    ]);
    const numbers = (v: unknown): Record<string, number> =>
      Object.fromEntries(
        Object.entries(asRecord(v)).filter(
          (e): e is [string, number] => typeof e[1] === "number",
        ),
      );
    const run = s.run;
    return {
      content: {
        run: {
          ...project(
            run,
            fields(
              "run_id",
              "run_name",
              "generated_at",
              "county",
              "state",
              "roll_year",
            ),
          ),
          row_counts: numbers(run.row_counts),
          limitations: Array.isArray(run.limitations)
            ? run.limitations.filter((x): x is string => typeof x === "string")
            : [],
        },
        history: s.history.map((h) => ({
          ...project(h, fields("run_id", "finished_at", "published")),
          row_counts: numbers(h.row_counts),
        })),
        // Each source once, with what records no longer repeat (its URLs); no page-level rows.
        sources: src.sources.map((x) => ({
          ...project(
            x as unknown as Record<string, unknown>,
            fields(
              "source_kind",
              "source_name",
              "record_count",
              "page_count",
              "first_retrieved_at",
              "last_retrieved_at",
              "role",
              "hub_page",
              "query_url",
            ),
          ),
          query_urls: Array.isArray(x.query_urls)
            ? x.query_urls.filter((u): u is string => typeof u === "string")
            : null,
          ...project(
            x as unknown as Record<string, unknown>,
            fields("terms_of_use", "license", "attribution", "access"),
          ),
        })),
      },
      fact: { tool: "run_summary", run_id: str(run.run_id) },
    };
  },
};

/** A tool input the schema cannot express (e.g. max below min). */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const shortMessage = (err: unknown): string => {
  const m = err instanceof Error ? err.message : String(err);
  const line = m.split("\n")[0] ?? m;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
};

/** Run one tool by name on raw (model or MCP) input. Never throws. */
export async function runTool(
  name: string,
  rawInput: unknown,
  queries: DataQueries,
): Promise<ToolOutcome> {
  const fail = (error: string, gaps: string[] = []): ToolOutcome => ({
    name,
    ok: false,
    content: { error },
    error,
    records: [],
    ids: [],
    gaps,
    dropped: 0,
    fact: null,
  });
  if (!(name in toolSchemas)) return fail(`unknown tool: ${name}`);
  const tool = name as ToolName;
  const parsed = toolSchemas[tool].safeParse(rawInput ?? {});
  if (!parsed.success)
    return fail(
      `invalid input: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
        .join("; ")}`,
    );
  const fromParsed = (o: ToolOutcome): ToolOutcome => ({
    ...o,
    input: parsed.data,
  });
  try {
    const p: Produced = await (
      run[tool] as (q: DataQueries, input: unknown) => Promise<Produced>
    )(queries, parsed.data);
    const guarded = dropDescriptions(p.content);
    return {
      name,
      ok: true,
      input: parsed.data,
      content: guarded.value,
      records: p.records ?? [],
      ids: p.ids ?? [],
      gaps: p.gaps ?? [],
      dropped: guarded.dropped,
      fact: p.fact,
    };
  } catch (err) {
    return fromParsed(fail(shortMessage(err)));
  }
}

/** JSON Schema for one tool, in the shape strict tool use accepts (unsupported keywords moved to descriptions). */
export function toolInputJsonSchema(
  name: ToolName,
): Anthropic.Tool.InputSchema {
  const js = z.toJSONSchema(toolSchemas[name], { io: "input" }) as Record<
    string,
    unknown
  >;
  delete js.$schema;
  return transformJSONSchema(js) as Anthropic.Tool.InputSchema;
}

/** The tools as the Messages API takes them: strict, additionalProperties false. */
export function anthropicTools(): Anthropic.Tool[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    input_schema: toolInputJsonSchema(name),
    strict: true,
  }));
}
