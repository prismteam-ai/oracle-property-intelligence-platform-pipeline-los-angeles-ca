/**
 * LA County Assessor Parcel Data Roll 2026 - raw cache download (increment 4 cache).
 * Source/endpoint/fields identical to the increment 1 pilot (src/fetch-slice.ts on feat/la-parcel-slice):
 *   query_url, outFields=*, returnGeometry=false, page size 1000, >= 2000 ms between requests.
 * Differences: whole roll (no ZIP or city filter); OBJECTID keyset ranges instead of offsets.
 *
 * Usage: node fetch-roll.mjs <cache-dir> [--test] [--summary-only]
 *   --test          fetch the count and ONE page (first page, or next missing page), then stop
 *   --summary-only  only (re)build summary.json from the pages on disk
 * Rerun is resumable: manifest pages whose gunzipped sha256 matches are skipped.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const QUERY_URL =
  "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0/query";
const ROLL_YEAR = "2026";
const PAGE_SIZE = 1000;
const MIN_INTERVAL_MS = 2000;
const MAX_RETRIES = 5; // retries after the first attempt
const PREFLIGHT_COUNT = 2428433;
const UA = "prism-pipeline-la-pilot/1 (open-data download)"; // same as pilot
// Any attribute key matching this means personal/owner data: stop.
const FORBIDDEN_KEY =
  /owner|mail|contact|phone|e-?mail|taxpayer|assessee|^name$|_name$|firstname|lastname|fullname/i;
// Field names used for the summary (resolved against the observed keys).
const ID_CANDIDATES = ["AIN", "APN", "ain", "apn"];
const LAT_CANDIDATES = [
  "CENTER_LAT",
  "Center_Lat",
  "CenterLat",
  "LAT",
  "Latitude",
];
const LON_CANDIDATES = [
  "CENTER_LON",
  "Center_Lon",
  "CenterLon",
  "LON",
  "Longitude",
];
const YEARBUILT_CANDIDATES = [
  "YearBuilt1",
  "YearBuilt",
  "Year_Built",
  "EffectiveYear1",
]; // first one present is used

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error(
    "usage: node fetch-roll.mjs <cache-dir> [--test] [--summary-only]",
  );
  process.exit(2);
}
const TEST = args.includes("--test");
const SUMMARY_ONLY = args.includes("--summary-only");
const pagesDir = join(dir, "pages");
const manifestPath = join(dir, "manifest.jsonl");
const logPath = join(dir, "run.log");
mkdirSync(pagesDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(logPath, line + "\n");
}
function die(msg, code = 1) {
  log(`STOP: ${msg}`);
  process.exit(code);
}

let lastRequestAt = 0;
let requestsMade = 0;
let errorsLogged = 0;
async function get(params) {
  const url = `${QUERY_URL}?${new URLSearchParams(params).toString()}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const fetchedAt = new Date().toISOString();
    requestsMade++;
    let why;
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(120_000),
      });
      const body = Buffer.from(await res.arrayBuffer());
      let parsed = null;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        /* handled below */
      }
      if (res.status === 200 && parsed && !parsed.error)
        return { url, status: res.status, body, parsed, fetchedAt };
      why = `HTTP ${res.status} ${body.toString("utf8").slice(0, 200).replace(/\s+/g, " ")}`;
    } catch (err) {
      why = `fetch error: ${err.message}`;
    }
    errorsLogged++;
    log(
      `ERROR attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${why} | ${url.slice(url.indexOf("?"), url.indexOf("?") + 160)}`,
    );
    if (attempt < MAX_RETRIES)
      await sleep(MIN_INTERVAL_MS * 2 ** (attempt + 1)); // 4,8,16,32,64 s
  }
  die(`giving up after ${MAX_RETRIES} retries: ${url}`);
}

const pageFile = (i) => `page-${String(i).padStart(5, "0")}.json.gz`;

function loadVerifiedManifest() {
  if (!existsSync(manifestPath)) return [];
  const lines = readFileSync(manifestPath, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const good = [];
  for (const l of lines) {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      break;
    }
    const f = join(pagesDir, m.file);
    let ok;
    try {
      ok =
        existsSync(f) &&
        sha(gunzipSync(readFileSync(f))) === m.sha256 &&
        m.http_status === 200;
    } catch {
      ok = false;
    }
    if (!ok) {
      log(
        `resume: page ${m.page} (${m.file}) missing or sha256 mismatch; refetching from here`,
      );
      break;
    }
    good.push(m);
  }
  if (good.length !== lines.length) {
    renameSync(manifestPath, `${manifestPath}.bak-${Date.now()}`);
    writeFileSync(
      manifestPath,
      good.map((m) => JSON.stringify(m)).join("\n") + (good.length ? "\n" : ""),
    );
  }
  return good;
}

// Roll_HomeOwnersExemp is a homeowners' exemption dollar amount, not owner identity. It is allowed only
// as a numeric amount (or null); any other value fails (checked per row below).
const ALLOWED_KEY = "Roll_HomeOwnersExemp";
function checkKeys(keys, baseline) {
  const bad = keys.filter((k) => k !== ALLOWED_KEY && FORBIDDEN_KEY.test(k));
  if (bad.length)
    die(
      `owner/name/mailing/contact-like field(s) present in response: ${bad.join(", ")}`,
      3,
    );
  if (baseline) {
    const extra = keys.filter((k) => !baseline.has(k));
    if (extra.length)
      die(`new field(s) appeared vs first page: ${extra.join(", ")}`, 3);
  }
}

async function buildSummary(startedAtMs, expected) {
  const manifest = loadVerifiedManifest();
  let rows = 0,
    withCoords = 0,
    withYear = 0,
    dup = 0;
  const seen = new Set();
  let idF, latF, lonF, ybF;
  for (const m of manifest) {
    const page = JSON.parse(
      gunzipSync(readFileSync(join(pagesDir, m.file))).toString("utf8"),
    );
    if (!idF) {
      const keys = Object.keys(page.features[0].attributes);
      const pick = (c) => c.find((k) => keys.includes(k));
      idF = pick(ID_CANDIDATES);
      latF = pick(LAT_CANDIDATES);
      lonF = pick(LON_CANDIDATES);
      ybF = pick(YEARBUILT_CANDIDATES);
    }
    for (const f of page.features) {
      const a = f.attributes;
      rows++;
      const id = String(a[idF] ?? "");
      if (seen.has(id)) dup++;
      else seen.add(id);
      const lat = Number(a[latF]),
        lon = Number(a[lonF]);
      if (
        a[latF] != null &&
        a[lonF] != null &&
        lat !== 0 &&
        lon !== 0 &&
        Number.isFinite(lat) &&
        Number.isFinite(lon)
      )
        withCoords++;
      const yb = Number(a[ybF]);
      if (a[ybF] != null && Number.isFinite(yb) && yb > 0) withYear++;
    }
  }
  const pct = (n) => (rows ? Math.round((n / rows) * 10000) / 100 : null);
  const summary = {
    generated_at: new Date().toISOString(),
    total_rows: rows,
    preflight_count: PREFLIGHT_COUNT,
    source_count_at_start: expected ?? null,
    diff_vs_preflight: rows - PREFLIGHT_COUNT,
    diff_vs_source_count: expected == null ? null : rows - expected,
    parcel_id_field: idF ?? null,
    duplicate_parcel_ids: dup,
    coordinate_fields: [latF ?? null, lonF ?? null],
    rows_with_coordinates: withCoords,
    rows_with_coordinates_pct: pct(withCoords),
    year_built_field: ybF ?? null,
    rows_with_year_built: withYear,
    rows_with_year_built_pct: pct(withYear),
    pages: manifest.length,
    oid_min: manifest[0]?.oid_min ?? null,
    oid_max: manifest.at(-1)?.oid_max ?? null,
    duration_seconds: startedAtMs
      ? Math.round((Date.now() - startedAtMs) / 1000)
      : null,
    requests_this_invocation: requestsMade,
    errors_logged_this_invocation: errorsLogged,
    complete: expected != null ? rows === expected : null,
  };
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  log(`summary.json written: ${JSON.stringify(summary)}`);
  return summary;
}

async function main() {
  const startedAt = Date.now();
  if (SUMMARY_ONLY) {
    await buildSummary(null, null);
    return;
  }
  const baseWhere = `RollYear = '${ROLL_YEAR}'`;

  const countRes = await get({
    where: baseWhere,
    returnCountOnly: "true",
    f: "json",
  });
  const expected = countRes.parsed.count;
  log(
    `source count for roll ${ROLL_YEAR}: ${expected} (preflight ${PREFLIGHT_COUNT}, diff ${expected - PREFLIGHT_COUNT})`,
  );

  const manifest = loadVerifiedManifest();
  let baseline = null;
  if (manifest.length) {
    const first = JSON.parse(
      gunzipSync(readFileSync(join(pagesDir, manifest[0].file))).toString(
        "utf8",
      ),
    );
    baseline = new Set(Object.keys(first.features[0].attributes));
  }
  let page = manifest.length;
  let lastOid = manifest.length ? manifest.at(-1).oid_max : null;
  let total = manifest.reduce((s, m) => s + m.rows, 0);
  log(
    `resume: ${manifest.length} verified pages, ${total} rows, last OBJECTID ${lastOid}`,
  );
  if (manifest.length && manifest.at(-1).final) {
    log("last manifest page is final; nothing to fetch");
  } else
    while (true) {
      const where =
        lastOid == null ? baseWhere : `${baseWhere} AND OBJECTID > ${lastOid}`;
      const res = await get({
        where,
        outFields: "*",
        returnGeometry: "false",
        orderByFields: "OBJECTID ASC",
        resultRecordCount: String(PAGE_SIZE),
        f: "json",
      });
      const feats = res.parsed.features ?? [];
      const n = feats.length;
      if (n === 0) {
        if (total !== expected)
          die(
            `empty page after OBJECTID ${lastOid} but total ${total} != source count ${expected}`,
          );
        break;
      }
      const keys = Object.keys(feats[0].attributes);
      for (const f of feats)
        if (Object.keys(f.attributes).length !== keys.length)
          die(`inconsistent attributes within page ${page}`);
      if (!baseline) {
        baseline = new Set(keys);
        log(`FIELDS (${keys.length}): ${keys.join(", ")}`);
      }
      checkKeys(keys, baseline);
      for (const f of feats) {
        const v = f.attributes[ALLOWED_KEY];
        if (v != null && typeof v !== "number")
          die(
            `${ALLOWED_KEY} has non-numeric value ${JSON.stringify(v).slice(0, 60)} on page ${page}`,
            3,
          );
      }
      const oids = feats.map((f) => Number(f.attributes.OBJECTID));
      if (
        oids.some(
          (o, i) =>
            !Number.isFinite(o) ||
            (i && o <= oids[i - 1]) ||
            (lastOid != null && o <= lastOid),
        )
      )
        die(`OBJECTIDs not strictly ascending on page ${page}`);
      const file = pageFile(page);
      const tmp = join(pagesDir, file + ".tmp");
      writeFileSync(tmp, gzipSync(res.body, { level: 6 }));
      renameSync(tmp, join(pagesDir, file));
      const isFinal = !res.parsed.exceededTransferLimit && n < PAGE_SIZE;
      const entry = {
        page,
        file,
        oid_min: oids[0],
        oid_max: oids.at(-1),
        rows: n,
        sha256: sha(res.body),
        bytes: res.body.length,
        http_status: res.status,
        fetched_at: res.fetchedAt,
        request_url: res.url,
        ...(isFinal ? { final: true } : {}),
      };
      appendFileSync(manifestPath, JSON.stringify(entry) + "\n");
      total += n;
      lastOid = entry.oid_max;
      page++;
      if (page % 25 === 0 || TEST || isFinal)
        log(
          `page ${entry.page}: ${n} rows, OBJECTID ${entry.oid_min}-${entry.oid_max} (total ${total}/${expected})`,
        );
      if (TEST) {
        log("--test: stopping after one page");
        return;
      }
      if (isFinal) break;
    }
  const summary = await buildSummary(startedAt, expected);
  if (!summary.complete)
    die(
      `row count mismatch: downloaded ${summary.total_rows}, source count ${expected}`,
    );
  log("DONE");
}

main().catch((e) => die(`unhandled: ${e.stack || e}`));
