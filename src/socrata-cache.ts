/**
 * Shared checks for the two LADBS caches (data.lacity.org, Socrata SoQL pages): one page file is
 * read, its gzip and JSON digests and sizes are checked against the cache manifest, and its rows are
 * returned. Used by src/stage-permits.ts and src/stage-contractors.ts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const PAGES_DIR = "pages";
export const SOCRATA_ORIGIN = "https://data.lacity.org";

/** One page entry of a cache manifest.json (fields both caches record). */
export interface SocrataPage {
  page: number;
  file: string;
  url: string;
  query: string;
  row_count: number;
  retrieved_at: string;
  sha256_json: string;
  sha256_gz: string;
  bytes_json: number;
  bytes_gz: number;
}

export const sha256 = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");

/** sha256 of each named cache file that exists (recorded in the run manifest; contents never copied). */
export function cacheFileHashes(
  cacheDir: string,
  names: readonly string[],
): Array<{ path: string; sha256: string }> {
  return names.map((path) => ({
    path,
    sha256: sha256(readFileSync(join(cacheDir, path))),
  }));
}

/**
 * The page's request: https://data.lacity.org/resource/<dataset>.json with $query equal to the
 * manifest's query. Returns the query.
 */
export function checkPageRequest(p: SocrataPage, dataset: string): string {
  const url = new URL(p.url);
  if (
    `${url.origin}${url.pathname}` !==
    `${SOCRATA_ORIGIN}/resource/${dataset}.json`
  )
    throw new Error(`${p.file}: request URL is not the ${dataset} resource`);
  if (url.searchParams.get("$query") !== p.query)
    throw new Error(`${p.file}: request URL query differs from the manifest`);
  return p.query;
}

/** Read one page: plain file name, gzip and JSON sha256 and sizes, row count. */
export function readPage(
  cacheDir: string,
  p: SocrataPage,
): Array<Record<string, unknown>> {
  if (!/^[\w.-]+$/.test(p.file) || p.file.startsWith("."))
    throw new Error(`page file "${p.file}" is not a plain name`);
  const gz = readFileSync(join(cacheDir, PAGES_DIR, p.file));
  if (gz.length !== p.bytes_gz || sha256(gz) !== p.sha256_gz)
    throw new Error(`${p.file}: gzip sha256 or size mismatch`);
  const body = gunzipSync(gz);
  if (body.length !== p.bytes_json || sha256(body) !== p.sha256_json)
    throw new Error(`${p.file}: JSON sha256 or size mismatch`);
  const rows = JSON.parse(body.toString("utf8")) as unknown;
  if (!Array.isArray(rows) || rows.length !== p.row_count)
    throw new Error(`${p.file}: row count mismatch`);
  return rows as Array<Record<string, unknown>>;
}

/** The SELECT list of a SoQL query, or a failure if the query has none. */
export function selectList(query: string, file: string): string[] {
  const m = /^SELECT (.+?) (?:WHERE|ORDER BY) /.exec(query);
  if (!m) throw new Error(`${file}: query has no SELECT list`);
  return m[1]!.split(",").map((s) => s.trim());
}

/**
 * Paging: the query ends "ORDER BY <order> LIMIT <n> OFFSET <page × n>", every page but the last is
 * full and the last is not. Pages must be listed in order from 0.
 */
export function checkPaging(
  pages: SocrataPage[],
  order: string,
  label: string,
): void {
  let limit: number | undefined;
  for (const [i, p] of pages.entries()) {
    if (p.page !== i)
      throw new Error(`${label}: manifest page ${i} is numbered ${p.page}`);
    const m = new RegExp(
      ` ORDER BY ${order.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} LIMIT (\\d+) OFFSET (\\d+)$`,
    ).exec(p.query);
    if (!m) throw new Error(`${p.file}: query is not ordered by ${order}`);
    const n = Number(m[1]);
    limit ??= n;
    if (n !== limit || Number(m[2]) !== i * n)
      throw new Error(`${p.file}: LIMIT/OFFSET do not follow page ${i}`);
    const last = i === pages.length - 1;
    if (last ? p.row_count >= n : p.row_count !== n)
      throw new Error(`${p.file}: ${p.row_count} rows breaks the paging`);
  }
}

/** Keep exactly these fields of a source row (absent → null); every value must be a string or null. */
export function pickFields(
  row: Record<string, unknown>,
  fields: readonly string[],
  file: string,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of fields) {
    const v = row[f] ?? null;
    if (v !== null && typeof v !== "string")
      throw new Error(`${file}: field ${f} is not text`);
    out[f] = v;
  }
  return out;
}
