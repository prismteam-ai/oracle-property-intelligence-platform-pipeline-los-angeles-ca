import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { PERMIT_FIELDS } from "../src/permit-fields.ts";
import { stagePermits } from "../src/stage-permits.ts";
import {
  makePermitCache,
  permitRow,
  resourceUrl,
  rewritePage,
} from "./fixtures/ladbs-cache.ts";

let dir: string;
let out: string;
let fx: ReturnType<typeof makePermitCache>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "permit-cache-"));
  out = join(dir, "staged.ndjson");
  fx = makePermitCache(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const staged = () =>
  readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("stages every row with PERMIT_FIELDS and provenance only", async () => {
  const r = await stagePermits(dir, out);
  expect(r.rows).toBe(4);
  expect(r.rowsByDataset).toEqual({ "aaaa-1111": 3, "bbbb-2222": 1 });
  expect(r.files.map((f) => f.path)).toEqual([
    "manifest.json",
    "summary.json",
    "fetch.mjs",
  ]);
  const rows = staged();
  expect(rows).toHaveLength(4);
  for (const row of rows)
    expect(Object.keys(row).sort()).toEqual(
      [
        ...PERMIT_FIELDS,
        "_dataset",
        "_dataset_kind",
        "_page_file",
        "_request_url",
        "_retrieved_at",
        "_page_sha256",
      ].sort(),
    );
  const sub = rows.find((x) => x._dataset === "bbbb-2222")!;
  expect(sub).toMatchObject({
    _dataset_kind: "submitted",
    _page_file: "pages/bbbb-2222_p000.json.gz",
    issue_date: null,
    submitted_date: "2025-05-06T00:00:00.000",
  });
  expect(sub._page_sha256).toBe(fx.manifest.pages[2]!.sha256_json);
});

test("the derived roofing_flagged file is never read", async () => {
  writeFileSync(join(dir, "roofing_flagged.jsonl.gz"), "not gzip");
  await expect(stagePermits(dir, out)).resolves.toMatchObject({ rows: 4 });
  expect(readFileSync("src/stage-permits.ts", "utf8")).not.toMatch(
    /roofing_flagged\.jsonl/,
  );
});

const breaks: Array<[string, (f: typeof fx) => void, RegExp]> = [
  [
    "status",
    (f) => void (f.manifest.status = "partial"),
    /status is "partial"/,
  ],
  [
    "gzip sha256",
    (f) => void (f.manifest.pages[0]!.sha256_gz = "0".repeat(64)),
    /gzip sha256 or size mismatch/,
  ],
  [
    "JSON sha256",
    (f) => void (f.manifest.pages[1]!.sha256_json = "0".repeat(64)),
    /JSON sha256 or size mismatch/,
  ],
  [
    "page row count",
    (f) => {
      f.manifest.pages[1]!.row_count = 2;
      f.manifest.counts[0]!.expected_rows = 4;
      f.manifest.counts[0]!.fetched_rows = 4;
      f.summary.rows_per_set["aaaa-1111"]!.rows = 4;
    },
    /breaks the paging|row count mismatch/,
  ],
  [
    "request URL",
    (f) =>
      void (f.manifest.pages[0]!.url = resourceUrl("aaaa-1111", "SELECT *")),
    /request URL query differs/,
  ],
  [
    "submitted filter",
    (f) => {
      const p = f.manifest.pages[2]!;
      p.query = p.query.replace(" AND issue_date IS NULL", "");
      p.url = resourceUrl("bbbb-2222", p.query);
    },
    /query WHERE is not the cache filter/,
  ],
  [
    "count query",
    (f) => void (f.manifest.counts[1]!.query = "SELECT count(*) AS n"),
    /count query WHERE/,
  ],
  [
    "expected vs fetched",
    (f) => void (f.manifest.counts[0]!.fetched_rows = 2),
    /3 page rows, expected 3, fetched 2/,
  ],
  [
    "summary per set",
    (f) => void (f.summary.rows_per_set["bbbb-2222"]!.rows = 9),
    /summary 9/,
  ],
  [
    "summary total",
    (f) => void (f.summary.total_rows = 5),
    /totals do not match summary.json/,
  ],
  [
    "paging offset",
    (f) => {
      const p = f.manifest.pages[1]!;
      p.query = p.query.replace("OFFSET 2", "OFFSET 3");
      p.url = resourceUrl("aaaa-1111", p.query);
    },
    /LIMIT\/OFFSET do not follow page 1/,
  ],
  [
    "selected fields",
    (f) => {
      const p = f.manifest.pages[0]!;
      p.query = p.query.replace("work_desc, ", "");
      p.url = resourceUrl("aaaa-1111", p.query);
    },
    /does not select work_desc/,
  ],
  [
    "dataset sets",
    (f) => void (f.manifest.counts = f.manifest.counts.slice(0, 1)),
    /datasets differ/,
  ],
  [
    "file name",
    (f) => void (f.manifest.pages[0]!.file = "../aaaa-1111_p000.json.gz"),
    /not the file name/,
  ],
];

test.each(breaks)("fails on a %s mismatch", async (_n, breakIt, msg) => {
  breakIt(fx);
  fx.write();
  await expect(stagePermits(dir, out)).rejects.toThrow(msg);
});

/** Page every dataset (or only the pages `which` picks) by "permit_nbr, :id", as the committed fetch script does. */
const reorder = (
  f: ReturnType<typeof makePermitCache>,
  which: (p: { dataset: string; page: number }) => boolean = () => true,
) => {
  for (const p of f.manifest.pages.filter(which)) {
    p.query = p.query.replace(
      " ORDER BY permit_nbr LIMIT ",
      " ORDER BY permit_nbr, :id LIMIT ",
    );
    p.url = resourceUrl(p.dataset, p.query);
  }
};

test("stages a cache paged by permit_nbr, :id (the committed fetch script's order) like the first order", async () => {
  await stagePermits(dir, out);
  const before = staged().map((r) => r.permit_nbr);
  reorder(fx);
  fx.write();
  expect(
    fx.manifest.pages.every((p) =>
      p.query.includes(" ORDER BY permit_nbr, :id LIMIT "),
    ),
  ).toBe(true);
  await stagePermits(dir, out);
  expect(staged().map((r) => r.permit_nbr)).toEqual(before);
});

test("fails when the pages of one dataset mix the two orders", async () => {
  reorder(fx, (p) => p.dataset === "aaaa-1111" && p.page === 1);
  fx.write();
  await expect(stagePermits(dir, out)).rejects.toThrow(
    // Page 0 sets the dataset's order (permit_nbr); page 1 breaks it.
    /aaaa-1111_p001\.json\.gz: query is not ordered by permit_nbr$/,
  );
});

test("fails on any other paging order", async () => {
  for (const p of fx.manifest.pages) {
    p.query = p.query.replace(
      " ORDER BY permit_nbr LIMIT ",
      " ORDER BY :id LIMIT ",
    );
    p.url = resourceUrl(p.dataset, p.query);
  }
  fx.write();
  await expect(stagePermits(dir, out)).rejects.toThrow(
    /query is not ordered by permit_nbr/,
  );
});

test("fails when a permit_nbr appears twice", async () => {
  rewritePage(dir, fx.manifest.pages[1]!, [permitRow("10000-10000-00001")]);
  fx.write();
  await expect(stagePermits(dir, out)).rejects.toThrow(
    /appears more than once/,
  );
});

test("fails on a value that is not text", async () => {
  rewritePage(dir, fx.manifest.pages[1]!, [
    permitRow("10000-10000-00003", { zip_code: 90001 }),
  ]);
  fx.write();
  await expect(stagePermits(dir, out)).rejects.toThrow(
    /field zip_code is not text/,
  );
});
