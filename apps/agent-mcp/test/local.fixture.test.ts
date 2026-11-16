/**
 * The agent tools, the place index and the MCP server over the REAL data API router, on the API's synthetic
 * fixtures (apps/api/test/fixture.ts: writeFixture for parcels, writePermitFixture for the permit routes) laid out
 * as repository checkouts (runs/ + data/, with the history row's permit_files), opened through the same local
 * wiring the MCP server and the eval use (openDb with permitFiles). No network: fetch is stubbed to throw.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOF_AGE_BASIS,
  type LongOpenResult,
  type ParcelPermits,
} from "@oracle-la/api/contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  GAP_CONTRACTOR_DEFAULT,
  GAP_CONTRACTOR_NO_WINDOW,
  OWNERSHIP_BASES,
  STANDARD_GAPS,
  ScriptedModel,
  TOOL_NAMES,
  systemPrompt,
  idsInText,
  lastToolResult,
  runAgent,
  runTool,
  textReply,
  toolReply,
  type AgentSettings,
  type ApiQueries,
  type Citation,
  type DataQueries,
  type LongOpenInput,
  type PermitQueries,
} from "@oracle-la/agent";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
// The API's fixture, imported by relative path like openDb.
import {
  FIXTURE,
  PERMIT_FIXTURE,
  PERMIT_WORK_DESC,
  writeFixture,
  writePermitFixture,
  type FixtureRun,
} from "../../api/test/fixture.ts";
import {
  PASADENA_RESOLVED,
  fakeQueries,
} from "../../../packages/agent/test/helpers.ts";
import { createMcpServer } from "../src/create-server.ts";
import {
  RunFilesMissingError,
  openLocalData,
  type LocalData,
} from "../src/local-data.ts";

const P = FIXTURE.point;
const N = PERMIT_FIXTURE.p;
let data: LocalData;
/** The permit run (writePermitFixture), opened the same way. */
let permitData: LocalData;

const SETTINGS: AgentSettings = {
  modelId: "claude-test-model",
  maxToolTurns: 5,
  maxTokens: 80_000,
  maxOutputTokens: 2_048,
  timeBudgetMs: 25_000,
  effort: "low",
};

/**
 * A fixture run as a checkout: runs/run_history.jsonl → data/out/<run>/<parquet> and its three permit Parquet files
 * (permit_files: role, path, sha256, as the pipeline writes them), runs/<run>/run_manifest.json.
 */
async function fixtureRepo(f: FixtureRun): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "agent-repo-"));
  const out = `data/out/${FIXTURE.runId}`;
  const parquetPath = `${out}/${FIXTURE.parquetFile}`;
  const manifestPath = `runs/${FIXTURE.runId}/run_manifest.json`;
  mkdirSync(join(repo, out), { recursive: true });
  mkdirSync(join(repo, "runs", FIXTURE.runId), { recursive: true });
  copyFileSync(join(f.dir, FIXTURE.parquetFile), join(repo, parquetPath));
  for (const pf of f.permitFiles)
    copyFileSync(join(f.dir, pf.file), join(repo, out, pf.file));
  copyFileSync(join(f.dir, "run_manifest.json"), join(repo, manifestPath));
  const row = JSON.parse(
    readFileSync(join(f.dir, "run_history.jsonl"), "utf8"),
  ) as Record<string, unknown>;
  writeFileSync(
    join(repo, "runs/run_history.jsonl"),
    JSON.stringify({
      ...row,
      parquet_sha256: f.parquetSha256,
      parquet_path: parquetPath,
      permit_files: f.permitFiles.map((pf) => ({
        role: pf.role,
        path: `${out}/${pf.file}`,
        sha256: pf.sha256,
      })),
      manifest_path: manifestPath,
    }) + "\n",
  );
  return repo;
}

/** A fixture run as a checkout; the run's own folder is removed once copied, also when the copy fails. */
async function checkoutOf(write: () => Promise<FixtureRun>): Promise<string> {
  const f = await write();
  try {
    return await fixtureRepo(f);
  } finally {
    f.remove();
  }
}

/** The queries with a counter on explorer.sources (explicit members: the caller is a proxy). */
function countingSources(q: DataQueries): {
  queries: DataQueries;
  count: () => number;
} {
  let n = 0;
  return {
    queries: {
      parcels: q.parcels,
      explorer: {
        runSummary: () => q.explorer.runSummary(),
        sources: () => (n++, q.explorer.sources()),
      },
      permits: q.permits,
      places: q.places,
    },
    count: () => n,
  };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", () => {
    throw new Error("network is disabled in tests");
  });
  data = await openLocalData({
    repoRoot: await checkoutOf(writeFixture),
  });
  permitData = await openLocalData({
    repoRoot: await checkoutOf(writePermitFixture),
  });
});
/** Scratch checkouts for the missing-data case, inside this test folder; removed afterwards. */
const SCRATCH = join(
  fileURLToPath(new URL("./", import.meta.url)),
  `.local-scratch-${process.pid}`,
);
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("local wiring", () => {
  test("the tRPC caller satisfies ApiQueries structurally; the latest run is served", async () => {
    const api: ApiQueries = data.caller;
    expect(data.runId).toBe(FIXTURE.runId);
    expect((await api.explorer.runSummary()).run).toMatchObject({
      run_id: FIXTURE.runId,
    });
  });
  test("caller.permits satisfies PermitQueries (compile-time, both input directions) and is what the tools read", async () => {
    const caller = permitData.caller;
    // Function-typed members: inputs are checked contravariantly, so an agent input the API would refuse fails tsc.
    const permits: PermitQueries = caller.permits;
    const longOpen: (i: LongOpenInput) => Promise<LongOpenResult> =
      caller.permits.longOpen;
    const forParcel: (i: { parcel_id: string }) => Promise<ParcelPermits> =
      caller.permits.forParcel;
    // And the API's own input type fits the agent's LongOpenInput (no field the agent's type lacks).
    type ApiLongOpenInput = Parameters<typeof caller.permits.longOpen>[0];
    const toLane = (i: ApiLongOpenInput): LongOpenInput => i;
    const input = toLane({ ...P, radius_miles: 5 });
    expect((await longOpen(input)).items.map((i) => i.permit_number)).toEqual(
      (await permits.longOpen(input)).items.map((i) => i.permit_number),
    );
    expect((await forParcel({ parcel_id: "0000000011" })).parcel_id).toBe(
      "0000000011",
    );
    expect(permitData.queries.permits).toBe(caller.permits);
  });
  test("permit numbers: the unverified-ID pattern matches every fixture permit number and the API's permit records", async () => {
    const all = Object.values(N);
    expect(idsInText(all.join(" "))).toEqual(all);
    // The API's own permit cursor accepts the shape; every permit record key it serves matches the pattern.
    const records = await permitData.caller.explorer.records({
      source_name: PERMIT_FIXTURE.permitSource,
      limit: 100,
    });
    const keys = records.items.map((r) => r.record_key);
    expect(keys).toHaveLength(PERMIT_FIXTURE.permits);
    expect(idsInText(keys.join(" "))).toEqual(keys);
    await expect(
      permitData.caller.explorer.records({
        source_name: PERMIT_FIXTURE.permitSource,
        after: N.P1,
        limit: 1,
      }),
    ).resolves.toMatchObject({ source_kind: "permit" });
  });
});

describe("openLocalData on a checkout without the run's data files (a worktree: runs/ but no data/)", () => {
  test("a clear error naming the first missing file, the count and ORACLE_REPO_DIR; nothing staged", async () => {
    const repo = join(SCRATCH, "worktree");
    mkdirSync(join(repo, "runs"), { recursive: true });
    const row = {
      run_id: FIXTURE.runId,
      parquet_sha256: "0".repeat(64),
      parquet_path: `data/out/${FIXTURE.runId}/${FIXTURE.parquetFile}`,
      manifest_path: `runs/${FIXTURE.runId}/run_manifest.json`,
      permit_files: [1, 2, 3].map((i) => ({
        role: `role-${i}`,
        path: `data/out/${FIXTURE.runId}/permits-${i}.parquet`,
        sha256: "0".repeat(64),
      })),
    };
    writeFileSync(
      join(repo, "runs/run_history.jsonl"),
      JSON.stringify(row) + "\n",
    );
    const stageDir = join(SCRATCH, "stage-never-created");
    const tmpDir = join(SCRATCH, "tmp-never-created");
    const opening = openLocalData({ repoRoot: repo, stageDir, tmpDir });
    await expect(opening).rejects.toBeInstanceOf(RunFilesMissingError);
    await expect(opening).rejects.toThrow(
      `the run's data files are missing under ${repo} (first missing: ${row.parquet_path}; 5 missing). Point at a checkout that has them: ORACLE_REPO_DIR=<checkout>.`,
    );
    await expect(opening).rejects.not.toThrow(/ENOENT/);
    expect(existsSync(stageDir)).toBe(false);
    expect(existsSync(tmpDir)).toBe(false);
    // No history at all: the history is the one missing file.
    await expect(
      openLocalData({ repoRoot: join(SCRATCH, "no-runs"), stageDir, tmpDir }),
    ).rejects.toThrow("(first missing: runs/run_history.jsonl; 1 missing)");
  });
});

describe("tools over the real appRouter", () => {
  test.each([5, 10])(
    "search_aged_roofs returns the same parcel IDs in the same order as caller.parcels.search (radius %s)",
    async (radius) => {
      const direct = await data.caller.parcels.search({
        lat: P.lat,
        lon: P.lon,
        radius_miles: radius,
        threshold_years: 15,
        limit: 25,
      });
      const o = await runTool(
        "search_aged_roofs",
        {
          lat: P.lat,
          lon: P.lon,
          radius_miles: radius,
          threshold_years: 15,
          limit: 25,
        },
        data.queries,
      );
      expect(o.ok).toBe(true);
      const c = o.content as {
        items: Array<{ parcel_id: string; roof_age_basis: string }>;
        count: number;
      };
      expect(c.items.map((i) => i.parcel_id)).toEqual(
        direct.items.map((i) => i.parcel_id),
      );
      expect(c.count).toBe(direct.count);
      expect(c.items.every((i) => i.roof_age_basis === "PROXY")).toBe(true);
      for (const r of o.records)
        expect(r).toEqual<Citation>({
          kind: "parcel",
          id: expect.stringMatching(/^\d{10}$/),
          source_name: FIXTURE.source,
          collected_at: "2026-11-11T16:17:40.932Z",
        });
      expect(o.records).toHaveLength(c.items.length);
    },
  );
  test("the fixture's expected order at 5 mi (nearest first)", async () => {
    const o = await runTool(
      "search_aged_roofs",
      { lat: P.lat, lon: P.lon },
      data.queries,
    );
    const c = o.content as { items: Array<{ parcel_id: string }> };
    expect(c.items.map((i) => i.parcel_id)).toEqual([
      "0000000001",
      "0000000007",
      "0000000002",
    ]);
  });
  test("parcel_detail: no owner field from the real view", async () => {
    const o = await runTool(
      "parcel_detail",
      { parcel_id: "0000000001" },
      data.queries,
    );
    const json = JSON.stringify(o.content);
    for (const k of [
      "owner_unchanged_10y_proxy",
      "out_of_area_owner",
      "last_recording_date",
    ])
      expect(json).not.toContain(k);
    expect(o.content).toMatchObject({
      property: {
        parcel_id: "0000000001",
        city: "TEST CITY",
        use_label: "Single",
        roof_age_basis: "PROXY",
        roof_age_basis_label: ROOF_AGE_BASIS.proxy,
      },
    });
    // The source name and collection time only; page file, request URL and sha256 stay in the data API.
    const prov = (o.content as { provenance: Record<string, unknown> })
      .provenance;
    expect(Object.keys(prov)).toEqual(["source_name", "source_retrieved_at"]);
    expect(prov.source_name).toBe(FIXTURE.source);
    expect(typeof prov.source_retrieved_at).toBe("string");
  });
  test("run_summary over the real views", async () => {
    const o = await runTool("run_summary", {}, data.queries);
    expect(o.content).toMatchObject({
      run: {
        run_id: FIXTURE.runId,
        limitations: ["fixture only"],
        row_counts: { parquet: 7 },
      },
      sources: [
        {
          source_name: FIXTURE.source,
          terms_of_use: "https://example.test/terms",
          // Each source's URLs, once.
          hub_page: "https://example.test/hub",
          query_url: "https://example.test/query",
          query_urls: null,
        },
      ],
    });
  });
});

describe("permit tools over the real permits router (writePermitFixture)", () => {
  /** A source of the kind as explorer.sources serves it, for the expected citation. */
  async function sourceOf(kind: "permit" | "contractor") {
    const s = (await permitData.caller.explorer.sources()).sources.find(
      (x) => x.source_kind === kind,
    )!;
    return {
      source_name: s.source_name,
      license: s.license,
      attribution: s.attribution,
      retrieved:
        s.first_retrieved_at === s.last_retrieved_at
          ? s.first_retrieved_at
          : `${s.first_retrieved_at} to ${s.last_retrieved_at}`,
    };
  }

  test.each([5, 10])(
    "long_open_permits returns the same permit numbers in the same order as caller.permits.longOpen (radius %s)",
    async (radius) => {
      const direct = await permitData.caller.permits.longOpen({
        lat: P.lat,
        lon: P.lon,
        radius_miles: radius,
        min_open_days: 1826,
        sort: "open_days",
        offset: 0,
        limit: 25,
      });
      const o = await runTool(
        "long_open_permits",
        { lat: P.lat, lon: P.lon, radius_miles: radius, limit: 25 },
        permitData.queries,
      );
      expect(o.ok).toBe(true);
      const c = o.content as {
        count: number;
        scope: string;
        source: unknown;
        items: Array<Record<string, unknown>>;
      };
      expect(c.items.map((i) => i.permit_number)).toEqual(
        direct.items.map((i) => i.permit_number),
      );
      expect(c.items.map((i) => i.permit_number)).toEqual([
        N.P7,
        N.P2,
        N.P3,
        N.P9,
        N.P6,
      ]);
      expect(c.items.map((i) => i.parcel_id)).toEqual(
        direct.items.map((i) => i.parcel_id),
      );
      expect(c.count).toBe(direct.count);
      // The route filters roofing work on the server (68c697b): the open-issued non-roofing permit P11 is left
      // out, the coating-only permit P9 is kept and flagged; the tool filters nothing itself.
      expect(c.items.map((i) => i.permit_number)).not.toContain(N.P11);
      expect(c.items.every((i) => i.roofing_work === true)).toBe(true);
      expect(
        c.items.filter((i) => i.roof_coating_only).map((i) => i.permit_number),
      ).toEqual([N.P9]);
      expect(c.scope).toBe("roofing work only");
      const permitSource = await sourceOf("permit");
      expect(permitSource.source_name).toBe(PERMIT_FIXTURE.permitSource);
      expect(c.source).toEqual(permitSource);
      // Each item keeps both roofing flags; LADBS's status text is served as source_status.
      for (const [i, item] of c.items.entries()) {
        expect(item.roofing_work).toBe(direct.items[i]!.roofing_work);
        expect(item.roof_coating_only).toBe(direct.items[i]!.roof_coating_only);
        expect(item.source_status).toBe(direct.items[i]!.source_status_desc);
        expect(item).not.toHaveProperty("source_status_desc");
        // The basis word is the stored label's first word; the label is served as is.
        const label = direct.items[i]!.roof_age_basis;
        expect(item.roof_age_basis).toBe(label.split(":")[0]);
        expect(item.roof_age_basis_label).toBe(label);
      }
      // P2 counts at parcel A, whose roof year comes from the finaled roofing permit P1.
      expect(c.items[1]).toMatchObject({
        parcel_id: "0000000011",
        roof_age_basis: "PERMIT",
        roof_age_basis_label: ROOF_AGE_BASIS.permit,
        roof_year_permit_number: N.P1,
      });
      expect(c.items[2]).toMatchObject({
        parcel_id: "0000000022",
        roof_age_basis: "PROXY",
        roof_age_basis_label: ROOF_AGE_BASIS.proxy,
        building_level: true,
        join_method: "condo-building",
      });
      // Each item's permit, then the permit that set its parcel's roof year, each cited once.
      const cited = [
        ...new Set(
          direct.items.flatMap((i) => [
            i.permit_number,
            ...(i.roof_year_permit_number ? [i.roof_year_permit_number] : []),
          ]),
        ),
      ];
      expect(cited).toContain(N.P1);
      expect(o.records).toEqual(
        cited.map((id) => ({
          kind: "permit",
          id,
          source_name: permitSource.source_name,
          license: "none stated",
          attribution: "LADBS",
          collected_at: permitSource.retrieved,
        })),
      );
      expect(o.gaps).toEqual([]);
      expect(JSON.stringify(o.content)).not.toContain(PERMIT_WORK_DESC);
    },
  );

  test("parcel_permits: the parcel's fields once, then permits with contractors, BBB not available, sources once", async () => {
    const direct = await permitData.caller.permits.forParcel({
      parcel_id: "0000000011",
    });
    const o = await runTool(
      "parcel_permits",
      { parcel_id: "0000000011" },
      permitData.queries,
    );
    expect(o.ok).toBe(true);
    const c = o.content as Record<string, unknown> & {
      permits: Array<
        Record<string, unknown> & {
          contractors: Array<Record<string, unknown>>;
        }
      >;
    };
    expect(Object.keys(c)).toEqual([
      "parcel_id",
      "permit_data_available",
      "jurisdiction",
      "effective_roof_year",
      "roof_age_basis",
      "roof_age_basis_label",
      "roof_year_permit_number",
      "permits",
      "canonical_name_note",
      "bbb",
      "sources",
    ]);
    expect(c).toMatchObject({
      parcel_id: "0000000011",
      permit_data_available: true,
      jurisdiction: "LOS ANGELES",
      effective_roof_year: 2020,
      roof_age_basis: "PERMIT",
      roof_age_basis_label: ROOF_AGE_BASIS.permit,
      roof_year_permit_number: N.P1,
      bbb: { available: false, reason: direct.bbb.reason },
      sources: {
        permits: await sourceOf("permit"),
        contractors: await sourceOf("contractor"),
      },
    });
    expect(c.permits.map((p) => p.permit_number)).toEqual(
      direct.permits.map((p) => p.permit_number),
    );
    expect(c.permits.map((p) => p.permit_number)).toEqual([N.P1, N.P2]);
    expect(c.permits[0]).toMatchObject({
      permit_status_class: "closed",
      source_status: "Permit Finaled",
      roofing_work: true,
      roof_coating_only: false,
    });
    for (const p of c.permits) {
      expect(p).not.toHaveProperty("parcel_id");
      expect(p).not.toHaveProperty("source_status_desc");
    }
    expect(c.permits[0]!.contractors).toEqual([
      {
        contractors_business_name: "FIXTURE ROOFING INC",
        license_identifier: "100001",
        // The license's identity as the API serves it (identity_permit_count is not passed on).
        contractor_identity_key: "100001",
        canonical_business_name: "FIXTURE ROOFING INC",
        name_variant_count: 1,
        license_class: "C-39",
        source_license_type: "C39",
        license_class_note: null,
        is_owner_builder: false,
        city_name: "VAN NUYS",
        state_code: "CA",
      },
      expect.objectContaining({
        contractors_business_name: null,
        is_owner_builder: true,
        license_class_note: "owner-builder",
      }),
    ]);
    expect(c.permits[1]!.contractors).toEqual([]);
    expect(o.records.map((r) => `${r.kind}:${r.id}:${r.source_name}`)).toEqual([
      `permit:${N.P1}:${PERMIT_FIXTURE.permitSource}`,
      `permit:${N.P2}:${PERMIT_FIXTURE.permitSource}`,
      `contractor:${N.P1}:${PERMIT_FIXTURE.contractorSource}`,
    ]);
    // Each source with its own name, license, attribution and retrieval time: the contractor citation never
    // takes the permit source's.
    const permitSource = await sourceOf("permit");
    const contractorSource = await sourceOf("contractor");
    expect(permitSource).toEqual({
      source_name: PERMIT_FIXTURE.permitSource,
      license: "none stated",
      attribution: "LADBS",
      retrieved: "2026-11-12T13:14:56.570Z",
    });
    expect(contractorSource).toEqual({
      source_name: PERMIT_FIXTURE.contractorSource,
      license: "CC BY 4.0",
      attribution: "LADBS",
      retrieved: "2026-11-12T14:00:51.383Z",
    });
    expect(o.records[0]).toEqual({
      kind: "permit",
      id: N.P1,
      source_name: PERMIT_FIXTURE.permitSource,
      license: "none stated",
      attribution: "LADBS",
      collected_at: permitSource.retrieved,
    });
    expect(o.records[2]).toEqual({
      kind: "contractor",
      id: N.P1,
      source_name: PERMIT_FIXTURE.contractorSource,
      license: "CC BY 4.0",
      attribution: "LADBS",
      collected_at: contractorSource.retrieved,
    });
    expect(JSON.stringify(o.content)).not.toContain(PERMIT_WORK_DESC);
  });

  test("parcel_permits outside the City of Los Angeles; a parcel without permits cites nothing", async () => {
    const d = await runTool(
      "parcel_permits",
      { parcel_id: "0000000031" },
      permitData.queries,
    );
    expect(d.content).toMatchObject({
      permit_data_available: false,
      jurisdiction: "PASADENA",
    });
    const h = await runTool(
      "parcel_permits",
      { parcel_id: "0000000042" },
      permitData.queries,
    );
    expect(h.content).toMatchObject({
      permit_data_available: true,
      permits: [],
    });
    expect(h.records).toEqual([]);
    expect((h.content as { sources: unknown }).sources).toEqual({
      permits: await sourceOf("permit"),
    });
  });

  test("search_aged_roofs: the basis word and label come from the search item (PERMIT from a finaled roofing permit)", async () => {
    const o = await runTool(
      "search_aged_roofs",
      {
        lat: P.lat,
        lon: P.lon,
        radius_miles: 5,
        threshold_years: 5,
        limit: 25,
      },
      permitData.queries,
    );
    const items = (o.content as { items: Array<Record<string, unknown>> })
      .items;
    expect(items.find((i) => i.parcel_id === "0000000011")).toMatchObject({
      effective_roof_year: 2020,
      roof_age_years: 6,
      roof_age_basis: "PERMIT",
      roof_age_basis_label: ROOF_AGE_BASIS.permit,
      roof_year_permit_number: N.P1,
      permit_data_available: true,
    });
    expect(items.find((i) => i.parcel_id === "0000000031")).toMatchObject({
      roof_age_basis: "PROXY",
      permit_data_available: false,
    });
    expect(o.ids).toContain(N.P1);
  });

  test("parcel_detail: roof-year facts from v_property, the basis as word and label", async () => {
    const o = await runTool(
      "parcel_detail",
      { parcel_id: "0000000011" },
      permitData.queries,
    );
    expect(o.content).toMatchObject({
      property: {
        effective_roof_year: 2020,
        roof_year_permit_number: N.P1,
        roof_age_basis: "PERMIT",
        roof_age_basis_label: ROOF_AGE_BASIS.permit,
        jurisdiction: "LOS ANGELES",
        permit_data_available: true,
      },
    });
  });
});

describe("resolve_place over DuckDB (contract views, bound parameters)", () => {
  test("postal city and jurisdiction from the fixture's columns; unknown names", async () => {
    const city = await data.queries.places.resolve({ name: "Test City, CA" });
    expect(city).toMatchObject({
      status: "resolved",
      basis: "postal_city",
      raw_values: ["TEST CITY"],
      parcel_count: 6,
      center: { lat: P.lat, lon: P.lon },
      center_reliable: true,
    });
    if (city.status === "resolved")
      expect(city.note).toBe(
        `Resolved 'Test City, CA' (postal city) to the median center ${P.lat.toFixed(5)}, ${P.lon.toFixed(5)} of 6 parcels. Stored postal city names: TEST CITY.`,
      );
    const juris = await data.queries.places.resolve({ name: "Los Angeles" });
    expect(juris).toMatchObject({
      status: "resolved",
      basis: "jurisdiction",
      raw_values: ["LOS ANGELES"],
      parcel_count: 6,
    });
    expect(
      (await data.queries.places.resolve({ name: "Atlantis" })).status,
    ).toBe("unknown");
  });
});

describe("MCP server over the SDK's in-memory transport", () => {
  async function connect() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(data.queries);
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    return { client, server };
  }

  test("lists the six tools and answers search_aged_roofs like the API", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      const search = tools.find((t) => t.name === "search_aged_roofs")!;
      expect(search.inputSchema.required).toEqual(["lat", "lon"]);

      const res = await client.callTool({
        name: "search_aged_roofs",
        arguments: {
          lat: P.lat,
          lon: P.lon,
          radius_miles: 5,
          threshold_years: 15,
        },
      });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      const body = JSON.parse(content[0]!.text) as {
        result: { items: Array<{ parcel_id: string }> };
        records: Citation[];
        gaps: string[];
      };
      const direct = await data.caller.parcels.search({
        lat: P.lat,
        lon: P.lon,
        radius_miles: 5,
        threshold_years: 15,
        limit: 10,
      });
      expect(body.result.items.map((i) => i.parcel_id)).toEqual(
        direct.items.map((i) => i.parcel_id),
      );
      expect(body.records.every((r) => r.source_name === FIXTURE.source)).toBe(
        true,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("search_aged_roofs over MCP where no matching parcel has permit data: the long-open count is not available (null, not 0), and the result and gaps say the parcels are outside the City of Los Angeles, naming no place", async () => {
    const { queries } = fakeQueries();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(queries);
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const call = (long_open_permit: boolean) =>
        client.callTool({
          name: "search_aged_roofs",
          arguments: {
            ...PASADENA_RESOLVED,
            radius_miles: 1,
            threshold_years: 20,
            long_open_permit,
          },
        });
      const body = (res: Awaited<ReturnType<typeof call>>) =>
        JSON.parse(
          (res.content as Array<{ type: string; text: string }>)[0]!.text,
        ) as {
          result: {
            count: number | null;
            items: unknown[];
            long_open_permit?: { status: string; count: number | null };
            permit_data?: { without_permit_data: number; text: string };
          };
          gaps: string[];
        };
      const res = await call(true);
      expect(res.isError).toBeFalsy();
      const b = body(res);
      expect(b.result.count).toBeNull();
      expect(b.result.items).toEqual([]);
      expect(b.result.long_open_permit).toMatchObject({
        status: "not_available",
        count: null,
      });
      // The outside statement (where the agent states the place outside the City), then the not-available text.
      expect(b.gaps).toHaveLength(2);
      expect(b.gaps[0]).toBe(b.result.permit_data!.text);
      expect(b.gaps[0]).toBe(
        "All of the nearest 3 of the 42 parcels that match the roof-age rule (only those were checked: the data API marks at most 3 parcels) are outside the City of Los Angeles: no permit data there.",
      );
      expect(b.gaps[1]).toMatch(
        /^Not available: none of the nearest 3 of the 42 parcels that match the roof-age rule has permit data \(all are outside the City of Los Angeles;/,
      );
      expect(b.gaps[1]).toContain("unknown, not 0");
      const plain = body(await call(false));
      expect(plain.result.count).toBe(42);
      expect(plain.result.permit_data?.without_permit_data).toBe(3);
      expect(plain.gaps).toContain(plain.result.permit_data!.text);
      expect(plain.result.permit_data!.text).toMatch(
        /are outside the City of Los Angeles: no permit data there\.$/,
      );
      for (const g of [...b.gaps, ...plain.gaps])
        expect(g).not.toContain("Pasadena");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("long_open_permits over MCP answers from the real permit routes", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(permitData.queries);
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const res = await client.callTool({
        name: "long_open_permits",
        arguments: { lat: P.lat, lon: P.lon, radius_miles: 5 },
      });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).not.toContain(PERMIT_WORK_DESC);
      const body = JSON.parse(content[0]!.text) as {
        result: { items: Array<{ permit_number: string }> };
        records: Citation[];
      };
      expect(body.result.items.map((i) => i.permit_number)).toEqual([
        N.P7,
        N.P2,
        N.P3,
        N.P9,
        N.P6,
      ]);
      expect(
        body.records.every(
          (r) =>
            r.kind === "permit" &&
            r.source_name === PERMIT_FIXTURE.permitSource,
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("the MCP server shares the tool layer: long_open_permit and with_contractor_window are in its schemas, and search_aged_roofs' long-open filter answers like parcels.points' marks", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(permitData.queries);
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      const props = (name: string) =>
        Object.keys(
          tools.find((t) => t.name === name)!.inputSchema.properties ?? {},
        );
      expect(props("search_aged_roofs")).toContain("long_open_permit");
      expect(props("long_open_permits")).toContain("with_contractor_window");
      const filter = {
        lat: P.lat,
        lon: P.lon,
        radius_miles: 5,
        threshold_years: 15,
      };
      const res = await client.callTool({
        name: "search_aged_roofs",
        arguments: { ...filter, long_open_permit: true },
      });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      const body = JSON.parse(content[0]!.text) as {
        result: {
          count: number;
          long_open_permit: { unit: string; count: number; of: number };
          items: Array<{ parcel_id: string }>;
        };
      };
      const points = await permitData.caller.parcels.points(filter);
      const marked = points.id.filter(
        (_, i) => points.long_open_permit[i] === 1,
      );
      expect(marked.length).toBeGreaterThan(0);
      expect(marked.length).toBeLessThan(points.count);
      expect(body.result.long_open_permit).toMatchObject({
        unit: "parcels",
        count: marked.length,
        of: points.count,
      });
      expect(body.result.count).toBe(marked.length);
      expect(body.result.items.map((i) => i.parcel_id)).toEqual(
        marked.slice(0, 10),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("runAgent end to end on the fixture (scripted model)", () => {
  test("demo prompt 1 with the fixture point: records cite the fixture source", async () => {
    const model = new ScriptedModel([
      toolReply([
        {
          name: "search_aged_roofs",
          input: {
            lat: P.lat,
            lon: P.lon,
            radius_miles: 5,
            threshold_years: 15,
          },
        },
      ]),
      textReply(
        "Parcels 0000000001, 0000000007 and 0000000002 have roofs older than 15 years (year-built proxy).",
      ),
    ]);
    const a = await runAgent(
      {
        question:
          "Which properties in Los Angeles County within five miles of Van Nuys have roofs older than 15 years?",
        center: { ...P, label: "Fixture point" },
      },
      { model, queries: data.queries, settings: SETTINGS },
    );
    expect(a.status).toBe("answered");
    expect(a.records.map((r) => r.id)).toEqual([
      "0000000001",
      "0000000007",
      "0000000002",
    ]);
    expect(a.unverified_ids).toEqual([]);
    for (const g of STANDARD_GAPS) expect(a.gaps).toContain(g);
    for (const h of [
      "## How this was answered",
      "## Assumptions",
      "## Records cited",
      "## Gaps",
    ])
      expect(a.markdown).toContain(h);
  });
});

describe("conversation on the permit fixture: pipeline README lines 108 then 110 ([city xyz] → the fixture's postal city)", () => {
  test("the permit turn reuses turn 1's area, reads the real permit routes, cites the permit source once, no descriptions", async () => {
    const counted = countingSources(permitData.queries);
    const model = new ScriptedModel([
      // Turn 1
      toolReply([{ name: "resolve_place", input: { name: "Test City" } }]),
      (p) => {
        const r = lastToolResult(p, "resolve_place") as {
          center: { lat: number; lon: number };
        };
        return toolReply([
          {
            name: "search_aged_roofs",
            input: {
              lat: r.center.lat,
              lon: r.center.lon,
              radius_miles: 5,
              threshold_years: 15,
            },
          },
        ]);
      },
      textReply("Listed the parcels with roofs older than 15 years."),
      // Turn 2: the area comes from the request's "Previous search area" block, never from constants.
      (p) => {
        const texts = p.messages.at(-1)!.content as Array<{
          type: string;
          text?: string;
        }>;
        const m =
          /^Previous search area: .+, center (-?[\d.]+), (-?[\d.]+), radius ([\d.]+) mi\.$/.exec(
            texts[0]!.text!,
          )!;
        return toolReply([
          {
            name: "long_open_permits",
            input: {
              lat: Number(m[1]),
              lon: Number(m[2]),
              radius_miles: Number(m[3]),
              min_open_days: Math.round(5 * 365.25),
            },
          },
        ]);
      },
      (p) => {
        const r = lastToolResult(p, "long_open_permits") as {
          items: Array<{ parcel_id: string; permit_number: string }>;
        };
        return toolReply([
          {
            name: "parcel_permits",
            // The parcel of the condo-building permit P3 (its contractor is FIXTURE BUILDERS).
            input: {
              parcel_id: r.items.find((i) => i.permit_number === N.P3)!
                .parcel_id,
            },
          },
        ]);
      },
      textReply(
        `Permit ${N.P3} has been open 2,500 days; the listed contractor is FIXTURE BUILDERS (license 100002).`,
      ),
    ]);
    const a1 = await runAgent(
      {
        question:
          "Which properties in Los Angeles County within five miles of Test City have roofs older than 15 years?",
      },
      { model, queries: counted.queries, settings: SETTINGS },
    );
    expect(a1.status).toBe("answered");
    const area = a1.session.area!;
    expect(area).toMatchObject({ label: "Test City", radius_miles: 5 });

    const before = counted.count();
    const a2 = await runAgent(
      {
        question:
          "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?",
        history: a1.history,
        session: a1.session,
      },
      { model, queries: counted.queries, settings: SETTINGS },
    );
    expect(a2.status).toBe("answered");
    // explorer.sources was read once for the answer's two permit tools.
    expect(counted.count() - before).toBe(1);
    const direct = await permitData.caller.permits.longOpen({
      lat: area.lat,
      lon: area.lon,
      radius_miles: area.radius_miles,
      min_open_days: 1826,
      limit: 10,
    });
    const permitRecords = a2.records.filter((r) => r.kind === "permit");
    // The long-open permits with their parcels' roof-year permits, then parcel_permits' own.
    const forParcel = await permitData.caller.permits.forParcel({
      parcel_id: "0000000022",
    });
    expect(permitRecords.map((r) => r.id)).toEqual([
      ...new Set([
        ...direct.items.flatMap((i) => [
          i.permit_number,
          ...(i.roof_year_permit_number ? [i.roof_year_permit_number] : []),
        ]),
        ...forParcel.permits.map((p) => p.permit_number),
        ...(forParcel.roof_year_permit_number
          ? [forParcel.roof_year_permit_number]
          : []),
      ]),
    ]);
    expect(a2.records.filter((r) => r.kind === "contractor")).toEqual([
      {
        kind: "contractor",
        id: N.P3,
        source_name: PERMIT_FIXTURE.contractorSource,
        license: "CC BY 4.0",
        attribution: "LADBS",
        collected_at: "2026-11-12T14:00:51.383Z",
      },
    ]);
    expect(a2.reasoning).toBe(
      "Searched long-open permits, roofing work only, within 5 mi of Test City open at least 1,826 days: 5 match, 5 listed; read the permits of parcel 0000000022 (1 permit, 1 contractor row). Rule: long-open permits are roofing work only (the data API's rule: an issued permit for roofing work, open at least 1,826 days; a roof-coating-only permit counts and is flagged).",
    );
    expect(a2.assumptions).toContain(
      "Radius and center reused from the previous question (Test City, 5 mi).",
    );
    const cited = a2.markdown.slice(
      a2.markdown.indexOf("## Records cited"),
      a2.markdown.indexOf("## Gaps"),
    );
    expect(cited.split(PERMIT_FIXTURE.permitSource)).toHaveLength(2);
    expect(cited.split(PERMIT_FIXTURE.contractorSource)).toHaveLength(2);
    // The two source lines: each source's own license, attribution and retrieval time.
    expect(cited).toContain(
      "\n- Permits: Fixture LADBS permits (license: none stated; attribution: LADBS), retrieved 2026-11-12T13:14:56.570Z\n",
    );
    expect(cited).toContain(
      `\n- Contractor rows of permits: Fixture LADBS contractors (license: CC BY 4.0; attribution: LADBS), retrieved 2026-11-12T14:00:51.383Z\n  - ${N.P3}\n`,
    );
    for (const id of permitRecords.map((r) => r.id))
      expect(cited).toContain(`\n  - ${id}`);
    expect(a2.unverified_ids).toEqual([]);
    const everything = JSON.stringify({ requests: model.requests, a1, a2 });
    expect(everything).not.toContain(PERMIT_WORK_DESC);
    expect(everything).not.toContain("source_status_desc");
  });
});

describe("the ownership filter, resolve_place and the contractor window over the real routers (fixtures)", () => {
  test.each(OWNERSHIP_BASES)(
    "search_aged_roofs with ownership basis %s answers as caller.parcels.search with it; the stated texts are the API's",
    async (basis) => {
      const direct = await data.caller.parcels.search({
        lat: P.lat,
        lon: P.lon,
        radius_miles: 5,
        threshold_years: 15,
        ownership_basis: basis,
        limit: 25,
      });
      const o = await runTool(
        "search_aged_roofs",
        {
          lat: P.lat,
          lon: P.lon,
          limit: 25,
          ownership_filter: true,
          ownership_basis: basis,
        },
        data.queries,
      );
      expect(o.ok).toBe(true);
      const c = o.content as {
        count: number;
        ownership: unknown;
        items: Array<{ parcel_id: string; land_base_year: number | null }>;
      };
      expect(c.count).toBe(direct.count);
      expect(c.items.map((i) => i.parcel_id)).toEqual(
        direct.items.map((i) => i.parcel_id),
      );
      expect(c.items.map((i) => i.land_base_year)).toEqual(
        direct.items.map((i) => i.land_base_year),
      );
      expect(c.ownership).toEqual(direct.ownership);
    },
  );
  test("resolve_place goes through the data API's places.resolve (the shared module)", async () => {
    const o = await runTool(
      "resolve_place",
      { name: "Test City" },
      data.queries,
    );
    const direct = await data.caller.places.resolve({ name: "Test City" });
    expect(o.content).toMatchObject({
      status: direct.status,
      ...(direct.status === "resolved"
        ? { parcel_count: direct.parcel_count, raw_values: direct.raw_values }
        : {}),
    });
  });
  test("a run whose sources state no contractor window: the prompt as without one, the documented end and why", async () => {
    const model = new ScriptedModel([textReply("No contractor data then.")]);
    const a = await runAgent(
      {
        question:
          "Which contractors are on roofing permits issued after May 2023?",
      },
      { model, queries: permitData.queries, settings: SETTINGS },
    );
    expect(model.requests[0]!.params.system).toBe(
      systemPrompt(SETTINGS.maxToolTurns),
    );
    expect(a.gaps.slice(1, 3)).toEqual([
      GAP_CONTRACTOR_DEFAULT,
      GAP_CONTRACTOR_NO_WINDOW,
    ]);
  });
});
