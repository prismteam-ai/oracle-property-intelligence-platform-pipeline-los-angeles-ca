import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

// The option checks run before the guard, the validator or any file is read.
const run = (...args: string[]) =>
  spawnSync(process.execPath, ["src/build-outputs.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, KIT_DIR: "" },
  });

test.each([
  [["cache-dir", "--bogus"], /unknown option --bogus/],
  [["cache-dir", "--permit-cache"], /--permit-cache needs a value/],
  [
    ["cache-dir", "--permit-cache", "--dry-run"],
    /--permit-cache needs a value/,
  ],
  [[], /usage: node src\/build-outputs\.ts/],
  [["a", "b.json", "c"], /usage: node src\/build-outputs\.ts/],
])("build-outputs %j fails: %s", (args, msg) => {
  const r = run(...args);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(msg);
});

test("the old configs stop at the scope guard, before anything is built", () => {
  for (const cfg of ["config/la-pilot-run.json", "config/la-county-run.json"]) {
    const r = run("cache-dir", cfg, "--dry-run");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/SCOPE GUARD FAILED/);
  }
});
