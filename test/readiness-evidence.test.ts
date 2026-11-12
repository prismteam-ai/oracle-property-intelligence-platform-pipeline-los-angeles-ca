import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { acceptReadinessOutput } from "../src/readiness.ts";

// The validator's outputs on the sources catalog, written by the tool to docs/evidence/:
// with the destination proven, and with the county-wide exception added. The build's
// readiness rule must accept both.
test.each([
  "docs/evidence/la-preflight-pass-destination.json",
  "docs/evidence/la-preflight-pass-county.json",
])("the build accepts the recorded validator output %s", (path) => {
  const bytes = readFileSync(path);
  const r = acceptReadinessOutput(bytes);
  expect(r.overall).toBe("PASS");
  expect(r.gates).toContainEqual({ gate: "destination", status: "PASS" });
  expect(r.gates).toContainEqual({
    gate: "permit",
    status: "APPROVED_EXCEPTION",
  });
  expect(r.output_sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
});

test("the county evidence reports the county-wide exception", () => {
  const report = JSON.parse(
    readFileSync("docs/evidence/la-preflight-pass-county.json", "utf8"),
  ) as { gates: Array<{ gate: string; evidence: string }> };
  expect(report.gates.find((g) => g.gate === "permit")?.evidence).toMatch(
    /^Increment 4: parcels only, all of Los Angeles County/,
  );
});
