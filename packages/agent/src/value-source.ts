/**
 * Where a search's radius and roof age threshold came from: the question, the previous search area, the screen,
 * the default, or none of them (precedence in that order). One rule for both sides: the tool runner states it in
 * search_aged_roofs' and long_open_permits' results (`value_sources`, so the model reads the source before it
 * answers), and the answer's assumptions state the same sentences (agent.ts explain).
 */
import { sameCoord } from "../../views/src/place-index.ts";

/** Where a search's radius or roof age threshold came from (precedence: question, previous area, screen, default). */
export type ValueSource =
  "question" | "previous_area" | "screen" | "default" | "other";
export const VALUE_SOURCE_NAMES = [
  "question",
  "previous_area",
  "screen",
  "default",
  "other",
] as const satisfies readonly ValueSource[];

/** The tool defaults: radius 5 mi, roof age threshold 15 years. */
export const DEFAULT_RADIUS_MILES = 5;
export const DEFAULT_THRESHOLD_YEARS = 15;

/** Number words the question may use for a distance, a roof age or a duration. */
export const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
};

const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
/**
 * A search is attributed to a center when both coordinates agree at 5 decimals (the precision resolve_place serves
 * and the agent states), both sides through the same formatter (place-index.ts coordText).
 */
export const atCenter = (
  c: { lat: number; lon: number },
  lat: number,
  lon: number,
) => sameCoord(c.lat, lat) && sameCoord(c.lon, lon);

const NUMBER_WORD = Object.keys(NUMBER_WORDS).join("|");
/** Distances in the question, in miles: "five miles", "1 mile", "1-mile", "a mile", "half a mile", "2.5 mi". */
export function questionMiles(question: string): number[] {
  const re = new RegExp(
    String.raw`\b(half an?|an?|\d+(?:\.\d+)?|${NUMBER_WORD})[\s-]+(?:miles?|mi)\b`,
    "gi",
  );
  return [...question.matchAll(re)].map((m) => {
    const w = m[1]!.toLowerCase();
    if (w.startsWith("half")) return 0.5;
    if (w === "a" || w === "an") return 1;
    return NUMBER_WORDS[w] ?? Number(w);
  });
}
/** Numbers of years in the question: "older than 25 years", "25-year-old roofs", "fifteen years". */
export function questionYears(question: string): number[] {
  const re = new RegExp(
    String.raw`\b(\d+(?:\.\d+)?|${NUMBER_WORD})[\s-]+years?\b`,
    "gi",
  );
  return [...question.matchAll(re)].map((m) => {
    const w = m[1]!.toLowerCase();
    return NUMBER_WORDS[w] ?? Number(w);
  });
}

/**
 * The assumption naming where a search's radius or roof age threshold came from (deterministic; the eval's screen
 * and value_sources checks rebuild it). `screen` is the screen's value for the same setting, when the request had a
 * screen.
 */
export function valueSourceAssumption(
  what: "radius" | "threshold",
  value: number,
  source: ValueSource,
  screen: number | undefined,
): string {
  const label = what === "radius" ? "Radius" : "Roof age threshold";
  const unit = (n: number) => (what === "radius" ? `${n} mi` : `${n} years`);
  const shows =
    screen !== undefined ? ` (the screen shows ${unit(screen)})` : "";
  switch (source) {
    case "question":
      return `${label} ${unit(value)} from the question${shows}.`;
    case "previous_area":
      return `${label} ${unit(value)} from the previous search area${shows}.`;
    case "screen":
      return `${label} ${unit(value)} from the screen (the question gives ${what === "radius" ? "no distance" : "no roof age"}).`;
    case "default":
      return `${label} ${unit(value)}: the tool's default${screen !== undefined ? `, not the screen's ${unit(screen)}` : ""}.`;
    case "other":
      return `${label} ${unit(value)}: from neither the question${screen !== undefined ? ", the screen" : ""} nor the previous search area.`;
  }
}

/** The source of a search's value: the question, the previous area (radius only), the screen, the default, or none. */
export function valueSource(
  value: number,
  inQuestion: readonly number[],
  previous: number | undefined,
  screen: number | undefined,
  fallback: number,
): ValueSource {
  if (inQuestion.some((n) => same(n, value))) return "question";
  if (previous !== undefined && same(previous, value)) return "previous_area";
  if (screen !== undefined && same(screen, value)) return "screen";
  if (same(fallback, value)) return "default";
  return "other";
}

/**
 * What the tool runner needs from the request to state the sources: the question, the screen, the previous search
 * area, and the centers a search may be attributed to before the previous area (the request's center, then the places
 * resolved earlier in the same answer), the order agent.ts explain() attributes a search's center in.
 */
export interface ValueSourceContext {
  question: string;
  screen?: { radius_miles: number; threshold_years: number };
  /** The request's center (the CRM pin or the presenter's place). */
  center?: { lat: number; lon: number };
  /** The previous answer's search area (the session's). */
  previous?: { lat: number; lon: number; radius_miles: number };
  /** The centers of the places resolve_place resolved earlier in this answer. */
  places?: ReadonlyArray<{ lat: number; lon: number }>;
}

/** One value with its source and the assumption sentence that states it (valueSourceAssumption). */
export interface StatedValue {
  value: number;
  source: ValueSource;
  text: string;
}
/** The `value_sources` of a search result: the radius, and for search_aged_roofs the roof age threshold. */
export interface ValueSources {
  radius: StatedValue;
  threshold?: StatedValue;
}

/**
 * The previous area's radius when a search at (lat, lon) reuses the previous area (explain()'s rule): its center is
 * the previous area's, and neither a place resolved earlier in the answer nor the request's center is at it.
 */
export function reusedRadius(
  ctx: ValueSourceContext,
  lat: number,
  lon: number,
): number | undefined {
  if ((ctx.places ?? []).some((p) => atCenter(p, lat, lon))) return undefined;
  if (ctx.center && atCenter(ctx.center, lat, lon)) return undefined;
  return ctx.previous && atCenter(ctx.previous, lat, lon)
    ? ctx.previous.radius_miles
    : undefined;
}

/**
 * The values of a search_aged_roofs or long_open_permits call whose sources are stated, from its parsed input
 * (schema defaults applied) at (lat, lon): the radius, and for search_aged_roofs the roof age threshold; null for
 * any other tool.
 */
export function searchValuesOf(
  tool: string,
  input: Record<string, unknown>,
  lat: number,
  lon: number,
): Parameters<typeof valueSources>[1] | null {
  if (tool !== "search_aged_roofs" && tool !== "long_open_permits") return null;
  return {
    lat,
    lon,
    radius_miles: Number(input.radius_miles),
    ...(tool === "search_aged_roofs" &&
    typeof input.threshold_years === "number"
      ? { threshold_years: input.threshold_years }
      : {}),
  };
}

/**
 * The radius's source (and, with a threshold, the roof age threshold's) of a search with these parsed inputs (schema
 * defaults applied).
 */
export function valueSources(
  ctx: ValueSourceContext,
  input: {
    lat: number;
    lon: number;
    radius_miles: number;
    threshold_years?: number;
  },
): ValueSources {
  const screen = ctx.screen;
  const radius = valueSource(
    input.radius_miles,
    questionMiles(ctx.question),
    reusedRadius(ctx, input.lat, input.lon),
    screen?.radius_miles,
    DEFAULT_RADIUS_MILES,
  );
  const out: ValueSources = {
    radius: {
      value: input.radius_miles,
      source: radius,
      text: valueSourceAssumption(
        "radius",
        input.radius_miles,
        radius,
        screen?.radius_miles,
      ),
    },
  };
  if (input.threshold_years !== undefined) {
    const threshold = valueSource(
      input.threshold_years,
      questionYears(ctx.question),
      undefined,
      screen?.threshold_years,
      DEFAULT_THRESHOLD_YEARS,
    );
    out.threshold = {
      value: input.threshold_years,
      source: threshold,
      text: valueSourceAssumption(
        "threshold",
        input.threshold_years,
        threshold,
        screen?.threshold_years,
      ),
    };
  }
  return out;
}
