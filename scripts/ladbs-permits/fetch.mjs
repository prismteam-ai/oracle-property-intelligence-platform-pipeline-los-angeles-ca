// LADBS roof-permit raw cache fetcher (data.lacity.org Socrata SoQL, no token).
// Usage: node fetch.mjs <cache-dir>            -> fetch pages + manifest into <cache-dir>
//        node fetch.mjs summarize <cache-dir>  -> summary.json + roofing_flagged.jsonl.gz from the cached pages
// The cache folder is required and must not exist yet: a fetch never writes into an existing folder, so a
// recorded run's cache is never overwritten. Nothing is written beside this script.
// Rules: 1 s between requests, 120 s timeout per request, up to 2 retries per request, stop on any
// error after that. Every row's columns are checked against COLS before a page is written.
//
// work_desc: this script downloads the permits' work description (work_desc). It is free text and
// can contain people's names. It is used only to flag roofing work: the ROOF filter of the queries
// and the roof_r / roof_only flags below. The pipeline reads it only to set its own roofing flags
// and never serves it.
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODE = process.argv[2] === "summarize" ? "summarize" : "fetch";
const DIR_ARG = MODE === "summarize" ? process.argv[3] : process.argv[2];
if (!DIR_ARG) {
  console.error(
    "usage: node fetch.mjs <cache-dir> | node fetch.mjs summarize <cache-dir>",
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
// A fetch creates its cache folder itself and refuses one that exists (empty or not): the parent folder is
// created if needed, then mkdirSync without recursive fails on an existing folder, before any request.
function newCacheFolder() {
  if (existsSync(ROOT)) {
    console.error(
      `refusing: the cache folder ${ROOT} exists; a fetch writes only into a new folder`,
    );
    process.exit(2);
  }
  mkdirSync(dirname(ROOT), { recursive: true });
  mkdirSync(ROOT);
  mkdirSync(PAGES);
}
const BASE = "https://data.lacity.org/resource";
const UA = "oracle-la-pipeline-fetch";
const LIMIT = 50000;
const TIMEOUT_MS = 120_000;
const COLS = [
  "permit_nbr",
  "apn",
  "pin_nbr",
  "primary_address",
  "zip_code",
  "lat",
  "lon",
  "type_lat_lon",
  "permit_type",
  "permit_sub_type",
  "use_code",
  "use_desc",
  "business_unit",
  "work_desc",
  "submitted_date",
  "issue_date",
  "status_desc",
  "status_date",
  "cofo_date",
  "valuation",
  "square_footage",
  "construction",
  "solar",
  "refresh_time",
];
const ROOF = "upper(work_desc) LIKE '%ROOF%'";
const SETS = [
  { id: "pi9x-tg5x", kind: "issued", where: ROOF },
  { id: "dyxf-7hc4", kind: "issued", where: ROOF },
  { id: "e67z-kt2n", kind: "issued", where: ROOF },
  {
    id: "gwh9-jnip",
    kind: "submitted",
    where: `${ROOF} AND issue_date IS NULL`,
  },
  {
    id: "n3xg-rixm",
    kind: "submitted",
    where: `${ROOF} AND issue_date IS NULL`,
  },
  {
    id: "b6ii-mhed",
    kind: "submitted",
    where: `${ROOF} AND issue_date IS NULL`,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReq = 0;
async function soql(id, query) {
  const url = `${BASE}/${id}.json?${new URLSearchParams({ $query: query })}`;
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
      console.error(`  attempt ${attempt + 1} failed for ${id}: ${e.message}`);
      if (attempt < 2) await sleep(2000 * (attempt + 1));
    }
  }
  throw new Error(`giving up on ${id} after 2 retries: ${lastErr.message}`);
}

// Socrata leaves out null fields, so a row may have fewer keys than COLS, never others.
function checkColumns(rows, where) {
  const bad = new Set();
  for (const r of rows)
    for (const k of Object.keys(r)) if (!COLS.includes(k)) bad.add(k);
  if (bad.size)
    throw new Error(`unexpected column(s) in ${where}: ${[...bad].join(", ")}`);
}

async function fetchAll() {
  newCacheFolder();
  const manifest = {
    source: "data.lacity.org",
    startedAt: new Date().toISOString(),
    token: false,
    pages: [],
    counts: [],
  };
  const save = () =>
    writeFileSync(
      join(ROOT, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  try {
    for (const s of SETS) {
      const cq = `SELECT count(*) AS n WHERE ${s.where}`;
      const c = await soql(s.id, cq);
      const expected = Number(JSON.parse(c.body)[0].n);
      manifest.counts.push({
        dataset: s.id,
        kind: s.kind,
        query: cq,
        expected_rows: expected,
        retrieved_at: c.retrievedAt,
      });
      console.log(`${s.id}: expecting ${expected}`);
      let got = 0;
      for (let page = 0; ; page++) {
        const q = `SELECT ${COLS.join(", ")} WHERE ${s.where} ORDER BY permit_nbr, :id LIMIT ${LIMIT} OFFSET ${page * LIMIT}`;
        const r = await soql(s.id, q);
        const rows = JSON.parse(r.body);
        if (!Array.isArray(rows))
          throw new Error(`non-array response from ${s.id}`);
        if (rows.length === 0) break;
        checkColumns(rows, `${s.id} page ${page}`); // before anything is written
        const gz = gzipSync(Buffer.from(r.body));
        const file = `${s.id}_p${String(page).padStart(3, "0")}.json.gz`;
        writeFileSync(join(PAGES, file), gz);
        manifest.pages.push({
          dataset: s.id,
          kind: s.kind,
          page,
          file,
          url: r.url,
          query: q,
          row_count: rows.length,
          retrieved_at: r.retrievedAt,
          attempts: r.attempts,
          sha256_json: createHash("sha256").update(r.body).digest("hex"),
          sha256_gz: createHash("sha256").update(gz).digest("hex"),
          bytes_json: Buffer.byteLength(r.body),
          bytes_gz: gz.length,
          columns_checked: true,
        });
        save();
        got += rows.length;
        console.log(`  ${file}: ${rows.length} rows (total ${got})`);
        if (rows.length < LIMIT) break;
      }
      manifest.counts.at(-1).fetched_rows = got;
      if (got !== expected)
        throw new Error(`${s.id}: fetched ${got} != expected ${expected}`);
    }
    manifest.finishedAt = new Date().toISOString();
    manifest.status = "complete";
  } catch (e) {
    manifest.status = "stopped";
    manifest.error = e.message;
    save();
    console.error(`STOPPED: ${e.message}`);
    process.exit(1);
  }
  save();
}

// ---- flags (computed after download, not used as filters) ----
// roof_r and roof_only are the first probe's flags, kept as they were when this cache was made.
// They are not the pipeline's roofing rule: the pipeline computes its own flags from the pages
// (src/roof-flags.ts) and never reads roofing_flagged.jsonl.gz.
const R_PATTERNS = [
  "RE-ROOF",
  "REROOF",
  "RE ROOF",
  "ROOF COVER",
  "ROOFING",
  "ROOF TILE",
  "COATING TO AN EXISTING ROOF",
];
const roofR = (d) => R_PATTERNS.some((p) => d.includes(p));
// RE-ROOF boilerplate = the two standard Express/e-Permit texts seen in the probe.
const boiler = (d) =>
  d.startsWith("RE-ROOF WITH CLASS A OR B") ||
  /^REROOF WITH \d+(\.\d+)? SQRS/.test(d);
const roofOnly = (row, d) =>
  row.business_unit === "Express Permit" || boiler(d);

function summarize() {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "manifest.json"), "utf8"),
  );
  if (manifest.status !== "complete")
    throw new Error("manifest not complete; refusing to summarize");
  const perSet = {};
  const seen = new Map();
  const status = {};
  const out = [];
  const apn = { present_10digit: 0, masked: 0, null_or_empty: 0, other: 0 };
  const flags = {
    roof_r: 0,
    roof_only: 0,
    roof_only_not_r: 0,
    roof_r_not_only: 0,
    neither: 0,
  };
  for (const p of manifest.pages) {
    const buf = readFileSync(join(PAGES, p.file));
    if (createHash("sha256").update(buf).digest("hex") !== p.sha256_gz)
      throw new Error(`sha mismatch ${p.file}`);
    const rows = JSON.parse(gunzipSync(buf).toString());
    perSet[p.dataset] ??= { kind: p.kind, rows: 0 };
    perSet[p.dataset].rows += rows.length;
    for (const row of rows) {
      seen.set(row.permit_nbr, [
        ...(seen.get(row.permit_nbr) ?? []),
        p.dataset,
      ]);
      const a = row.apn;
      if (!a || !a.trim()) apn.null_or_empty++;
      else if (a.includes("*")) apn.masked++;
      else if (/^\d{10}$/.test(a)) apn.present_10digit++;
      else apn.other++;
      status[row.status_desc ?? "(null)"] =
        (status[row.status_desc ?? "(null)"] ?? 0) + 1;
      const d = (row.work_desc ?? "").toUpperCase();
      const r = roofR(d);
      const o = roofOnly(row, d);
      if (r) flags.roof_r++;
      if (o) flags.roof_only++;
      if (o && !r) flags.roof_only_not_r++;
      if (r && !o) flags.roof_r_not_only++;
      if (!r && !o) flags.neither++;
      out.push(
        JSON.stringify({
          ...row,
          source_dataset: p.dataset,
          retrieved_at: p.retrieved_at,
          roof_r: r,
          roof_only: o,
        }),
      );
    }
  }
  const dups = [...seen.entries()].filter(([, v]) => v.length > 1);
  const dupPairs = {};
  for (const [, v] of dups) {
    const k = v.join("+");
    dupPairs[k] = (dupPairs[k] ?? 0) + 1;
  }
  const totalRows = Object.values(perSet).reduce((s, x) => s + x.rows, 0);
  const summary = {
    generated_at: new Date().toISOString(),
    filter: ROOF + " (submitted sets: AND issue_date IS NULL)",
    rows_per_set: perSet,
    total_rows: totalRows,
    distinct_permit_nbr: seen.size,
    duplicate_permit_nbrs: dups.length,
    duplicate_set_combinations: dupPairs,
    apn,
    status_counts: Object.fromEntries(
      Object.entries(status).sort((a, b) => b[1] - a[1]),
    ),
    flags,
    flag_note:
      "roof_r and roof_only are the first probe's flags, not the pipeline's roofing rule",
    flag_definitions: {
      roof_r: `upper(work_desc) contains any of ${JSON.stringify(R_PATTERNS)}`,
      roof_only:
        "business_unit = 'Express Permit' OR upper(work_desc) starts with 'RE-ROOF WITH CLASS A OR B' OR matches /^REROOF WITH <n> SQRS/",
    },
  };
  writeFileSync(join(ROOT, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(ROOT, "roofing_flagged.jsonl.gz"),
    gzipSync(Buffer.from(out.join("\n") + "\n")),
  );
  console.log(JSON.stringify(summary, null, 2));
}

if (MODE === "summarize") summarize();
else await fetchAll();
