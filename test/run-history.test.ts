import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  appendRunHistory,
  inputCacheDigests,
  planHistory,
  readHistory,
  rebuildFields,
  schemaChanges,
  type InputManifestLike,
} from "../src/run-history.ts";

let dir = "";
let historyPath = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-history-"));
  historyPath = join(dir, "run_history.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// finished_at follows the run ID's last letter (run-a before run-b before run-p), so rows append in order.
const finishedAt = (run_id: string) =>
  new Date(
    Date.UTC(2026, 10, 1, 0, 0, run_id.charCodeAt(run_id.length - 1) - 96),
  ).toISOString();
const row = (run_id: string, parquet_sha256: string) => ({
  run_id,
  finished_at: finishedAt(run_id),
  parquet_path: `data/out/${run_id}/x.parquet`,
  parquet_sha256,
  published: false,
});
const lines = () => readFileSync(historyPath, "utf8").split("\n").length - 1;

test("first run: no history file, the run is new with no previous run", () => {
  expect(readHistory(historyPath)).toEqual([]);
  expect(planHistory([], "run-a", "aa")).toEqual({
    kind: "new",
    previous: undefined,
  });
  expect(appendRunHistory(historyPath, row("run-a", "aa"))).toBe("added");
  expect(lines()).toBe(1);
});

test("rebuilding the same run with the same Parquet adds no second row", () => {
  appendRunHistory(historyPath, row("run-a", "aa"));
  const before = readFileSync(historyPath);
  const plan = planHistory(readHistory(historyPath), "run-a", "aa");
  expect(plan).toEqual({ kind: "recorded", row: row("run-a", "aa") });
  expect(appendRunHistory(historyPath, row("run-a", "aa"))).toBe(
    "already-recorded",
  );
  expect(readFileSync(historyPath)).toEqual(before);
});

test("the same run ID with a different Parquet fails and writes nothing", () => {
  appendRunHistory(historyPath, row("run-a", "aa"));
  const before = readFileSync(historyPath);
  expect(() => planHistory(readHistory(historyPath), "run-a", "bb")).toThrow(
    /run run-a is already in the run history with Parquet sha256 aa; this build gives bb/,
  );
  expect(() => appendRunHistory(historyPath, row("run-a", "bb"))).toThrow(
    /needs a new run ID/,
  );
  expect(readFileSync(historyPath)).toEqual(before);
});

test("a recorded row without a Parquet sha256 fails closed", () => {
  writeFileSync(historyPath, JSON.stringify({ run_id: "run-a" }) + "\n");
  expect(() => planHistory(readHistory(historyPath), "run-a", "aa")).toThrow(
    /Parquet sha256 \(none\)/,
  );
});

test("a new run ID is appended and its delta base is the last recorded run", () => {
  appendRunHistory(historyPath, row("run-a", "aa"));
  appendRunHistory(historyPath, row("run-b", "bb"));
  expect(planHistory(readHistory(historyPath), "run-c", "cc")).toEqual({
    kind: "new",
    previous: row("run-b", "bb"),
  });
  expect(appendRunHistory(historyPath, row("run-c", "cc"))).toBe("added");
  expect(readHistory(historyPath).map((r) => r.run_id)).toEqual([
    "run-a",
    "run-b",
    "run-c",
  ]);
});

const permitFiles = (sha: string) => [
  { role: "permits", path: "p.parquet", sha256: `${sha}1` },
  { role: "permit_parcels", path: "pp.parquet", sha256: `${sha}2` },
  { role: "permit_contractors", path: "pc.parquet", sha256: `${sha}3` },
];

test("a permit run records its permit files; the same files rebuild to nothing new", () => {
  appendRunHistory(historyPath, row("run-a", "aa"));
  const permitRow = { ...row("run-p", "pp"), permit_files: permitFiles("x") };
  expect(appendRunHistory(historyPath, permitRow)).toBe("added");
  const [old, latest] = readHistory(historyPath);
  expect(old!.permit_files).toBeUndefined();
  expect(latest!.permit_files).toEqual(permitFiles("x"));
  // The same files in another order are the same build.
  expect(
    planHistory(
      readHistory(historyPath),
      "run-p",
      "pp",
      [...permitFiles("x")].reverse(),
    ).kind,
  ).toBe("recorded");
  expect(appendRunHistory(historyPath, permitRow)).toBe("already-recorded");
});

test("the same run ID with other permit files fails and writes nothing", () => {
  appendRunHistory(historyPath, {
    ...row("run-p", "pp"),
    permit_files: permitFiles("x"),
  });
  const before = readFileSync(historyPath);
  expect(() =>
    appendRunHistory(historyPath, {
      ...row("run-p", "pp"),
      permit_files: permitFiles("y"),
    }),
  ).toThrow(/other permit files/);
  expect(() => planHistory(readHistory(historyPath), "run-p", "pp")).toThrow(
    /other permit files/,
  );
  expect(readFileSync(historyPath)).toEqual(before);
});

test("files identical to a run recorded before the build digest add no row and name that run's ID", () => {
  const old = { ...row("run-a", "aa"), permit_files: permitFiles("x") };
  appendRunHistory(historyPath, old);
  const before = readFileSync(historyPath);
  const newId = "run-a-b0123456789ab";
  expect(
    planHistory(readHistory(historyPath), newId, "aa", permitFiles("x")),
  ).toEqual({ kind: "recorded", row: old });
  expect(
    appendRunHistory(historyPath, {
      ...row(newId, "aa"),
      finished_at: finishedAt("run-z"),
      permit_files: permitFiles("x"),
    }),
  ).toBe("already-recorded");
  expect(readFileSync(historyPath)).toEqual(before);
  // Other permit files: a new run.
  expect(
    planHistory(readHistory(historyPath), newId, "aa", permitFiles("y")).kind,
  ).toBe("new");
});

test("files identical to a run with a build digest under another ID are a new run (a manifest-only change)", () => {
  const digested = {
    ...row("run-a", "aa"),
    build_digest: "d".repeat(64),
    permit_files: permitFiles("x"),
  };
  appendRunHistory(historyPath, digested);
  expect(
    planHistory(readHistory(historyPath), "run-b", "aa", permitFiles("x")),
  ).toEqual({ kind: "new", previous: digested });
});

test("appending leaves the earlier lines byte-identical", () => {
  appendRunHistory(historyPath, row("run-a", "aa"));
  appendRunHistory(historyPath, row("run-b", "bb"));
  const before = readFileSync(historyPath);
  expect(appendRunHistory(historyPath, row("run-c", "cc"))).toBe("added");
  const after = readFileSync(historyPath);
  expect(after.subarray(0, before.length)).toEqual(before);
  expect(after.subarray(before.length).toString()).toBe(
    JSON.stringify(row("run-c", "cc")) + "\n",
  );
});

test("a row whose finished_at is not later than every recorded one is refused", () => {
  appendRunHistory(historyPath, row("run-b", "bb"));
  const before = readFileSync(historyPath);
  // Earlier, and the same instant.
  for (const finished_at of [finishedAt("run-a"), finishedAt("run-b")])
    expect(() =>
      appendRunHistory(historyPath, { ...row("run-c", "cc"), finished_at }),
    ).toThrow(/not later than every recorded run/);
  expect(() =>
    appendRunHistory(historyPath, {
      ...row("run-c", "cc"),
      finished_at: "14 Nov 2026",
    }),
  ).toThrow(/no ISO finished_at/);
  expect(readFileSync(historyPath)).toEqual(before);
  // A recorded row without finished_at fails closed.
  writeFileSync(historyPath, JSON.stringify({ run_id: "run-x" }) + "\n");
  expect(() => appendRunHistory(historyPath, row("run-c", "cc"))).toThrow(
    /run run-x has no ISO finished_at/,
  );
});

const cacheManifest = (pageSha: string): InputManifestLike => ({
  cache: {
    summary: { path: "summary.json", sha256: "s1" },
    manifest: { path: "manifest.jsonl", sha256: "m1" },
    download_script: {
      copy_that_ran: { path: "fetch-roll.mjs", sha256: "f1" },
    },
    pages: [{ path: "pages/page-00000.json.gz", body_sha256: pageSha }],
  },
  permit_caches: {
    permits: {
      files: [{ path: "manifest.json", sha256: "pm" }],
      pages: [{ path: "pages/p0.json.gz", json_sha256: "pj", gz_sha256: "pg" }],
    },
    contractors: {
      files: [{ path: "manifest.json", sha256: "cm" }],
      pages: [],
    },
  },
  files: [{ path: "data/out/run-a/x.parquet", sha256: "out" }],
});

test("rebuild fields: 'rebuild' only when every input cache digest equals the previous run's", () => {
  const inputs = inputCacheDigests(cacheManifest("p0"));
  expect(inputs).toEqual([
    "contractors manifest.json cm",
    "permits manifest.json pm",
    "permits pages/p0.json.gz pj pg",
    "roll fetch-roll.mjs f1",
    "roll manifest.jsonl m1",
    "roll pages/page-00000.json.gz p0",
    "roll summary.json s1",
  ]);
  expect(rebuildFields(inputs, { run_id: "run-a", inputs })).toEqual({
    run_kind: "rebuild",
    rebuild_of: "run-a",
    source_changes: "none",
  });
  const changed = inputCacheDigests(cacheManifest("p0."));
  for (const prev of [{ run_id: "run-a", inputs: changed }, undefined])
    expect(rebuildFields(inputs, prev)).toEqual({
      run_kind: "new data",
      rebuild_of: null,
      source_changes: null,
    });
  // The served run's manifest lists every cache file: 2,429 roll pages plus summary, manifest
  // and download script; 3 files and 10 pages of permits; 3 files and 3 pages of contractors.
  const served = JSON.parse(
    readFileSync("runs/2026-11-12T14-00-51-383Z/run_manifest.json", "utf8"),
  ) as InputManifestLike;
  expect(inputCacheDigests(served)).toHaveLength(2432 + 13 + 6);
});

test("schema changes: columns added, removed and retyped per table against the previous run", () => {
  const col = (name: string, type = "VARCHAR") => ({ name, type });
  expect(schemaChanges(undefined, { property: [col("a")] })).toBeNull();
  expect(
    schemaChanges(
      { property: [col("a"), col("b")], permits: [col("p")], gone: [col("g")] },
      {
        property: [col("a", "BIGINT"), col("c")],
        permits: [col("p")],
        permit_contractors: [col("k")],
      },
    ),
  ).toEqual({
    property: {
      added: ["c"],
      removed: ["b"],
      retyped: ["a: VARCHAR -> BIGINT"],
    },
    permits: { added: [], removed: [], retyped: [] },
    permit_contractors: {
      added: ["k"],
      removed: [],
      retyped: [],
      new_table: true,
    },
    gone: { added: [], removed: ["g"], retyped: [], removed_table: true },
  });
});
