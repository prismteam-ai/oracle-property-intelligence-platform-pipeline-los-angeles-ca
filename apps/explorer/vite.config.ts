import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { parsePublications } from "../../src/publications.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The repository paths the Explorer bundle's code comes from: every module of the bundle outside node_modules lies
 * under one of them (checked at every build, see sourcePathsCover), the files copied into dist (index.html,
 * public) and what decides how they are built (this file, the app's package.json and tsconfig, the shared React
 * tsconfig) are listed too, and the lockfile pins the third-party code. A commit that changes none of them (e.g.
 * docs only) leaves dist byte-identical.
 */
export const EXPLORER_SOURCE_PATHS = [
  "apps/explorer/src",
  "apps/explorer/index.html",
  "apps/explorer/public",
  "apps/explorer/vite.config.ts",
  "apps/explorer/package.json",
  "apps/explorer/tsconfig.json",
  "packages/tsconfig/react.json",
  "packages/tsconfig/base.json",
  "packages/agent/src/contractor-coverage.ts",
  "packages/agent/src/http-data.ts",
  "packages/agent/src/ownership.ts",
  "packages/agent/src/permit-api.ts",
  "packages/agent/src/policy.ts",
  "packages/agent/src/tools.ts",
  "packages/api-client/src",
  "packages/views/src/place-index.ts",
  "packages/views/src/sql.ts",
  "pnpm-lock.yaml",
  "runs/publications.jsonl",
  "src/publications.ts",
] as const;

/**
 * The short hash (7 characters) of the last commit that changed EXPLORER_SOURCE_PATHS, read with git at build;
 * with "-dirty" appended when those paths have uncommitted changes. The page shows it (a Vite define, no
 * environment value).
 */
export function explorerCommit(repoRoot: string = REPO_ROOT): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const full = git("log", "-1", "--format=%H", "--", ...EXPLORER_SOURCE_PATHS);
  if (!/^[0-9a-f]{40}$/.test(full))
    throw new Error(
      `no commit found for the Explorer's source paths in ${repoRoot} (git log printed "${full}")`,
    );
  const dirty =
    git("status", "--porcelain", "--", ...EXPLORER_SOURCE_PATHS) !== "";
  return `${full.slice(0, 7)}${dirty ? "-dirty" : ""}`;
}

/** The bundled modules' repository paths that lie under none of EXPLORER_SOURCE_PATHS (none expected). */
export function uncoveredModules(
  moduleIds: Iterable<string>,
  repoRoot: string = REPO_ROOT,
): string[] {
  const root = realpathSync(repoRoot);
  const out = new Set<string>();
  for (const id of moduleIds) {
    // Virtual modules (\0…, plugin ids) are not files; a query (?…) is not part of the path.
    const file = id.split("?")[0]!;
    if (!isAbsolute(file)) continue;
    const rel = relative(root, realpathSync(file)).split("\\").join("/");
    if (rel.startsWith("..") || rel.split("/").includes("node_modules"))
      continue;
    if (
      !EXPLORER_SOURCE_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`))
    )
      out.add(rel);
  }
  return [...out].sort();
}

/** Fails the build when a bundled repository file is outside EXPLORER_SOURCE_PATHS (the commit would miss it). */
function sourcePathsCover(): Plugin {
  return {
    name: "explorer-source-paths-cover",
    apply: "build",
    generateBundle(_options, bundle) {
      const ids = Object.values(bundle).flatMap((o) =>
        o.type === "chunk" ? o.moduleIds : [],
      );
      const missing = uncoveredModules(ids);
      if (missing.length)
        this.error(
          `EXPLORER_SOURCE_PATHS misses bundled files: ${missing.join(", ")}`,
        );
    },
  };
}

/** Fails the build when runs/publications.jsonl (bundled into the run history) has a malformed line. */
function publicationsWellFormed(repoRoot: string = REPO_ROOT): Plugin {
  return {
    name: "explorer-publications-well-formed",
    apply: "build",
    buildStart() {
      try {
        parsePublications(
          readFileSync(`${repoRoot}runs/publications.jsonl`, "utf8"),
        );
      } catch (err) {
        this.error((err as Error).message);
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), sourcePathsCover(), publicationsWellFormed()],
  build: { target: "es2022" },
  define: {
    // The Explorer's own commit, shown on the page (src/commit.ts EXPLORER_COMMIT); computed at build only.
    __EXPLORER_COMMIT__: JSON.stringify(
      command === "build" ? explorerCommit() : "unbundled",
    ),
  },
}));
