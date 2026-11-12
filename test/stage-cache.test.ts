import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadRunConfig, whereClause } from "../src/run-config.ts";
import { RAW_FIELDS } from "../src/raw-fields.ts";
import {
  cacheRunId,
  readCacheSummary,
  stageCache,
  type CachePage,
} from "../src/stage-cache.ts";

const QUERY_URL =
  "https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Assessor%20Parcel%20Data%20Roll%202026/FeatureServer/0/query";
const WHERE = "RollYear = '2026'";
const scope = { queryUrl: QUERY_URL, where: WHERE };
// Fields the source returns that the build does not read; staging must drop them.
const EXTRA = { Roll_TotalValue: 500000, SQFTmain: 1200, Bedrooms: 3 };

const requestUrl = (where: string) =>
  `${QUERY_URL}?${new URLSearchParams({ where, outFields: "*", returnGeometry: "false", orderByFields: "OBJECTID ASC", resultRecordCount: "2", f: "json" }).toString()}`;

function row(oid: number): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const f of RAW_FIELDS) r[f] = `${f}-${oid}`;
  return { ...r, OBJECTID: oid, AIN: String(4000000000 + oid), ...EXTRA };
}

interface Fixture {
  dir: string;
  pages: CachePage[];
  writeManifest: (pages: CachePage[]) => void;
}

/** A synthetic two-page cache in fetch-roll.mjs's layout: OBJECTID 1-2 and 3. */
function makeCache(dir: string): Fixture {
  mkdirSync(join(dir, "pages"), { recursive: true });
  const groups = [[1, 2], [3]];
  let prevMax = 0;
  const pages = groups.map((oids, page): CachePage => {
    const body = Buffer.from(
      JSON.stringify({ features: oids.map((o) => ({ attributes: row(o) })) }),
    );
    const file = `page-${String(page).padStart(5, "0")}.json.gz`;
    writeFileSync(join(dir, "pages", file), gzipSync(body));
    const where = page === 0 ? WHERE : `${WHERE} AND OBJECTID > ${prevMax}`;
    prevMax = oids.at(-1)!;
    return {
      page,
      file,
      oid_min: oids[0]!,
      oid_max: oids.at(-1)!,
      rows: oids.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
      http_status: 200,
      fetched_at: `2026-11-12T00:00:0${page}.000Z`,
      request_url: requestUrl(where),
      ...(page === groups.length - 1 ? { final: true } : {}),
    };
  });
  const writeManifest = (ps: CachePage[]) =>
    writeFileSync(
      join(dir, "manifest.jsonl"),
      ps.map((p) => JSON.stringify(p)).join("\n") + "\n",
    );
  writeManifest(pages);
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({
      generated_at: "2026-11-12T01:44:04.047Z",
      total_rows: 3,
      source_count_at_start: 3,
      pages: 2,
      oid_min: 1,
      oid_max: 3,
      complete: true,
    }),
  );
  return { dir, pages, writeManifest };
}

let tmp = "";
let fx: Fixture;
let ndjson = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "stage-cache-"));
  fx = makeCache(join(tmp, "cache"));
  ndjson = join(tmp, "rows.ndjson");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const staged = () =>
  readFileSync(ndjson, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("a valid cache", () => {
  test("stages every row, only RAW_FIELDS plus provenance", async () => {
    const r = await stageCache(fx.dir, ndjson, scope);
    expect(r.rows).toBe(3);
    expect(r.pages).toHaveLength(2);
    const rows = staged();
    expect(rows.map((x) => x.OBJECTID)).toEqual([1, 2, 3]);
    for (const x of rows)
      expect(Object.keys(x).sort()).toEqual(
        [
          ...RAW_FIELDS,
          "_page_file",
          "_request_url",
          "_retrieved_at",
          "_page_sha256",
        ].sort(),
      );
    expect(rows[2]).toMatchObject({
      AIN: "4000000003",
      _page_file: "pages/page-00001.json.gz",
      _request_url: fx.pages[1]!.request_url,
      _retrieved_at: "2026-11-12T00:00:01.000Z",
      _page_sha256: fx.pages[1]!.sha256,
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /Roll_TotalValue|SQFTmain|Bedrooms/,
    );
  });

  test("run ID from the summary's generated_at", () => {
    expect(cacheRunId(readCacheSummary(fx.dir))).toBe(
      "2026-11-12T01-44-04-047Z",
    );
  });

  test("the county config's where clause is the download script's filter", () => {
    const script = readFileSync("scripts/fetch-roll.mjs", "utf8");
    const year = /const ROLL_YEAR = "(\d{4})";/.exec(script)?.[1];
    expect(script).toContain("const baseWhere = `RollYear = '${ROLL_YEAR}'`;");
    const cfg = loadRunConfig("config/la-county-run.json");
    expect(whereClause(cfg)).toBe(`RollYear = '${year}'`);
    expect(/const QUERY_URL =\s*"([^"]+)";/.exec(script)?.[1]).toBe(
      cfg.source.query_url,
    );
  });
});

describe("verification failures", () => {
  const broken = (change: (ps: CachePage[]) => void) => {
    const ps = fx.pages.map((p) => ({ ...p }));
    change(ps);
    fx.writeManifest(ps);
    return stageCache(fx.dir, ndjson, scope);
  };

  test("body sha256 mismatch", async () => {
    await expect(
      broken((ps) => (ps[1]!.sha256 = "0".repeat(64))),
    ).rejects.toThrow(/page 1: body sha256 or size mismatch/);
  });

  test("HTTP status other than 200", async () => {
    await expect(broken((ps) => (ps[0]!.http_status = 500))).rejects.toThrow(
      /page 0: HTTP status 500/,
    );
  });

  test("row count mismatch", async () => {
    await expect(broken((ps) => (ps[0]!.rows = 3))).rejects.toThrow(
      /page 0: row count mismatch/,
    );
  });

  test("OBJECTID gap between pages", async () => {
    await expect(broken((ps) => (ps[1]!.oid_min = 4))).rejects.toThrow(
      /page 1: starts at OBJECTID 4, expected 3/,
    );
  });

  test("a request with another where clause", async () => {
    await expect(
      broken(
        (ps) =>
          (ps[0]!.request_url = requestUrl(
            "RollYear = '2026' AND SitusZIP5 = '91405'",
          )),
      ),
    ).rejects.toThrow(/page 0: request where/);
  });

  test("a request to another service", async () => {
    await expect(
      broken(
        (ps) =>
          (ps[0]!.request_url = ps[0]!.request_url.replace(
            "services.arcgis.com",
            "example.org",
          )),
      ),
    ).rejects.toThrow(/page 0: request URL is not the run's query URL/);
  });

  test("a page file outside pages/", async () => {
    await expect(
      broken((ps) => (ps[0]!.file = "../summary.json")),
    ).rejects.toThrow(/not a plain name/);
  });

  test("a page missing from the manifest", async () => {
    await expect(broken((ps) => ps.pop())).rejects.toThrow(
      /1 pages, summary.json says 2/,
    );
  });

  test("a raw field missing from a row", async () => {
    const body = Buffer.from(
      JSON.stringify({
        features: [1, 2].map((o) => {
          const attributes = row(o);
          delete attributes.YearBuilt;
          return { attributes };
        }),
      }),
    );
    writeFileSync(join(fx.dir, "pages", fx.pages[0]!.file), gzipSync(body));
    await expect(
      broken((ps) => {
        ps[0]!.sha256 = createHash("sha256").update(body).digest("hex");
        ps[0]!.bytes = body.length;
      }),
    ).rejects.toThrow(/page 0: field YearBuilt missing/);
  });

  test("totals that do not match summary.json", async () => {
    const s = JSON.parse(readFileSync(join(fx.dir, "summary.json"), "utf8"));
    writeFileSync(
      join(fx.dir, "summary.json"),
      JSON.stringify({ ...s, total_rows: 4 }),
    );
    await expect(stageCache(fx.dir, ndjson, scope)).rejects.toThrow(
      /do not match summary.json/,
    );
  });
});
