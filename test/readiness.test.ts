import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  KIT_COMMIT,
  VALIDATOR_PATH,
  VALIDATOR_SHA256,
  acceptReadinessOutput,
  runReadiness,
  verifiedValidator,
} from "../src/readiness.ts";

// Synthetic validator outputs in the validator's JSON shape (not tool records).
const passBytes = readFileSync("test/fixtures/readiness/pass.json");
const blockedBytes = readFileSync("test/fixtures/readiness/blocked.json");
const edited = (change: (r: Record<string, unknown>) => void) => {
  const r = JSON.parse(passBytes.toString()) as Record<string, unknown>;
  change(r);
  return JSON.stringify(r);
};

describe("acceptReadinessOutput", () => {
  test("PASS with the permit exception: records overall, every gate and the output sha256", () => {
    const r = acceptReadinessOutput(passBytes);
    expect(r.overall).toBe("PASS");
    expect(r.seed_allowed).toBe(true);
    expect(r.ingest_allowed).toBe(true);
    expect(r.gates).toEqual([
      { gate: "catalog_metadata", status: "PASS" },
      { gate: "parcel", status: "PASS" },
      { gate: "permit", status: "APPROVED_EXCEPTION" },
      { gate: "destination", status: "PASS" },
      { gate: "enrichment", status: "PASS" },
    ]);
    expect(r.output_sha256).toBe(
      createHash("sha256").update(passBytes).digest("hex"),
    );
  });

  test("BLOCKED fails closed and names the blocked gate", () => {
    expect(() => acceptReadinessOutput(blockedBytes)).toThrow(
      /overall is BLOCKED[\s\S]*seed_allowed is not true[\s\S]*gate permit is BLOCKED/,
    );
  });

  test("PASS without the permit exception fails", () => {
    const out = edited((r) => {
      (r.gates as Array<{ gate: string; status: string }>).find(
        (g) => g.gate === "permit",
      )!.status = "PASS";
    });
    expect(() => acceptReadinessOutput(out)).toThrow(
      /permit gate is PASS, not APPROVED_EXCEPTION/,
    );
  });

  test("PASS with seed or ingest not allowed fails", () => {
    expect(() =>
      acceptReadinessOutput(edited((r) => (r.seed_allowed = false))),
    ).toThrow(/seed_allowed is not true/);
    expect(() =>
      acceptReadinessOutput(edited((r) => delete r.ingest_allowed)),
    ).toThrow(/ingest_allowed is not true/);
  });

  test("output that is not JSON, or has no gates, fails", () => {
    expect(() => acceptReadinessOutput("")).toThrow(/not JSON/);
    expect(() => acceptReadinessOutput(edited((r) => delete r.gates))).toThrow(
      /no gates/,
    );
  });
});

describe("validator file check", () => {
  test("pinned to the kit commit and a sha256", () => {
    expect(KIT_COMMIT).toBe("71b8341");
    expect(VALIDATOR_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("KIT_DIR unset fails clearly", () => {
    expect(() => verifiedValidator(undefined)).toThrow(/KIT_DIR is not set/);
    expect(() => runReadiness("docs/los-angeles-sources.yaml", "")).toThrow(
      /KIT_DIR is not set/,
    );
  });

  test("a validator file with another sha256 is refused and never run", () => {
    const kit = mkdtempSync(join(tmpdir(), "kit-mismatch-"));
    try {
      const validator = join(kit, VALIDATOR_PATH);
      const marker = join(kit, "ran");
      mkdirSync(dirname(validator), { recursive: true });
      writeFileSync(
        validator,
        `open(${JSON.stringify(marker)}, "w").write("ran")\nprint('{"overall": "PASS"}')\n`,
      );
      expect(() => verifiedValidator(kit)).toThrow(
        /sha256 [0-9a-f]{64} is not the kit 71b8341 sha256/,
      );
      expect(() => runReadiness("docs/los-angeles-sources.yaml", kit)).toThrow(
        /is not the kit 71b8341 sha256/,
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(kit, { recursive: true, force: true });
    }
  });
});
