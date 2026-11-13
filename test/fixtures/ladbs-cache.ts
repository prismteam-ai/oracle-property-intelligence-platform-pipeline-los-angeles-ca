/**
 * Synthetic LADBS caches in the layout of the two data.lacity.org fetch scripts (manifest.json,
 * summary.json, fetch.mjs, pages/<dataset>_pNNN.json.gz), written at test setup. No real rows.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CONTRACTOR_FIELDS } from "../../src/permit-fields.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PERMIT_SELECT =
  "permit_nbr, apn, pin_nbr, primary_address, zip_code, lat, lon, permit_type, permit_sub_type, business_unit, work_desc, submitted_date, issue_date, status_desc, status_date, valuation";
const FILTER = "upper(work_desc) LIKE '%ROOF%'";

export const resourceUrl = (dataset: string, query: string) =>
  `https://data.lacity.org/resource/${dataset}.json?${new URLSearchParams({ $query: query }).toString()}`;

function page(
  dir: string,
  dataset: string,
  i: number,
  rows: object[],
  query: string,
) {
  const body = Buffer.from(JSON.stringify(rows));
  const gz = gzipSync(body);
  const file = `${dataset}_p${String(i).padStart(3, "0")}.json.gz`;
  writeFileSync(join(dir, "pages", file), gz);
  return {
    page: i,
    file,
    url: resourceUrl(dataset, query),
    query,
    row_count: rows.length,
    retrieved_at: `2026-11-12T13:1${i}:00.000Z`,
    attempts: 1,
    sha256_json: sha(body),
    sha256_gz: sha(gz),
    bytes_json: body.length,
    bytes_gz: gz.length,
  };
}

/** Replace a page's rows on disk and update its digests and sizes in the manifest entry. */
export function rewritePage(
  dir: string,
  p: {
    file: string;
    sha256_json: string;
    sha256_gz: string;
    bytes_json: number;
    bytes_gz: number;
  },
  rows: object[],
) {
  const body = Buffer.from(JSON.stringify(rows));
  const gz = gzipSync(body);
  writeFileSync(join(dir, "pages", p.file), gz);
  Object.assign(p, {
    sha256_json: sha(body),
    sha256_gz: sha(gz),
    bytes_json: body.length,
    bytes_gz: gz.length,
  });
}

export function permitRow(nbr: string, extra: object = {}) {
  return {
    permit_nbr: nbr,
    apn: "5551234001",
    pin_nbr: "PIN",
    primary_address: "100 W FIXTURE ST",
    zip_code: "90001",
    lat: "34.0",
    lon: "-118.2",
    permit_type: "Bldg-Alter/Repair",
    permit_sub_type: "1 or 2 Family Dwelling",
    business_unit: "Express Permit",
    work_desc: "REROOF FIXTURE",
    issue_date: "2020-01-02T00:00:00.000",
    status_desc: "Permit Finaled",
    status_date: "2020-03-04T00:00:00.000",
    valuation: "1000",
    ...extra,
  };
}

/**
 * A permit cache: dataset "aaaa-1111" (issued) on two pages of LIMIT 2 (3 rows) and "bbbb-2222"
 * (submitted) on one page. Returns the parts so tests can break one and rewrite the JSON files.
 */
export function makePermitCache(dir: string) {
  mkdirSync(join(dir, "pages"), { recursive: true });
  const q = (where: string, offset: number) =>
    `SELECT ${PERMIT_SELECT} WHERE ${where} ORDER BY permit_nbr LIMIT 2 OFFSET ${offset}`;
  const sub = `${FILTER} AND issue_date IS NULL`;
  const issued = [
    page(
      dir,
      "aaaa-1111",
      0,
      [permitRow("10000-10000-00001"), permitRow("10000-10000-00002")],
      q(FILTER, 0),
    ),
    page(dir, "aaaa-1111", 1, [permitRow("10000-10000-00003")], q(FILTER, 2)),
  ].map((p) => ({ dataset: "aaaa-1111", kind: "issued", ...p }));
  const submitted = [
    page(
      dir,
      "bbbb-2222",
      0,
      [
        permitRow("20000-20000-00001", {
          issue_date: undefined,
          submitted_date: "2025-05-06T00:00:00.000",
          status_desc: "PC Approved",
        }),
      ],
      q(sub, 0),
    ),
  ].map((p) => ({ dataset: "bbbb-2222", kind: "submitted", ...p }));
  const manifest = {
    source: "data.lacity.org",
    startedAt: "2026-11-12T13:10:00.000Z",
    token: false,
    pages: [...issued, ...submitted],
    counts: [
      {
        dataset: "aaaa-1111",
        kind: "issued",
        query: `SELECT count(*) AS n WHERE ${FILTER}`,
        expected_rows: 3,
        retrieved_at: "2026-11-12T13:10:01.000Z",
        fetched_rows: 3,
      },
      {
        dataset: "bbbb-2222",
        kind: "submitted",
        query: `SELECT count(*) AS n WHERE ${sub}`,
        expected_rows: 1,
        retrieved_at: "2026-11-12T13:10:02.000Z",
        fetched_rows: 1,
      },
    ],
    finishedAt: "2026-11-12T13:14:00.000Z",
    status: "complete",
  };
  const summary = {
    generated_at: "2026-11-12T13:14:56.570Z",
    rows_per_set: {
      "aaaa-1111": { kind: "issued", rows: 3 },
      "bbbb-2222": { kind: "submitted", rows: 1 },
    },
    total_rows: 4,
    distinct_permit_nbr: 4,
  };
  const write = () => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
  };
  writeFileSync(join(dir, "fetch.mjs"), "// fixture\n");
  write();
  return { manifest, summary, write };
}

export function contractorRow(nbr: string, extra: object = {}) {
  return {
    pcis_permit: nbr,
    contractors_business_name: "FIXTURE ROOFING CO",
    license: "123456",
    license_type: "C39",
    license_expiration_date: "2027-01-31T00:00:00.000",
    contractor_city: "LOS ANGELES",
    contractor_state: "CA",
    issue_date: "2020-01-02T00:00:00.000",
    ...extra,
  };
}

/**
 * A contractor cache (view 8guu-8f5m) on two pages of LIMIT 3: four rows, one an exact duplicate
 * of another, and one more row for an already-seen permit (2 extra rows by the summary's count).
 */
export function makeContractorCache(dir: string) {
  mkdirSync(join(dir, "pages"), { recursive: true });
  const view = "8guu-8f5m";
  const q = (offset: number) =>
    `SELECT ${CONTRACTOR_FIELDS.join(", ")} ORDER BY pcis_permit, :id LIMIT 3 OFFSET ${offset}`;
  const pages = [
    page(
      dir,
      view,
      0,
      [
        contractorRow("10000-10000-00001"),
        contractorRow("10000-10000-00001"),
        contractorRow("10000-10000-00002", { license_type: "B" }),
      ],
      q(0),
    ),
    page(
      dir,
      view,
      1,
      [contractorRow("10000-10000-00002", { license_type: "C10" })],
      q(3),
    ),
  ].map((p) => ({ ...p, columns_checked: true }));
  const manifest = {
    source: "https://data.lacity.org",
    view,
    allowed_columns: [...CONTRACTOR_FIELDS] as string[],
    token: false,
    pages,
    count: {
      query: "SELECT count(*) AS n",
      expected_rows: 4,
      retrieved_at: "2026-11-12T14:00:37.000Z",
      fetched_rows: 4,
    },
    status: "complete",
  };
  const summary = {
    generated_at: "2026-11-12T14:00:51.383Z",
    view,
    rows: 4,
    distinct_permits: 2,
    duplicate_rows: 2,
  };
  const write = () => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
  };
  writeFileSync(join(dir, "fetch.mjs"), "// fixture\n");
  write();
  return { manifest, summary, write };
}
