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
import { basename, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FIXTURE, writeRun } from "./fixture.ts";
import { stageFiles, tempFolders } from "./helpers.ts";

describe("stageFiles: the staged copy of the run files", () => {
  // Each test stages under its own parent folder, so it can see exactly what is left behind.
  const root = mkdtempSync(join(tmpdir(), "api-stage-test-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const parent = (name: string) => mkdtempSync(join(root, `${name}-`));
  writeFileSync(join(root, "a.parquet"), "parquet bytes");
  writeFileSync(join(root, "manifest.json"), "{}");

  test("copies each file under its name; remove() deletes the folder and everything in it", () => {
    const p = parent("ok");
    const s = stageFiles(
      [
        [join(root, "a.parquet"), "run.parquet"],
        [join(root, "manifest.json"), "run_manifest.json"],
      ],
      p,
    );
    expect(readdirSync(p)).toEqual([basename(s.dir)]);
    expect(readdirSync(s.dir).sort()).toEqual([
      "run.parquet",
      "run_manifest.json",
    ]);
    expect(readFileSync(join(s.dir, "run.parquet"), "utf8")).toBe(
      "parquet bytes",
    );
    s.remove();
    expect(existsSync(s.dir)).toBe(false);
    expect(readdirSync(p)).toEqual([]);
    s.remove(); // a second call is a no-op
  });

  test("a failed copy removes the partly staged folder and rethrows", () => {
    const p = parent("fail");
    expect(() =>
      stageFiles(
        [
          [join(root, "a.parquet"), "run.parquet"],
          [join(root, "missing.parquet"), "missing.parquet"],
        ],
        p,
      ),
    ).toThrow(/ENOENT/);
    expect(readdirSync(p)).toEqual([]);
  });
});

describe("tempFolders and writeRun: the DuckDB temp folders and the fixture runs", () => {
  // Each test makes its folders under its own parent folder, so it can see exactly what is left behind.
  const root = mkdtempSync(join(tmpdir(), "api-temp-test-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const parent = (name: string) => mkdtempSync(join(root, `${name}-`));

  test("make() gives a new api-tmp- folder each call; removeAll() deletes them and what is in them", () => {
    const p = parent("tmp");
    const tmp = tempFolders("api-tmp-", p);
    const a = tmp.make();
    const b = tmp.make();
    expect(a).not.toBe(b);
    expect(readdirSync(p).sort()).toEqual([basename(a), basename(b)].sort());
    expect(basename(a)).toMatch(/^api-tmp-/);
    // As DuckDB and the S3 copy leave them: nested folders with files.
    mkdirSync(join(a, "duckdb"));
    writeFileSync(join(a, "duckdb", "spill.tmp"), "x");
    tmp.removeAll();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(readdirSync(p)).toEqual([]);
    tmp.removeAll(); // a second call is a no-op
  });

  test("a fixture run's remove() deletes its api-fixture- folder and everything in it", async () => {
    const p = parent("run");
    const r = await writeRun("select 1 as x", undefined, undefined, p);
    expect(readdirSync(p)).toEqual([basename(r.dir)]);
    expect(basename(r.dir)).toMatch(/^api-fixture-/);
    expect(readdirSync(r.dir)).toContain(FIXTURE.parquetFile);
    r.remove();
    expect(existsSync(r.dir)).toBe(false);
    expect(readdirSync(p)).toEqual([]);
    r.remove(); // a second call is a no-op
  });

  test("a failed fixture write removes the partly written folder and rethrows", async () => {
    const p = parent("fail");
    await expect(
      writeRun("select * from no_such_table", undefined, undefined, p),
    ).rejects.toThrow(/no_such_table/);
    expect(readdirSync(p)).toEqual([]);
  });
});
