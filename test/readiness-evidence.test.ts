import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { acceptReadinessOutput } from "../src/readiness.ts";

// The validator's outputs on the sources catalog, written by the tool to docs/evidence/:
// with the destination proven, with the county-wide exception added, and with the county
// parcels plus City of LA permits exception first. The build's readiness rule must accept all.
test.each([
  "docs/evidence/la-preflight-pass-destination.json",
  "docs/evidence/la-preflight-pass-county.json",
  "docs/evidence/la-preflight-pass-county-permits.json",
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

test("the permits evidence reports the increment-5 exception", () => {
  const report = JSON.parse(
    readFileSync("docs/evidence/la-preflight-pass-county-permits.json", "utf8"),
  ) as { gates: Array<{ gate: string; evidence: string }> };
  expect(report.gates.find((g) => g.gate === "permit")?.evidence).toMatch(
    /^Increment 5: all of Los Angeles County's parcels[\s\S]*City of Los Angeles building permits/,
  );
});

test("the build lists the permits evidence for a permit run", () => {
  expect(readFileSync("src/build-outputs.ts", "utf8")).toMatch(
    /withPermits\s*\?\s*\["docs\/evidence\/la-preflight-pass-county-permits\.json"\]/,
  );
});
