/**
 * Demo eval (design brief §9 as amended by §11; NOT run in phase A). The two agent prompts of the pipeline README
 * (lines 108 and 110), "[city xyz]" → "Van Nuys", asked as ONE conversation (history and session carried from
 * prompt 1 to prompt 2) with NO center: the agent must resolve "Van Nuys" itself through resolve_place, from the
 * run's own parcels. Data: the local run files through the data API's openDb.
 *
 * Runs only when AGENT_PROVIDER and AGENT_MODEL are set and the provider has a key; otherwise it prints
 * "skipped: no key" and exits 0.
 * - anthropic: the key file named by the required --key-file <path> option exists (no default path; without the
 *   option the script exits 2 with a usage error naming it). Format: JSON { "apiKey": "<key>" }, a regular file
 *   with mode exactly 0600. If it exists but is refused (wrong mode, not a regular file, invalid JSON, no apiKey),
 *   the refusal is printed (path, mode and reason; never the file's content) and the exit code is 1.
 *   ANTHROPIC_API_KEY is never read and has no effect.
 * - bedrock: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK, or AWS_PROFILE. --key-file
 *   is a usage error (exit 2).
 *
 * Each answer prints its markdown, status, records, gaps, usage and elapsed time, then the checks:
 * - every prompt: status answered; at least one record; every standard gap; elapsed under the budget; the
 *   markdown has "How this was answered", "Assumptions", "Records cited" and "Gaps";
 * - prompt 1: called resolve_place;
 * - prompt 2: its search tool inputs reuse prompt 1's center and radius (prompt 1's returned session.area).
 * The permit tools read the data API's permits.longOpen and permits.forParcel over the same Db (local-data.ts
 * passes the history row's permit_files to openDb). Exit code 1 if any check fails.
 *
 *   AGENT_PROVIDER=anthropic AGENT_MODEL=<model> node scripts/eval-demo.ts --key-file <key-file>
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  AnthropicKeyFileError,
  STANDARD_GAPS,
  createModelClient,
  loadConfig,
  runAgent,
  toolSchemas,
  type AgentAnswer,
  type AgentRequest,
  type ModelClient,
  type SessionArea,
} from "@oracle-la/agent";
import { openLocalData } from "../src/local-data.ts";

const env = process.env;
const USAGE =
  "usage: AGENT_PROVIDER=<anthropic|bedrock> AGENT_MODEL=<model> node scripts/eval-demo.ts [--key-file <path>, required for AGENT_PROVIDER=anthropic]";

/** A usage error: the message and the usage line on stderr, exit code 2. */
function usageError(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

let keyFile: string | undefined;
try {
  ({
    values: { "key-file": keyFile },
  } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: { "key-file": { type: "string" } },
  }));
} catch (err) {
  usageError(err instanceof Error ? err.message : String(err));
}
if (env.AGENT_PROVIDER === "anthropic" && !keyFile)
  usageError("--key-file <path> is required for AGENT_PROVIDER=anthropic");
if (
  env.AGENT_PROVIDER &&
  env.AGENT_PROVIDER !== "anthropic" &&
  keyFile !== undefined
)
  usageError("--key-file applies to AGENT_PROVIDER=anthropic only");

const hasKey =
  env.AGENT_PROVIDER === "anthropic"
    ? keyFile !== undefined && existsSync(keyFile)
    : env.AGENT_PROVIDER === "bedrock"
      ? Boolean(
          (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
          env.AWS_BEARER_TOKEN_BEDROCK ||
          env.AWS_PROFILE,
        )
      : false;

if (!env.AGENT_PROVIDER || !env.AGENT_MODEL || !hasKey) {
  console.log("skipped: no key");
  process.exit(0);
}

const SECTIONS = [
  "## How this was answered",
  "## Assumptions",
  "## Records cited",
  "## Gaps",
];
const SEARCH_TOOLS = ["search_aged_roofs", "long_open_permits"] as const;
type SearchTool = (typeof SEARCH_TOOLS)[number];
const isSearchTool = (name: string): name is SearchTool =>
  (SEARCH_TOOLS as readonly string[]).includes(name);

type Message = NonNullable<AgentRequest["history"]>[number];
type Block = Exclude<Message["content"], string>[number];
type ToolUse = Extract<Block, { type: "tool_use" }>;

/** The tool calls the model made in this answer (the history entries after the previous history). */
function toolCalls(
  a: AgentAnswer,
  previousLength: number,
): Array<{ name: string; input: unknown }> {
  return a.history
    .slice(previousLength)
    .flatMap((m) =>
      m.role === "assistant" && typeof m.content !== "string"
        ? m.content
            .filter((b): b is ToolUse => b.type === "tool_use")
            .map((b) => ({ name: b.name, input: b.input }))
        : [],
    );
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

const config = loadConfig(env, { anthropicKeyFile: keyFile });
let model: ModelClient;
try {
  model = createModelClient(config);
} catch (err) {
  // The refusal names the path, the mode and the reason; it never contains the file's content.
  if (err instanceof AnthropicKeyFileError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
const data = await openLocalData({ repoRoot: env.ORACLE_REPO_DIR });
const prompts = [
  "Which properties in Los Angeles County within five miles of Van Nuys have roofs older than 15 years?",
  "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?",
];

let failed = 0;
let history: Message[] = [];
let session: AgentRequest["session"] = {};
let firstArea: SessionArea | undefined;
console.log(
  `run ${data.runId}, provider ${config.provider}, model ${config.modelId}, budget ${config.timeBudgetMs} ms`,
);
for (const [i, question] of prompts.entries()) {
  const previousLength = history.length;
  const a: AgentAnswer = await runAgent(
    { question, history, session },
    { model, queries: data.queries, settings: config },
  );
  history = a.history;
  session = a.session;
  const calls = toolCalls(a, previousLength);
  console.log(`\n=== Prompt ${i + 1}: ${question}\n`);
  console.log(a.markdown);
  console.log(
    `\nstatus ${a.status}${a.stopped_by ? ` (${a.stopped_by}${a.error ? `: ${a.error}` : ""})` : ""}; records ${a.records.length}; gaps ${a.gaps.length}; ` +
      `usage in ${a.usage.input_tokens} / out ${a.usage.output_tokens} tokens, ${a.usage.model_calls} model calls, ${a.usage.tool_calls} tool calls; ${a.elapsed_ms} ms; ` +
      `tools: ${calls.map((c) => c.name).join(", ") || "none"}`,
  );
  const checks: Array<[string, boolean]> = [
    ["status answered", a.status === "answered"],
    ["at least one record", a.records.length >= 1],
    ["every standard gap", STANDARD_GAPS.every((g) => a.gaps.includes(g))],
    [
      `elapsed under ${config.timeBudgetMs} ms`,
      a.elapsed_ms < config.timeBudgetMs,
    ],
    [
      "markdown has the four sections",
      SECTIONS.every((s) => a.markdown.includes(s)),
    ],
  ];
  if (i === 0) {
    checks.push([
      "called resolve_place",
      calls.some((c) => c.name === "resolve_place"),
    ]);
    firstArea = a.session.area;
  } else {
    // The inputs as the tool ran them (schema defaults applied, e.g. radius_miles 5).
    const searches = calls.flatMap((c) => {
      if (!isSearchTool(c.name)) return [];
      const parsed = toolSchemas[c.name].safeParse(c.input);
      return parsed.success
        ? [parsed.data]
        : [{ lat: NaN, lon: NaN, radius_miles: NaN }];
    });
    const area = firstArea;
    checks.push([
      area
        ? `search inputs reuse prompt 1's center ${area.lat}, ${area.lon} and radius ${area.radius_miles} mi`
        : "search inputs reuse prompt 1's center and radius (prompt 1 set no area)",
      area !== undefined &&
        searches.length > 0 &&
        searches.every(
          (input) =>
            same(input.lat, area.lat) &&
            same(input.lon, area.lon) &&
            same(input.radius_miles, area.radius_miles),
        ),
    ]);
  }
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
    if (!ok) failed++;
  }
}
console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
process.exitCode = failed ? 1 : 0;
