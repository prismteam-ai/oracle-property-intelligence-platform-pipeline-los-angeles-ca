/**
 * Scope guard: run before any seed or download. Fails (exit 1) when the run's scope
 * differs from the approved permit-gate exception in the sources catalog.
 * It does not change or replace the kit's readiness validator.
 *
 * Usage: node src/scope-guard.ts [run-config.json] [sources.yaml]
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { loadRunConfig, type RunScope } from "./run-config.ts";

export interface ExceptionScope {
  jurisdiction: string;
  zips: string[];
  roll_year: string;
  permits_harvested: boolean;
}

export function exceptionScopeFromCatalog(catalogYaml: string): ExceptionScope {
  const catalog = parse(catalogYaml) as {
    approved_exceptions?: Array<Record<string, unknown>>;
  };
  const entry = (catalog.approved_exceptions ?? []).find(
    (e) => e.gate === "permit",
  );
  if (!entry)
    throw new Error("no approved permit-gate exception in the sources catalog");
  const scope = entry.scope as Record<string, unknown> | undefined;
  if (
    !scope ||
    !Array.isArray(scope.zips) ||
    typeof scope.jurisdiction !== "string" ||
    scope.roll_year === undefined
  ) {
    throw new Error(
      "permit exception has no complete scope (jurisdiction, zips, roll_year)",
    );
  }
  if (typeof entry.permits_harvested !== "boolean") {
    throw new Error("permit exception has no boolean permits_harvested");
  }
  return {
    jurisdiction: scope.jurisdiction,
    zips: scope.zips.map(String),
    roll_year: String(scope.roll_year),
    permits_harvested: entry.permits_harvested,
  };
}

const norm = (s: string) => s.trim().toUpperCase();
const sameSet = (a: string[], b: string[]) => {
  const x = [...new Set(a.map(norm))].sort();
  const y = [...new Set(b.map(norm))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Returns the list of mismatches; empty means the run is inside the approved scope. */
export function checkScope(run: RunScope, allowed: ExceptionScope): string[] {
  const errors: string[] = [];
  if (
    !run.jurisdiction ||
    norm(run.jurisdiction) !== norm(allowed.jurisdiction)
  ) {
    errors.push(
      `jurisdiction "${run.jurisdiction ?? ""}" is not the approved "${allowed.jurisdiction}"`,
    );
  }
  if (
    !Array.isArray(run.zips) ||
    run.zips.length === 0 ||
    !sameSet(run.zips, allowed.zips)
  ) {
    errors.push(
      `zips [${(run.zips ?? []).join(", ")}] are not the approved [${allowed.zips.join(", ")}]`,
    );
  }
  if (String(run.roll_year) !== allowed.roll_year) {
    errors.push(
      `roll_year "${run.roll_year}" is not the approved "${allowed.roll_year}"`,
    );
  }
  if (run.permits_harvested !== allowed.permits_harvested) {
    errors.push(
      `permits_harvested ${run.permits_harvested} is not the approved ${allowed.permits_harvested}`,
    );
  }
  return errors;
}

export function guardOrThrow(runConfigPath: string, catalogPath: string): void {
  const run = loadRunConfig(runConfigPath);
  const allowed = exceptionScopeFromCatalog(readFileSync(catalogPath, "utf8"));
  const errors = checkScope(run, allowed);
  if (errors.length > 0) {
    throw new Error(
      `SCOPE GUARD FAILED: run is outside the approved permit-gate exception:\n - ${errors.join("\n - ")}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const runPath = process.argv[2] ?? "config/la-pilot-run.json";
  const catalogPath = process.argv[3] ?? "docs/los-angeles-sources.yaml";
  try {
    guardOrThrow(runPath, catalogPath);
    console.log(
      `SCOPE GUARD PASS: ${runPath} is inside the approved exception in ${catalogPath}`,
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
