/**
 * County readiness from the kit's own validator (use-oracle validate-county-readiness.py).
 * The build runs the validator on the sources catalog and records its real output in the run
 * manifest. It fails closed unless the validator passes with the approved permit-gate exception
 * and allows seed and ingest.
 *
 * The validator is taken from the kit checkout named by KIT_DIR. Its file must match the sha256
 * of the same file at the pinned kit commit; the commit recorded is that constant, never the
 * checkout's HEAD.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KIT_COMMIT = "71b8341";
export const VALIDATOR_PATH =
  "skills/use-oracle/scripts/validate-county-readiness.py";
/** sha256 of VALIDATOR_PATH at KIT_COMMIT. */
export const VALIDATOR_SHA256 =
  "5c5b85159371184d24b929e4fd9610ed0373399a9b890715b0683ef8929abb3d";

const ACCEPTED_GATE_STATUSES = new Set([
  "PASS",
  "APPROVED_EXCEPTION",
  "NOT_APPLICABLE",
]);

export interface GateStatus {
  gate: string;
  status: string;
}

export interface ReadinessRecord {
  validator: { kit_commit: string; path: string; sha256: string };
  catalog: string;
  overall: string;
  gates: GateStatus[];
  seed_allowed: boolean;
  ingest_allowed: boolean;
  output_sha256: string;
}

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Parse the validator's stdout and apply the fail-closed rule. Returns overall, the status of
 * every gate, seed/ingest flags and the sha256 of the output bytes; throws otherwise.
 */
export function acceptReadinessOutput(
  stdout: Buffer | string,
): Omit<ReadinessRecord, "validator" | "catalog"> {
  let report: Record<string, unknown>;
  try {
    report = JSON.parse(stdout.toString()) as Record<string, unknown>;
  } catch {
    throw new Error("READINESS FAILED: validator output is not JSON");
  }
  const gates = Array.isArray(report.gates)
    ? (report.gates as Array<Record<string, unknown>>).map((g) => ({
        gate: String(g.gate),
        status: String(g.status),
      }))
    : [];
  const problems: string[] = [];
  if (report.overall !== "PASS")
    problems.push(`overall is ${String(report.overall)}`);
  if (report.seed_allowed !== true) problems.push("seed_allowed is not true");
  if (report.ingest_allowed !== true)
    problems.push("ingest_allowed is not true");
  if (gates.length === 0) problems.push("no gates in the output");
  for (const g of gates)
    if (!ACCEPTED_GATE_STATUSES.has(g.status))
      problems.push(`gate ${g.gate} is ${g.status}`);
  const permit = gates.find((g) => g.gate === "permit");
  if (permit?.status !== "APPROVED_EXCEPTION")
    problems.push(
      `permit gate is ${permit?.status ?? "missing"}, not APPROVED_EXCEPTION`,
    );
  if (problems.length > 0)
    throw new Error(`READINESS FAILED:\n - ${problems.join("\n - ")}`);
  return {
    overall: "PASS",
    gates,
    seed_allowed: true,
    ingest_allowed: true,
    output_sha256: sha256(stdout),
  };
}

/** Check the validator file against VALIDATOR_SHA256 and return its path; throws on a mismatch. */
export function verifiedValidator(kitDir: string | undefined): string {
  if (!kitDir)
    throw new Error(
      `KIT_DIR is not set: point it at a soofi-xyz team kit checkout whose ${VALIDATOR_PATH} matches kit commit ${KIT_COMMIT}`,
    );
  const path = join(kitDir, VALIDATOR_PATH);
  const actual = sha256(readFileSync(path));
  if (actual !== VALIDATOR_SHA256)
    throw new Error(
      `READINESS FAILED: ${VALIDATOR_PATH} sha256 ${actual} is not the kit ${KIT_COMMIT} sha256 ${VALIDATOR_SHA256}`,
    );
  return path;
}

/** Run the verified validator on the catalog (relative to cwd) and accept its output or throw. */
export function runReadiness(
  catalogPath: string,
  kitDir: string | undefined = process.env.KIT_DIR,
): ReadinessRecord {
  const validator = verifiedValidator(kitDir);
  const res = spawnSync("python3", ["-I", validator, catalogPath], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error)
    throw new Error(`READINESS FAILED: ${res.error.message}`, {
      cause: res.error,
    });
  if (res.status !== 0) {
    let detail = res.stderr.toString().trim();
    try {
      acceptReadinessOutput(res.stdout);
    } catch (err) {
      detail = (err as Error).message;
    }
    throw new Error(
      `READINESS FAILED: validator exited ${res.status}: ${detail}`,
    );
  }
  const accepted = acceptReadinessOutput(res.stdout);
  return {
    validator: {
      kit_commit: KIT_COMMIT,
      path: VALIDATOR_PATH,
      sha256: VALIDATOR_SHA256,
    },
    catalog: catalogPath,
    ...accepted,
  };
}
