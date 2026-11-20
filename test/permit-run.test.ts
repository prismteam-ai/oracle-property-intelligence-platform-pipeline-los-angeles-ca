import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  cacheShape,
  compareShapes,
  copyFetchScripts,
  newCacheDirs,
  nextSteps,
  parseArgs,
  plan,
  stamp,
} from "../scripts/permit-run.ts";
import {
  contractorRow,
  makeContractorCache,
  rewritePage,
} from "./fixtures/ladbs-cache.ts";

// Nothing here downloads, builds or touches runs/: the steps are planned, never run, and the caches are fixtures.
const NOW = new Date("2026-11-17T01:02:03.456Z");
const FETCH = [
  "--roll-cache",
  "roll",
  "--cache-root",
  "caches",
  "--license-read-at",
  "2026-11-12T13:19:00Z",
  "--previous",
  "old-p",
  "old-c",
];

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "permit-run-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a fetch run: download and summarize each cache into new folders, then the dry run; --real adds the build", () => {
  const o = parseArgs(FETCH);
  expect(o).toMatchObject({ maxChangePct: 1, real: false, plan: false });
  const p = plan(o, NOW);
  expect([p.permitCache, p.contractorCache]).toEqual(
    newCacheDirs("caches", NOW),
  );
  expect(p.permitCache).toMatch(/ladbs-permits-2026-11-17T01-02-03Z$/);
  expect(p.steps.map((s) => [s.argv.slice(1, 3), s.network])).toEqual([
    [["scripts/ladbs-permits/fetch.mjs", p.permitCache], true],
    [["scripts/ladbs-permits/fetch.mjs", "summarize"], false],
    [["scripts/ladbs-contractors/fetch.mjs", p.contractorCache], true],
    [["scripts/ladbs-contractors/fetch.mjs", "summarize"], false],
    [["src/build-outputs.ts", join(process.cwd(), "roll")], false],
  ]);
  expect(p.steps[2]!.argv.slice(-2)).toEqual([
    "--license-read-at",
    "2026-11-12T13:19:00Z",
  ]);
  expect(p.steps.at(-1)!.argv.at(-1)).toBe("--dry-run");
  const real = plan(parseArgs([...FETCH, "--real"]), NOW).steps;
  expect(real).toHaveLength(6);
  expect(real.at(-1)!.argv).not.toContain("--dry-run");
  expect(real.at(-1)!.argv).toContain("config/la-county-permits-run.json");
});

test("no step uploads, deploys or commits; those are printed as separate steps for the operator", () => {
  for (const args of [FETCH, [...FETCH, "--real"]])
    for (const s of plan(parseArgs(args), NOW).steps)
      expect(s.argv.join(" ")).not.toMatch(/\baws\b|\bcdk\b|\bgit\b|s3/);
  const next = nextSteps("RUN");
  expect(next.map((l) => l.split(":")[0])).toEqual([
    "check",
    "commit",
    "upload (AWS, approval)",
    "deploy (AWS, approval)",
  ]);
  expect(next[2]).toMatch(/6 objects.*--if-none-match '\*'/);
});

test("--from-caches builds without any download; --reuse-contractor-cache downloads the permits only", () => {
  const from = plan(
    parseArgs(["--roll-cache", "roll", "--from-caches", "p", "c", "--real"]),
    NOW,
  );
  expect(from.steps.every((s) => !s.network)).toBe(true);
  expect(from.steps).toHaveLength(2);
  const reuse = plan(
    parseArgs([
      "--roll-cache",
      "roll",
      "--cache-root",
      "caches",
      "--reuse-contractor-cache",
      "old-c",
      "--previous",
      "old-p",
      "old-c",
    ]),
    NOW,
  );
  expect(reuse.contractorCache).toBe(join(process.cwd(), "old-c"));
  expect(reuse.steps.filter((s) => s.network)).toHaveLength(1);
  expect(reuse.steps[0]!.argv[1]).toBe("scripts/ladbs-permits/fetch.mjs");
});

test.each([
  [[], /--roll-cache is required/],
  [["--roll-cache", "r", "--cache-root", "c"], /exactly one of/],
  [
    ["--roll-cache", "r", "--cache-root", "c", "--license-read-at", "t"],
    /needs --previous/,
  ],
  [["--roll-cache", "r", "--license-read-at", "t"], /needs --cache-root/],
  [
    ["--roll-cache", "r", "--from-caches", "p", "c", "--cache-root", "x"],
    /nothing is fetched/,
  ],
  [["--roll-cache", "r", "--from-caches", "p"], /--from-caches needs a value/],
  [[...FETCH, "--max-change-pct", "-1"], /0 or more/],
  [[...FETCH, "--upload"], /unknown argument --upload/],
])("parseArgs %j fails", (args, msg) => {
  expect(() => parseArgs(args)).toThrow(msg);
});

test("the cache stamp is the UTC time without colons or milliseconds", () => {
  expect(stamp(NOW)).toBe("2026-11-17T01-02-03Z");
});

test("the cache gate: rows within the limit and the same columns pass; more change, a new or a missing column stop", () => {
  const prev = { rows: 1000, columns: ["a", "b"] };
  expect(compareShapes("permits", { ...prev, rows: 1010 }, prev, 1)).toEqual(
    [],
  );
  expect(
    compareShapes("permits", { rows: 1011, columns: ["a", "c"] }, prev, 1),
  ).toEqual([
    "permits: 1011 rows against 1000 before (1.10% change, more than 1%)",
    "permits: new column(s) c",
    "permits: missing column(s) b",
  ]);
});

test("cacheShape reads every row of every page: rows and the columns seen", () => {
  const dir = join(root, "c");
  mkdirSync(dir);
  const fx = makeContractorCache(dir);
  const before = cacheShape(dir);
  expect(before.rows).toBe(4);
  expect(before.columns).toContain("pcis_permit");
  rewritePage(dir, fx.manifest.pages[1]!, [
    { ...contractorRow("10000-10000-00002"), contact_phone: "x" },
  ]);
  fx.write();
  expect(compareShapes("contractors", cacheShape(dir), before, 1).at(-1)).toBe(
    "contractors: new column(s) contact_phone",
  );
  fx.manifest.status = "stopped";
  fx.write();
  expect(() => cacheShape(dir)).toThrow(/cache status is "stopped"/);
});

test("the fetch scripts are copied into the caches the command downloaded; a copy already there is an error", () => {
  const p = join(root, "p");
  const c = join(root, "c");
  mkdirSync(p);
  mkdirSync(c);
  expect(
    copyFetchScripts([
      { kind: "permits", dir: p },
      { kind: "contractors", dir: c },
    ]),
  ).toEqual([
    `${join(p, "fetch.mjs")}: copied from scripts/ladbs-permits/fetch.mjs`,
    `${join(c, "fetch.mjs")}: copied from scripts/ladbs-contractors/fetch.mjs`,
  ]);
  expect(readFileSync(join(p, "fetch.mjs"), "utf8")).toBe(
    readFileSync("scripts/ladbs-permits/fetch.mjs", "utf8"),
  );
  writeFileSync(join(c, "fetch.mjs"), "// the copy that ran\n");
  expect(() => copyFetchScripts([{ kind: "contractors", dir: c }])).toThrow(
    /exists: a new cache has no fetch script yet/,
  );
  expect(readFileSync(join(c, "fetch.mjs"), "utf8")).toBe(
    "// the copy that ran\n",
  );
});

test("--plan prints the steps and runs none of them", () => {
  const caches = join(root, "caches");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/permit-run.ts", ...args], {
      encoding: "utf8",
      timeout: 20_000,
    });
  const planned = run(
    ...FETCH.map((a) => (a === "caches" ? caches : a)),
    "--plan",
  );
  expect(planned.status).toBe(0);
  expect(planned.stdout).toMatch(
    /download the LADBS permit sets .*\(network\)/,
  );
  expect(planned.stdout).toMatch(/never run by this command/);
  expect(existsSync(caches)).toBe(false);
});
