/**
 * Verify the LADBS permit cache (data.lacity.org; six permit datasets, issued and submitted) and
 * stream its rows to one NDJSON staging file under data/work, one page at a time. Each row keeps
 * only PERMIT_FIELDS (src/permit-fields.ts) plus its provenance. The derived roofing_flagged file in
 * the cache is never read.
 *
 * Checked before any row of a page is staged, failing on any mismatch:
 *  - manifest status "complete", source data.lacity.org;
 *  - each page: plain file name <dataset>_pNNN.json.gz, gzip and JSON sha256 and sizes, row count;
 *  - its request URL is the dataset's resource with the manifest's query; the query selects every
 *    staged field and uses the cache's filter (submitted sets also "issue_date IS NULL");
 *  - paging (ORDER BY permit_nbr LIMIT n OFFSET page × n) and per-dataset totals against
 *    manifest counts[] (expected_rows = fetched_rows) and summary.json rows_per_set;
 *  - the count query's WHERE equals the pages' WHERE;
 *  - the total against summary.json, and every permit_nbr once.
 */
import { once } from "node:events";
import { createWriteStream, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PERMIT_FIELDS } from "./permit-fields.ts";
import {
  cacheFileHashes,
  checkPageRequest,
  checkPaging,
  PAGES_DIR,
  pickFields,
  readPage,
  selectList,
  type SocrataPage,
} from "./socrata-cache.ts";

export type PermitKind = "issued" | "submitted";

export interface PermitPage extends SocrataPage {
  dataset: string;
  kind: PermitKind;
}

export interface PermitCacheManifest {
  source: string;
  status: string;
  pages: PermitPage[];
  counts: Array<{
    dataset: string;
    kind: PermitKind;
    query: string;
    expected_rows: number;
    fetched_rows: number;
  }>;
}

export interface PermitCacheSummary {
  generated_at: string;
  total_rows: number;
  distinct_permit_nbr: number;
  rows_per_set: Record<string, { kind: PermitKind; rows: number }>;
  [key: string]: unknown;
}

/** The cache's filter: every set; submitted sets add the second condition. */
export const PERMIT_FILTER = "upper(work_desc) LIKE '%ROOF%'";
export const SUBMITTED_FILTER = `${PERMIT_FILTER} AND issue_date IS NULL`;
/** Cache files whose sha256 the run manifest records. */
export const PERMIT_CACHE_FILES = [
  "manifest.json",
  "summary.json",
  "fetch.mjs",
] as const;

const whereOf = (query: string) =>
  / WHERE (.+?)(?: ORDER BY .*)?$/.exec(query)?.[1];

export function readPermitCache(cacheDir: string): {
  manifest: PermitCacheManifest;
  summary: PermitCacheSummary;
} {
  const read = <T>(f: string) =>
    JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as T;
  return {
    manifest: read<PermitCacheManifest>("manifest.json"),
    summary: read<PermitCacheSummary>("summary.json"),
  };
}

/** Check the manifest against summary.json before any page is read; returns the pages by dataset. */
function checkPermitManifest(
  manifest: PermitCacheManifest,
  summary: PermitCacheSummary,
): Map<string, PermitPage[]> {
  if (manifest.status !== "complete")
    throw new Error(`permit cache status is "${manifest.status}"`);
  if (manifest.source !== "data.lacity.org")
    throw new Error(`permit cache source is "${manifest.source}"`);
  const byDataset = new Map<string, PermitPage[]>();
  for (const p of manifest.pages)
    byDataset.set(p.dataset, [...(byDataset.get(p.dataset) ?? []), p]);
  const sets = Object.keys(summary.rows_per_set).sort();
  const counted = manifest.counts.map((c) => c.dataset).sort();
  if (
    JSON.stringify([...byDataset.keys()].sort()) !== JSON.stringify(sets) ||
    JSON.stringify(counted) !== JSON.stringify(sets)
  )
    throw new Error(
      "permit cache datasets differ between manifest and summary",
    );
  for (const c of manifest.counts) {
    const pages = byDataset.get(c.dataset)!;
    const set = summary.rows_per_set[c.dataset]!;
    const where = c.kind === "submitted" ? SUBMITTED_FILTER : PERMIT_FILTER;
    if (c.kind !== set.kind || pages.some((p) => p.kind !== c.kind))
      throw new Error(
        `${c.dataset}: kind differs between manifest and summary`,
      );
    if (whereOf(c.query) !== where)
      throw new Error(
        `${c.dataset}: count query WHERE is not the cache filter`,
      );
    const rows = pages.reduce((n, p) => n + p.row_count, 0);
    if (
      c.expected_rows !== c.fetched_rows ||
      c.expected_rows !== rows ||
      set.rows !== rows
    )
      throw new Error(
        `${c.dataset}: ${rows} page rows, expected ${c.expected_rows}, fetched ${c.fetched_rows}, summary ${set.rows}`,
      );
    checkPaging(pages, "permit_nbr", c.dataset);
    for (const p of pages) {
      if (p.file !== `${c.dataset}_p${String(p.page).padStart(3, "0")}.json.gz`)
        throw new Error(
          `${p.file}: not the file name of ${c.dataset} page ${p.page}`,
        );
      checkPageRequest(p, c.dataset);
      if (whereOf(p.query) !== where)
        throw new Error(`${p.file}: query WHERE is not the cache filter`);
      const fields = selectList(p.query, p.file);
      const missing = PERMIT_FIELDS.filter((f) => !fields.includes(f));
      if (missing.length)
        throw new Error(
          `${p.file}: query does not select ${missing.join(", ")}`,
        );
    }
  }
  return byDataset;
}

/** Verify the permit cache and write the staged rows; returns counts and the cache file hashes. */
export async function stagePermits(
  cacheDir: string,
  ndjsonPath: string,
): Promise<{
  summary: PermitCacheSummary;
  pages: PermitPage[];
  rows: number;
  rowsByDataset: Record<string, number>;
  files: Array<{ path: string; sha256: string }>;
}> {
  const { manifest, summary } = readPermitCache(cacheDir);
  const byDataset = checkPermitManifest(manifest, summary);
  const files = cacheFileHashes(cacheDir, PERMIT_CACHE_FILES);
  // Opened synchronously, so a failure never leaves an open still pending on the stream.
  const out = createWriteStream(ndjsonPath, { fd: openSync(ndjsonPath, "w") });
  const seen = new Set<string>();
  const rowsByDataset: Record<string, number> = {};
  let rows = 0;
  try {
    for (const [dataset, pages] of byDataset) {
      for (const p of pages) {
        let chunk = "";
        for (const r of readPage(cacheDir, p)) {
          const row = pickFields(r, PERMIT_FIELDS, p.file);
          const nbr = row.permit_nbr;
          if (!nbr) throw new Error(`${p.file}: row without permit_nbr`);
          if (seen.has(nbr))
            throw new Error(`${p.file}: a permit_nbr appears more than once`);
          seen.add(nbr);
          chunk +=
            JSON.stringify({
              ...row,
              _dataset: dataset,
              _dataset_kind: p.kind,
              _page_file: `${PAGES_DIR}/${p.file}`,
              _request_url: p.url,
              _retrieved_at: p.retrieved_at,
              _page_sha256: p.sha256_json,
            }) + "\n";
        }
        rows += p.row_count;
        rowsByDataset[dataset] = (rowsByDataset[dataset] ?? 0) + p.row_count;
        if (!out.write(chunk)) await once(out, "drain");
      }
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
  if (summary.total_rows !== rows || summary.distinct_permit_nbr !== seen.size)
    throw new Error(
      `permit cache totals do not match summary.json (staged ${rows} rows, ${seen.size} permits)`,
    );
  return { summary, pages: manifest.pages, rows, rowsByDataset, files };
}
