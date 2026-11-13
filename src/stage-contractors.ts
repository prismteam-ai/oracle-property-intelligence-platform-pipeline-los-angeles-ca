/**
 * Verify the LADBS contractor cache (data.lacity.org view 8guu-8f5m, "roofing permits") and stream
 * its rows to one NDJSON staging file under data/work. Each row keeps CONTRACTOR_FIELDS
 * (src/permit-fields.ts) plus its provenance. Rows that repeat an earlier row in every field are
 * staged once and counted (exact duplicates). summary.json's duplicate_rows is a different count:
 * rows beyond the first for each permit (rows minus distinct permits).
 *
 * Checked, failing on any mismatch:
 *  - manifest status "complete", the view of summary.json, columns_checked on every page;
 *  - the manifest's allowed columns are exactly CONTRACTOR_FIELDS, and every page selects exactly them;
 *  - each page: plain file name <view>_pNNN.json.gz, gzip and JSON sha256 and sizes, row count,
 *    request URL (the view's resource with the manifest's query);
 *  - paging (ORDER BY pcis_permit, :id LIMIT n OFFSET page × n);
 *  - rows against count.expected_rows = fetched_rows and summary.json rows; distinct permits and
 *    rows minus distinct permits against summary.json.
 * summary.json is hashed, never copied (it records a local path).
 */
import { once } from "node:events";
import { createWriteStream, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTOR_FIELDS } from "./permit-fields.ts";
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

export interface ContractorCacheManifest {
  view: string;
  status: string;
  allowed_columns: string[];
  pages: Array<SocrataPage & { columns_checked: boolean }>;
  count: { query: string; expected_rows: number; fetched_rows: number };
}

export interface ContractorCacheSummary {
  generated_at: string;
  view: string;
  rows: number;
  distinct_permits: number;
  duplicate_rows: number;
  [key: string]: unknown;
}

export const CONTRACTOR_VIEW = "8guu-8f5m";
/** Cache files whose sha256 the run manifest records. */
export const CONTRACTOR_CACHE_FILES = [
  "manifest.json",
  "summary.json",
  "fetch.mjs",
] as const;

export function readContractorCache(cacheDir: string): {
  manifest: ContractorCacheManifest;
  summary: ContractorCacheSummary;
} {
  const read = <T>(f: string) =>
    JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as T;
  return {
    manifest: read<ContractorCacheManifest>("manifest.json"),
    summary: read<ContractorCacheSummary>("summary.json"),
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Verify the contractor cache and write the staged rows (exact duplicates once). */
export async function stageContractors(
  cacheDir: string,
  ndjsonPath: string,
): Promise<{
  summary: ContractorCacheSummary;
  rows: number;
  staged: number;
  duplicates: number;
  distinctPermits: number;
  files: Array<{ path: string; sha256: string }>;
}> {
  const { manifest, summary } = readContractorCache(cacheDir);
  if (manifest.status !== "complete")
    throw new Error(`contractor cache status is "${manifest.status}"`);
  if (manifest.view !== CONTRACTOR_VIEW || summary.view !== CONTRACTOR_VIEW)
    throw new Error(`contractor cache is not view ${CONTRACTOR_VIEW}`);
  if (!sameList(manifest.allowed_columns, CONTRACTOR_FIELDS))
    throw new Error("contractor cache columns are not CONTRACTOR_FIELDS");
  if (manifest.count.query !== "SELECT count(*) AS n")
    throw new Error("contractor count query is not an unfiltered count");
  checkPaging(manifest.pages, "pcis_permit, :id", CONTRACTOR_VIEW);
  for (const p of manifest.pages) {
    if (
      p.file !==
      `${CONTRACTOR_VIEW}_p${String(p.page).padStart(3, "0")}.json.gz`
    )
      throw new Error(`${p.file}: not the file name of page ${p.page}`);
    if (p.columns_checked !== true)
      throw new Error(`${p.file}: columns not checked at download`);
    checkPageRequest(p, CONTRACTOR_VIEW);
    if (!sameList(selectList(p.query, p.file), CONTRACTOR_FIELDS))
      throw new Error(`${p.file}: query does not select CONTRACTOR_FIELDS`);
  }
  const pageRows = manifest.pages.reduce((n, p) => n + p.row_count, 0);
  const { expected_rows, fetched_rows } = manifest.count;
  if (
    expected_rows !== fetched_rows ||
    expected_rows !== pageRows ||
    summary.rows !== pageRows
  )
    throw new Error(
      `contractor cache: ${pageRows} page rows, expected ${expected_rows}, fetched ${fetched_rows}, summary ${summary.rows}`,
    );
  const files = cacheFileHashes(cacheDir, CONTRACTOR_CACHE_FILES);

  const out = createWriteStream(ndjsonPath, { fd: openSync(ndjsonPath, "w") });
  const seenRows = new Set<string>();
  const permits = new Set<string>();
  let rows = 0;
  let duplicates = 0;
  try {
    for (const p of manifest.pages) {
      let chunk = "";
      for (const r of readPage(cacheDir, p)) {
        rows += 1;
        const row = pickFields(r, CONTRACTOR_FIELDS, p.file);
        if (!row.pcis_permit)
          throw new Error(`${p.file}: row without pcis_permit`);
        permits.add(row.pcis_permit);
        const key = JSON.stringify(CONTRACTOR_FIELDS.map((f) => row[f]));
        if (seenRows.has(key)) {
          duplicates += 1;
          continue;
        }
        seenRows.add(key);
        chunk +=
          JSON.stringify({
            ...row,
            _dataset: CONTRACTOR_VIEW,
            _page_file: `${PAGES_DIR}/${p.file}`,
            _request_url: p.url,
            _retrieved_at: p.retrieved_at,
            _page_sha256: p.sha256_json,
          }) + "\n";
      }
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
    summary.distinct_permits !== permits.size ||
    summary.duplicate_rows !== rows - permits.size
  )
    throw new Error(
      `contractor cache: ${permits.size} permits in ${rows} rows, summary.json says ${summary.distinct_permits} permits and ${summary.duplicate_rows} extra rows`,
    );
  return {
    summary,
    rows,
    staged: rows - duplicates,
    duplicates,
    distinctPermits: permits.size,
    files,
  };
}
