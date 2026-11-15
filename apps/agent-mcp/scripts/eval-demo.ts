/**
 * Eval CLI (the code is src/eval/*.ts). Never run in this lane: it calls a real provider.
 *
 *   node scripts/eval-demo.ts --provider <anthropic|bedrock> --model <haiku-5.5|sonnet-5.5> --out <dir>
 *     [--key-file <path>, required for --provider anthropic] [--runs 3] [--max-usd 5] [--prompts <file>]
 *     [--repo <checkout with the run's data/; default $ORACLE_REPO_DIR, else this checkout>]
 *
 * --repo (or ORACLE_REPO_DIR) names the checkout whose runs/ and data/ the tools read; a worktree without data/
 * fails with exit 2 before any model call. --key-file names the Anthropic key file (no default path, no environment
 * variable). --out must resolve outside the repository checkouts. See
 * src/eval/cli.ts for the checks, the spend limit and the exit codes, and README.md for the walkthrough.
 */
import { main } from "../src/eval/cli.ts";

process.exitCode = await main(
  process.argv.slice(2),
  {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  },
  { env: process.env },
);
