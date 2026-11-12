/**
 * Scope guard: run before any seed or download. Fails (exit 1) unless the run's scope
 * matches one of the approved permit-gate exceptions in the sources catalog (jurisdiction,
 * ZIP set, roll year and permits flag).
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

function scopeOf(entry: Record<string, unknown>, n: number): ExceptionScope {
  const scope = entry.scope as Record<string, unknown> | undefined;
  if (
    !scope ||
    !Array.isArray(scope.zips) ||
    typeof scope.jurisdiction !== "string" ||
    scope.roll_year === undefined
  ) {
    throw new Error(
      `permit exception ${n} has no complete scope (jurisdiction, zips, roll_year)`,
    );
  }
  if (typeof entry.permits_harvested !== "boolean") {
    throw new Error(`permit exception ${n} has no boolean permits_harvested`);
  }
  return {
    jurisdiction: scope.jurisdiction,
    zips: scope.zips.map(String),
    roll_year: String(scope.roll_year),
    permits_harvested: entry.permits_harvested,
  };
}

/** Every permit-gate exception's scope, in catalog order. */
export function exceptionScopesFromCatalog(
  catalogYaml: string,
): ExceptionScope[] {
  const catalog = parse(catalogYaml) as {
    approved_exceptions?: Array<Record<string, unknown>>;
  };
  const entries = (catalog.approved_exceptions ?? []).filter(
    (e) => e.gate === "permit",
  );
  if (entries.length === 0)
    throw new Error("no approved permit-gate exception in the sources catalog");
  return entries.map((e, i) => scopeOf(e, i + 1));
}

const norm = (s: string) => s.trim().toUpperCase();
const sameSet = (a: string[], b: string[]) => {
  const x = [...new Set(a.map(norm))].sort();
  const y = [...new Set(b.map(norm))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Returns the list of mismatches; empty means the run is inside this exception's scope. */
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
  // An exception without ZIP codes allows only a run without a ZIP filter, and the reverse.
  if (!Array.isArray(run.zips) || !sameSet(run.zips, allowed.zips)) {
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

/**
 * The run passes when it is inside the scope of one permit-gate exception. Returns the
 * matching exception's number (1-based, catalog order among permit exceptions); throws
 * with every exception's mismatches otherwise.
 */
export function matchException(
  run: RunScope,
  allowed: ExceptionScope[],
): number {
  const mismatches = allowed.map((a) => checkScope(run, a));
  const i = mismatches.findIndex((m) => m.length === 0);
  if (i >= 0) return i + 1;
  throw new Error(
    "SCOPE GUARD FAILED: run is outside every approved permit-gate exception:\n" +
      mismatches
        .map((m, n) => ` exception ${n + 1}:\n - ${m.join("\n - ")}`)
        .join("\n"),
  );
}

export function guardOrThrow(
  runConfigPath: string,
  catalogPath: string,
): number {
  return matchException(
    loadRunConfig(runConfigPath),
    exceptionScopesFromCatalog(readFileSync(catalogPath, "utf8")),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const runPath = process.argv[2] ?? "config/la-pilot-run.json";
  const catalogPath = process.argv[3] ?? "docs/los-angeles-sources.yaml";
  try {
    const n = guardOrThrow(runPath, catalogPath);
    console.log(
      `SCOPE GUARD PASS: ${runPath} is inside approved permit exception ${n} in ${catalogPath}`,
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
