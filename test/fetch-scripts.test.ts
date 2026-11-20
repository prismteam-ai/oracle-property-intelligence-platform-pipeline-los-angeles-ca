import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

// Every case here stops before the first request: no network is used.
const PERMITS = "scripts/ladbs-permits/fetch.mjs";
const CONTRACTORS = "scripts/ladbs-contractors/fetch.mjs";
const LICENSE = ["--license-read-at", "2026-11-12T13:19:00Z"];
const run = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "fetch-scripts-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each([
  ["permits", PERMITS, []],
  ["contractors", CONTRACTORS, LICENSE],
] as const)(
  "the %s fetch refuses an existing cache folder, empty or not, and writes nothing into it",
  (_n, script, extra) => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const recorded = join(root, "recorded");
    mkdirSync(recorded);
    writeFileSync(join(recorded, "manifest.json"), "{}");
    for (const dir of [empty, recorded]) {
      const before = readdirSync(dir);
      const r = run(script, dir, ...extra);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/refusing: the cache folder .* exists/);
      expect(readdirSync(dir)).toEqual(before);
    }
  },
);

test.each([
  [[], /--license-read-at needs the time/],
  [["--license-read-at"], /--license-read-at needs the time/],
  [["--license-read-at", "12 Nov 2026"], /got 12 Nov 2026/],
  [["--license-read-at", "2026-11-12T13:19:00"], /needs the time/],
  [["--license-read-at", "2999-01-01T00:00:00Z"], /needs the time/],
])(
  "the contractor fetch %j stops before any request or folder",
  (args, msg) => {
    const dir = join(root, "new");
    const r = run(CONTRACTORS, dir, ...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(msg);
    expect(existsSync(dir)).toBe(false);
  },
);

test("the contractor script records the given license time, never a written one", () => {
  const src = readFileSync(CONTRACTORS, "utf8");
  expect(src).toMatch(/retrieved_at: LICENSE_READ_AT,/);
  expect(src).not.toMatch(/retrieved_at: "\d{4}-/);
});
