// LADBS contractor fields for roofing permits, from public view 8guu-8f5m on data.lacity.org (no token).
// Usage: node fetch.mjs <cache-dir>                                  -> fetch pages + manifest into <cache-dir>
//        node fetch.mjs summarize <cache-dir> <permit-cache-dir>     -> summary.json in <cache-dir>
// The cache folder is required, and summarize also requires the permit cache folder (the one holding
// the permit script's roofing_flagged.jsonl.gz); nothing is written beside this script.
// Guard rules: only the ALLOWED columns may be requested or stored; every row of every page is checked
// and the run stops if any other column appears. 1 s between requests, 120 s timeout per request,
// up to 2 retries, then stop.
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODE = process.argv[2] === "summarize" ? "summarize" : "fetch";
const [DIR_ARG, PERMIT_DIR_ARG] =
  MODE === "summarize" ? process.argv.slice(3) : process.argv.slice(2);
if (!DIR_ARG || (MODE === "summarize" && !PERMIT_DIR_ARG)) {
  console.error(
    "usage: node fetch.mjs <cache-dir> | node fetch.mjs summarize <cache-dir> <permit-cache-dir>",
  );
  process.exit(2);
}
const ROOT = resolve(DIR_ARG);
if (ROOT === dirname(fileURLToPath(import.meta.url))) {
  console.error(
    "refusing: the cache folder must not be the script's own folder",
  );
  process.exit(2);
}
const PAGES = join(ROOT, "pages");
const VIEW = "8guu-8f5m";
const HOST = "https://data.lacity.org";
const UA = "oracle-la-pipeline-fetch";
const LIMIT = 50000;
const TIMEOUT_MS = 120_000;
const ALLOWED = [
  "pcis_permit",
  "contractors_business_name",
  "license",
  "license_type",
  "license_expiration_date",
  "contractor_city",
  "contractor_state",
  "issue_date",
];
const PERMIT_FLAGGED = "roofing_flagged.jsonl.gz"; // written by the permit script's summarize

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
let lastReq = 0;
async function get(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    // 1 try + 2 retries
    const wait = lastReq + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      return {
        url,
        body,
        retrievedAt: new Date().toISOString(),
        attempts: attempt + 1,
      };
    } catch (e) {
      lastErr = e;
      console.error(`  attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt < 2) await sleep(2000 * (attempt + 1));
    }
  }
  throw new Error(`giving up after 2 retries: ${lastErr.message}`);
}
const soqlUrl = (q) =>
  `${HOST}/resource/${VIEW}.json?${new URLSearchParams({ $query: q })}`;

function checkColumns(rows, where) {
  const bad = new Set();
  for (const r of rows)
    for (const k of Object.keys(r)) if (!ALLOWED.includes(k)) bad.add(k);
  if (bad.size)
    throw new Error(`unexpected column(s) in ${where}: ${[...bad].join(", ")}`);
}

async function fetchAll() {
  mkdirSync(PAGES, { recursive: true });
  const manifest = {
    source: HOST,
    view: VIEW,
    view_name: "roofing permits",
    parent_dataset: "yv23-pmwf (login required; not accessed)",
    license_stated: {
      name: "Creative Commons Attribution 4.0 International",
      id: "CC_40_BY",
      attribution: "LADBS",
      attribution_link: "https://creativecommons.org/licenses/by/4.0/",
      terms_link: "http://creativecommons.org/licenses/by/4.0/legalcode",
    },
    allowed_columns: ALLOWED,
    token: false,
    startedAt: new Date().toISOString(),
    pages: [],
  };
  const save = () =>
    writeFileSync(
      join(ROOT, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  try {
    // License evidence: the view page as read earlier (the view metadata endpoint is not called here,
    // because it can carry cached column values, including restricted columns).
    manifest.license_evidence = {
      page_url:
        "https://data.lacity.org/A-Prosperous-City/roofing-permits/8guu-8f5m",
      retrieved_at: "2026-11-12T13:19:00Z",
    };

    const cq = "SELECT count(*) AS n";
    const c = await get(soqlUrl(cq));
    const expected = Number(JSON.parse(c.body)[0].n);
    manifest.count = {
      query: cq,
      expected_rows: expected,
      retrieved_at: c.retrievedAt,
    };
    console.log(`${VIEW}: expecting ${expected}`);
    let got = 0;
    for (let page = 0; ; page++) {
      const q = `SELECT ${ALLOWED.join(", ")} ORDER BY pcis_permit, :id LIMIT ${LIMIT} OFFSET ${page * LIMIT}`;
      const r = await get(soqlUrl(q));
      const rows = JSON.parse(r.body);
      if (!Array.isArray(rows)) throw new Error("non-array response");
      if (rows.length === 0) break;
      checkColumns(rows, `page ${page}`); // before anything is written
      const gz = gzipSync(Buffer.from(r.body));
      const file = `${VIEW}_p${String(page).padStart(3, "0")}.json.gz`;
      writeFileSync(join(PAGES, file), gz);
      manifest.pages.push({
        page,
        file,
        url: r.url,
        query: q,
        row_count: rows.length,
        retrieved_at: r.retrievedAt,
        attempts: r.attempts,
        sha256_json: sha(r.body),
        sha256_gz: sha(gz),
        bytes_json: Buffer.byteLength(r.body),
        bytes_gz: gz.length,
        columns_checked: true,
      });
      save();
      got += rows.length;
      console.log(`  ${file}: ${rows.length} rows (total ${got})`);
      if (rows.length < LIMIT) break;
    }
    manifest.count.fetched_rows = got;
    if (got !== expected)
      throw new Error(`fetched ${got} != expected ${expected}`);
    manifest.finishedAt = new Date().toISOString();
    manifest.status = "complete";
    manifest.fetch_script_sha256 = sha(
      readFileSync(fileURLToPath(import.meta.url)),
    );
  } catch (e) {
    manifest.status = "stopped";
    manifest.error = e.message;
    save();
    console.error(`STOPPED: ${e.message}`);
    process.exit(1);
  }
  save();
}

function summarize() {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "manifest.json"), "utf8"),
  );
  if (manifest.status !== "complete")
    throw new Error("manifest not complete; refusing to summarize");
  // roof_r is the permit script's first-probe flag, not the pipeline's roofing rule.
  const permits = new Map(); // permit_nbr -> roof_r
  for (const line of gunzipSync(
    readFileSync(join(resolve(PERMIT_DIR_ARG), PERMIT_FLAGGED)),
  )
    .toString()
    .split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    permits.set(r.permit_nbr, r.roof_r);
  }
  let rows = 0;
  const distinct = new Set();
  const cls = {};
  for (const p of manifest.pages) {
    const buf = readFileSync(join(PAGES, p.file));
    if (sha(buf) !== p.sha256_gz) throw new Error(`sha mismatch ${p.file}`);
    const data = JSON.parse(gunzipSync(buf).toString());
    checkColumns(data, p.file);
    for (const r of data) {
      rows++;
      distinct.add(r.pcis_permit);
      const k = r.license_type ?? "(null)";
      cls[k] = (cls[k] ?? 0) + 1;
    }
  }
  let j = 0,
    jr = 0,
    rowsJoined = 0,
    rowsJoinedR = 0;
  for (const id of distinct)
    if (permits.has(id)) {
      j++;
      if (permits.get(id)) jr++;
    }
  for (const p of manifest.pages) {
    for (const r of JSON.parse(
      gunzipSync(readFileSync(join(PAGES, p.file))).toString(),
    )) {
      if (permits.has(r.pcis_permit)) {
        rowsJoined++;
        if (permits.get(r.pcis_permit)) rowsJoinedR++;
      }
    }
  }
  const summary = {
    generated_at: new Date().toISOString(),
    view: VIEW,
    license: "CC BY 4.0, attribution LADBS",
    rows,
    distinct_permits: distinct.size,
    duplicate_rows: rows - distinct.size,
    license_class_counts: Object.fromEntries(
      Object.entries(cls).sort((a, b) => b[1] - a[1]),
    ),
    join_to_ladbs_permits: {
      permit_cache: PERMIT_FLAGGED,
      permit_cache_rows: permits.size,
      distinct_permits_joined: j,
      distinct_permits_joined_roof_r: jr,
      distinct_permits_not_joined: distinct.size - j,
      rows_joined: rowsJoined,
      rows_joined_roof_r: rowsJoinedR,
    },
  };
  writeFileSync(join(ROOT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (MODE === "summarize") summarize();
else await fetchAll();
