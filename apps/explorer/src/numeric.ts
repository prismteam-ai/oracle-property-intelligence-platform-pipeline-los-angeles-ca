/**
 * Number fields as plain text entries: a field's state is the text exactly as typed (it can be emptied and
 * retyped), and it is read only when the search runs. A value that is empty or not a number in range gives a
 * plain message and nothing is sent.
 */
import type { ChangeEvent } from "react";
import type { LA_BOUNDS, MAX_OPEN_DAYS } from "@oracle-la/api-client";

/** The search centres the data API accepts (LA County with a margin); typed so a different API box fails the typecheck. */
export const LA_BOX: typeof LA_BOUNDS = {
  minLat: 33.2,
  maxLat: 34.9,
  minLon: -119.0,
  maxLon: -117.6,
};
/** The API's largest open duration in days (100 years); typed as the API's constant. */
export const MAX_DAYS: typeof MAX_OPEN_DAYS = 36_525;

/**
 * What a number input reports when the browser cannot read its text as a number (it then reports ""), so an
 * unreadable entry is told apart from an empty one. Never shown: the browser keeps showing what was typed.
 */
export const NOT_A_NUMBER = "\u0000not-a-number";
/** The text of a number input as typed (NOT_A_NUMBER when the browser cannot read it). */
export const typed = (e: ChangeEvent<HTMLInputElement>) =>
  e.target.validity?.badInput ? NOT_A_NUMBER : e.target.value;
/** The value given back to the input for a field's text. */
export const inputValue = (text: string) => (text === NOT_A_NUMBER ? "" : text);

export interface NumberRule {
  /** The field's label, as the form shows it. */
  label: string;
  min: number;
  max: number;
  /** Whole numbers only. */
  whole?: boolean;
  /** Said after the range, e.g. "(Los Angeles County)". */
  note?: string;
}
export type Read<V> = { value: V } | { error: string };

/** Plain decimal notation only: no exponent, hex, Infinity or thousands separators. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const fmt = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 6 });
const range = (r: NumberRule) =>
  `${r.whole ? "a whole number" : "a number"} from ${fmt(r.min)} to ${fmt(r.max)}${r.note ? ` ${r.note}` : ""}`;

/** A field's text as a number of the rule, or the message to show. */
export function readNumber(text: string, rule: NumberRule): Read<number> {
  const t = text.trim();
  if (t === "")
    return { error: `${rule.label} is empty: enter ${range(rule)}.` };
  const n = Number(t);
  if (
    text === NOT_A_NUMBER ||
    !DECIMAL.test(t) ||
    (rule.whole && !Number.isInteger(n)) ||
    n < rule.min ||
    n > rule.max
  )
    return { error: `${rule.label} must be ${range(rule)}.` };
  return { value: n };
}
/** An optional field: empty reads as undefined (not sent). */
export const readOptional = (
  text: string,
  rule: NumberRule,
): Read<number | undefined> =>
  text.trim() === "" && text !== NOT_A_NUMBER
    ? { value: undefined }
    : readNumber(text, rule);

/** Every field read, or all their messages in form order, as one text. */
export function readAll<T extends Record<string, Read<unknown>>>(
  reads: T,
):
  | { values: { [K in keyof T]: T[K] extends Read<infer V> ? V : never } }
  | { error: string } {
  const errors = Object.values(reads).flatMap((r) =>
    "error" in r ? [r.error] : [],
  );
  if (errors.length) return { error: errors.join(" ") };
  return {
    values: Object.fromEntries(
      Object.entries(reads).map(([k, r]) => [
        k,
        (r as { value: unknown }).value,
      ]),
    ) as { [K in keyof T]: T[K] extends Read<infer V> ? V : never },
  };
}

export const LAT: NumberRule = {
  label: "Latitude",
  min: LA_BOX.minLat,
  max: LA_BOX.maxLat,
  note: "(Los Angeles County)",
};
export const LON: NumberRule = {
  label: "Longitude",
  min: LA_BOX.minLon,
  max: LA_BOX.maxLon,
  note: "(Los Angeles County)",
};
/** Decimals are allowed (0.1 to 10); the arrows step whole miles. */
export const RADIUS: NumberRule = {
  label: "Radius (miles)",
  min: 0.1,
  max: 10,
};
