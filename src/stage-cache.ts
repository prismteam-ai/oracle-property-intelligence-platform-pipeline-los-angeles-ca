/**
 * Verify the whole-roll cache written by scripts/fetch-roll.mjs and stream it to one NDJSON
 * staging file, one page at a time (the roll is never held in memory). Each row keeps only
 * RAW_FIELDS plus its provenance from the cache manifest. Raw pages are not copied.
 *
 * Every page is checked against manifest.jsonl before any of its rows is staged:
 *  - the page file is a plain name under pages/ (paths stay cache-relative);
 *  - HTTP status 200;
 *  - the gunzipped body has the recorded sha256 and byte count;
 *  - the request URL is the run's query URL with the run's where clause (plus the OBJECTID
 *    keyset condition after the first page);
 *  - the row count is the recorded one;
 *  - OBJECTIDs run without a gap from 1, page after page, and match the recorded range.
 * The totals must match summary.json, and the last page must be the only one marked final.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { RAW_FIELDS } from "./raw-fields.ts";

export interface CachePage {
  page: number;
  file: string;
  oid_min: number;
  oid_max: number;
  rows: number;
  sha256: string;
  bytes: number;
  http_status: number;
  fetched_at: string;
  request_url: string;
  final?: boolean;
}

export interface CacheSummary {
  generated_at: string;
  total_rows: number;
  source_count_at_start: number | null;
  pages: number;
  oid_min: number | null;
  oid_max: number | null;
  complete: boolean | null;
  [key: string]: unknown;
}

export interface CacheScope {
  /** The run's query URL (config source.query_url). */
  queryUrl: string;
  /** The run's where clause (run-config whereClause). */
  where: string;
}

export const PAGES_DIR = "pages";

export function readCacheSummary(cacheDir: string): CacheSummary {
  return JSON.parse(
    readFileSync(join(cacheDir, "summary.json"), "utf8"),
  ) as CacheSummary;
}

export function readCacheManifest(cacheDir: string): CachePage[] {
  return readFileSync(join(cacheDir, "manifest.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CachePage);
}

/** Run ID of a cache build: the cache summary's generated_at with ":" and "." replaced. */
export function cacheRunId(summary: CacheSummary): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(summary.generated_at))
    throw new Error(`summary.json generated_at is not an ISO time`);
  return summary.generated_at.replace(/[:.]/g, "-");
}

const base = (u: URL) => `${u.origin}${u.pathname}`;

function checkRequest(
  p: CachePage,
  scope: CacheScope,
  previousOidMax: number,
): void {
  const url = new URL(p.request_url);
  if (base(url) !== base(new URL(scope.queryUrl)))
    throw new Error(`page ${p.page}: request URL is not the run's query URL`);
  const expected =
    p.page === 0
      ? scope.where
      : `${scope.where} AND OBJECTID > ${previousOidMax}`;
  const where = url.searchParams.get("where");
  if (where !== expected)
    throw new Error(
      `page ${p.page}: request where "${where}" is not "${expected}"`,
    );
}

/** Verify the cache and write the staged rows; returns the pages, the summary and the row count. */
export async function stageCache(
  cacheDir: string,
  ndjsonPath: string,
  scope: CacheScope,
): Promise<{ pages: CachePage[]; summary: CacheSummary; rows: number }> {
  const summary = readCacheSummary(cacheDir);
  const pages = readCacheManifest(cacheDir);
  if (pages.length === 0) throw new Error("cache manifest has no pages");
  if (pages.length !== summary.pages)
    throw new Error(
      `cache manifest has ${pages.length} pages, summary.json says ${summary.pages}`,
    );
  // Opened synchronously, so a failure never leaves an open still pending on the stream.
  const out = createWriteStream(ndjsonPath, { fd: openSync(ndjsonPath, "w") });
  let rows = 0;
  let nextOid = 1;
  try {
    for (const [i, p] of pages.entries()) {
      if (p.page !== i)
        throw new Error(`manifest line ${i + 1} is page ${p.page}`);
      if (!/^[\w.-]+$/.test(p.file) || p.file.startsWith("."))
        throw new Error(`page ${p.page}: file "${p.file}" is not a plain name`);
      if (p.http_status !== 200)
        throw new Error(`page ${p.page}: HTTP status ${p.http_status}`);
      if (Boolean(p.final) !== (i === pages.length - 1))
        throw new Error(`page ${p.page}: final flag does not match its place`);
      checkRequest(p, scope, nextOid - 1);
      const file = `${PAGES_DIR}/${p.file}`;
      const body = gunzipSync(readFileSync(join(cacheDir, file)));
      if (
        createHash("sha256").update(body).digest("hex") !== p.sha256 ||
        body.length !== p.bytes
      )
        throw new Error(`page ${p.page}: body sha256 or size mismatch`);
      const features = (
        JSON.parse(body.toString("utf8")) as {
          features?: Array<{ attributes: Record<string, unknown> }>;
        }
      ).features;
      if (!Array.isArray(features) || features.length !== p.rows)
        throw new Error(`page ${p.page}: row count mismatch`);
      if (p.oid_min !== nextOid)
        throw new Error(
          `page ${p.page}: starts at OBJECTID ${p.oid_min}, expected ${nextOid}`,
        );
      let chunk = "";
      for (const f of features) {
        const a = f.attributes;
        if (a.OBJECTID !== nextOid)
          throw new Error(
            `page ${p.page}: OBJECTID ${String(a.OBJECTID)}, expected ${nextOid}`,
          );
        nextOid += 1;
        const row: Record<string, unknown> = {};
        for (const k of RAW_FIELDS) {
          if (!Object.hasOwn(a, k))
            throw new Error(`page ${p.page}: field ${k} missing`);
          row[k] = a[k];
        }
        row._page_file = file;
        row._request_url = p.request_url;
        row._retrieved_at = p.fetched_at;
        row._page_sha256 = p.sha256;
        chunk += JSON.stringify(row) + "\n";
      }
      if (p.oid_max !== nextOid - 1)
        throw new Error(
          `page ${p.page}: ends at OBJECTID ${nextOid - 1}, manifest says ${p.oid_max}`,
        );
      rows += features.length;
      if (!out.write(chunk)) await once(out, "drain");
    }
  } catch (err) {
    const closed = once(out, "close");
    out.destroy();
    await closed;
    throw err;
  }
  await new Promise<void>((resolve, reject) =>
    out.end((err?: Error | null) => (err ? reject(err) : resolve())),
  );
  if (
    summary.complete !== true ||
    summary.total_rows !== rows ||
    summary.source_count_at_start !== rows ||
    summary.oid_min !== 1 ||
    summary.oid_max !== rows
  )
    throw new Error(
      `cache totals do not match summary.json (staged ${rows} rows, OBJECTID 1-${nextOid - 1})`,
    );
  return { pages, summary, rows };
}
