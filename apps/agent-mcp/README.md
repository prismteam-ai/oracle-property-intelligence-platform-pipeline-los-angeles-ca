# @oracle-la/agent-mcp

The local stdio MCP server that exposes the `@oracle-la/agent` tools over the data API, and the eval that runs the
agent against a real model on the fifteen prompts in `eval/prompts.json`.

Both read the **latest run** of a repository checkout: `runs/run_history.jsonl`, its last row's `parquet_path`,
`manifest_path` and every `permit_files` path (the property Parquet, the run manifest and the three permit Parquet
files under `data/`). A worktree has `runs/` but no `data/`, so point both at the checkout that has the files
(`<checkout>` below).

## Eval

The eval calls a real provider and spends money. Nothing in the tests runs it; it runs only when you start it.

```sh
node apps/agent-mcp/scripts/eval-demo.ts \
  --provider anthropic --model sonnet-5.5 \
  --key-file <key-file> \
  --repo <checkout> \
  --out <folder outside any checkout> \
  --runs 3 --max-usd 5
```

Usage line:

```text
usage: node scripts/eval-demo.ts --provider <anthropic|bedrock> --model <haiku-5.5|sonnet-5.5> --out <dir> [--key-file <path>, required for --provider anthropic] [--runs 3] [--max-usd 5] [--prompts <file>] [--repo <checkout with the run's data/; default $ORACLE_REPO_DIR, else this checkout>]
```

Through pnpm (`pnpm --filter @oracle-la/agent-mcp eval -- ...`) the command runs in `apps/agent-mcp`, so relative
`--out`, `--repo`, `--key-file` and `--prompts` paths resolve from there; use absolute paths.

### Options

- `--provider anthropic|bedrock` and `--model haiku-5.5|sonnet-5.5` (required): one model per invocation.
  `opus-5.5` is refused: it is not priced for the eval (no cache prices are recorded for it).
- `--key-file <path>`: the Anthropic key file (see below). Required with `--provider anthropic`; with `--provider
  bedrock` it is a usage error.
- `--repo <dir>`: the checkout whose `runs/run_history.jsonl` and `data/` files the tools read. Default: the
  `ORACLE_REPO_DIR` environment variable when it is set and not empty, else this checkout. `--repo` wins over
  `ORACLE_REPO_DIR`.
- `--out <dir>` (required): where the outputs go; created if missing.
- `--runs <n>`: how many times every prompt is asked, 1 to 100 (default 3).
- `--max-usd <usd>`: the spend limit in dollars (default 5).
- `--prompts <file>`: another prompts file (default `eval/prompts.json`, validated on load).

Other settings (tool turns, token caps, time budget, effort) come from the `AGENT_*` environment variables
(`AGENT_MAX_TOOL_TURNS`, `AGENT_MAX_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS`, `AGENT_TIME_BUDGET_MS`, `AGENT_EFFORT`);
`--provider` and `--model` set `AGENT_PROVIDER` and `AGENT_MODEL`.

### The run's data files (`--repo` / `ORACLE_REPO_DIR`)

Before any model call, before the model client is built and before anything is created in `--out`, the eval checks
that the latest run's files exist under `--repo`. If any is missing it exits 2 and names the first one:

```text
eval: the run's data files are missing under <checkout> (first missing: data/out/<run_id>/<name>.parquet; 5 missing). Point the eval at a checkout that has them: --repo <checkout> (or ORACLE_REPO_DIR=<checkout>).
```

A missing `runs/run_history.jsonl` is reported the same way (`first missing: runs/run_history.jsonl; 1 missing`); a
history with no run, or a line that is not JSON, also exits 2.

### Credentials and the key file

- `anthropic`: the API key is read from a key file, never from the environment. The path is the required
  `--key-file <path>` option; there is no default path and no environment variable for it, and the key itself is
  never an argument. Without the option the eval exits 2 with
  `--key-file <path> is required for --provider anthropic`. The file is JSON with an `apiKey` field, and must be a
  regular file with mode `0600` exactly. A key file with another mode, or that is not valid, is refused
  with exit 1; the message names the path, the mode and the reason, never the content.
- `bedrock`: the AWS SDK's credentials (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or
  `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_PROFILE`). The region is fixed in `packages/agent` (`BEDROCK_REGION`).
  `--key-file` is refused (exit 2).

With no credentials for the provider (no file at the `--key-file` path, or none of the AWS variables), the eval
prints `skipped: no key` and exits 0 without creating anything. This check comes first, before the data-file check.

### `--out` rules

- Required. Created (with its parents) only after every check above has passed.
- Refused (exit 2, nothing created) when it resolves inside a repository checkout: this checkout, `ORACLE_REPO_DIR`
  when set, and `--repo`. The check uses the real path of the nearest existing parent, so a symbolic link into a
  checkout is refused too.
- Existing files with the same names are overwritten.

### Spend limit (`--max-usd`)

Spend is the sum over model calls of the API's usage figures (input, cache write, cache read and output tokens) times
the price table in `packages/agent` (`models.ts`); Bedrock prices are the Anthropic prices times 1.1 and are labeled
an estimate. Before each model call the eval computes the call's worst case: `ceil(request JSON characters / 2)`
input tokens at the input price (for Haiku, the over-100,000-token price when that bound exceeds 100,000) plus
`max_tokens` at the output price. If the spend so far plus that worst case would exceed `--max-usd`, the call is not
made, the whole eval stops, the outputs so far are written and the exit code is 1. A call that fails counts at its
worst case.

### Outputs

In `--out`:

- `run-<n>-<prompt id>.json`: one transcript per answer: run, prompt ID, question, history, markdown, records, gaps,
  usage (per model call), spend, the checks with their details, elapsed time, and `stopped_by`.
- `results.tsv` and `results.md`: one row per answer with run, prompt, status, each check (counts, cited, gaps,
  gaps_text, elapsed, tools, refusal, place, ownership), token counts, USD and milliseconds. `results.md` also states the
  provider, model, data run, spend, the worst-case formula and whether the budget stopped the eval.

stdout carries only the short summary: one line per run (passed, failed, spend), a total line with the limit, a
budget-stop line when it applies, and the output folder. Errors go to stderr.

### Exit codes

- `0`: every answer passed, or `skipped: no key`.
- `1`: a check failed, the budget stopped the eval, or the Anthropic key file was refused.
- `2`: a usage error, an `--out` inside a checkout, an invalid prompts file, or the run's data files missing under
  `--repo`.

## MCP server

Over the hosted data API (no run files needed on this machine), with the `mcp` API client's token:

```sh
pnpm --filter @oracle-la/agent-mcp mcp --api-url <data API URL> --token-file <key-file>
```

`--token-file` is required with `--api-url` and has no default: a JSON file `{ "apiToken": "<token>" }` with mode
`0600` exactly (`chmod 600 <key-file>`); the token is never an argument or an environment variable. Another mode, a
missing file, invalid JSON or no `apiToken` refuses to start (exit 1) with the path, the mode and the reason, never
the content; a missing option exits 2. The tools read the data API as the hosted agent does: at most 2 calls in
flight, each attempt at most 5 s, one retry (after 0–500 ms) when the data API is busy (HTTP 429 or 503), another
transient status or a timeout, then the tool reports the gap (e.g. `data API busy: permits.longOpen not read`).

Over the latest run of a checkout, in process:

```sh
ORACLE_REPO_DIR=<checkout> pnpm --filter @oracle-la/agent-mcp mcp
```

The server speaks MCP on stdio over the latest run of `ORACLE_REPO_DIR` (default: this checkout). stdout carries the
protocol only; messages go to stderr. When the run's data files are missing it exits 1 before staging anything, with
the same wording as the eval but without the CLI option:

```text
oracle-la-agent MCP server failed to start: the run's data files are missing under <repo> (first missing: <path>; N missing). Point at a checkout that has them: ORACLE_REPO_DIR=<checkout>.
```
