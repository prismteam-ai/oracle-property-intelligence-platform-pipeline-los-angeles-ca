/**
 * The Explorer's commit (change 13): computed at build from git over EXPLORER_SOURCE_PATHS and injected with a
 * Vite define; the build fails when a bundled repository file lies outside those paths. No environment value.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import config, {
  EXPLORER_SOURCE_PATHS,
  explorerCommit,
  uncoveredModules,
} from "../vite.config.ts";
import { EXPLORER_COMMIT } from "../src/commit.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const define = (command: "build" | "serve") => {
  const c =
    typeof config === "function"
      ? config({ command, mode: "production" })
      : config;
  return (c as { define?: Record<string, string> }).define;
};

describe("the Explorer's commit", () => {
  test("every source path exists in the repository", () => {
    for (const p of EXPLORER_SOURCE_PATHS)
      expect(existsSync(`${root}${p}`), p).toBe(true);
  });

  test("the commit is a 7-character hash (with -dirty for uncommitted changes in those paths)", () => {
    expect(explorerCommit(root)).toMatch(/^[0-9a-f]{7}(-dirty)?$/);
  });

  test("a build defines __EXPLORER_COMMIT__ as that commit; the dev server and the tests have none", () => {
    expect(define("build")).toEqual({
      __EXPLORER_COMMIT__: JSON.stringify(explorerCommit(root)),
    });
    expect(define("serve")).toEqual({
      __EXPLORER_COMMIT__: JSON.stringify("unbundled"),
    });
    // Run from source (no define): "unbundled".
    expect(EXPLORER_COMMIT).toBe("unbundled");
  });

  test("the coverage check flags a repository file outside the paths; node_modules, virtual modules and queries pass", () => {
    expect(
      uncoveredModules(
        [
          `${root}apps/explorer/src/App.tsx`,
          `${root}apps/explorer/src/styles.css?direct`,
          `${root}packages/agent/src/tools.ts`,
          `${root}packages/agent/src/prompt.ts`,
          `${root}docs/runbook.md`,
          `${root}apps/explorer/node_modules/react/index.js`,
          "\0vite/modulepreload-polyfill.js",
        ],
        root,
      ),
    ).toEqual(["docs/runbook.md", "packages/agent/src/prompt.ts"]);
  });
});
