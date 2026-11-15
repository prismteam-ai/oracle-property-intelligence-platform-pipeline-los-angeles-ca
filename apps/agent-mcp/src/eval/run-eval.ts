/**
 * The eval: every prompt, conversation by conversation, `runs` times, one model per
 * invocation. Per answer: the checks (checks.ts), its usage and spend (budget.ts), and one transcript JSON in the
 * output folder; at the end (or when the spend limit stops the eval) results.tsv and results.md. Returns the short
 * summary the CLI prints (nothing else goes to stdout) and the exit code: 1 when stopped by the budget or when any
 * answer failed, else 0.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_CHARS_PER_TOKEN,
  pricingBasis,
  runAgent,
  type AgentAnswer,
  type AgentRequest,
  type AgentSettings,
  type DataQueries,
  type ModelClient,
  type PricedModelKey,
  type Provider,
  type SessionState,
} from "@oracle-la/agent";
import { Budget, type BudgetStop, type MeteredCall } from "./budget.ts";
import {
  CHECK_NAMES,
  allPassed,
  checkAnswer,
  type AnswerChecks,
  type ToolCallRecord,
} from "./checks.ts";
import { conversations, type EvalPrompt } from "./prompts.ts";

export interface EvalOptions {
  provider: Provider;
  model: PricedModelKey;
  runs: number;
  maxUsd: number;
  /** An existing folder (the CLI resolves, checks and creates it). */
  outDir: string;
  prompts: EvalPrompt[];
}

export interface EvalDeps {
  model: ModelClient;
  queries: DataQueries;
  settings: AgentSettings;
  /** Clock for runAgent (defaults to Date.now). */
  now?: () => number;
  /** The served data run, for the outputs. */
  dataRunId?: string;
}

export type RowStatus = "pass" | "fail" | "stopped";

export interface ResultRow {
  run: number;
  prompt: string;
  status: RowStatus;
  checks: AnswerChecks;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  usd: number;
  ms: number;
}

export interface EvalResult {
  exitCode: 0 | 1;
  summary: string[];
  rows: ResultRow[];
  stop: (BudgetStop & { run: number; prompt: string }) | null;
  spentUsd: number;
}

const usd = (x: number) => `$${x.toFixed(4)}`;

/** The worst-case formula, as written in the outputs. */
export const WORST_CASE_FORMULA = `worst case of a call = ceil(request JSON characters / ${MIN_CHARS_PER_TOKEN}) × input price (Haiku: the over-100,000 price when that bound exceeds 100,000) + max_tokens × output price; a call is made only if committed spend + its worst case ≤ max-usd`;

function sumUsage(calls: readonly MeteredCall[]) {
  const t = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    usd: 0,
  };
  for (const c of calls) {
    t.usd += c.usd;
    if (!c.usage) continue;
    t.input_tokens += c.usage.input_tokens;
    t.cache_creation_input_tokens += c.usage.cache_creation_input_tokens;
    t.cache_read_input_tokens += c.usage.cache_read_input_tokens;
    t.output_tokens += c.usage.output_tokens;
  }
  return t;
}

const tsvCell = (v: string | number) => String(v).replace(/[\t\r\n]+/g, " ");

const COLUMNS = [
  "run",
  "prompt",
  "status",
  ...CHECK_NAMES,
  "input_tokens",
  "cache_write_tokens",
  "cache_read_tokens",
  "output_tokens",
  "usd",
  "ms",
] as const;

function rowCells(r: ResultRow): Array<string | number> {
  return [
    r.run,
    r.prompt,
    r.status,
    ...CHECK_NAMES.map((n) => r.checks[n].result),
    r.input_tokens,
    r.cache_creation_input_tokens,
    r.cache_read_input_tokens,
    r.output_tokens,
    r.usd.toFixed(6),
    r.ms,
  ];
}

function writeTables(
  outDir: string,
  opts: EvalOptions,
  rows: readonly ResultRow[],
  result: Pick<EvalResult, "stop" | "spentUsd">,
  modelId: string,
  dataRunId: string | undefined,
): void {
  writeFileSync(
    join(outDir, "results.tsv"),
    [
      COLUMNS.join("\t"),
      ...rows.map((r) => rowCells(r).map(tsvCell).join("\t")),
    ]
      .map((l) => `${l}\n`)
      .join(""),
  );
  const md = (v: string | number) => String(v).replace(/\|/g, "\\|");
  const lines = [
    "# Eval results",
    "",
    `- Provider ${opts.provider}, model ${opts.model} (${modelId}), runs ${opts.runs}, ${opts.prompts.length} prompts${dataRunId ? `, data run ${dataRunId}` : ""}`,
    `- Spend ${usd(result.spentUsd)} of max ${usd(opts.maxUsd)} (${pricingBasis(opts.provider)})`,
    `- ${WORST_CASE_FORMULA}`,
    result.stop
      ? `- Stopped by budget before a model call in run ${result.stop.run}, prompt ${result.stop.prompt}: committed ${usd(result.stop.committed_usd)} + worst case ${usd(result.stop.worst_case_usd)} (${result.stop.input_tokens_bound} input tokens bound, max_tokens ${result.stop.max_tokens}) > ${usd(result.stop.max_usd)}`
      : "- Not stopped by the budget",
    "",
    `| ${COLUMNS.join(" | ")} |`,
    `|${COLUMNS.map(() => " --- ").join("|")}|`,
    ...rows.map((r) => `| ${rowCells(r).map(md).join(" | ")} |`),
    "",
  ];
  writeFileSync(join(outDir, "results.md"), lines.join("\n"));
}

/** One answer's transcript (the file content). */
export interface Transcript {
  run: number;
  prompt_id: string;
  case: string;
  group: string;
  question: string;
  expected: EvalPrompt["expected"];
  status: AgentAnswer["status"];
  stopped_by: AgentAnswer["stopped_by"] | null;
  text: string;
  markdown: string;
  reasoning: string;
  assumptions: string[];
  records: AgentAnswer["records"];
  gaps: string[];
  unverified_ids: string[];
  tool_calls: Array<Pick<ToolCallRecord, "name" | "input" | "is_error">>;
  usage: AgentAnswer["usage"] & { model_call_usage: MeteredCall[] };
  spend_usd: number;
  spend_basis: string;
  checks: AnswerChecks;
  elapsed_ms: number;
  /** The conversation after this answer (what the next prompt of the group receives). */
  history: AgentAnswer["history"];
  session: SessionState;
}

export async function runEval(
  opts: EvalOptions,
  deps: EvalDeps,
): Promise<EvalResult> {
  const budget = new Budget(opts.provider, opts.model, opts.maxUsd);
  const model = budget.meter(deps.model);
  const rows: ResultRow[] = [];
  let stop: EvalResult["stop"] = null;
  const groups = conversations(opts.prompts);

  outer: for (let run = 1; run <= opts.runs; run++) {
    for (const group of groups) {
      let history: NonNullable<AgentRequest["history"]> = [];
      let session: SessionState = {};
      for (const prompt of group) {
        const previousLength = history.length;
        const previousArea = session.area;
        const answer = await runAgent(
          { question: prompt.question, history, session },
          {
            model,
            queries: deps.queries,
            settings: deps.settings,
            beforeModelCall: budget.gate,
            ...(deps.now ? { now: deps.now } : {}),
          },
        );
        const calls = budget.take();
        const { checks, calls: toolCalls } = await checkAnswer({
          prompt,
          answer,
          previousLength,
          previousArea,
          queries: deps.queries,
        });
        const stopped = answer.stopped_by === "budget";
        const u = sumUsage(calls);
        const row: ResultRow = {
          run,
          prompt: prompt.id,
          status: stopped ? "stopped" : allPassed(checks) ? "pass" : "fail",
          checks,
          input_tokens: u.input_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens,
          cache_read_input_tokens: u.cache_read_input_tokens,
          output_tokens: u.output_tokens,
          usd: u.usd,
          ms: answer.elapsed_ms,
        };
        rows.push(row);
        const transcript: Transcript = {
          run,
          prompt_id: prompt.id,
          case: prompt.case,
          group: prompt.group,
          question: prompt.question,
          expected: prompt.expected,
          status: answer.status,
          stopped_by: answer.stopped_by ?? null,
          text: answer.text,
          markdown: answer.markdown,
          reasoning: answer.reasoning,
          assumptions: answer.assumptions,
          records: answer.records,
          gaps: answer.gaps,
          unverified_ids: answer.unverified_ids,
          tool_calls: toolCalls.map((c) => ({
            name: c.name,
            input: c.input,
            is_error: c.is_error,
          })),
          usage: { ...answer.usage, model_call_usage: calls },
          spend_usd: u.usd,
          spend_basis: pricingBasis(opts.provider),
          checks,
          elapsed_ms: answer.elapsed_ms,
          history: answer.history,
          session: answer.session,
        };
        writeFileSync(
          join(opts.outDir, `run-${run}-${prompt.id}.json`),
          `${JSON.stringify(transcript, null, 2)}\n`,
        );
        if (stopped && budget.stop) {
          stop = { ...budget.stop, run, prompt: prompt.id };
          break outer;
        }
        history = answer.history;
        session = answer.session;
      }
    }
  }

  const spentUsd = budget.spentUsd;
  writeTables(
    opts.outDir,
    opts,
    rows,
    { stop, spentUsd },
    deps.settings.modelId,
    deps.dataRunId,
  );

  const summary: string[] = [];
  const count = (rs: readonly ResultRow[], s: RowStatus) =>
    rs.filter((r) => r.status === s).length;
  const line = (label: string, rs: readonly ResultRow[]) => {
    const stopped = count(rs, "stopped");
    return `${label}: ${count(rs, "pass")} passed, ${count(rs, "fail")} failed${stopped ? `, ${stopped} stopped` : ""}, ${usd(rs.reduce((n, r) => n + r.usd, 0))}`;
  };
  for (let run = 1; run <= opts.runs; run++) {
    const rs = rows.filter((r) => r.run === run);
    if (rs.length) summary.push(line(`run ${run}`, rs));
  }
  const estimate = opts.provider === "bedrock" ? " (estimate)" : "";
  summary.push(`${line("total", rows)}${estimate} of max ${usd(opts.maxUsd)}`);
  if (stop)
    summary.push(
      `stopped by budget in run ${stop.run}, prompt ${stop.prompt}: ${usd(stop.committed_usd)} + worst case ${usd(stop.worst_case_usd)} > ${usd(stop.max_usd)}`,
    );
  summary.push(`outputs: ${opts.outDir}`);
  const failed = rows.some((r) => r.status !== "pass");
  return {
    exitCode: stop || failed ? 1 : 0,
    summary,
    rows,
    stop,
    spentUsd,
  };
}
