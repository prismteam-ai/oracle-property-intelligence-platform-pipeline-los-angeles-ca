/**
 * The agent's tools on the real latest run (openLocalData over the checkout's runs/ and data/), for these
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
  WITHIN_WINDOW_LIMIT,
  type AgentSettings,
  type ContractorWindow,
} from "@oracle-la/agent";
import { beforeAll, describe, expect, test as vitestTest } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/create-server.ts";
import { checkCounts } from "../src/eval/checks.ts";
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
  maxTokens: 80_000,
  maxOutputTokens: 2_048,
  timeBudgetMs: 25_000,
  effort: "low",
};
const VAN_NUYS = { lat: 34.199, lon: -118.487 };
/** The Van Nuys center resolve_place gives on the served run. */
const VAN_NUYS_CENTER = { lat: 34.20155, lon: -118.45361 };
const CONTRACTOR_SOURCE =
  "LADBS roofing permits, contractor view (data.lacity.org 8guu-8f5m)";
const WINDOW: ContractorWindow = {
  source_name: CONTRACTOR_SOURCE,
  field: "permit_issue_date",
  first: "2013-01-02",
  last: "2023-05-19",
};

describe.skipIf(!hasRealData)("the agent on the real latest run", () => {
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
      "\n- Contractor rows end in May 2023: for permits issued after May 2023, call run_summary and state the contractor window from it (there is no contractor data after May 2023) instead of reading parcels' permits.\n",
    );
  });

  test("eval prompt i's question with the scripted model: the contractor gap and the text check pass on the real sources", async () => {
    const text =
      "There is no contractor data for permits issued after May 2023: contractor rows end in May 2023.";
    // run_summary, as the May 2023 line says.
    const model = new ScriptedModel([
      toolReply([{ name: "run_summary", input: {} }]),
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

  /** The CRM pin of the 15 Nov hosted check. */
  const CRM_PIN = { lat: 34.20008, lon: -118.48111 };

  test("search_aged_roofs with long_open_permit at the CRM pin, 1 mi, 15 years: 144 of 3,948 parcels, the CRM legend's count (parcels.points marks and parcels.match agree); items equal parcels.search's", async () => {
    const filter = { ...CRM_PIN, radius_miles: 1, threshold_years: 15 };
    const o = await runTool(
      "search_aged_roofs",
      { ...filter, long_open_permit: true },
      data.queries,
    );
    expect(o.ok).toBe(true);
    const c = o.content as {
      count: number;
      long_open_permit: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
    };
    expect(c.count).toBe(144);
    expect(c.long_open_permit).toMatchObject({
      unit: "parcels",
      count: 144,
      of: 3_948,
      checked: 3_948,
      complete: true,
      min_open_days: 1826,
    });
    expect(String(c.long_open_permit.text)).toMatch(
      /^144 of the 3,948 parcels that match the roof-age rule have a long-open roofing permit .* This counts parcels, not permits/,
    );
    // Every matching parcel has permit data: the text as it was, nothing about permit data added.
    expect(c.long_open_permit).toMatchObject({
      status: "available",
      with_permit_data: 3_948,
    });
    expect(c.long_open_permit.text).toBe(
      "144 of the 3,948 parcels that match the roof-age rule have a long-open roofing permit (an issued LADBS roofing-work permit still open at least 1,826 days). This counts parcels, not permits: a parcel with several long-open permits counts once, and a building-level (condominium) permit marks every unit it links.",
    );
    expect(c).not.toHaveProperty("permit_data");
    expect(o.gaps.some((g) => g.includes("City of Los Angeles"))).toBe(false);
    // The CRM legend's count (the drawn points' marks) and its lead list's (parcels.match, long_open_permit, 72 IDs
    // per call) are the same 144 parcels.
    const points = await data.caller.parcels.points(filter);
    const marked = points.id.filter((_, i) => points.long_open_permit[i] === 1);
    expect(marked).toHaveLength(144);
    const matched: string[] = [];
    for (let i = 0; i < points.id.length; i += 72)
      matched.push(
        ...(
          await data.caller.parcels.match({
            ...filter,
            long_open_permit: true,
            parcel_ids: points.id.slice(i, i + 72),
          })
        ).parcel_ids,
      );
    expect(new Set(matched)).toEqual(new Set(marked));
    // The listed parcels are the nearest marked ones, with the search item's own facts (distance included).
    expect(c.items.map((it) => it.parcel_id)).toEqual(marked.slice(0, 10));
    // The search's pages, nearest first, until every listed parcel is found.
    const byId = new Map<string, Record<string, unknown>>();
    for (
      let offset = 0;
      c.items.some((it) => !byId.has(String(it.parcel_id))) && offset < 3_948;
      offset += 100
    )
      for (const it of (
        await data.caller.parcels.search({ ...filter, limit: 100, offset })
      ).items)
        byId.set(it.parcel_id, it as unknown as Record<string, unknown>);
    for (const it of c.items) {
      const s = byId.get(String(it.parcel_id))!;
      expect(s).toBeDefined();
      for (const k of [
        "address",
        "year_built",
        "effective_roof_year",
        "roof_age_years",
        "roof_year_permit_number",
        "permit_data_available",
        "distance_miles",
      ] as const)
        expect(it[k]).toEqual(s[k]);
    }
    // The eval's counts check compares the same.
    const counts = await checkCounts(
      [
        {
          id: "t1",
          name: "search_aged_roofs",
          input: { ...filter, long_open_permit: true },
          result: o.content,
          is_error: false,
        },
      ],
      data.queries,
    );
    expect(counts).toEqual({
      result: "pass",
      details: [
        "search_aged_roofs: equal (parcels.points: 144 of 3948 parcels marked long-open, 10 IDs)",
      ],
    });
  });

  test("long_open_permits with with_contractor_window at Van Nuys, 5 mi, limit 10: the longest-open list has 10 items, the within-window list 5 (WITHIN_WINDOW_LIMIT), each carrying its permit's contractor rows, as permits.forParcel serves them", async () => {
    const o = await runTool(
      "long_open_permits",
      {
        ...VAN_NUYS_CENTER,
        radius_miles: 5,
        limit: 10,
        with_contractor_window: true,
      },
      data.queries,
    );
    expect(o.ok).toBe(true);
    const content = o.content as {
      longest_open: { items: unknown[] };
      within_contractor_window: {
        count: number;
        returned: number;
        contractor_source: { source_name: string };
        items: Array<Record<string, unknown>>;
      };
    };
    expect(content.longest_open.items).toHaveLength(10);
    const w = content.within_contractor_window;
    expect(WITHIN_WINDOW_LIMIT).toBe(5);
    expect(w.items).toHaveLength(5);
    expect(w.returned).toBe(5);
    expect(o.gaps).toContain(
      `Results truncated: the within-window list returned 5 of ${w.count} long-open permits (longest open first).`,
    );
    expect(w.contractor_source.source_name).toBe(CONTRACTOR_SOURCE);
    const statuses: Record<string, number> = {};
    for (const it of w.items) {
      const direct = await data.caller.permits.forParcel({
        parcel_id: String(it.parcel_id),
      });
      const permit = direct.permits.find(
        (p) => p.permit_number === it.permit_number,
      )!;
      expect(permit).toBeDefined();
      const rows = (it.contractors as Array<Record<string, unknown>>).map(
        (c) => [
          c.contractors_business_name,
          c.license_identifier,
          c.canonical_business_name,
        ],
      );
      expect(rows).toEqual(
        permit.contractors.map((c) => [
          c.contractors_business_name,
          c.license_identifier,
          c.canonical_business_name ?? null,
        ]),
      );
      statuses[String(it.contractor_status)] =
        (statuses[String(it.contractor_status)] ?? 0) + 1;
    }
    expect(statuses["not read"]).toBeUndefined();
    expect(statuses.named).toBeGreaterThan(0);
    expect(o.records.filter((r) => r.kind === "contractor").length).toBe(
      (statuses.named ?? 0) + (statuses["owner-builder"] ?? 0),
    );
  });

  test("search_aged_roofs at Van Nuys, 5 mi: a listed row with a PERMIT roof year cites the LADBS permit source too", async () => {
    const o = await runTool(
      "search_aged_roofs",
      { ...VAN_NUYS_CENTER, radius_miles: 5, threshold_years: 15, limit: 25 },
      data.queries,
    );
    const items = (o.content as { items: Array<Record<string, unknown>> })
      .items;
    const permitRows = items.filter((it) => it.roof_age_basis === "PERMIT");
    expect(permitRows.length).toBeGreaterThan(0);
    const permitSource = (await data.caller.explorer.sources()).sources
      .filter((s) => s.source_kind === "permit")
      .map((s) => s.source_name)
      .join("; ");
    expect(permitSource).toMatch(/LADBS/);
    for (const it of permitRows)
      expect(it.citation).toMatchObject({
        source_name: expect.any(String),
        roof_year_source: { source_name: permitSource },
      });
    for (const it of items.filter((x) => x.roof_age_basis === "PROXY"))
      expect(it.citation).not.toHaveProperty("roof_year_source");
  });

  /** Prompt d's search center (the model's call): every parcel within 1 mi lies outside the City of Los Angeles. */
  const PASADENA_CALL = { lat: 34.1528, lon: -118.13578 };
  const ALL_OUTSIDE =
    "All 7,845 parcels that match the roof-age rule are outside the City of Los Angeles: no permit data there.";
  /** A 1 mi area across the city line west of Pasadena: some matching parcels in the City of Los Angeles. */
  const MIXED = { lat: 34.145, lon: -118.18 };

  test("search_aged_roofs at the Pasadena center, 1 mi, 20 years: with long_open_permit the count is not available (null, not 0) among 7,845 parcels without permit data, nothing listed; without it the 7,845 are stated as outside the City of Los Angeles", async () => {
    const filter = { ...PASADENA_CALL, radius_miles: 1, threshold_years: 20 };
    const notAvailable =
      "Not available: none of the 7,845 parcels that match the roof-age rule has permit data (all are outside the City of Los Angeles), so whether they have a long-open roofing permit (an issued LADBS roofing-work permit still open at least 1,826 days) is unknown, not 0; the filter can't be evaluated there.";
    for (const input of [
      { ...filter, limit: 10, long_open_permit: true },
      { ...filter, long_open_permit: true },
    ]) {
      const o = await runTool("search_aged_roofs", input, data.queries);
      expect(o.ok).toBe(true);
      expect(o.content).toMatchObject({
        count: null,
        returned: 0,
        items: [],
        truncated: false,
        long_open_permit: {
          status: "not_available",
          count: null,
          of: 7_845,
          checked: 7_845,
          with_permit_data: 0,
          complete: true,
          text: notAvailable,
        },
        permit_data: { checked: 7_845, without_permit_data: 7_845 },
      });
      // The outside statement (as the agent raises it for the place) and the not-available text.
      expect(o.gaps).toEqual([ALL_OUTSIDE, notAvailable]);
      expect(o.records).toEqual([]);
      const counts = await checkCounts(
        [
          {
            id: "t1",
            name: "search_aged_roofs",
            input,
            result: o.content,
            is_error: false,
          },
        ],
        data.queries,
      );
      expect(counts).toEqual({
        result: "pass",
        details: [
          "search_aged_roofs: equal (parcels.points: none of the 7845 parcels checked of 7845 has permit data, count not available)",
        ],
      });
    }
    const plain = await runTool("search_aged_roofs", filter, data.queries);
    expect(plain.content).toMatchObject({ count: 7_845, returned: 10 });
    expect(plain.gaps).toContain(ALL_OUTSIDE);
  });

  /** long_open_permits' statements at the Pasadena center, 1 mi: all 8,864 parcels with a roof year are outside. */
  const LONG_OPEN_ALL_OUTSIDE =
    "All 8,864 parcels within 1 mi that have a roof year are outside the City of Los Angeles: no permit data there.";
  const LONG_OPEN_NOT_AVAILABLE =
    "Not available: none of the 8,864 parcels within 1 mi that have a roof year has permit data (all are outside the City of Los Angeles), so whether there are long-open roofing permits (an issued LADBS roofing-work permit still open at least 1,826 days) is unknown, not 0.";

  test("long_open_permits at the Pasadena center, 1 mi, default window: the count is not available (null, not 0), the 8,864 parcels without permit data are stated, and the answer raises Pasadena's outside-the-City gap", async () => {
    const input = { ...PASADENA_CALL, radius_miles: 1 };
    const o = await runTool("long_open_permits", input, data.queries);
    expect(o.ok).toBe(true);
    expect(o.content).toMatchObject({
      count: null,
      status: "not_available",
      text: LONG_OPEN_NOT_AVAILABLE,
      returned: 0,
      items: [],
      truncated: false,
      permit_data: {
        checked: 8_864,
        without_permit_data: 8_864,
        complete: true,
        text: LONG_OPEN_ALL_OUTSIDE,
      },
    });
    expect(o.gaps).toEqual([LONG_OPEN_ALL_OUTSIDE, LONG_OPEN_NOT_AVAILABLE]);
    const counts = await checkCounts(
      [
        {
          id: "t1",
          name: "long_open_permits",
          input: { ...input, min_open_days: 1826, limit: 10 },
          result: o.content,
          is_error: false,
        },
      ],
      data.queries,
    );
    expect(counts).toEqual({
      result: "pass",
      details: [
        "long_open_permits: equal (parcels.points: 8864 of 8864 checked without permit data; permits.longOpen: count not available, 0 IDs)",
      ],
    });
    const model = new ScriptedModel([
      toolReply([{ name: "resolve_place", input: { name: "Pasadena" } }]),
      toolReply([{ name: "long_open_permits", input }]),
      textReply(
        "Permit data covers the City of Los Angeles only. Pasadena is a separate city, so whether it has long-open roofing permits is unknown.",
      ),
    ]);
    const a = await runAgent(
      {
        question: "Which permits near Pasadena have been open for many years?",
      },
      { model, queries: data.queries, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    // Both outside statements: the tool's (the parcel count, no place), then the agent's (the place).
    expect(
      a.gaps.filter((g) =>
        g.endsWith("outside the City of Los Angeles: no permit data there."),
      ),
    ).toEqual([
      LONG_OPEN_ALL_OUTSIDE,
      "Pasadena is outside the City of Los Angeles: no permit data there.",
    ]);
    expect(a.gaps).toContain(LONG_OPEN_NOT_AVAILABLE);
    expect(GAPS.outside_city_of_la.inText("Pasadena").test(a.text)).toBe(true);
  });

  test("long_open_permits with with_contractor_window at the Pasadena center, 1 mi: both lists not available (null), the outside statement once", async () => {
    const o = await runTool(
      "long_open_permits",
      { ...PASADENA_CALL, radius_miles: 1, with_contractor_window: true },
      data.queries,
    );
    const c = o.content as Record<string, Record<string, unknown>>;
    expect(c.permit_data).toMatchObject({
      without_permit_data: 8_864,
      text: LONG_OPEN_ALL_OUTSIDE,
    });
    expect(c.longest_open).toMatchObject({
      count: null,
      status: "not_available",
      text: LONG_OPEN_NOT_AVAILABLE,
    });
    expect(c.within_contractor_window).toMatchObject({
      count: null,
      status: "not_available",
    });
    expect(o.gaps.filter((g) => g === LONG_OPEN_ALL_OUTSIDE)).toHaveLength(1);
  });

  test("long_open_permits in the mixed area (34.145, -118.18, 1 mi): the count of 17 stands; 1,979 of the 3,005 parcels stated as without permit data", async () => {
    const input = { ...MIXED, radius_miles: 1 };
    const o = await runTool("long_open_permits", input, data.queries);
    const outside =
      "1,979 of the 3,005 parcels within 1 mi that have a roof year are outside the City of Los Angeles: no permit data there.";
    expect(o.content).toMatchObject({
      count: 17,
      returned: 10,
      permit_data: {
        checked: 3_005,
        without_permit_data: 1_979,
        complete: true,
        text: outside,
      },
    });
    expect(o.content).not.toHaveProperty("status");
    expect(o.gaps).toEqual([
      outside,
      "Results truncated: long_open_permits returned 10 of 17 long-open permits (longest open first).",
    ]);
    const counts = await checkCounts(
      [
        {
          id: "t1",
          name: "long_open_permits",
          input: { ...input, min_open_days: 1826, limit: 10 },
          result: o.content,
          is_error: false,
        },
      ],
      data.queries,
    );
    expect(counts.result).toBe("pass");
  });

  test("long_open_permits as prompt a2 calls it (the Van Nuys center, 5 mi, with_contractor_window): only the nearest 25,000 parcels were checked, all with permit data, and permit_data says so; the counts stand (no status)", async () => {
    const o = await runTool(
      "long_open_permits",
      {
        ...VAN_NUYS_CENTER,
        radius_miles: 5,
        limit: 10,
        with_contractor_window: true,
      },
      data.queries,
    );
    const c = o.content as Record<string, Record<string, unknown>>;
    expect(Object.keys(c)).toEqual([
      "scope",
      "source",
      "permit_data",
      "contractor_window",
      "longest_open",
      "within_contractor_window",
    ]);
    const nearest =
      "All of the nearest 25,000 of the 143,251 parcels within 5 mi that have a roof year (only those were checked: the data API marks at most 25,000 parcels) have permit data; the other 118,251 were not checked.";
    expect(c.permit_data).toEqual({
      checked: 25_000,
      matched: 143_251,
      without_permit_data: 0,
      complete: false,
      text: nearest,
    });
    expect(c.longest_open).toMatchObject({ count: 2_309, returned: 10 });
    expect(c.longest_open).not.toHaveProperty("status");
    expect(c.within_contractor_window).toMatchObject({
      count: 2_039,
      returned: 5,
    });
    expect(c.within_contractor_window).not.toHaveProperty("status");
    expect(o.gaps).toEqual([
      nearest,
      "Results truncated: the longest-open list returned 10 of 2309 long-open permits (longest open first).",
      "Results truncated: the within-window list returned 5 of 2039 long-open permits (longest open first).",
    ]);
  });

  test("prompt d's flow with only the filtered call, on the real data: the answer's gaps include Pasadena's outside-the-City gap", async () => {
    const model = new ScriptedModel([
      toolReply([{ name: "resolve_place", input: { name: "Pasadena" } }]),
      toolReply([
        {
          name: "search_aged_roofs",
          input: {
            ...PASADENA_CALL,
            radius_miles: 1,
            threshold_years: 20,
            limit: 10,
            long_open_permit: true,
          },
        },
      ]),
      textReply(
        "Permit data covers the City of Los Angeles only. Pasadena is a separate city, so whether these parcels have long-open roofing permits is unknown.",
      ),
    ]);
    const a = await runAgent(
      {
        question:
          "Which properties within one mile of Pasadena have roofs older than 20 years, and do they have open roofing permits?",
      },
      { model, queries: data.queries, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    expect(a.gaps).toContain(
      "Pasadena is outside the City of Los Angeles: no permit data there.",
    );
    // Both outside statements: the tool's (the parcel count, no place), then the agent's (the place).
    expect(
      a.gaps.filter((g) =>
        g.endsWith("outside the City of Los Angeles: no permit data there."),
      ),
    ).toEqual([
      ALL_OUTSIDE,
      "Pasadena is outside the City of Los Angeles: no permit data there.",
    ]);
    expect(GAPS.outside_city_of_la.inText("Pasadena").test(a.text)).toBe(true);
  });

  test("search_aged_roofs over MCP (the SDK's in-memory transport) at the Pasadena center, 1 mi, 20 years, limit 10, long_open_permit: the gaps list the outside statement, then the not-available text", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(data.queries);
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const res = await client.callTool({
        name: "search_aged_roofs",
        arguments: {
          ...PASADENA_CALL,
          radius_miles: 1,
          threshold_years: 20,
          limit: 10,
          long_open_permit: true,
        },
      });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(
        (res.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as {
        result: {
          count: number | null;
          long_open_permit: { status: string; text: string };
          permit_data: { text: string };
        };
        gaps: string[];
      };
      expect(body.result.count).toBeNull();
      expect(body.result.long_open_permit.status).toBe("not_available");
      expect(body.result.permit_data.text).toBe(ALL_OUTSIDE);
      expect(body.gaps).toEqual([
        ALL_OUTSIDE,
        body.result.long_open_permit.text,
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("long_open_permits over MCP (the SDK's in-memory transport) at the Pasadena center, 1 mi: the shared tool layer gives count null, status not_available, the outside statement then the not-available text", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(data.queries);
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const res = await client.callTool({
        name: "long_open_permits",
        arguments: { ...PASADENA_CALL, radius_miles: 1 },
      });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(
        (res.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as {
        result: {
          count: number | null;
          status: string;
          text: string;
          permit_data: { text: string };
        };
        gaps: string[];
      };
      expect(body.result.count).toBeNull();
      expect(body.result.status).toBe("not_available");
      expect(body.result.text).toBe(LONG_OPEN_NOT_AVAILABLE);
      expect(body.result.permit_data.text).toBe(LONG_OPEN_ALL_OUTSIDE);
      expect(body.gaps).toEqual([
        LONG_OPEN_ALL_OUTSIDE,
        LONG_OPEN_NOT_AVAILABLE,
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("long_open_permits over MCP at Van Nuys, 5 mi, limit 10, with_contractor_window: the shared tool layer lists 10 longest-open permits and 5 within the window", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(data.queries);
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const res = await client.callTool({
        name: "long_open_permits",
        arguments: {
          ...VAN_NUYS_CENTER,
          radius_miles: 5,
          limit: 10,
          with_contractor_window: true,
        },
      });
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(
        (res.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as {
        result: {
          longest_open: { returned: number; items: unknown[] };
          within_contractor_window: {
            count: number;
            returned: number;
            items: unknown[];
          };
        };
        gaps: string[];
      };
      expect(body.result.longest_open.items).toHaveLength(10);
      const w = body.result.within_contractor_window;
      expect(w.items).toHaveLength(WITHIN_WINDOW_LIMIT);
      expect(w.returned).toBe(WITHIN_WINDOW_LIMIT);
      expect(body.gaps).toContain(
        `Results truncated: the within-window list returned 5 of ${w.count} long-open permits (longest open first).`,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("search_aged_roofs in a mixed area (34.145, -118.18, 1 mi, 20 years): 16 long-open of the 788 parcels with permit data; the other 1,924 of 2,712 stated as without permit data, with and without the filter", async () => {
    const filter = { ...MIXED, radius_miles: 1, threshold_years: 20 };
    const outside =
      "1,924 of the 2,712 parcels that match the roof-age rule are outside the City of Los Angeles: no permit data there.";
    const o = await runTool(
      "search_aged_roofs",
      { ...filter, long_open_permit: true },
      data.queries,
    );
    expect(o.content).toMatchObject({
      count: 16,
      long_open_permit: {
        status: "available",
        count: 16,
        of: 2_712,
        checked: 2_712,
        with_permit_data: 788,
        complete: true,
      },
      permit_data: { without_permit_data: 1_924, text: outside },
    });
    expect(
      String(
        (o.content as { long_open_permit: { text: string } }).long_open_permit
          .text,
      ),
    ).toMatch(
      /^16 of the 788 parcels that match the roof-age rule and have permit data have a long-open roofing permit .*The other 1,924 of the 2,712 are outside the City of Los Angeles/,
    );
    expect(o.gaps).toContain(outside);
    const plain = await runTool("search_aged_roofs", filter, data.queries);
    expect(plain.content).toMatchObject({
      count: 2_712,
      permit_data: { without_permit_data: 1_924 },
    });
    expect(plain.gaps).toContain(outside);
    const counts = await checkCounts(
      [
        {
          id: "t1",
          name: "search_aged_roofs",
          input: { ...filter, long_open_permit: true, limit: 10 },
          result: o.content,
          is_error: false,
        },
        {
          id: "t2",
          name: "search_aged_roofs",
          input: { ...filter, limit: 10 },
          result: plain.content,
          is_error: false,
        },
      ],
      data.queries,
    );
    expect(counts.result).toBe("pass");
  });

  test("search_aged_roofs with long_open_permit within 0.1 mi of parcel 4366022031 (outside the City of Los Angeles, with a long-open mark), 5 years: the count is the 3 parcels.points marks; the marked parcel counts as having permit data", async () => {
    const filter = {
      lat: 34.07311,
      lon: -118.45758,
      radius_miles: 0.1,
      threshold_years: 5,
    };
    const p = await data.queries.parcels.points({
      ...filter,
      min_open_days: 1826,
    });
    const marked = p.id.filter((_, i) => p.long_open_permit[i] === 1);
    expect(marked).toHaveLength(3);
    expect(marked).toContain("4366022031");
    expect(p.permit_data_available[p.id.indexOf("4366022031")]).toBe(0);
    const input = { ...filter, limit: 10, long_open_permit: true };
    const o = await runTool("search_aged_roofs", input, data.queries);
    expect(o.content).toMatchObject({
      count: 3,
      returned: 3,
      long_open_permit: {
        status: "available",
        count: 3,
        of: 56,
        checked: 56,
        with_permit_data: 56,
        complete: true,
        text: "3 of the 56 parcels that match the roof-age rule have a long-open roofing permit (an issued LADBS roofing-work permit still open at least 1,826 days). This counts parcels, not permits: a parcel with several long-open permits counts once, and a building-level (condominium) permit marks every unit it links.",
      },
    });
    expect(o.content).not.toHaveProperty("permit_data");
    expect(
      (o.content as { items: Array<{ parcel_id: string }> }).items.map(
        (it) => it.parcel_id,
      ),
    ).toEqual(marked);
    expect(o.gaps.some((g) => g.includes("City of Los Angeles"))).toBe(false);
    const plain = await runTool(
      "search_aged_roofs",
      { ...filter, limit: 10 },
      data.queries,
    );
    expect(plain.content).toMatchObject({ count: 56 });
    expect(plain.content).not.toHaveProperty("permit_data");
    const counts = await checkCounts(
      [
        {
          id: "t1",
          name: "search_aged_roofs",
          input,
          result: o.content,
          is_error: false,
        },
        {
          id: "t2",
          name: "search_aged_roofs",
          input: { ...filter, limit: 10 },
          result: plain.content,
          is_error: false,
        },
      ],
      data.queries,
    );
    expect(counts).toEqual({
      result: "pass",
      details: [
        "search_aged_roofs: equal (parcels.points: 3 of 56 parcels marked long-open, 3 IDs)",
        "search_aged_roofs: equal (parcels.search: count 56, 10 IDs; parcels.points: 0 of 56 checked without permit data)",
      ],
    });
  });

  test("search_aged_roofs without the filter at the Van Nuys center, 5 mi (15 years): the nearest 25,000 of 115,373 checked, all with permit data, stated as such with the total", async () => {
    const input = { ...VAN_NUYS_CENTER, radius_miles: 5, threshold_years: 15 };
    const o = await runTool("search_aged_roofs", input, data.queries);
    const text =
      "All of the nearest 25,000 of the 115,373 parcels that match the roof-age rule (only those were checked: the data API marks at most 25,000 parcels) have permit data; the other 90,373 were not checked.";
    expect(o.content).toMatchObject({
      count: 115_373,
      returned: 10,
      permit_data: {
        checked: 25_000,
        matched: 115_373,
        without_permit_data: 0,
        complete: false,
        text,
      },
    });
    expect(o.gaps).toContain(text);
    expect(o.gaps.some((g) => g.includes("City of Los Angeles"))).toBe(false);
    const counts = await checkCounts(
      [
        {
          id: "t1",
          name: "search_aged_roofs",
          input: { ...input, limit: 10 },
          result: o.content,
          is_error: false,
        },
      ],
      data.queries,
    );
    expect(counts.result).toBe("pass");
  });
});

// A missing data/ fails the run when REQUIRE_REAL_DATA=1.
if (!hasRealData && REQUIRE_REAL_DATA)
  vitestTest("real data is present for the agent (REQUIRE_REAL_DATA=1)", () => {
    expect.fail(
      `the agent's real-data checks cannot run: ${missing.length} run file(s) missing, first ${missing[0]}`,
    );
  });
