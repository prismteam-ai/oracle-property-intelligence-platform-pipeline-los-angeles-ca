import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REPO } from "./helpers.ts";

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) =>
    statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)],
  );

test("API code never names Parquet files or raw Parquet columns (views only)", () => {
  const raw =
    /read_parquet|parcel_identifier|property_structure_built_year|unnormalized_address|source_http_request|tax_rate_area_city|assessor_id_formatted/;
  const offenders = walk(join(REPO, "apps/api/src")).filter((f) =>
    raw.test(readFileSync(f, "utf8")),
  );
  expect(offenders).toEqual([]);
});

test("build outputs and secrets are never tracked by git", () => {
  const tracked = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      ":(glob)**/cdk.out/**",
      ":(glob)**/cdk-outputs*.json",
      ":(glob)**/dist/**",
      ":(glob)**/.secrets/**",
      ":(glob)**/build/**",
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  expect(tracked.trim()).toBe("");
});
