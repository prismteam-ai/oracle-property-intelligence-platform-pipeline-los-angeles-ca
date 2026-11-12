import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  appendRunHistory,
  planHistory,
  readHistory,
} from "../src/run-history.ts";

let dir = "";
let historyPath = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-history-"));
  historyPath = join(dir, "run_history.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (run_id: string, parquet_sha256: string) => ({
  run_id,
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
