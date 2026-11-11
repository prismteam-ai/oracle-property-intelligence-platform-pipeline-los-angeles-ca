/**
 * Download the approved parcel slice from the LA County Assessor roll query API.
 * Sequential, at most one request per min_request_interval_ms. Raw page bytes are kept
 * unchanged next to a receipt (request URL, retrieval time, HTTP status, bytes, sha256).
 *
 * Usage: node src/fetch-slice.ts [run-config.json]
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guardOrThrow } from "./scope-guard.ts";
import { loadRunConfig, whereClause } from "./run-config.ts";

const configPath = process.argv[2] ?? "config/la-pilot-run.json";
const cfg = loadRunConfig(configPath);
guardOrThrow(configPath, cfg.sources_catalog);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(
  "data",
  "raw",
  "los-angeles",
  `roll-${cfg.roll_year}`,
  runId,
);
mkdirSync(outDir, { recursive: true });
const receiptsPath = join(outDir, "receipts.jsonl");
const where = whereClause(cfg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function get(
  params: Record<string, string>,
): Promise<{ url: string; status: number; body: Buffer; retrievedAt: string }> {
  const url = `${cfg.source.query_url}?${new URLSearchParams(params).toString()}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait =
      lastRequestAt + cfg.source.min_request_interval_ms - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const retrievedAt = new Date().toISOString();
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "prism-pipeline-la-pilot/1 (open-data download)",
        },
        signal: AbortSignal.timeout(120_000),
      });
      const body = Buffer.from(await res.arrayBuffer());
      const text = body.toString("utf8");
      const retryable =
        res.status === 429 || res.status >= 500 || text.startsWith('{"error"');
      if (!retryable) return { url, status: res.status, body, retrievedAt };
      console.error(
        `attempt ${attempt}: HTTP ${res.status} ${text.slice(0, 200)}`,
      );
    } catch (err) {
      console.error(`attempt ${attempt}: ${(err as Error).message}`);
    }
    await sleep(cfg.source.min_request_interval_ms * 2 ** attempt);
  }
  throw new Error(`giving up after retries: ${url}`);
}

const countRes = await get({ where, returnCountOnly: "true", f: "json" });
const expected = (
  JSON.parse(countRes.body.toString("utf8")) as { count: number }
).count;
console.log(`expected rows: ${expected}`);

let offset = 0;
let page = 0;
let total = 0;
while (true) {
  const res = await get({
    where,
    outFields: "*",
    returnGeometry: "false",
    orderByFields: "OBJECTID ASC",
    resultOffset: String(offset),
    resultRecordCount: String(cfg.source.page_size),
    f: "json",
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${res.url}`);
  const parsed = JSON.parse(res.body.toString("utf8")) as {
    features?: unknown[];
    exceededTransferLimit?: boolean;
  };
  const n = parsed.features?.length ?? 0;
  const file = `page-${String(page).padStart(4, "0")}.json`;
  writeFileSync(join(outDir, file), res.body);
  const sha256 = createHash("sha256").update(res.body).digest("hex");
  appendFileSync(
    receiptsPath,
    JSON.stringify({
      file,
      request_url: res.url,
      method: "GET",
      retrieved_at: res.retrievedAt,
      http_status: res.status,
      bytes: res.body.length,
      sha256,
      rows: n,
    }) + "\n",
  );
  total += n;
  console.log(`${file}: ${n} rows (total ${total}/${expected})`);
  if (n === 0 || (!parsed.exceededTransferLimit && n < cfg.source.page_size))
    break;
  offset += n;
  page += 1;
}

writeFileSync(
  join(outDir, "fetch-summary.json"),
  JSON.stringify(
    {
      run_id: runId,
      config: configPath,
      where,
      expected_count: expected,
      count_request_url: countRes.url,
      count_retrieved_at: countRes.retrievedAt,
      downloaded_rows: total,
      pages: page + 1,
    },
    null,
    2,
  ) + "\n",
);
if (total !== expected) {
  console.error(
    `row count mismatch: downloaded ${total}, expected ${expected}`,
  );
  process.exit(1);
}
console.log(`done: ${outDir}`);
