/**
 * The eval CLI (design brief §15.1, §16), behind scripts/eval-demo.ts:
 *
 *   node scripts/eval-demo.ts --provider <anthropic|bedrock> --model <haiku-5.5|sonnet-5.5> --out <dir>
 *     [--key-file <path>, required for --provider anthropic] [--runs 3] [--max-usd 5] [--prompts <file>]
 *     [--repo <checkout with the run's data/; default $ORACLE_REPO_DIR, else this checkout>]
 *
 * One model per invocation; opus-5.5 is refused (not priced: no cache prices recorded). --repo is the checkout
 * whose runs/run_history.jsonl and data/ files the tools read (default ORACLE_REPO_DIR when set and not empty, else
 * this checkout; a worktree usually has runs/ but no data/, so point it at the main checkout). --out is required,
 * created if missing, and refused when it resolves (realpath of its nearest existing ancestor, then the rest of the
 * path) inside a repository checkout (this checkout, ORACLE_REPO_DIR when set, and --repo). The check runs before
 * anything is created. With no credentials for the provider it prints "skipped: no key" and exits 0 (nothing
 * created). Then, before the model client is built and before --out is created, the latest run's files must exist
 * under --repo (runs/run_history.jsonl, its parquet_path, manifest_path and every permit_files path); if any is
 * missing it exits 2 with a message that names the first missing file, the count, --repo and ORACLE_REPO_DIR.
 * Credentials:
 * anthropic: the key file named by --key-file <path> exists (the option is required for this provider, with no
 * default path and no environment variable; its mode and content are checked when the client is built; a refusal
 * names path, mode and reason, never the content);
 * bedrock: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK, or AWS_PROFILE (--key-file is a
 * usage error).
 * Other settings (tool turns, token caps, time budget, effort) come from the AGENT_* environment (config.ts).
 * stdout carries the short summary only; errors go to stderr. Exit codes: 0 all passed (or skipped), 1 a check
 * failed, the budget stopped the eval or the key file was refused, 2 a usage, output-folder, prompts-file or
 * run-data error.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AnthropicKeyFileError,
  PRICED_MODEL_KEYS,
  PROVIDERS,
  createModelClient,
  isPricedModel,
  loadConfig,
  type AgentConfig,
  type DataQueries,
  type ModelClient,
  type PricedModelKey,
  type Provider,
} from "@oracle-la/agent";
import {
  DEFAULT_PROMPTS_FILE,
  PromptsFileError,
  loadPrompts,
} from "./prompts.ts";
import {
  RunHistoryError,
  missingRunFiles,
  runFilesMissingText,
} from "../run-files.ts";
import { runEval } from "./run-eval.ts";

export const USAGE =
  "usage: node scripts/eval-demo.ts --provider <anthropic|bedrock> --model <haiku-5.5|sonnet-5.5> --out <dir> [--key-file <path>, required for --provider anthropic] [--runs 3] [--max-usd 5] [--prompts <file>] [--repo <checkout with the run's data/; default $ORACLE_REPO_DIR, else this checkout>]";

/** How to point the eval at a checkout with the run's files (the end of a run-data error). */
const POINT_AT_DATA =
  "Point the eval at a checkout that has them: --repo <checkout> (or ORACLE_REPO_DIR=<checkout>).";

/** This checkout's root (this file is apps/agent-mcp/src/eval/cli.ts); local-data.ts's DEFAULT_REPO_ROOT too. */
export const CHECKOUT_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);

export const DEFAULT_RUNS = 3;
export const DEFAULT_MAX_USD = 5;
export const MAX_RUNS = 100;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class OutDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutDirError";
  }
}

/** The data checkout --repo defaults to: ORACLE_REPO_DIR when set and not empty, else this checkout. */
export function defaultRepo(env: Record<string, string | undefined>): string {
  return resolve(env.ORACLE_REPO_DIR || CHECKOUT_ROOT);
}

/**
 * The eval's message when the latest run's files are missing under `repo` (exit 2), e.g. "eval: the run's data
 * files are missing under /x (first missing: data/out/r/p.parquet; 5 missing). Point the eval at a checkout that has
 * them: --repo <checkout> (or ORACLE_REPO_DIR=<checkout>)."
 */
export function runFilesMissingMessage(
  repo: string,
  missing: readonly string[],
): string {
  return `eval: ${runFilesMissingText(repo, missing)}. ${POINT_AT_DATA}`;
}

export interface CliArgs {
  provider: Provider;
  model: PricedModelKey;
  out: string;
  /** The Anthropic key file's path as given (--key-file; provider "anthropic" only, where it is required). */
  keyFile?: string;
  runs: number;
  maxUsd: number;
  prompts: string;
  /** The data checkout, absolute (--repo, else ORACLE_REPO_DIR, else this checkout). */
  repo: string;
}

/**
 * Parse and validate the arguments (node:util parseArgs, strict); throws UsageError. `env` gives --repo's default
 * (ORACLE_REPO_DIR).
 */
export function parseCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): CliArgs {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        provider: { type: "string" },
        model: { type: "string" },
        out: { type: "string" },
        "key-file": { type: "string" },
        runs: { type: "string" },
        "max-usd": { type: "string" },
        prompts: { type: "string" },
        repo: { type: "string" },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const provider = values.provider;
  if (!provider || !(PROVIDERS as readonly string[]).includes(provider))
    throw new UsageError(
      `--provider must be one of ${PROVIDERS.join(", ")}${provider ? ` (got ${provider})` : ""}`,
    );
  const model = values.model;
  if (model === "opus-5.5")
    throw new UsageError(
      "opus-5.5 is not priced for the eval (no cache prices are recorded for it); use haiku-5.5 or sonnet-5.5",
    );
  if (!model || !isPricedModel(model))
    throw new UsageError(
      `--model must be one of ${PRICED_MODEL_KEYS.join(", ")}${model ? ` (got ${model})` : ""}`,
    );
  if (!values.out) throw new UsageError("--out <dir> is required");
  const keyFile = values["key-file"];
  if (provider === "anthropic" && !keyFile)
    throw new UsageError(
      "--key-file <path> is required for --provider anthropic",
    );
  if (provider !== "anthropic" && keyFile !== undefined)
    throw new UsageError("--key-file applies to --provider anthropic only");
  if (values.repo === "")
    throw new UsageError(
      "--repo needs a checkout folder (the one with the run's data/)",
    );
  const runsText = values.runs ?? String(DEFAULT_RUNS);
  const runs = Number(runsText);
  if (!/^\d+$/.test(runsText) || runs < 1 || runs > MAX_RUNS)
    throw new UsageError(
      `--runs must be a whole number from 1 to ${MAX_RUNS} (got ${runsText})`,
    );
  const maxText = values["max-usd"] ?? String(DEFAULT_MAX_USD);
  const maxUsd = Number(maxText);
  if (!/^\d+(?:\.\d+)?$/.test(maxText) || !(maxUsd > 0))
    throw new UsageError(
      `--max-usd must be a positive number of dollars (got ${maxText})`,
    );
  return {
    provider: provider as Provider,
    model,
    out: values.out,
    ...(keyFile !== undefined ? { keyFile } : {}),
    runs,
    maxUsd,
    prompts: values.prompts ?? DEFAULT_PROMPTS_FILE,
    repo: values.repo ? resolve(values.repo) : defaultRepo(env),
  };
}

/**
 * The real path of `out` without creating anything: the realpath of its nearest existing ancestor, then the rest
 * of the path. Throws OutDirError when it is inside (or is) one of the repository checkouts (their realpaths).
 */
export function resolveOutDir(
  out: string,
  repoRoots: readonly string[],
): string {
  let p = resolve(out);
  const rest: string[] = [];
  while (!existsSync(p)) {
    const parent = dirname(p);
    if (parent === p) break;
    rest.unshift(basename(p));
    p = parent;
  }
  const real = join(realpathSync(p), ...rest);
  for (const root of repoRoots) {
    if (!existsSync(root)) continue;
    const r = realpathSync(root);
    if (real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))
      throw new OutDirError(
        `--out ${out} resolves to ${real}, inside the repository checkout ${r}; choose a folder outside it`,
      );
  }
  return real;
}

/**
 * Whether the provider has credentials to try (the eval never reads a key itself). `keyFile` is --key-file's path
 * (provider "anthropic").
 */
export function hasCredentials(
  provider: Provider,
  env: Record<string, string | undefined>,
  keyFile?: string,
): boolean {
  if (provider === "anthropic")
    return keyFile !== undefined && existsSync(keyFile);
  return Boolean(
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
    env.AWS_BEARER_TOKEN_BEDROCK ||
    env.AWS_PROFILE,
  );
}

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface CliDeps {
  env: Record<string, string | undefined>;
  /** Checkouts --out must stay out of besides --repo, which is always added (default: this checkout and
   * ORACLE_REPO_DIR). */
  repoRoots?: readonly string[];
  hasCredentials?: (
    provider: Provider,
    env: Record<string, string | undefined>,
    keyFile?: string,
  ) => boolean;
  /** The model client factory; `config.anthropicKeyFile` is --key-file's path. */
  createModel?: (config: AgentConfig) => ModelClient;
  /** The data the tools read (default: the latest run of the --repo checkout, local-data.ts). The run's files
   * are checked under --repo before this is called. */
  openData?: (repo: string) => Promise<{ queries: DataQueries; runId: string }>;
  now?: () => number;
}

async function defaultOpenData(repo: string) {
  // Imported here so tests that inject data never load DuckDB.
  const { openLocalData } = await import("../local-data.ts");
  return openLocalData({ repoRoot: repo });
}

/** Run the CLI; returns the exit code. */
export async function main(
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const env = deps.env;
  let args: CliArgs;
  let outDir: string;
  try {
    args = parseCliArgs(argv, env);
    outDir = resolveOutDir(args.out, [
      ...(deps.repoRoots ?? [
        CHECKOUT_ROOT,
        ...(env.ORACLE_REPO_DIR ? [env.ORACLE_REPO_DIR] : []),
      ]),
      args.repo,
    ]);
  } catch (err) {
    if (err instanceof UsageError || err instanceof OutDirError) {
      io.stderr(err.message);
      if (err instanceof UsageError) io.stderr(USAGE);
      return 2;
    }
    throw err;
  }
  let prompts;
  try {
    prompts = loadPrompts(args.prompts);
  } catch (err) {
    if (err instanceof PromptsFileError) {
      io.stderr(err.message);
      return 2;
    }
    throw err;
  }
  if (
    !(deps.hasCredentials ?? hasCredentials)(args.provider, env, args.keyFile)
  ) {
    io.stdout("skipped: no key");
    return 0;
  }
  // The run's files under --repo, before the model client is built and before --out is created.
  try {
    const missing = missingRunFiles(args.repo);
    if (missing.length > 0) {
      io.stderr(runFilesMissingMessage(args.repo, missing));
      return 2;
    }
  } catch (err) {
    if (err instanceof RunHistoryError) {
      io.stderr(`eval: ${err.message}. ${POINT_AT_DATA}`);
      return 2;
    }
    throw err;
  }
  const config = loadConfig(
    {
      ...env,
      AGENT_PROVIDER: args.provider,
      AGENT_MODEL: args.model,
    },
    { anthropicKeyFile: args.keyFile },
  );
  let model: ModelClient;
  try {
    model = (deps.createModel ?? createModelClient)(config);
  } catch (err) {
    // The refusal names the path, the mode and the reason; never the file's content.
    if (err instanceof AnthropicKeyFileError) {
      io.stderr(err.message);
      return 1;
    }
    throw err;
  }
  mkdirSync(outDir, { recursive: true });
  const data = await (deps.openData ?? defaultOpenData)(args.repo);
  const result = await runEval(
    {
      provider: args.provider,
      model: args.model,
      runs: args.runs,
      maxUsd: args.maxUsd,
      outDir,
      prompts,
    },
    {
      model,
      queries: data.queries,
      settings: config,
      dataRunId: data.runId,
      ...(deps.now ? { now: deps.now } : {}),
    },
  );
  for (const line of result.summary) io.stdout(line);
  return result.exitCode;
}
