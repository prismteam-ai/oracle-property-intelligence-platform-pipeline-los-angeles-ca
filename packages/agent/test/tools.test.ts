import { beforeAll, describe, expect, test } from "vitest";
import { basisWord, onceSources } from "../src/permit-api.ts";
import { dropDescriptions } from "../src/policy.ts";
import {
  TOOL_NAMES,
  anthropicTools,
  runTool,
  toolSchemas,
} from "../src/tools.ts";
import {
  CONTRACTOR_RETRIEVED,
  FAKE_PARCELS,
  FAKE_PERMITS,
  FAKE_SOURCES,
  PERMIT_RETRIEVED,
  ROOF_AGE_BASIS,
  SECRET_DESCRIPTION,
  blockNetwork,
  fakeQueries,
} from "./helpers.ts";

beforeAll(blockNetwork);

/** Every key at any depth of a JSON value. */
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  return out;
}

describe("tool definitions for the model", () => {
  const tools = anthropicTools();
  test("six tools, strict, objects closed, no unsupported keywords left in the schema", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "resolve_place",
      "search_aged_roofs",
      "long_open_permits",
      "parcel_detail",
      "parcel_permits",
      "run_summary",
    ]);
    for (const t of tools) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema.additionalProperties).toBe(false);
      const keys = keysDeep(t.input_schema.properties);
      for (const bad of [
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "pattern",
        "default",
        "$schema",
      ])
        expect(keys).not.toContain(bad);
    }
  });
  test("bounds and defaults survive as description text", () => {
    const search = tools.find((t) => t.name === "search_aged_roofs")!;
    const props = search.input_schema.properties as Record<
      string,
      { description?: string }
    >;
    expect(props.radius_miles?.description).toMatch(/maximum: 10/);
    expect(props.radius_miles?.description).toMatch(/default: 5/);
    expect(search.input_schema.required).toEqual(["lat", "lon"]);
  });
  test("zod defaults (shared with the MCP server)", () => {
    expect(toolSchemas.search_aged_roofs.parse({ lat: 34, lon: -118 })).toEqual(
      {
        lat: 34,
        lon: -118,
        radius_miles: 5,
        threshold_years: 15,
        limit: 10,
      },
    );
    expect(toolSchemas.long_open_permits.parse({ lat: 34, lon: -118 })).toEqual(
      {
        lat: 34,
        lon: -118,
        radius_miles: 5,
        min_open_days: 1826,
        limit: 10,
      },
    );
    // No client-side roofing input: the server filters roofing work (68c697b).
    expect(
      toolSchemas.long_open_permits.safeParse({
        lat: 34,
        lon: -118,
        roofing_only: true,
      }).success,
    ).toBe(false);
    expect(TOOL_NAMES).toHaveLength(6);
  });
});

describe("runTool", () => {
  test("unknown tool and invalid input are error results, not exceptions", async () => {
    const { queries, calls } = fakeQueries();
    const a = await runTool("drop_tables", {}, queries);
    expect(a).toMatchObject({ ok: false, error: "unknown tool: drop_tables" });
    const b = await runTool(
      "search_aged_roofs",
      { lat: 34, lon: -118, radius_miles: 50 },
      queries,
    );
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/radius_miles/);
    const c = await runTool("parcel_detail", { parcel_id: "123" }, queries);
    expect(c.ok).toBe(false);
    expect(calls).toEqual([]);
  });
  test("search_aged_roofs: inputs reach parcels.search unchanged; every item cited; truncation stated", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      {
        lat: 34.199,
        lon: -118.487,
        radius_miles: 5,
        threshold_years: 15,
        limit: 3,
      },
      queries,
    );
    expect(o.ok).toBe(true);
    expect(calls[0]).toEqual({
      fn: "parcels.search",
      input: {
        lat: 34.199,
        lon: -118.487,
        radius_miles: 5,
        threshold_years: 15,
        offset: 0,
        limit: 3,
      },
    });
    expect(calls.filter((c) => c.fn === "parcels.detail")).toHaveLength(3);
    const content = o.content as {
      items: Array<Record<string, unknown>>;
      count: number;
      truncated: boolean;
    };
    expect(content.items.map((i) => i.parcel_id)).toEqual(FAKE_PARCELS);
    expect(Object.keys(content.items[0]!)).toEqual([
      "parcel_id",
      "address",
      "year_built",
      "effective_roof_year",
      "roof_age_years",
      "roof_age_basis",
      "roof_age_basis_label",
      "roof_year_permit_number",
      "permit_data_available",
      "distance_miles",
      "citation",
    ]);
    // The basis comes from the search item (its first word plus the full label), not from the detail row.
    expect(content.items[0]).toMatchObject({
      roof_age_years: 76,
      roof_age_basis: "PROXY",
      roof_age_basis_label: ROOF_AGE_BASIS.proxy,
      permit_data_available: true,
    });
    expect(content.truncated).toBe(true);
    expect(o.records).toHaveLength(3);
    for (const r of o.records)
      expect(r).toEqual({
        kind: "parcel",
        id: expect.stringMatching(/^\d{10}$/),
        source_name: "LA County Assessor Roll",
        collected_at: "2026-11-11T16:17:40.932Z",
      });
    expect(o.gaps.join("\n")).toMatch(
      /truncated: search_aged_roofs returned 3 of 42/,
    );
    expect(o.gaps.join("\n")).toMatch(/proxy/);
  });
  test("parcel_detail: allowlisted fields only, no owner field at all", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "parcel_detail",
      { parcel_id: "1000000001" },
      queries,
    );
    const keys = keysDeep(o.content);
    for (const owner of [
      "owner_unchanged_10y_proxy",
      "out_of_area_owner",
      "last_recording_date",
    ])
      expect(keys).not.toContain(owner);
    expect(keys).not.toContain("use_description");
    const property = (o.content as { property: Record<string, unknown> })
      .property;
    expect(property.use_label).toBe("Single");
    expect(property).toMatchObject({
      roof_age_basis: "PROXY",
      roof_age_basis_label: ROOF_AGE_BASIS.proxy,
      effective_roof_year: 1950,
      jurisdiction: "LOS ANGELES",
      permit_data_available: true,
    });
    // §15.2: per record, the source name and collection time only; URLs once per source in run_summary, page
    // files and hashes in the data API.
    expect((o.content as { provenance: unknown }).provenance).toEqual({
      source_name: FAKE_SOURCES.parcel,
      source_retrieved_at: "2026-11-11T16:17:40.932Z",
    });
    for (const dropped of [
      "source_request_url",
      "source_page_file",
      "source_page_sha256",
      "source_request_method",
    ])
      expect(keys).not.toContain(dropped);
    expect(o.records).toEqual([
      {
        kind: "parcel",
        id: "1000000001",
        source_name: "LA County Assessor Roll",
        collected_at: "2026-11-11T16:17:40.932Z",
      },
    ]);
  });
  test("long_open_permits: inputs reach permits.longOpen unchanged; no roofing filter; the source cited once", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "long_open_permits",
      { lat: 34.2, lon: -118.45, radius_miles: 5 },
      queries,
    );
    expect(o.ok).toBe(true);
    expect(calls).toEqual([
      {
        fn: "permits.longOpen",
        input: {
          lat: 34.2,
          lon: -118.45,
          radius_miles: 5,
          min_open_days: 1826,
          sort: "open_days",
          offset: 0,
          limit: 10,
        },
      },
      { fn: "explorer.sources", input: undefined },
    ]);
    const c = o.content as {
      rule: string;
      scope: string;
      source: unknown;
      items: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    // The route's rule.text, unchanged (§15.3).
    expect(c.rule).toBe("Open at least min_open_days days (fake rule).");
    expect(c.scope).toBe("roofing work only");
    expect(c.source).toEqual({
      source_name: FAKE_SOURCES.permit,
      license: null,
      attribution: "LADBS",
      retrieved: PERMIT_RETRIEVED,
    });
    expect(c.items.map((i) => i.permit_number)).toEqual([
      FAKE_PERMITS[0],
      FAKE_PERMITS[2],
    ]);
    expect(Object.keys(c.items[0]!)).toEqual([
      "permit_number",
      "permit_status_class",
      "source_status",
      "source_permit_type",
      "source_permit_sub_type",
      "address",
      "application_received_date",
      "permit_issue_date",
      "status_date",
      "open_since",
      "open_days",
      "roofing_work",
      "roof_coating_only",
      "join_method",
      "building_level",
      "parcel_count",
      "parcel_id",
      "distance_miles",
      "effective_roof_year",
      "roof_age_basis",
      "roof_age_basis_label",
      "roof_year_permit_number",
    ]);
    expect(c.items[1]).toMatchObject({
      source_status: "Issued",
      roofing_work: true,
      roof_coating_only: false,
      roof_age_basis: "PERMIT",
      roof_age_basis_label: ROOF_AGE_BASIS.permit,
      roof_year_permit_number: FAKE_PERMITS[0],
    });
    // No per-item source fields: the citation is the permit source from explorer.sources.
    expect(c.items.every((i) => !("citation" in i))).toBe(true);
    expect(o.records).toEqual(
      [FAKE_PERMITS[0], FAKE_PERMITS[2]].map((id) => ({
        kind: "permit",
        id,
        source_name: FAKE_SOURCES.permit,
        attribution: "LADBS",
        collected_at: PERMIT_RETRIEVED,
      })),
    );
    expect(c.truncated).toBe(true);
    expect(o.gaps).toEqual([
      "Results truncated: long_open_permits returned 2 of 57 long-open permits (longest open first).",
    ]);
    const all = await runTool(
      "long_open_permits",
      { lat: 34.2, lon: -118.45, max_open_days: 9000, limit: 25 },
      queries,
    );
    expect(all.ok).toBe(true);
    expect(calls[2]!.input).toMatchObject({ max_open_days: 9000, limit: 25 });
  });
  test("roof-age basis: the first word of the stored label", () => {
    expect(basisWord(ROOF_AGE_BASIS.proxy)).toBe("PROXY");
    expect(basisWord(ROOF_AGE_BASIS.permit)).toBe("PERMIT");
    expect(basisWord("PROXY")).toBe("PROXY");
    expect(basisWord("PERMITTED: x")).toBeNull();
    expect(basisWord(null)).toBeNull();
  });
  test("long_open_permits: max below min is an error result", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "long_open_permits",
      { lat: 34, lon: -118, min_open_days: 2000, max_open_days: 100 },
      queries,
    );
    expect(o).toMatchObject({
      ok: false,
      error: "max_open_days is below min_open_days",
    });
  });
  test("permit descriptions (work_desc, description) never appear in a tool result", async () => {
    const { queries } = fakeQueries();
    for (const [name, input] of [
      ["long_open_permits", { lat: 34, lon: -118 }],
      ["parcel_permits", { parcel_id: "1000000001" }],
    ] as const) {
      const o = await runTool(name, input, queries);
      expect(o.ok).toBe(true);
      const json = JSON.stringify(o.content);
      expect(json).not.toContain(SECRET_DESCRIPTION);
      expect(json).not.toMatch(/desc/i);
      // LADBS's status text survives, renamed: it is a status, not a description.
      expect(json).toContain('"source_status":"Issued"');
      // Only the extra description keys were dropped, by the allowlist (the guard had nothing left to drop).
      expect(o.dropped).toBe(0);
    }
  });
  test("parcel_permits: the parcel's fields once, then permits with contractors; BBB not available; sources cited once", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "parcel_permits",
      { parcel_id: "1000000001" },
      queries,
    );
    expect(o.ok).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual([
      "permits.forParcel",
      "explorer.sources",
    ]);
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
      "bbb",
      "sources",
    ]);
    expect(c).toMatchObject({
      parcel_id: "1000000001",
      permit_data_available: true,
      jurisdiction: "LOS ANGELES",
      effective_roof_year: 2016,
      roof_age_basis: "PERMIT",
      roof_age_basis_label: ROOF_AGE_BASIS.permit,
      roof_year_permit_number: FAKE_PERMITS[2],
      bbb: { available: false, reason: "BBB ratings are not available." },
      sources: {
        permits: {
          source_name: FAKE_SOURCES.permit,
          license: null,
          attribution: "LADBS",
          retrieved: PERMIT_RETRIEVED,
        },
        // The contractor source's own license, attribution and retrieval time, never the permit row's.
        contractors: {
          source_name: FAKE_SOURCES.contractor,
          license: "CC BY 4.0",
          attribution: "LADBS",
          retrieved: CONTRACTOR_RETRIEVED,
        },
      },
    });
    // The parcel's fields are not repeated per permit.
    for (const p of c.permits) {
      expect(p).not.toHaveProperty("parcel_id");
      expect(p).not.toHaveProperty("roof_age_basis");
      expect(p).not.toHaveProperty("effective_roof_year");
    }
    expect(c.permits.map((p) => p.permit_number)).toEqual([
      FAKE_PERMITS[0],
      FAKE_PERMITS[1],
    ]);
    expect(Object.keys(c.permits[0]!).at(-1)).toBe("contractors");
    expect(Object.keys(c.permits[0]!.contractors[0]!)).toEqual([
      "contractors_business_name",
      "license_identifier",
      "license_class",
      "source_license_type",
      "license_class_note",
      "is_owner_builder",
      "license_expiration_date",
      "city_name",
      "state_code",
    ]);
    expect(c.permits[1]!.contractors).toEqual([]);
    expect(o.records).toEqual([
      {
        kind: "permit",
        id: FAKE_PERMITS[0],
        source_name: FAKE_SOURCES.permit,
        attribution: "LADBS",
        collected_at: PERMIT_RETRIEVED,
      },
      {
        kind: "permit",
        id: FAKE_PERMITS[1],
        source_name: FAKE_SOURCES.permit,
        attribution: "LADBS",
        collected_at: PERMIT_RETRIEVED,
      },
      {
        kind: "contractor",
        id: FAKE_PERMITS[0],
        source_name: FAKE_SOURCES.contractor,
        license: "CC BY 4.0",
        attribution: "LADBS",
        collected_at: CONTRACTOR_RETRIEVED,
      },
    ]);
  });
  test("a permit route error is an error result, never an exception", async () => {
    const { queries } = fakeQueries();
    const failing = {
      ...queries,
      permits: {
        ...queries.permits,
        forParcel: () =>
          Promise.reject(new Error("parcel 1000000009 not found")),
      },
    };
    const o = await runTool(
      "parcel_permits",
      { parcel_id: "1000000009" },
      failing,
    );
    expect(o).toMatchObject({
      ok: false,
      error: "parcel 1000000009 not found",
      input: { parcel_id: "1000000009" },
    });
  });
  test("onceSources: explorer.sources runs once for any number of calls", async () => {
    const { queries, calls } = fakeQueries();
    const once = onceSources(queries);
    await runTool("long_open_permits", { lat: 34.2, lon: -118.45 }, once);
    await runTool("parcel_permits", { parcel_id: "1000000001" }, once);
    await runTool("run_summary", {}, once);
    expect(calls.filter((c) => c.fn === "explorer.sources")).toHaveLength(1);
  });
  test("run_summary: run facts and sources, no other run fields", async () => {
    const { queries } = fakeQueries();
    const o = await runTool("run_summary", {}, queries);
    const json = JSON.stringify(o.content);
    expect(json).not.toContain("secret_field");
    expect(o.content).toMatchObject({
      run: {
        run_id: "run-1",
        row_counts: { parquet: 3 },
        limitations: ["fixture only"],
      },
      sources: [
        {
          source_kind: "contractor",
          license: "CC BY 4.0",
          attribution: "LADBS",
        },
        { source_kind: "permit", source_name: FAKE_SOURCES.permit },
        {
          source_kind: "parcel",
          source_name: "LA County Assessor Roll",
          terms_of_use: "https://example.test/terms",
        },
      ],
    });
  });
  test("run_summary: each source once with its URLs, terms, license, attribution, page count and window (§15.2)", async () => {
    const { queries } = fakeQueries();
    const o = await runTool("run_summary", {}, queries);
    const sources = (o.content as { sources: Array<Record<string, unknown>> })
      .sources;
    expect(sources.map((x) => Object.keys(x))).toEqual(
      sources.map(() => [
        "source_kind",
        "source_name",
        "record_count",
        "page_count",
        "first_retrieved_at",
        "last_retrieved_at",
        "role",
        "hub_page",
        "query_url",
        "query_urls",
        "terms_of_use",
        "license",
        "attribution",
        "access",
      ]),
    );
    expect(sources[1]).toMatchObject({
      source_kind: "permit",
      page_count: 1,
      first_retrieved_at: "2026-11-12T10:00:00.000Z",
      last_retrieved_at: "2026-11-12T11:30:00.000Z",
      query_url: null,
      query_urls: [
        "https://example.test/permits?a=1",
        "https://example.test/permits?a=2",
      ],
    });
    expect(sources[2]).toMatchObject({
      source_kind: "parcel",
      hub_page: "https://example.test/hub",
      query_url: "https://example.test/query",
      query_urls: null,
    });
    // No page-level rows: they stay in the data API.
    expect(keysDeep(o.content)).not.toContain("source_page_sha256");
    expect(keysDeep(o.content)).not.toContain("pages");
  });
});

describe("description guard", () => {
  test("drops /desc/i keys at any depth and counts them", () => {
    const r = dropDescriptions({
      a: 1,
      work_desc: "x",
      nested: [{ Description: "y", keep: true, deeper: { descr: 1 } }],
    });
    expect(r).toEqual({
      value: { a: 1, nested: [{ keep: true, deeper: {} }] },
      dropped: 3,
    });
  });
});
