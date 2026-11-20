import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CONTRACTOR_FIELDS } from "../src/permit-fields.ts";
import { stageContractors } from "../src/stage-contractors.ts";
import {
  contractorRow,
  makeContractorCache,
  resourceUrl,
  rewritePage,
} from "./fixtures/ladbs-cache.ts";

let dir: string;
let out: string;
let fx: ReturnType<typeof makeContractorCache>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "contractor-cache-"));
  out = join(dir, "staged.ndjson");
  fx = makeContractorCache(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("stages each distinct row once, counting exact duplicates", async () => {
  const r = await stageContractors(dir, out);
  expect(r).toMatchObject({
    rows: 4,
    staged: 3,
    duplicates: 1,
    distinctPermits: 2,
    licenseEvidence: {
      page_url:
        "https://data.lacity.org/A-Prosperous-City/roofing-permits/8guu-8f5m",
      retrieved_at: "2026-11-12T13:19:00Z",
      basis: null,
    },
  });
  const rows = readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(rows.map((x) => x.license_type)).toEqual(["C39", "B", "C10"]);
  for (const row of rows)
    expect(Object.keys(row).sort()).toEqual(
      [
        ...CONTRACTOR_FIELDS,
        "_dataset",
        "_page_file",
        "_request_url",
        "_retrieved_at",
        "_page_sha256",
      ].sort(),
    );
  expect(rows[2]).toMatchObject({
    _dataset: "8guu-8f5m",
    _page_file: "pages/8guu-8f5m_p001.json.gz",
  });
});

test("the 12 Nov cache's earlier key licence_evidence is read the same", async () => {
  const e = fx.manifest.license_evidence!;
  fx.manifest.license_evidence = undefined;
  Object.assign(fx.manifest, { licence_evidence: e });
  fx.write();
  await expect(stageContractors(dir, out)).resolves.toMatchObject({
    licenseEvidence: { retrieved_at: "2026-11-12T13:19:00Z", basis: null },
  });
});

test("a row that differs in any field is not a duplicate", async () => {
  rewritePage(dir, fx.manifest.pages[0]!, [
    contractorRow("10000-10000-00001"),
    contractorRow("10000-10000-00001", { contractor_city: "BURBANK" }),
    contractorRow("10000-10000-00002", { license_type: "B" }),
  ]);
  fx.write();
  await expect(stageContractors(dir, out)).resolves.toMatchObject({
    staged: 4,
    duplicates: 0,
  });
});

const breaks: Array<[string, (f: typeof fx) => void, RegExp]> = [
  [
    "status",
    (f) => void (f.manifest.status = "partial"),
    /status is "partial"/,
  ],
  ["view", (f) => void (f.summary.view = "xxxx-0000"), /not view 8guu-8f5m/],
  [
    "allowed columns",
    (f) => void f.manifest.allowed_columns.push("contact_phone"),
    /columns are not CONTRACTOR_FIELDS/,
  ],
  [
    "columns_checked",
    (f) => void (f.manifest.pages[1]!.columns_checked = false),
    /columns not checked/,
  ],
  [
    "selected columns",
    (f) => {
      const p = f.manifest.pages[0]!;
      p.query = p.query.replace("SELECT ", "SELECT applicant_name, ");
      p.url = resourceUrl("8guu-8f5m", p.query);
    },
    /does not select CONTRACTOR_FIELDS/,
  ],
  [
    "gzip sha256",
    (f) => void (f.manifest.pages[1]!.sha256_gz = "0".repeat(64)),
    /gzip sha256 or size mismatch/,
  ],
  [
    "expected rows",
    (f) => void (f.manifest.count.expected_rows = 5),
    /4 page rows, expected 5/,
  ],
  ["summary rows", (f) => void (f.summary.rows = 3), /summary 3/],
  [
    "distinct permits",
    (f) => void (f.summary.distinct_permits = 3),
    /summary.json says 3 permits/,
  ],
  [
    "extra rows",
    (f) => void (f.summary.duplicate_rows = 1),
    /and 1 extra rows/,
  ],
  [
    "license evidence time",
    (f) => void (f.manifest.license_evidence!.retrieved_at = "12 Nov 2026"),
    /license_evidence needs page_url and retrieved_at/,
  ],
  [
    "license evidence",
    (f) => void (f.manifest.license_evidence = undefined),
    /license_evidence needs page_url and retrieved_at/,
  ],
  [
    "count query",
    (f) =>
      void (f.manifest.count.query = "SELECT count(*) AS n WHERE x IS NULL"),
    /not an unfiltered count/,
  ],
];

test.each(breaks)("fails on a %s mismatch", async (_n, breakIt, msg) => {
  breakIt(fx);
  fx.write();
  await expect(stageContractors(dir, out)).rejects.toThrow(msg);
});
