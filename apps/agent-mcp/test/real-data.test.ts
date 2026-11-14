/**
 * The agent's tools on the real latest run (openLocalData over the checkout's runs/ and data/), for the P19
 * changes: the contractor window, places.resolve, the ownership bases and the contractor identity. Skipped when
 * data/ does not hold the run's files (a worktree or a replay); REQUIRE_REAL_DATA=1 makes that a failure, as in
 * apps/api/test/routers.test.ts. Expected values are the rebuild run's (2026-11-12T14-00-51-383Z-bc7f18f2e9cf2),
 * as the API's real-data checks state them.
 */
import {
  GAP_CONTRACTOR_DEFAULT,
  OWNERSHIP_BASES,
  ScriptedModel,
  contractorGaps,
  contractorWindow,
  runAgent,
  runTool,
  systemPrompt,
  textReply,
  toolReply,
  type AgentSettings,
  type ContractorWindow,
} from "@oracle-la/agent";
import { beforeAll, describe, expect, test as vitestTest } from "vitest";
import { GAPS } from "../src/eval/prompts.ts";
import {
  DEFAULT_REPO_ROOT,
  missingRunFiles,
  openLocalData,
  type LocalData,
} from "../src/local-data.ts";

const REQUIRE_REAL_DATA = process.env.REQUIRE_REAL_DATA === "1";
const missing = missingRunFiles(DEFAULT_REPO_ROOT);
const hasRealData = missing.length === 0;
/** Each check gets 30 s: the full suite runs every test file in parallel. */
const test = (name: string, fn: () => Promise<void>) =>
  vitestTest(name, fn, 30_000);

const SETTINGS: AgentSettings = {
  modelId: "claude-test-model",
  maxToolTurns: 5,
  maxTokens: 40_000,
  maxOutputTokens: 2_048,
  timeBudgetMs: 25_000,
  effort: "low",
};
const VAN_NUYS = { lat: 34.199, lon: -118.487 };
const CONTRACTOR_SOURCE =
  "LADBS roofing permits, contractor view (data.lacity.org 8guu-8f5m)";
const WINDOW: ContractorWindow = {
  source_name: CONTRACTOR_SOURCE,
  field: "permit_issue_date",
  first: "2013-01-02",
  last: "2023-05-19",
};

describe.skipIf(!hasRealData)("the agent on the real latest run (P19)", () => {
  let data: LocalData;
  beforeAll(async () => {
    data = await openLocalData();
  }, 60_000);

  test("the contractor window from explorer.sources: 2013-01-02 to 2023-05-19 under the contractor source; the gap's first sentence is the standard one", async () => {
    const w = contractorWindow(await data.caller.explorer.sources());
    expect(w).toEqual(WINDOW);
    expect(contractorGaps({ status: "stated", window: w! })).toEqual([
      GAP_CONTRACTOR_DEFAULT,
      `The contractor rows (${CONTRACTOR_SOURCE}) cover permits issued 2013-01-02 to 2023-05-19 (by permit_issue_date).`,
    ]);
    const prompt = systemPrompt(SETTINGS.maxToolTurns, w);
    expect(prompt).toContain(
      `There is no contractor license data after May 2023 (the contractor rows, from ${CONTRACTOR_SOURCE}, cover permits issued 2013-01-02 to 2023-05-19).`,
    );
    // The instruction line is the same as without a window.
    expect(prompt).toContain(
      "\n- Contractor rows end in May 2023: for permits issued after May 2023, say there is no contractor data instead of reading parcels' permits for it.\n",
    );
  });

  test("eval prompt i's question with the scripted model: the contractor gap and the text check pass on the real sources", async () => {
    const text =
      "There is no contractor data for permits issued after May 2023: contractor rows end in May 2023.";
    const model = new ScriptedModel([
      toolReply([{ name: "resolve_place", input: { name: "Van Nuys" } }]),
      textReply(text),
    ]);
    const a = await runAgent(
      {
        question:
          "Which contractors are listed on roofing permits issued after May 2023 within five miles of Van Nuys?",
      },
      { model, queries: data.queries, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    const spec = GAPS.contractor_license_after_may_2023;
    expect(a.gaps.some((g) => spec.inGaps(g))).toBe(true);
    expect(spec.inText.test(a.text)).toBe(true);
    expect(a.gaps).toContain(
      `The contractor rows (${CONTRACTOR_SOURCE}) cover permits issued 2013-01-02 to 2023-05-19 (by permit_issue_date).`,
    );
  });

  test("resolve_place through places.resolve: Van Nuys by postal city to 34.20155, -118.45361 (456 parcels)", async () => {
    const o = await runTool(
      "resolve_place",
      { name: "Van Nuys" },
      data.queries,
    );
    expect(o.content).toMatchObject({
      status: "resolved",
      basis: "postal_city",
      center: { lat: 34.20155, lon: -118.45361 },
      parcel_count: 456,
    });
  });

  test("search_aged_roofs at Van Nuys, 5 mi, 15 years: off gives the served 113,632; each basis equals parcels.search with it, both = at most either", async () => {
    const off = await runTool(
      "search_aged_roofs",
      { ...VAN_NUYS, radius_miles: 5, threshold_years: 15 },
      data.queries,
    );
    expect((off.content as { count: number }).count).toBe(113_632);
    const counts: Record<string, number> = {};
    for (const basis of OWNERSHIP_BASES) {
      const direct = await data.caller.parcels.search({
        ...VAN_NUYS,
        radius_miles: 5,
        threshold_years: 15,
        ownership_basis: basis,
        limit: 10,
      });
      const o = await runTool(
        "search_aged_roofs",
        {
          ...VAN_NUYS,
          radius_miles: 5,
          threshold_years: 15,
          ownership_filter: true,
          ownership_basis: basis,
        },
        data.queries,
      );
      const c = o.content as { count: number; ownership: unknown };
      expect(c.count).toBe(direct.count);
      expect(c.ownership).toEqual(direct.ownership);
      counts[basis] = c.count;
    }
    expect(counts.both).toBeLessThanOrEqual(
      Math.min(counts.recording!, counts.base_year!),
    );
    expect(counts.both).toBeGreaterThan(0);
  });

  test("parcel_permits on a long-open parcel: each contractor row's identity as permits.forParcel serves it", async () => {
    const lo = await runTool(
      "long_open_permits",
      { ...VAN_NUYS, radius_miles: 5, limit: 25 },
      data.queries,
    );
    const parcels = (
      lo.content as { items: Array<{ parcel_id: string }> }
    ).items.map((i) => i.parcel_id);
    let checked = 0;
    for (const parcel_id of parcels) {
      const direct = await data.caller.permits.forParcel({ parcel_id });
      const rows = direct.permits.flatMap((p) => p.contractors);
      if (!rows.length) continue;
      const o = await runTool("parcel_permits", { parcel_id }, data.queries);
      const got = (
        o.content as {
          permits: Array<{ contractors: Array<Record<string, unknown>> }>;
        }
      ).permits.flatMap((p) => p.contractors);
      expect(
        got.map((c) => [
          c.contractor_identity_key,
          c.canonical_business_name,
          c.name_variant_count,
        ]),
      ).toEqual(
        rows.map((c) => [
          c.contractor_identity_key ?? null,
          c.canonical_business_name ?? null,
          c.name_variant_count ?? null,
        ]),
      );
      checked += rows.length;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// A missing data/ fails the run when REQUIRE_REAL_DATA=1.
if (!hasRealData && REQUIRE_REAL_DATA)
  vitestTest("real data is present for the agent (REQUIRE_REAL_DATA=1)", () => {
    expect.fail(
      `the agent's real-data checks cannot run: ${missing.length} run file(s) missing, first ${missing[0]}`,
    );
  });
