/**
 * The agent's tools. One zod schema per tool: the model gets its JSON Schema
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
  LongOpenResult,
  OwnershipBasis,
  OwnershipRuleOut,
  ParcelDetail,
  ParcelPermit,
  ParcelPermits,
  PointsResult,
  SearchItem,
  SourceKind,
} from "@oracle-la/api/contract";
import { z } from "zod";
import {
  DEFAULT_OWNERSHIP_BASIS,
  OWNERSHIP_BASES,
  ownershipStated,
} from "./ownership.ts";
import {
  CALL_TIMEOUT_MS,
  MAX_ATTEMPTS,
  RETRY_BASE_MS,
  unavailableIn,
} from "./http-data.ts";
import { contractorWindow } from "./contractor-coverage.ts";
import { basisWord, type DataQueries, type SourceList } from "./permit-api.ts";
import {
  haversineMiles,
  resolutionNote,
  roundCenter,
  type PlaceCandidate,
  type PlaceResolution,
} from "../../views/src/place-index.ts";
import {
  dedupeCitations,
  dropDescriptions,
  fields,
  project,
  type Citation,
} from "./policy.ts";

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

/**
 * Most permits the within-window list of long_open_permits asks for and lists: min(limit, 5). Each of them carries its
 * contractor rows, so the list stays short; the longest-open list keeps `limit` (default 10).
 */
export const WITHIN_WINDOW_LIMIT = 5;

/**
 * How long long_open_permits waits for the contractor rows of its within-window list: one data call's worst case
 * through the HTTP adapter (two 5 s attempts and a jitter wait of at most 500 ms), whatever the number of listed
 * parcels. The reads go through the adapter's bulkhead (at most 1 in flight); a read not finished by then is stated
 * as not read, so the reads add at most this long to an answer and leave the rest of its time budget to the model.
 */
export const CONTRACTOR_READS_MS =
  CALL_TIMEOUT_MS * MAX_ATTEMPTS + RETRY_BASE_MS * 2;

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
    ownership_filter: z
      .boolean()
      .default(false)
      .describe(
        "Keep only parcels whose owner is unchanged for 10 years or more, by a County-roll proxy (not a sale date). Off by default; on only when the question asks for it",
      ),
    ownership_basis: z
      .enum(OWNERSHIP_BASES)
      .optional()
      .describe(
        'With ownership_filter on: "recording" (no recorded document in 10 years), "base_year" (no reassessment in 10 years) or "both" (the default)',
      ),
    long_open_permit: z
      .boolean()
      .default(false)
      .describe(
        `Keep only parcels with a long-open roofing permit (an issued LADBS roofing-work permit open at least ${DEFAULT_MIN_OPEN_DAYS.toLocaleString("en-US")} days). The count is then of parcels, not permits. Off by default; on when the question asks which or how many of the aged-roof parcels have long-open permits`,
      ),
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
    with_contractor_window: z
      .boolean()
      .default(false)
      .describe(
        "Also list the longest-open permits issued within the contractor window, each with its contractor rows: a second labeled list in the same result, with its day limit and dates stated. Off by default; on when the question asks for long-open permits and their contractors",
      ),
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
    "(PERMIT). Returns the count, the rule text and up to `limit` parcels nearest first, each with its source citation " +
    "(for a PERMIT roof year also the permit source). " +
    "Optional ownership filter, off by default: ownership_filter keeps parcels whose owner is unchanged for 10 years " +
    'or more by a County-roll proxy, on ownership_basis "recording", "base_year" or "both" (the default); the result ' +
    "states the basis, its weakness and that the bases are proxies from the County roll, not sales records. Optional " +
    "long_open_permit, off by default: keeps only the parcels with a long-open roofing permit (the CRM map's rule); " +
    "the result's long_open_permit states the parcel count, of how many aged-roof parcels, and that it counts parcels, not permits. " +
    "Permits are served for the City of Los Angeles only: where no matching parcel has permit data or a long-open mark the " +
    "long-open count is not available (count null, status not_available), never 0, and permit_data states how many matching " +
    "parcels have none (and, when only the nearest were checked, how many match).",
  long_open_permits:
    "City of Los Angeles (LADBS) roofing-work permits, issued and still open, within a radius: open at least " +
    "min_open_days days (optionally at most max_open_days), longest open first, each counted once at its nearest " +
    "parcel. Durations are in days only. Each item has its permit number, parcel ID, status, open days, the " +
    "roofing_work and roof_coating_only flags and its parcel's roof year; the permit source is cited once. With " +
    "with_contractor_window, a second list follows: the longest-open permits issued within the contractor window " +
    "(at most the stated number of days open), each list labeled; each of its items carries its permit's contractor " +
    "rows (business name, license number, license class, canonical name, name variant count, owner-builder) and " +
    "contractor_status: named, owner-builder, none stated or not read (with why).",
  parcel_detail:
    "One parcel's property facts (address, year built, effective roof year and basis, use type, coordinates, " +
    "whether permit data covers it) and its provenance: source name and collection time (for a PERMIT roof year also " +
    "the permit source; the source's URLs, terms " +
    "and license are in run_summary; page files and hashes stay in the data API, explorer.sources pages and " +
    "explorer.records). No owner fields exist.",
  parcel_permits:
    "One parcel's roof-year facts and whether permit data covers it, then its permits (status class, LADBS status " +
    "text, dates, open days, roofing flags) with contractor businesses (business name, license number, license " +
    "class) and each license's identity: its key (the license number), canonical name (null when the license has " +
    "no name) and name variant count (variants are never listed). BBB ratings are not available. Permit " +
    "descriptions are never returned.",
  run_summary:
    "The served data run: run ID, timestamps, row counts, limitations, and each source once: kind, name, query " +
    "URL(s), hub page, terms of use, license, attribution, record and page counts, retrieval window and coverage " +
    "window (the contractor rows' permit_issue_date range; null for the others). Records " +
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
      /** The listed count: the search's, or with long_open_permit the long-open parcels; null: not available. */
      count: number | null;
      /** The parcels that match the search (the roof-age rule and the ownership filter, when on). */
      matched: number;
      returned: number;
      proxy_count: number;
      /** Listed parcels with permit_data_available false. */
      no_permit_data: number;
      /** Which matching parcels have permit data (parcels.points); null when that read failed. */
      matched_permit_data: PermitCoverage | null;
      /** The ownership basis the search applied; null: no ownership filter. */
      ownership_basis: OwnershipBasis | null;
      /** With long_open_permit: the parcels with a long-open roofing permit, of how many; null: no such filter. */
      long_open: {
        /** Null: not available (no parcel checked has permit data), never 0. */
        count: number | null;
        of: number;
        min_open_days: number;
        /** False when only the nearest parcels were checked (the count is a lower bound). */
        complete: boolean;
      } | null;
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
      /** With with_contractor_window: the within-window list (or why it is missing); absent without it. */
      within_window?: WithinWindowFact;
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
export function sourceRef(src: SourceList, kind: SourceKind): SourceRef | null {
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

/**
 * The permit that set a parcel's effective roof year (roof_year_permit_number, basis PERMIT) is a permit record:
 * cited as kind "permit" under the permit source, like any listed permit (null when the value is not a permit
 * number string or the run lists no permit source).
 */
const roofYearCitation = (
  ref: SourceRef | null,
  roofYearPermit: unknown,
): Citation | null =>
  ref && typeof roofYearPermit === "string"
    ? cite("permit", ref, roofYearPermit)
    : null;
const present = <T>(xs: ReadonlyArray<T | null>): T[] =>
  xs.filter((x): x is T => x !== null);

/** The basis word and the full stored label, from a roof_age_basis value. */
const basis = (label: unknown) => ({
  roof_age_basis: basisWord(label),
  roof_age_basis_label: str(label),
});

const num = (n: number) => n.toLocaleString("en-US");

/** One listed row of search_aged_roofs: a search item, or with long_open_permit the same fields from the detail. */
type Row = Pick<SearchItem, "parcel_id"> &
  Partial<Omit<SearchItem, "parcel_id">>;

/** A row whose roof year comes from a permit: its citation names the permit source too. */
const fromPermit = (r: Row): boolean =>
  typeof r.roof_year_permit_number === "string" ||
  basisWord(r.roof_age_basis) === "PERMIT";

/** A number, or a numeric string (DuckDB may serve a year as one), else null. */
const numberOrNull = (v: unknown): number | null => {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * A long-open parcel's row from its parcels.detail (v_property), with the search item's fields as the search
 * computes them: roof_age_years = roll year − effective roof year, distance_miles the haversine distance from the
 * center rounded to 3 decimals. A detail not read gives the parcel ID only.
 */
function rowFromDetail(
  parcel_id: string,
  d: Read<ParcelDetail>,
  center: { lat: number; lon: number },
): Row {
  if (!d.ok) return { parcel_id };
  const p = d.value.property;
  const rollYear = numberOrNull(p.roll_year);
  const roofYear = numberOrNull(p.effective_roof_year);
  const lat = numberOrNull(p.latitude);
  const lon = numberOrNull(p.longitude);
  return {
    parcel_id,
    address: str(p.address),
    year_built: numberOrNull(p.year_built),
    ...(roofYear !== null ? { effective_roof_year: roofYear } : {}),
    ...(roofYear !== null && rollYear !== null
      ? { roof_age_years: rollYear - roofYear }
      : {}),
    roof_age_basis: p.roof_age_basis as SearchItem["roof_age_basis"],
    roof_year_permit_number: str(p.roof_year_permit_number),
    permit_data_available: p.permit_data_available === true,
    land_base_year: numberOrNull(p.land_base_year),
    ...(lat !== null && lon !== null
      ? {
          distance_miles:
            Math.round(haversineMiles(center, { lat, lon }) * 1000) / 1000,
        }
      : {}),
  };
}

/**
 * Which parcels that match a search have permit data: parcels.points' permit_data_available 1 (in the City of Los
 * Angeles, where LADBS permits are served) or a long-open mark (long_open_permit 1: a permit joined to the parcel,
 * wherever it is). Checked over the points drawn: all matching parcels, or the nearest max_points when the points
 * are truncated.
 */
export interface PermitCoverage {
  checked: number;
  with_permit_data: number;
  without_permit_data: number;
  /** False when only the nearest parcels were checked. */
  complete: boolean;
}

/**
 * The permit-data coverage of a search's parcels from parcels.points with the same filter. The points must be the
 * search's parcels (the same count) and mark each one (permit data and long-open); otherwise an error, never a
 * coverage guessed.
 */
function permitCoverage(p: PointsResult, aged: number): PermitCoverage {
  const marks = p.permit_data_available as unknown;
  if (!Array.isArray(marks) || marks.length !== p.id.length)
    throw new Error(
      "the data API's parcels.points did not mark the parcels with permit data",
    );
  const longOpen = p.long_open_permit as unknown;
  if (!Array.isArray(longOpen) || longOpen.length !== p.id.length)
    throw new Error(
      "the data API's parcels.points did not mark the long-open parcels",
    );
  if (p.count !== aged)
    throw new Error(
      `the data API's parcels.points counted ${p.count} parcels and its search ${aged}`,
    );
  const withData = marks.filter((m, i) => m === 1 || longOpen[i] === 1).length;
  return {
    checked: p.id.length,
    with_permit_data: withData,
    without_permit_data: p.id.length - withData,
    complete: !p.truncated,
  };
}

/** The parcels that match a search, as its texts name them. */
const matchingPhrase = (ownership: boolean) =>
  `parcels that match the roof-age rule${ownership ? " and the ownership filter" : ""}`;

/**
 * How many of a search's parcels have no permit data, as a sentence; null when every parcel checked has permit
 * data. Without permit data a parcel is outside the City of Los Angeles.
 */
function noPermitDataText(
  c: PermitCoverage,
  aged: number,
  ownership: boolean,
  maxPoints: number,
): string | null {
  if (c.without_permit_data === 0) return null;
  const matching = matchingPhrase(ownership);
  const outside = "outside the City of Los Angeles: no permit data there.";
  if (c.complete)
    return c.with_permit_data === 0
      ? `All ${num(aged)} ${matching} are ${outside}`
      : `${num(c.without_permit_data)} of the ${num(aged)} ${matching} are ${outside}`;
  const nearest = `the nearest ${num(c.checked)} of the ${num(aged)} ${matching} (only those were checked: the data API marks at most ${num(maxPoints)} parcels)`;
  return c.with_permit_data === 0
    ? `All of ${nearest} are ${outside}`
    : `${num(c.without_permit_data)} of ${nearest} are ${outside}`;
}

/**
 * A search's permit data when only the nearest parcels were checked (truncated points) and every one of them has
 * it: the others were not checked.
 */
function nearestCheckedText(
  c: PermitCoverage,
  aged: number,
  ownership: boolean,
  maxPoints: number,
): string {
  return `All of the nearest ${num(c.checked)} of the ${num(aged)} ${matchingPhrase(ownership)} (only those were checked: the data API marks at most ${num(maxPoints)} parcels) have permit data; the other ${num(aged - c.checked)} were not checked.`;
}

/** The long-open filter of search_aged_roofs as its result states it. */
export interface LongOpenParcelsStated {
  /** What the count counts. */
  unit: "parcels";
  /**
   * "available": the count is of the checked parcels that have permit data (or a long-open mark). "not_available":
   * none of them has permit data or a mark (all are outside the City of Los Angeles), so the filter can't be
   * evaluated: count is null, not 0.
   */
  status: "available" | "not_available";
  /** Parcels with a long-open roofing permit (among those checked that have permit data); null when not available. */
  count: number | null;
  /** The parcels that match the roof-age rule (and the ownership filter, when on): the search's count. */
  of: number;
  /** How many of them were checked: all, or the nearest MAX_POINTS when the data API's map points are truncated. */
  checked: number;
  /** How many of those checked have permit data (or a long-open mark): the parcels the count is of. */
  with_permit_data: number;
  complete: boolean;
  min_open_days: number;
  text: string;
}

/**
 * The parcels parcels.points marks long-open (long_open_permit 1), nearest first, and the count as stated: of
 * parcels, not permits. The points are the search's parcels (the same filter); a different count, a missing column
 * or another window is an error, never shown as filtered. A marked parcel has permit data (its permit is joined),
 * even outside the City of Los Angeles; a parcel with neither permit data nor a mark is not counted either way: when
 * none checked has permit data or a mark the count is not available, never 0. When the points are truncated (more
 * parcels than the data API draws) only the nearest are checked: the count is a lower bound, stated as such.
 */
function longOpenParcels(
  p: PointsResult,
  aged: number,
  ownership: boolean,
): {
  ids: string[];
  count: number | null;
  coverage: PermitCoverage;
  stated: LongOpenParcelsStated;
} {
  const marks = p.long_open_permit as unknown;
  if (!Array.isArray(marks) || marks.length !== p.id.length)
    throw new Error(
      "the data API's parcels.points did not mark the long-open parcels",
    );
  if (
    p.long_open?.min_open_days !== DEFAULT_MIN_OPEN_DAYS ||
    p.long_open.max_open_days !== null
  )
    throw new Error(
      `the data API's parcels.points applied a long-open window other than at least ${num(DEFAULT_MIN_OPEN_DAYS)} days`,
    );
  const coverage = permitCoverage(p, aged);
  const ids = p.id.filter((_, i) => marks[i] === 1);
  const complete = coverage.complete;
  const available = coverage.checked === 0 || coverage.with_permit_data > 0;
  const count = available ? ids.length : null;
  const rule = `an issued LADBS roofing-work permit still open at least ${num(DEFAULT_MIN_OPEN_DAYS)} days`;
  const unit =
    "This counts parcels, not permits: a parcel with several long-open permits counts once, and a building-level (condominium) permit marks every unit it links.";
  const matching = matchingPhrase(ownership);
  const without = coverage.without_permit_data;
  const unknown = `outside the City of Los Angeles (no permit data there): whether they have one is unknown.`;
  let text: string;
  if (!available)
    text = complete
      ? `Not available: none of the ${num(aged)} ${matching} has permit data (all are outside the City of Los Angeles), so whether they have a long-open roofing permit (${rule}) is unknown, not 0; the filter can't be evaluated there.`
      : `Not available: none of the nearest ${num(p.id.length)} of the ${num(aged)} ${matching} has permit data (all are outside the City of Los Angeles; only those were checked: the data API marks at most ${num(p.max_points)} parcels), so whether they have a long-open roofing permit (${rule}) is unknown, not 0; the filter can't be evaluated there. A smaller radius gives a full check.`;
  else if (complete)
    text =
      without === 0
        ? `${num(ids.length)} of the ${num(aged)} ${matching} have a long-open roofing permit (${rule}). ${unit}`
        : `${num(ids.length)} of the ${num(coverage.with_permit_data)} ${matching} and have permit data have a long-open roofing permit (${rule}). The other ${num(without)} of the ${num(aged)} are ${unknown} ${unit}`;
  else
    text = `At least ${num(ids.length)} of the ${num(aged)} ${matching} have a long-open roofing permit (${rule}): only the nearest ${num(p.id.length)} were checked (the data API marks at most ${num(p.max_points)} parcels), so the count is a lower bound; a smaller radius gives a full count.${without === 0 ? "" : ` ${num(without)} of those checked are ${unknown}`} ${unit}`;
  return {
    ids,
    count,
    coverage,
    stated: {
      unit: "parcels",
      status: available ? "available" : "not_available",
      count,
      of: aged,
      checked: p.id.length,
      with_permit_data: coverage.with_permit_data,
      complete,
      min_open_days: DEFAULT_MIN_OPEN_DAYS,
      text,
    },
  };
}

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
/**
 * What canonical_business_name is, stated once in every result that lists contractor rows: the data API's latest
 * business name on the license's permit rows, never a registration.
 */
export const CANONICAL_NAME_NOTE =
  "canonical_business_name is the latest business name on the license's LADBS permits, not a registered or legal name of the license.";

/**
 * The contractor identity (one per license number) comes as the API serves it: a license without any name keeps a
 * null canonical name (never filled from another field), and name variants are counted, never listed.
 */
const CONTRACTOR_FIELDS = fields(
  "contractors_business_name",
  "license_identifier",
  "contractor_identity_key",
  "canonical_business_name",
  "name_variant_count",
  "license_class",
  "source_license_type",
  "license_class_note",
  "is_owner_builder",
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
 * Per record, the source name and collection time only. The request URL, page file and
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
    // Every center (and each candidate's and also_matched's) at 5 decimals, the precision the note states and the
    // agent attributes searches at (place-index.ts coordText); then the note is rebuilt from those fields, so it
    // always states each center and parcel count.
    const at5 = <C extends PlaceCandidate>(c: C): C => ({
      ...c,
      center: roundCenter(c.center),
    });
    let r: PlaceResolution;
    if (found.status === "resolved") {
      const rounded = {
        ...at5(found),
        also_matched: found.also_matched ? at5(found.also_matched) : null,
      };
      r = { ...rounded, note: resolutionNote(rounded) };
    } else if (found.status === "ambiguous") {
      const rounded = { ...found, candidates: found.candidates.map(at5) };
      r = { ...rounded, note: resolutionNote(rounded) };
    } else r = found;
    const gaps: string[] = [];
    if (r.status !== "resolved" || !r.center_reliable) gaps.push(r.note);
    return { content: r, gaps, fact: { tool: "resolve_place", resolution: r } };
  },

  async search_aged_roofs(
    q: DataQueries,
    input: ToolInput<"search_aged_roofs">,
  ): Promise<Produced> {
    if (input.ownership_basis !== undefined && !input.ownership_filter)
      throw new ToolInputError(
        "ownership_basis is set but ownership_filter is off",
      );
    // Off by default; on, "both" unless a basis is named.
    const ownership: OwnershipBasis | null = input.ownership_filter
      ? (input.ownership_basis ?? DEFAULT_OWNERSHIP_BASIS)
      : null;
    const filter = {
      lat: input.lat,
      lon: input.lon,
      radius_miles: input.radius_miles,
      threshold_years: input.threshold_years,
      ...(ownership ? { ownership_basis: ownership } : {}),
    };
    // The search, and parcels.points with the same filter, issued together; they run one after the other through
    // the adapter's bulkhead (1 in flight). The points say which matching parcels have permit data (the City of Los
    // Angeles), so a place outside it is told from all the matching parcels, not only the listed ones. With
    // long_open_permit the search is for its count and rule only (one item) and the points also give the parcels
    // marked long-open, nearest first (the CRM map's highlight and legend); without it a points read that fails is a
    // stated gap, never a failed search.
    const [res, pointsRead] = await Promise.all([
      q.parcels.search({
        ...filter,
        offset: 0,
        limit: input.long_open_permit ? 1 : input.limit,
      }),
      q.parcels
        .points({ ...filter, min_open_days: DEFAULT_MIN_OPEN_DAYS })
        .then(
          (v): Read<PointsResult> => ({ ok: true, value: v }),
          (err: unknown): Read<PointsResult> => {
            if (input.long_open_permit) throw err;
            return { ok: false, why: notRead("parcels.points", err) };
          },
        ),
    ]);
    const points = pointsRead.ok ? pointsRead.value : null;
    // The count and items are only as filtered as the API says it filtered them.
    const unfiltered = (route: string, applied: OwnershipRuleOut | null) =>
      (applied?.basis ?? null) !== ownership
        ? `the data API ${route}applied ownership basis ${applied?.basis ?? "none"}, not ${ownership ?? "none"}`
        : null;
    const searchUnfiltered = unfiltered("", res.ownership);
    if (searchUnfiltered) throw new Error(searchUnfiltered);
    const pointsUnfiltered = points
      ? unfiltered("parcels.points ", points.ownership)
      : null;
    if (pointsUnfiltered && input.long_open_permit)
      throw new Error(pointsUnfiltered);
    const longOpen =
      points && input.long_open_permit
        ? longOpenParcels(points, res.count, ownership !== null)
        : null;
    // Without the filter: the coverage, or why it is not known (the points read failed or does not match the
    // search), never a failed search.
    let coverage: Read<PermitCoverage> | null = null;
    if (longOpen) coverage = { ok: true, value: longOpen.coverage };
    else if (pointsUnfiltered) coverage = { ok: false, why: pointsUnfiltered };
    else if (points)
      try {
        coverage = { ok: true, value: permitCoverage(points, res.count) };
      } catch (err) {
        coverage = { ok: false, why: shortMessage(err) };
      }
    else if (!pointsRead.ok) coverage = { ok: false, why: pointsRead.why };
    // The roof-age facts come from the search item itself (with long_open_permit, from the parcel's detail, read
    // for its citation anyway); the detail call is for the provenance citation. explorer.sources is read only when an
    // item's roof year comes from a permit (its citation's source). A read that fails is stated as a gap with the
    // reason (e.g. "data API busy: parcels.detail not read"), never dropped.
    const readDetail = (parcel_id: string) =>
      q.parcels.detail({ parcel_id }).then(
        (d): Read<ParcelDetail> => ({ ok: true, value: d }),
        (err: unknown): Read<ParcelDetail> => ({
          ok: false,
          why: notRead("parcels.detail", err),
        }),
      );
    const readSources = (rows: readonly Row[]) =>
      rows.some(fromPermit)
        ? q.explorer.sources().then(
            (s): Read<SourceList> => ({ ok: true, value: s }),
            (err: unknown): Read<SourceList> => ({
              ok: false,
              why: notRead("explorer.sources", err),
            }),
          )
        : null;
    let rows: Row[];
    let details: Array<Read<ParcelDetail>>;
    let src: Read<SourceList> | null;
    if (longOpen) {
      const listed = longOpen.ids.slice(0, input.limit);
      details = await Promise.all(listed.map(readDetail));
      rows = listed.map((id, i) => rowFromDetail(id, details[i]!, input));
      src = await readSources(rows);
    } else {
      rows = res.items;
      [details, src] = await Promise.all([
        Promise.all(rows.map((it) => readDetail(it.parcel_id))),
        readSources(rows),
      ]);
    }
    const permitRef = src?.ok ? sourceRef(src.value, "permit") : null;
    const records: Citation[] = [];
    const gaps: string[] = [];
    if (src && !src.ok)
      gaps.push(
        `${src.why}; the permits that set roof years are listed without a citation.`,
      );
    else if (src && !permitRef) gaps.push(noSourceGap("permit"));
    let proxy = 0;
    let permit = 0;
    let read = 0;
    const items = rows.map((it, i) => {
      const detail = details[i];
      // With long_open_permit a parcel whose detail was not read has no roof-age facts: not counted as unknown.
      const known = !longOpen || detail?.ok === true;
      const b = basis(it.roof_age_basis);
      if (known) read++;
      if (known && b.roof_age_basis === "PROXY") proxy++;
      if (known && b.roof_age_basis === "PERMIT") permit++;
      const citation = detail?.ok
        ? parcelCitation(it.parcel_id, detail.value.provenance)
        : null;
      if (citation) records.push(citation);
      else if (detail && !detail.ok)
        gaps.push(
          `${detail.why} for parcel ${it.parcel_id}; it is listed without a citation.`,
        );
      else
        gaps.push(
          `No source provenance was found for parcel ${it.parcel_id}; it is listed without a citation.`,
        );
      const roofYear = roofYearCitation(permitRef, it.roof_year_permit_number);
      if (roofYear) records.push(roofYear);
      // A roof year set by a permit (basis PERMIT) is cited under the permit source too, not only the parcel's.
      const roofYearSource =
        b.roof_age_basis === "PERMIT" && permitRef
          ? {
              source_name: permitRef.source_name,
              retrieved: permitRef.retrieved,
            }
          : null;
      const row = it as unknown as Record<string, unknown>;
      return {
        ...project(
          row,
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
          row,
          fields(
            "roof_year_permit_number",
            "permit_data_available",
            "distance_miles",
          ),
        ),
        // The roll's land base year, which the "base_year" and "both" bases read, only with the filter on.
        ...(ownership ? project(row, fields("land_base_year")) : {}),
        citation:
          citation || roofYearSource
            ? {
                ...(citation
                  ? {
                      source_name: citation.source_name,
                      collected_at: citation.collected_at,
                    }
                  : {}),
                ...(roofYearSource ? { roof_year_source: roofYearSource } : {}),
              }
            : null,
        // Why the citation is missing when its read failed (the item is still listed).
        ...(detail && !detail.ok ? { citation_not_read: detail.why } : {}),
      };
    });
    const unknown = read - proxy - permit;
    // Not available (null) when the filter can't be evaluated: no matching parcel has permit data.
    const count = longOpen ? longOpen.count : res.count;
    const truncated = count !== null && count > items.length;
    const noPermitData =
      coverage?.ok && points
        ? noPermitDataText(
            coverage.value,
            res.count,
            ownership !== null,
            points.max_points,
          )
        : null;
    // Without the filter and with truncated points: only the nearest were checked, stated even when all of them
    // have permit data.
    const permitData =
      noPermitData ??
      (!longOpen && coverage?.ok && points && !coverage.value.complete
        ? nearestCheckedText(
            coverage.value,
            res.count,
            ownership !== null,
            points.max_points,
          )
        : null);
    const notAvailable = longOpen?.stated.status === "not_available";
    // Also when not available: the outside statement is a gap wherever the agent states the place outside the City
    // of Los Angeles (no parcel checked has permit data or a long-open mark), the long-open text after it.
    if (permitData) gaps.push(permitData);
    else if (coverage && !coverage.ok)
      gaps.push(
        `${coverage.why}: whether the matching parcels have permit data (the City of Los Angeles) was not checked.`,
      );
    if (longOpen && (!longOpen.stated.complete || notAvailable))
      gaps.push(longOpen.stated.text);
    if (truncated)
      gaps.push(
        `Results truncated: search_aged_roofs returned ${items.length} of ${count} matching parcels (nearest first).`,
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
      count,
      returned: items.length,
      rule: res.rule.text,
      basis:
        proxy === items.length
          ? "PROXY (assessor year built, not a roof installation date)"
          : `per item: ${proxy} PROXY, ${permit} PERMIT${unknown ? `, ${unknown} unknown` : ""}${read < items.length ? `, ${items.length - read} not read` : ""}`,
      // The ownership filter applied: its basis, text, weakness and the proxy note (ownership.ts).
      ...(ownership ? { ownership: ownershipStated(ownership) } : {}),
      // The long-open filter applied: the parcel count (or not available), of how many, and its unit (parcels).
      ...(longOpen ? { long_open_permit: longOpen.stated } : {}),
      // How many matching parcels have no permit data (outside the City of Los Angeles), when any has none; without
      // the filter also when only the nearest were checked, with how many match in all.
      ...(permitData && coverage?.ok
        ? {
            permit_data: {
              checked: coverage.value.checked,
              ...(!longOpen && !coverage.value.complete
                ? { matched: res.count }
                : {}),
              without_permit_data: coverage.value.without_permit_data,
              complete: coverage.value.complete,
              text: permitData,
            },
          }
        : {}),
      items,
      truncated,
    };
    return {
      content,
      records: dedupeCitations(records),
      ids: rows.flatMap((it) =>
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
        count,
        matched: res.count,
        returned: items.length,
        proxy_count: proxy,
        no_permit_data: rows.filter((it) => it.permit_data_available === false)
          .length,
        matched_permit_data: coverage?.ok ? coverage.value : null,
        ownership_basis: ownership,
        long_open: longOpen
          ? {
              count: longOpen.count,
              of: res.count,
              min_open_days: DEFAULT_MIN_OPEN_DAYS,
              complete: longOpen.stated.complete,
            }
          : null,
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
    const longOpen = (maxOpenDays: number | undefined, limit = input.limit) =>
      q.permits.longOpen({
        lat: input.lat,
        lon: input.lon,
        radius_miles: input.radius_miles,
        min_open_days: input.min_open_days,
        ...(maxOpenDays !== undefined ? { max_open_days: maxOpenDays } : {}),
        sort: "open_days",
        offset: 0,
        limit,
      });
    const fact = (res: LongOpenResult, items: unknown[]) => ({
      tool: "long_open_permits" as const,
      lat: input.lat,
      lon: input.lon,
      radius_miles: input.radius_miles,
      min_open_days: input.min_open_days,
      max_open_days: input.max_open_days ?? null,
      count: res.count,
      returned: items.length,
    });
    if (!input.with_contractor_window) {
      const [res, src] = await Promise.all([
        longOpen(input.max_open_days),
        q.explorer.sources(),
      ]);
      const ref = sourceRef(src, "permit");
      const list = longOpenList(res, ref, "long_open_permits");
      return {
        content: {
          count: res.count,
          returned: list.items.length,
          rule: res.rule.text,
          scope: LONG_OPEN_SCOPE,
          source: ref,
          items: list.items,
          truncated: list.truncated,
        },
        records: list.records,
        ids: list.ids,
        gaps: list.gaps,
        fact: fact(res, list.items),
      };
    }
    // with_contractor_window: one call at a time, each through the data layer's own per-call
    // cap and retry (http-data.ts). The default list first; the window from explorer.sources (the answer's read for
    // the prompt's contractor end: onceSources, no new call in the agent); then the within-window list.
    const res = await longOpen(input.max_open_days);
    const src = await q.explorer.sources();
    const ref = sourceRef(src, "permit");
    const first = longOpenList(res, ref, "the longest-open list");
    const within = await withinWindow(
      input,
      res.rule.reference_date,
      contractorWindow(src),
      longOpen,
    );
    let second: ReturnType<typeof longOpenList> | null = null;
    let withinContent: Record<string, unknown>;
    let withinFact: WithinWindowFact;
    let contractorRecords: Citation[] = [];
    let contractorGaps: string[] = [];
    if (within.status === "read") {
      second = longOpenList(within.res, ref, "the within-window list");
      // Each within-window item with its permit's contractor rows, read here.
      const c = await withContractors(
        q,
        within.res.items,
        second.items,
        sourceRef(src, "contractor"),
        within.window.last,
      );
      contractorRecords = c.records;
      contractorGaps = c.gaps;
      withinContent = {
        label: `Longest-open permits issued within the contractor window (open at least ${days(input.min_open_days)} and at most ${days(within.maxOpenDays)})`,
        count: within.res.count,
        returned: second.items.length,
        max_open_days: within.maxOpenDays,
        rule: within.res.rule.text,
        contractor_source: c.source,
        contractors: c.summaryText,
        canonical_name_note: CANONICAL_NAME_NOTE,
        items: c.items,
        truncated: second.truncated,
      };
      withinFact = {
        status: "read",
        max_open_days: within.maxOpenDays,
        count: within.res.count,
        returned: second.items.length,
        contractors: c.summary,
      };
    } else {
      withinContent = {
        label:
          "Longest-open permits issued within the contractor window: not listed",
        not_listed: within.gap,
      };
      withinFact = { status: "not_listed", gap: within.gap };
    }
    return {
      content: {
        scope: LONG_OPEN_SCOPE,
        source: ref,
        contractor_window: within.window,
        longest_open: {
          label: `Longest-open permits, any issue date (open at least ${days(input.min_open_days)}${input.max_open_days !== undefined ? ` and at most ${days(input.max_open_days)}` : ""})`,
          count: res.count,
          returned: first.items.length,
          rule: res.rule.text,
          items: first.items,
          truncated: first.truncated,
        },
        within_contractor_window: withinContent,
      },
      records: dedupeCitations([
        ...first.records,
        ...(second?.records ?? []),
        ...contractorRecords,
      ]),
      ids: [...first.ids, ...(second?.ids ?? [])],
      gaps: [
        ...first.gaps,
        ...(second?.gaps ?? []),
        ...contractorGaps,
        ...(withinFact.status === "not_listed" ? [withinFact.gap] : []),
      ],
      fact: { ...fact(res, first.items), within_window: withinFact },
    };
  },

  async parcel_detail(
    q: DataQueries,
    input: ToolInput<"parcel_detail">,
  ): Promise<Produced> {
    const d = await q.parcels.detail({ parcel_id: input.parcel_id });
    const citation = parcelCitation(input.parcel_id, d.provenance);
    // The permit that set the roof year is cited under the permit source (explorer.sources, read only then), and a
    // PERMIT roof year names that source next to the parcel's provenance.
    const roofYearPermit = str(d.property.roof_year_permit_number);
    const b = basis(d.property.roof_age_basis);
    const fromPermitSource =
      roofYearPermit !== null || b.roof_age_basis === "PERMIT";
    const permitRef = fromPermitSource
      ? sourceRef(await q.explorer.sources(), "permit")
      : null;
    return {
      content: {
        property: {
          ...project(d.property, PROPERTY_FIELDS),
          ...b,
        },
        provenance: project(d.provenance, PROVENANCE_FIELDS),
        ...(b.roof_age_basis === "PERMIT" && permitRef
          ? {
              roof_year_source: {
                source_name: permitRef.source_name,
                retrieved: permitRef.retrieved,
              },
            }
          : {}),
      },
      records: present([citation, roofYearCitation(permitRef, roofYearPermit)]),
      ids: [input.parcel_id, ...strings(d.property.roof_year_permit_number)],
      gaps: fromPermitSource && !permitRef ? [noSourceGap("permit")] : [],
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
    const roofYearPermit = str(r.roof_year_permit_number);
    const gaps: string[] = [];
    if (!permitRef && (permits.length || roofYearPermit))
      gaps.push(noSourceGap("permit"));
    if (!contractorRef && contractorRows) gaps.push(noSourceGap("contractor"));
    return {
      content: {
        // The parcel's fields once, then its permits.
        parcel_id: str(r.parcel_id) ?? input.parcel_id,
        permit_data_available: r.permit_data_available === true,
        jurisdiction: str(r.jurisdiction),
        effective_roof_year: r.effective_roof_year ?? null,
        ...basis(r.roof_age_basis),
        roof_year_permit_number: roofYearPermit,
        permits,
        ...(contractorRows ? { canonical_name_note: CANONICAL_NAME_NOTE } : {}),
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
      // The parcel's permits, the permit that set its roof year, then the contractor rows.
      records: dedupeCitations([
        ...(permitRef
          ? r.permits.map((p) => cite("permit", permitRef, p.permit_number))
          : []),
        ...present([roofYearCitation(permitRef, roofYearPermit)]),
        ...(contractorRef
          ? withContractors.map((p) =>
              cite("contractor", contractorRef, p.permit_number),
            )
          : []),
      ]),
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
          // The window of the source's records in the data (the contractor rows' permit_issue_date); null: none.
          coverage: x.coverage
            ? project(
                x.coverage as unknown as Record<string, unknown>,
                fields("field", "first", "last"),
              )
            : null,
          ...project(
            x as unknown as Record<string, unknown>,
            fields("terms_of_use", "license", "attribution", "access"),
          ),
        })),
        // As parcel_permits states it: the fact and its reason in one sentence.
        bbb: {
          available: false,
          reason:
            "BBB ratings are not available: no source in this data includes them.",
        },
      },
      fact: { tool: "run_summary", run_id: str(run.run_id) },
    };
  },
};

const days = (n: number) => `${n.toLocaleString("en-US")} days`;

/** One long-open list as a tool result shows it: the projected items, citations, IDs and truncation gap. */
function longOpenList(
  res: LongOpenResult,
  ref: SourceRef | null,
  what: string,
): {
  items: Record<string, unknown>[];
  truncated: boolean;
  records: Citation[];
  ids: string[];
  gaps: string[];
} {
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
      `Results truncated: ${what} returned ${items.length} of ${res.count} long-open permits (longest open first).`,
    );
  return {
    items,
    truncated,
    // Each item's permit, then the permit that set its parcel's roof year (when there is one).
    records: ref
      ? dedupeCitations(
          res.items.flatMap((p) =>
            present([
              cite("permit", ref, p.permit_number),
              roofYearCitation(ref, p.roof_year_permit_number),
            ]),
          ),
        )
      : [],
    ids: res.items.flatMap((p) =>
      strings(p.permit_number, p.parcel_id, p.roof_year_permit_number),
    ),
    gaps,
  };
}

/** The within-window list of long_open_permits, as the agent's reasoning states it. */
export type WithinWindowFact =
  | {
      status: "read";
      max_open_days: number;
      count: number;
      returned: number;
      /** How many listed permits got each contractor status. */
      contractors: ContractorSummary;
    }
  | { status: "not_listed"; gap: string };

/**
 * A within-window item's contractor: named (at least one contractor row that is not an owner-builder), owner-builder
 * (every row is one), none stated (no contractor row; "after the contractor window" when the permit was issued after
 * the rows end) or not read (the read failed, timed out or did not list the permit; why is stated).
 */
export type ContractorStatus =
  | "named"
  | "owner-builder"
  | "none stated"
  | "after the contractor window"
  | "not read";
export type ContractorSummary = Record<ContractorStatus, number>;

/** The contractor fields a within-window item carries (the identity of each row: its license). */
const ITEM_CONTRACTOR_FIELDS = fields(
  "contractors_business_name",
  "license_identifier",
  "license_class",
  "license_class_note",
  "is_owner_builder",
  "canonical_business_name",
  "name_variant_count",
);

/**
 * The within-window items with their permits' contractor rows: permits.forParcel once per listed parcel, all
 * started at once through the data layer (the HTTP adapter's bulkhead keeps at most 1 in flight, so they queue and
 * run one at a time), still waited for at most CONTRACTOR_READS_MS. Every item states its contractor_status; a read
 * that failed, did not finish in time or did not list the permit is "not read" with why (and a gap), never left out.
 * Contractor rows are cited under the contractor source, once per permit.
 */
async function withContractors(
  q: DataQueries,
  res: readonly LongOpenItem[],
  items: ReadonlyArray<Record<string, unknown>>,
  contractorRef: SourceRef | null,
  windowLast: string | null,
): Promise<{
  items: Array<Record<string, unknown>>;
  records: Citation[];
  gaps: string[];
  source: SourceRef | null;
  summary: ContractorSummary;
  summaryText: string;
}> {
  const parcels = [...new Set(res.map((p) => p.parcel_id))];
  const reads = new Map<string, Read<ParcelPermits>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const all = Promise.all(
    parcels.map((parcel_id) =>
      q.permits.forParcel({ parcel_id }).then(
        (v) => void reads.set(parcel_id, { ok: true, value: v }),
        (err: unknown) =>
          void reads.set(parcel_id, {
            ok: false,
            why: notRead("permits.forParcel", err),
          }),
      ),
    ),
  );
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CONTRACTOR_READS_MS);
    }),
  ]);
  clearTimeout(timer);
  // What was read by now; a read still running is not read (its late result is not used).
  const done = new Map(reads);
  const summary: ContractorSummary = {
    named: 0,
    "owner-builder": 0,
    "none stated": 0,
    "after the contractor window": 0,
    "not read": 0,
  };
  const records: Citation[] = [];
  const gaps: string[] = [];
  const out = res.map((p, i) => {
    const item = items[i] ?? {};
    const r = done.get(p.parcel_id) ?? {
      ok: false as const,
      why: `permits.forParcel not read within ${CONTRACTOR_READS_MS / 1000} s`,
    };
    const permit = r.ok
      ? r.value.permits.find((x) => x.permit_number === p.permit_number)
      : undefined;
    const why = !r.ok
      ? r.why
      : !permit
        ? `permit ${p.permit_number} is not among parcel ${p.parcel_id}'s permits (permits.forParcel)`
        : null;
    if (why !== null) {
      summary["not read"]++;
      gaps.push(
        `The contractor of permit ${p.permit_number} (parcel ${p.parcel_id}) was not read (${why}); it is listed without its contractor.`,
      );
      return {
        ...item,
        contractor_status: "not read" satisfies ContractorStatus,
        contractor_not_read: why,
        contractors: null,
      };
    }
    const rows = Array.isArray(permit!.contractors) ? permit!.contractors : [];
    const status: ContractorStatus = rows.length
      ? rows.every((c) => c.is_owner_builder === true)
        ? "owner-builder"
        : "named"
      : windowLast !== null &&
          typeof p.permit_issue_date === "string" &&
          p.permit_issue_date > windowLast
        ? "after the contractor window"
        : "none stated";
    summary[status]++;
    if (rows.length && contractorRef)
      records.push(cite("contractor", contractorRef, p.permit_number));
    return {
      ...item,
      contractor_status: status,
      contractors: rows.map((c) =>
        project(
          c as unknown as Record<string, unknown>,
          ITEM_CONTRACTOR_FIELDS,
        ),
      ),
    };
  });
  if (!contractorRef && summary.named + summary["owner-builder"] > 0)
    gaps.push(noSourceGap("contractor"));
  const summaryText = (Object.keys(summary) as ContractorStatus[])
    .filter((k) => summary[k] > 0)
    .map((k) => `${summary[k]} ${k}`)
    .join(", ");
  return {
    items: out,
    records,
    gaps,
    source: contractorRef,
    summary,
    summaryText: `Contractor of each listed permit: ${summaryText || "no permit listed"}.`,
  };
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Whole days from one YYYY-MM-DD date to another (UTC); null when either is not such a date. */
export function daysBetween(from: string, to: string): number | null {
  const utc = (d: string) => {
    const m = ISO_DAY.exec(d);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = utc(from);
  const b = utc(to);
  return a === null || b === null ? null : Math.round((b - a) / 86_400_000);
}

/** The contractor window as a with_contractor_window result states it: its dates and the day limit. */
interface WindowStated {
  source_name: string | null;
  first: string | null;
  last: string | null;
  reference_date: string;
  /** The within-window day limit; null when there is no window to compute it from. */
  max_open_days: number | null;
  text: string;
}

/**
 * The within-window call of long_open_permits: a permit issued on or after the window's first day has been open at
 * most (reference date − first day) days, so the limit is that number of days (lowered to the call's own
 * max_open_days when it is smaller), computed here, never by the model. No call when there is no window, or when
 * the limit is below min_open_days (no permit can be both); a failed call is a stated gap, the first list stays. The
 * call asks for min(limit, WITHIN_WINDOW_LIMIT) permits; its truncation gap states how many of how many it returned.
 */
async function withinWindow(
  input: ToolInput<"long_open_permits">,
  referenceDate: string,
  window: ReturnType<typeof contractorWindow>,
  longOpen: (maxOpenDays: number, limit: number) => Promise<LongOpenResult>,
): Promise<
  { window: WindowStated } & (
    | { status: "read"; res: LongOpenResult; maxOpenDays: number }
    | { status: "not_listed"; gap: string }
  )
> {
  const toWindow = window ? daysBetween(window.first, referenceDate) : null;
  if (!window || toWindow === null) {
    const gap = window
      ? `The within-window list is not given: the run's reference date (${referenceDate}) is not a date the day limit can be computed from.`
      : "The within-window list is not given: the run's sources state no contractor window.";
    return {
      window: {
        source_name: window?.source_name ?? null,
        first: window?.first ?? null,
        last: window?.last ?? null,
        reference_date: referenceDate,
        max_open_days: null,
        text: gap,
      },
      status: "not_listed",
      gap,
    };
  }
  const maxOpenDays = Math.min(
    toWindow,
    input.max_open_days ?? MAX_OPEN_DAYS,
    MAX_OPEN_DAYS,
  );
  const stated: WindowStated = {
    source_name: window.source_name,
    first: window.first,
    last: window.last,
    reference_date: referenceDate,
    max_open_days: maxOpenDays,
    text:
      `The contractor rows (${window.source_name}) cover permits issued ${window.first} to ${window.last}. A permit ` +
      `issued on or after ${window.first} has been open at most ${days(toWindow)} on the run's reference date ` +
      `${referenceDate}, so the within-window list is limited to ${days(maxOpenDays)} open` +
      (maxOpenDays < toWindow ? " (the call's own max_open_days)." : "."),
  };
  if (maxOpenDays < input.min_open_days) {
    const gap = `No permit issued within the contractor window (from ${window.first}) can be open ${days(input.min_open_days)} on ${referenceDate}: the limit of ${days(maxOpenDays)} is below the minimum, so no within-window list is given.`;
    return { window: stated, status: "not_listed", gap };
  }
  try {
    return {
      window: stated,
      status: "read",
      res: await longOpen(
        maxOpenDays,
        Math.min(input.limit, WITHIN_WINDOW_LIMIT),
      ),
      maxOpenDays,
    };
  } catch (err) {
    const gap = `The within-window list was not read (${notRead("permits.longOpen", err)}): only the longest-open list is given.`;
    return { window: stated, status: "not_listed", gap };
  }
}

/** A tool input the schema cannot express (e.g. max below min). */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** A read that either returned its value or failed with the reason stated. */
type Read<T> = { ok: true; value: T } | { ok: false; why: string };

/** Why a read failed, as a gap states it: the adapter's gap for a call not read, else the route and the message. */
function notRead(route: string, err: unknown): string {
  return unavailableIn(err)?.gap ?? `${route} failed (${shortMessage(err)})`;
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
    // A data API call not read after its retry (http-data.ts): the error and its gap name the route.
    const unavailable = unavailableIn(err);
    return fromParsed(
      unavailable
        ? fail(unavailable.gap, [unavailable.gap])
        : fail(shortMessage(err)),
    );
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
