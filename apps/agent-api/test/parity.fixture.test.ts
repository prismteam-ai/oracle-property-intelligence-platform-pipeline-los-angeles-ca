/**
 * The HTTP DataQueries adapter against the data API's real router: tRPC's fetch adapter serves appRouter over the
 * API's permit fixture (apps/api/test/fixture.ts) in process, so the adapter's GET requests go through the same
 * tRPC server code as the deployed data API. Every route the tools read, and every tool, equals the in-process
 * caller over the same Db (explorer.sources: the sources, without the page list). Scratch folders are removed
 * afterwards. No network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOOL_NAMES,
  httpDataQueries,
  runTool,
  type DataQueries,
} from "@oracle-la/agent";
import { appRouter } from "@oracle-la/api/router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
// The API's database and fixture, by relative path (as apps/agent-mcp's tests import them).
import { openDb } from "../../api/src/db.ts";
import type { Ctx } from "../../api/src/trpc.ts";
import {
  FIXTURE,
  PERMIT_FIXTURE,
  writePermitFixture,
  type FixtureRun,
} from "../../api/test/fixture.ts";

const API_URL = "https://data-api.fixture.test";
const scratch: string[] = [];
let caller: ReturnType<typeof appRouter.createCaller>;
let http: DataQueries;
let direct: DataQueries;
const tokens: string[] = [];

beforeAll(async () => {
  vi.stubGlobal("fetch", () => {
    throw new Error("network is disabled in tests");
  });
  const f: FixtureRun = await writePermitFixture();
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-api-parity-"));
  scratch.push(f.dir, tmpDir);
  const db = await openDb({
    runId: FIXTURE.runId,
    parquetSha256: f.parquetSha256,
    parquetFile: FIXTURE.parquetFile,
    permitFiles: f.permitFiles,
    localDir: f.dir,
    tmpDir,
  });
  const ctx: Ctx = {
    db: async () => db,
    logger: { info() {}, warn() {} },
    metrics: { addMetric() {} },
  };
  caller = appRouter.createCaller(ctx);
  direct = {
    parcels: caller.parcels,
    explorer: caller.explorer,
    permits: caller.permits,
    places: caller.places,
  };
  http = httpDataQueries({
    apiUrl: API_URL,
    apiToken: "fixture-token",
    fetch: async (input, init) => {
      const req = new Request(String(input), init);
      tokens.push(req.headers.get("authorization") ?? "");
      return fetchRequestHandler({
        endpoint: "/trpc",
        req,
        router: appRouter,
        createContext: () => ctx,
      });
    },
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const P = FIXTURE.point;
const N = PERMIT_FIXTURE.p;

describe("the adapter over the real router equals the in-process caller", () => {
  test("every route the tools read; the token is sent on each request", async () => {
    const search = {
      lat: P.lat,
      lon: P.lon,
      radius_miles: 1,
      threshold_years: 15,
      offset: 0,
      limit: 5,
    };
    expect(await http.parcels.search(search)).toEqual(
      await direct.parcels.search(search),
    );
    const owned = { ...search, ownership_basis: "both" as const };
    expect(await http.parcels.search(owned)).toEqual(
      await direct.parcels.search(owned),
    );
    expect(await http.parcels.detail({ parcel_id: "0000000011" })).toEqual(
      await direct.parcels.detail({ parcel_id: "0000000011" }),
    );
    expect(await http.explorer.runSummary()).toEqual(
      await direct.explorer.runSummary(),
    );
    const sources = await http.explorer.sources();
    expect(sources).toEqual({
      sources: (await direct.explorer.sources()).sources,
    });
    expect(Object.keys(sources)).toEqual(["sources"]);
    const lo = {
      lat: P.lat,
      lon: P.lon,
      radius_miles: 5,
      min_open_days: 1826,
      sort: "open_days" as const,
      offset: 0,
      limit: 10,
    };
    expect(await http.permits.longOpen(lo)).toEqual(
      await direct.permits.longOpen(lo),
    );
    expect(await http.permits.forParcel({ parcel_id: "0000000011" })).toEqual(
      await direct.permits.forParcel({ parcel_id: "0000000011" }),
    );
    for (const name of ["Pasadena", "Springfield"])
      expect(await http.places.resolve({ name })).toEqual(
        await direct.places.resolve({ name }),
      );
    expect(new Set(tokens)).toEqual(new Set(["Bearer fixture-token"]));
  });

  test("every tool gives the same outcome over HTTP as in process", async () => {
    const inputs: Record<(typeof TOOL_NAMES)[number], unknown> = {
      resolve_place: { name: "Pasadena" },
      search_aged_roofs: { lat: P.lat, lon: P.lon, radius_miles: 1 },
      long_open_permits: { lat: P.lat, lon: P.lon, radius_miles: 5 },
      parcel_detail: { parcel_id: "0000000011" },
      parcel_permits: { parcel_id: "0000000011" },
      run_summary: {},
    };
    for (const name of TOOL_NAMES) {
      const viaHttp = await runTool(name, inputs[name], http);
      const inProcess = await runTool(name, inputs[name], direct);
      expect(viaHttp.ok, name).toBe(true);
      expect(viaHttp, name).toEqual(inProcess);
    }
    // The long-open search finds the fixture's long-open permit.
    const lo = await runTool(
      "long_open_permits",
      inputs.long_open_permits,
      http,
    );
    expect(lo.ids).toContain(N.P1);
  });

  test("a procedure error (an input the API refuses) is a failed tool, not a gap", async () => {
    const o = await runTool("parcel_detail", { parcel_id: "9999999999" }, http);
    expect(o.ok).toBe(false);
    expect(o.gaps).toEqual([]);
  });
});
