import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { stageFiles } from "./helpers.ts";

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
