import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { acceptReadinessOutput } from "../src/readiness.ts";

// The validator's output on the sources catalog with the destination proven, written by the
// tool to docs/evidence/. The build's readiness rule must accept it.
test("the build accepts the recorded validator output with the destination proven", () => {
  const bytes = readFileSync(
    "docs/evidence/la-preflight-pass-destination.json",
  );
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
