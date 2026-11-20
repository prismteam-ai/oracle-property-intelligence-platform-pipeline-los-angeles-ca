import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REPO } from "./helpers.ts";

const layer = join(REPO, "apps/api/build/duckdb-layer/nodejs/node_modules");

/** The Lambda layer must contain exactly the versions in pnpm-lock.yaml, and no musl binding. */
test.skipIf(!existsSync(layer))("DuckDB layer matches pnpm-lock.yaml", () => {
  const lock = readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8")
    .split(/^---$/m)
    .at(-1)!;
  const locked = new Map(
    [
      ...lock
        .split(/^packages:$/m)[1]!
        .split(/^snapshots:$/m)[0]!
        .matchAll(/^ {2}'?(@?[^@\s']+)@([^:'(]+)'?:$/gm),
    ].map((m) => [m[1]!, m[2]!]),
  );
  const found: Array<[string, string]> = [];
  for (const e of readdirSync(layer)) {
    if (e.startsWith(".")) continue;
    const dirs = e.startsWith("@")
      ? readdirSync(join(layer, e)).map((s) => join(e, s))
      : [e];
    for (const d of dirs) {
      const pj = join(layer, d, "package.json");
      if (existsSync(pj)) {
        const j = JSON.parse(readFileSync(pj, "utf8"));
        found.push([j.name, j.version]);
      }
    }
  }
  expect(found.length).toBeGreaterThanOrEqual(3);
  for (const [n, v] of found) expect({ n, v }).toEqual({ n, v: locked.get(n) });
  expect(found.map(([n]) => n).filter((n) => n.includes("musl"))).toEqual([]);
});
