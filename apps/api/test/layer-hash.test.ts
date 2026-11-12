import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "aws-cdk-lib";
import { afterAll, expect, test } from "vitest";
import { layerFingerprint } from "../cdk/lib/layer.ts";
import { REPO } from "./helpers.ts";

const dirs: string[] = [];
/** One clean layer build, exactly as the `layer` script does it, into a fresh directory. */
const build = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "duckdb-layer-"));
  dirs.push(dir);
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@oracle-la/duckdb-runtime",
      "--prod",
      "deploy",
      "--frozen-lockfile",
      "--config.node-linker=hoisted",
      join(dir, "nodejs"),
    ],
    { cwd: REPO, stdio: "pipe" },
  );
  return dir;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("two clean layer builds give the same layer asset hash", () => {
  const a = build();
  const b = build();
  expect(layerFingerprint(a)).toBe(layerFingerprint(b));
  // Without the exclude list the hashes differ (pnpm's metadata holds timestamps and the build path).
  expect(FileSystem.fingerprint(a)).not.toBe(FileSystem.fingerprint(b));
}, 120_000);
