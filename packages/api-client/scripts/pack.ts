/**
 * Pack @oracle-la/api-client as a self-contained tarball for the CRM repo (the client reaches the CRM as a vendored tarball with UPSTREAM.json).
 * - dist/index.js: the client (esbuild, ESM)
 * - dist/index.d.ts + dist/types/**: declarations of the API router and contract (tsc), so the CRM gets the
 *   same AppRouter type without the server code.
 * Usage: node packages/api-client/scripts/pack.ts <out-dir>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const repo = new URL("../../../", import.meta.url).pathname;
const pkgDir = join(repo, "packages/api-client");
const stage = join(pkgDir, "build/pack");
const out = process.argv[2];
if (!out) throw new Error("usage: pack.ts <out-dir>");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });

const tsconfig = join(pkgDir, "build/tsconfig.pack.json");
writeFileSync(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      target: "es2023",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      skipLibCheck: true,
      declaration: true,
      emitDeclarationOnly: true,
      rewriteRelativeImportExtensions: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      rootDir: repo,
      outDir: join(stage, "dist/types"),
      types: ["node"],
    },
    files: [
      join(repo, "apps/api/src/routers/index.ts"),
      join(repo, "apps/api/src/contract.ts"),
    ],
  }),
);
execFileSync(join(repo, "node_modules/.bin/tsc"), ["-p", tsconfig], {
  stdio: "inherit",
});

const pub = (p: string) => `./types/apps/api/src/${p}`;
execFileSync(
  join(repo, "apps/api/node_modules/.bin/esbuild"),
  [
    join(pkgDir, "src/index.ts"),
    "--bundle",
    "--format=esm",
    "--platform=neutral",
    `--outfile=${join(stage, "dist/index.js")}`,
    "--external:@trpc/client",
  ],
  { stdio: "inherit" },
);
writeFileSync(
  join(stage, "dist/index.d.ts"),
  `import type { TRPCClient } from "@trpc/client";
import type { AppRouter } from "${pub("routers/index.js")}";
export type { AppRouter };
export type * from "${pub("contract.js")}";
export interface ApiClientOptions { apiUrl: string; apiToken: string }
export declare function createApiClient(options: ApiClientOptions): TRPCClient<AppRouter>;
export type ApiClient = ReturnType<typeof createApiClient>;
`,
);
const own = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const api = JSON.parse(
  readFileSync(join(repo, "apps/api/package.json"), "utf8"),
);
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: own.name,
      version: own.version,
      type: "module",
      license: "UNLICENSED",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
      files: ["dist"],
      dependencies: {
        "@trpc/client": own.dependencies["@trpc/client"],
        "@trpc/server": api.dependencies["@trpc/server"],
        zod: api.dependencies.zod,
      },
    },
    null,
    2,
  ),
);
mkdirSync(out, { recursive: true });
execFileSync("pnpm", ["pack", "--pack-destination", out], {
  cwd: stage,
  stdio: "inherit",
});
const tgz = readdirSync(out).find(
  (f) => f.startsWith("oracle-la-api-client-") && f.endsWith(".tgz"),
)!;
const sha = createHash("sha256")
  .update(readFileSync(join(out, tgz)))
  .digest("hex");
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync(
    "git",
    ["status", "--porcelain", "--", "apps/api/src", "packages/api-client"],
    { cwd: repo, encoding: "utf8" },
  ).trim() !== "";
writeFileSync(
  join(out, "UPSTREAM.json"),
  JSON.stringify(
    {
      package: own.name,
      version: own.version,
      tarball: tgz,
      sha256: sha,
      source_repo:
        "oracle-property-intelligence-platform-pipeline-los-angeles-ca",
      source_commit: head,
      source_uncommitted_changes: dirty,
      built_at: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
cpSync(join(stage, "dist"), join(out, ".last-dist"), { recursive: true });
rmSync(join(out, ".last-dist"), { recursive: true, force: true });
console.log(`packed ${tgz} sha256 ${sha}`);
