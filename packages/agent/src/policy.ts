/**
 * Answer policy (design brief §6–§7, §11.4): standard gaps, the people guard, allowlist projection, the
 * description guard, citations, unverified IDs and the markdown layout.
 */

/**
 * A record any tool returned, cited in the answer. A parcel cites its own page (provenance row). Permits and
 * contractor rows carry no per-item provenance in the API: they cite their source from explorer.sources (name,
 * license, attribution and retrieval window of that kind's own source rows), and `id` is the permit number (for
 * "contractor", the permit whose contractor rows were shown).
 */
export interface Citation {
  kind: "parcel" | "permit" | "contractor";
  id: string;
  source_name: string;
  /** The source's license as the run states it (SourceRow.license); absent when the run states none. */
  license?: string;
  /** The source's attribution as the run states it (SourceRow.attribution); absent when the run states none. */
  attribution?: string;
  collected_at: string;
}

/**
 * The contractor gap where the run's sources state no window, and in refusals (which read no data). An answer
 * that reads the window states it instead (contractor-coverage.ts): on the served runs the same first sentence,
 * then the source and its window.
 */
export const DOCUMENTED_CONTRACTOR_END = "May 2023";
export const GAP_CONTRACTOR_DEFAULT = `No contractor license data after ${DOCUMENTED_CONTRACTOR_END}.`;

/** Always listed in every answer (American spelling); the contractor gap as contractor-coverage.ts states it. */
export const STANDARD_GAPS: readonly string[] = [
  "Permits cover the City of Los Angeles only (LADBS); parcels elsewhere in the county have no permit data.",
  GAP_CONTRACTOR_DEFAULT,
  "BBB ratings are not available.",
  "No owner data: owner names and contact details are neither collected nor served.",
  "Permit descriptions are not read or returned.",
];

export const GAP_NO_CENTER =
  "No search center was given or resolved: the agent needs a point (the CRM pin or a place name found in the data) for area questions.";

// ---------------------------------------------------------------------------------------------------------------
// People guard: runs before any model call.

export const PEOPLE_REFUSAL_TEXT =
  "I can't answer questions about people: owners, residents, occupants, tenants or anyone's contact details. " +
  "Owner names and contact details are neither collected nor served. I can answer about parcels, roof age, " +
  "permits and contractor businesses (business names and license numbers).";

/** Business terms that contain a people word but are about contractors, removed before matching. */
const BUSINESS_TERMS = /\bowner[\s-]?builders?\b/gi;

const OWNER = String.raw`owner(?:s|ship)?`;
const NOT = String.raw`(?:(?:has|have|had|is|was|were|did|does|do)(?:n['’]t|\s+not|\s+never)|never)`;
/**
 * How long a property has gone without an ownership change, in the wordings people use (approvals §3e.75 c): about
 * the property, answered through the ownership filter, never about who the owner is. Each phrase is removed before
 * matching, so a question stays refused when a people word or pattern is left outside it ("same owner for 10 years,
 * and who is the owner?" is refused by "the owner").
 */
export const OWNERSHIP_DURATION_TERMS: readonly RegExp[] = [
  // "same owner(s)", "the same ownership", "unchanged owner", "stable ownership"
  new RegExp(
    String.raw`\b(?:the\s+)?(?:same|unchanged|stable|constant)\s+${OWNER}\b`,
    "gi",
  ),
  // "owner hasn't changed", "owners that have not changed", "ownership never changed", "owner did not change"
  new RegExp(
    String.raw`\b${OWNER}\s+(?:(?:that|which|who)\s+)?${NOT}\s+(?:been\s+)?chang(?:e|ed)\b`,
    "gi",
  ),
  // "owner unchanged", "ownership stayed the same"
  new RegExp(
    String.raw`\b${OWNER}\s+(?:(?:is|was|has been|have been|stayed|remained)\s+)?(?:unchanged|the same)\b`,
    "gi",
  ),
  // "no change of owner", "without an ownership change", "no owner changes", "any change in ownership"
  new RegExp(
    String.raw`\b(?:no|without(?:\s+an?)?|any)\s+(?:change\s+(?:of|in)\s+${OWNER}|${OWNER}\s+changes?)\b`,
    "gi",
  ),
  // "changed owners", "change of ownership", "changing owners"
  new RegExp(
    String.raw`\bchang(?:e|ed|es|ing)\s+(?:(?:of|in)\s+)?${OWNER}\b`,
    "gi",
  ),
  // "long-time owners", "long-term ownership", "longstanding owner"
  new RegExp(String.raw`\blong[\s-]?(?:time|term|standing)\s+${OWNER}\b`, "gi"),
  // "owned by the same family", "held by the same owner"
  new RegExp(
    String.raw`\b(?:owned|held)\s+by\s+the\s+same\s+(?:${OWNER}|person|people|family|party)\b`,
    "gi",
  ),
];

const PEOPLE_PATTERNS: readonly RegExp[] = [
  // owners, residents, occupants, tenants and the like
  /\b(?:owners?|owned by|homeowners?|landlords?|landlady|residents?|occupants?|tenants?|renters?|lessees?|inhabitants?|neighbou?rs?)\b/i,
  // "who lives at", "who owns", "who rents"
  /\bwho\s+(?:lives?|lived|resides?|resided|owns?|owned|rents?|rented|occupies|occupied|stays?)\b/i,
  // someone living, residing or staying at a place: "the person living at", "anyone residing in"
  /\b(?:living|residing|staying)\s+(?:at|in|on)\b/i,
  // a person's phone, email or contact
  /\b(?:phone|telephone|cell(?:phone)?|mobile number|e-?mail|contact (?:info|information|details)|home address|mailing address)\b/i,
  // where someone lives
  /\bwhere\s+(?:does|do|did)\s+.+?\s+live\b/i,
  // a named individual (titles only; "Dr" is left out because it is also a street suffix)
  /\b(?:[Mm]r|[Mm]rs|[Mm]s|[Mm]iss)\.?\s+[A-Z][a-z]/,
  /\b(?:person|man|woman|someone|somebody|individual|people|family)\s+(?:named|called)\b/i,
  // people's names, and which person or family: "the names of the people", "which family has owned"
  /\bnames?\s+of\s+(?:the\s+|a\s+|any\s+)?(?:persons?|people|individuals?|famil(?:y|ies)|households?)\b/i,
  // ("individual" is left out here: "which individual parcels" is about parcels)
  /\b(?:which|what)\s+(?:persons?|people|famil(?:y|ies)|households?)\b/i,
];

/**
 * True when the question is about people rather than parcels, permits or contractor businesses. Contractor terms
 * (owner-builder) and ownership-duration phrases (OWNERSHIP_DURATION_TERMS) are removed first; every people
 * pattern is then matched on what is left.
 */
export function isPeopleQuestion(question: string): boolean {
  let q = question.replace(BUSINESS_TERMS, " ");
  for (const t of OWNERSHIP_DURATION_TERMS) q = q.replace(t, " ");
  return PEOPLE_PATTERNS.some((p) => p.test(q));
}

// ---------------------------------------------------------------------------------------------------------------
// No-tool-call rule (approvals §3e.75 b): runs after the model's last call.

/**
 * The fixed text of an answer whose reply used no tool result, in this turn or in the conversation: the model's
 * own text is never shown then (general knowledge, writing tasks, an instruction to ignore the rules, or a data
 * question answered from memory).
 */
export const NO_TOOL_CALL_TEXT =
  "Ask me about properties, permits or contractors in this data, with a place or a point, for example " +
  '"Which properties within five miles of Van Nuys have roofs older than 15 years?". I answer only from what my ' +
  "tools read from the data (Los Angeles County parcels and their roof age, City of Los Angeles building permits, " +
  "contractor businesses). This reply used none, so it is not shown.";

// ---------------------------------------------------------------------------------------------------------------
// Projection and the description guard.

export type Scalar = string | number | boolean | null;

const toScalar = (v: unknown): Scalar =>
  v === null || v === undefined
    ? null
    : typeof v === "string" || typeof v === "number" || typeof v === "boolean"
      ? v
      : null;

/**
 * Explicit allowlist projection: only the listed keys, scalars only (anything else becomes null). Never a spread
 * of the row. `keys` maps output name → source column.
 */
export function project(
  row: Record<string, unknown> | null | undefined,
  keys: Readonly<Record<string, string>>,
): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [outKey, srcKey] of Object.entries(keys))
    out[outKey] = toScalar(row?.[srcKey]);
  return out;
}

/** Same-name allowlist. */
export const fields = (...names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((n) => [n, n]));

const DESC_KEY = /desc/i;

/** The last guard: drops every key matching /desc/i at any depth and counts the drops. */
export function dropDescriptions(value: unknown): {
  value: unknown;
  dropped: number;
} {
  let dropped = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (DESC_KEY.test(k)) {
          dropped++;
          continue;
        }
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value), dropped };
}

// ---------------------------------------------------------------------------------------------------------------
// Citations and IDs.

export function dedupeCitations(records: readonly Citation[]): Citation[] {
  const seen = new Map<string, Citation>();
  for (const r of records) {
    const key = `${r.kind}:${r.id}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

/** 10-digit parcel IDs (AINs) as the API serves them. */
const PARCEL_ID = /(?<![\d-])\d{10}(?![\d-])/g;
/**
 * LADBS permit numbers as the API serves them, e.g. 16016-10000-00001: the permit cursor of explorer.records
 * (apps/api/src/routers/explorer.ts, CURSOR.permit = /^\d{5}-\d{5}-\d{5}$/), matched by every permit number of
 * the API's permit fixture (checked in apps/agent-mcp/test/local.fixture.test.ts).
 */
const PERMIT_NBR = /(?<![\d-])\d{5}-\d{5}-\d{5}(?![\d-])/g;

/** Parcel IDs and permit numbers written in the text. */
export function idsInText(text: string): string[] {
  return [
    ...new Set([
      ...(text.match(PARCEL_ID) ?? []),
      ...(text.match(PERMIT_NBR) ?? []),
    ]),
  ];
}

/** IDs in the text that no tool returned. */
export function unverifiedIds(
  text: string,
  returned: ReadonlySet<string>,
): string[] {
  return idsInText(text).filter((id) => !returned.has(id));
}

export const gapForUnverified = (id: string): string =>
  `Unverified ID in the answer: ${id} was not returned by any tool in this answer; treat it as unconfirmed.`;

export function uniq(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown.

export interface MarkdownParts {
  text: string;
  status: "answered" | "refused" | "stopped";
  stopped_by?: string;
  reasoning: string;
  assumptions: readonly string[];
  records: readonly Citation[];
  gaps: readonly string[];
}

const list = (xs: readonly string[]) =>
  xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- None.";

const KIND_LABEL: Record<Exclude<Citation["kind"], "parcel">, string> = {
  permit: "Permits",
  contractor: "Contractor rows of permits",
};

/** "<name> (license: <license>; attribution: <attribution>)", leaving out what the run does not state. */
function sourceLabel(r: Citation): string {
  const terms = [
    ...(r.license !== undefined ? [`license: ${r.license}`] : []),
    ...(r.attribution !== undefined ? [`attribution: ${r.attribution}`] : []),
  ];
  return terms.length
    ? `${r.source_name} (${terms.join("; ")})`
    : r.source_name;
}

/**
 * The "Records cited" lines: one line per parcel (its own page and time); permits and contractor rows listed by
 * number under one line per source ("<name> (license: <license>; attribution: <attribution>), retrieved <time>"),
 * so each source is stated once.
 */
export function recordLines(records: readonly Citation[]): string[] {
  const lines: string[] = [];
  const groups = new Map<string, { head: string; ids: string[] }>();
  for (const r of records) {
    if (r.kind === "parcel") {
      lines.push(
        `- parcel ${r.id}: ${r.source_name}, collected ${r.collected_at}`,
      );
      continue;
    }
    const label = sourceLabel(r);
    const key = `${r.kind}\u0000${label}\u0000${r.collected_at}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        head: `- ${KIND_LABEL[r.kind]}: ${label}, retrieved ${r.collected_at}`,
        ids: [],
      };
      groups.set(key, g);
      lines.push(key);
    }
    g.ids.push(r.id);
  }
  return lines.flatMap((l) => {
    const g = groups.get(l);
    return g ? [g.head, ...g.ids.map((id) => `  - ${id}`)] : [l];
  });
}

/** text + "How this was answered" + "Assumptions" + "Records cited" + "Gaps". */
export function buildMarkdown(p: MarkdownParts): string {
  const head =
    p.status === "stopped"
      ? `**Stopped before a full answer (${p.stopped_by ?? "unknown"}).**\n\n`
      : "";
  const records = recordLines(p.records);
  return [
    `${head}${p.text}`,
    `## How this was answered\n\n${p.reasoning}`,
    `## Assumptions\n\n${list(p.assumptions)}`,
    `## Records cited\n\n${records.length ? records.join("\n") : "- None."}`,
    `## Gaps\n\n${list(p.gaps)}`,
  ].join("\n\n");
}
