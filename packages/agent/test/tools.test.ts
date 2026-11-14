import { OWNERSHIP_BASIS, OWNERSHIP_PROXY_NOTE } from "@oracle-la/api/contract";
import { beforeAll, describe, expect, test } from "vitest";
import { ownershipRuleLine } from "../src/ownership.ts";
import { basisWord, onceSources, type DataQueries } from "../src/permit-api.ts";
import { dropDescriptions } from "../src/policy.ts";
import {
  TOOL_NAMES,
  anthropicTools,
  runTool,
  toolSchemas,
} from "../src/tools.ts";
import {
  CONTRACTOR_COVERAGE,
  CONTRACTOR_RETRIEVED,
  FAKE_PARCELS,
  FAKE_PERMITS,
  FAKE_SOURCES,
  OWNERSHIP_COUNT,
  PERMIT_RETRIEVED,
  ROOF_AGE_BASIS,
  SECRET_DESCRIPTION,
  apiOwnershipRule,
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
        ownership_filter: false,
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
      "contractor_identity_key",
      "canonical_business_name",
      "name_variant_count",
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
      // The permit that set the parcel's roof year (roof_year_permit_number), under the permit source (§17 A1).
      {
        kind: "permit",
        id: FAKE_PERMITS[2],
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
  test("§17 A1: every tool that returns a roof_year_permit_number cites it as a permit record under the permit source", async () => {
    const ROOF_PERMIT = "15016-20000-25193";
    const permitRecord = (id: string) => ({
      kind: "permit",
      id,
      source_name: FAKE_SOURCES.permit,
      attribution: "LADBS",
      collected_at: PERMIT_RETRIEVED,
    });
    const { queries, calls } = fakeQueries();
    const withRoofPermit: DataQueries = {
      ...queries,
      parcels: {
        search: async (i) => {
          const r = await queries.parcels.search(i);
          return {
            ...r,
            items: r.items.map((it, n) =>
              n === 1
                ? {
                    ...it,
                    roof_age_basis: ROOF_AGE_BASIS.permit,
                    effective_roof_year: 2015,
                    roof_year_permit_number: ROOF_PERMIT,
                  }
                : it,
            ),
          };
        },
        detail: async (i) => {
          const d = await queries.parcels.detail(i);
          return {
            ...d,
            property: {
              ...d.property,
              roof_age_basis: ROOF_AGE_BASIS.permit,
              roof_year_permit_number: ROOF_PERMIT,
            },
          };
        },
      },
      permits: {
        ...queries.permits,
        longOpen: async (i) => {
          const r = await queries.permits.longOpen(i);
          return {
            ...r,
            items: r.items.map((it, n) =>
              n === 0 ? { ...it, roof_year_permit_number: ROOF_PERMIT } : it,
            ),
          };
        },
      },
      explorer: queries.explorer,
      places: queries.places,
    };
    // search_aged_roofs: the parcel, then the permit that set its roof year; sources read for that citation.
    const search = await runTool(
      "search_aged_roofs",
      { lat: 34.2, lon: -118.45 },
      withRoofPermit,
    );
    expect(search.records.map((r) => `${r.kind}:${r.id}`)).toEqual([
      `parcel:${FAKE_PARCELS[0]}`,
      `parcel:${FAKE_PARCELS[1]}`,
      `permit:${ROOF_PERMIT}`,
      `parcel:${FAKE_PARCELS[2]}`,
    ]);
    expect(search.records[2]).toEqual(permitRecord(ROOF_PERMIT));
    expect(calls.filter((c) => c.fn === "explorer.sources")).toHaveLength(1);
    // parcel_detail: the parcel and its roof-year permit.
    const detail = await runTool(
      "parcel_detail",
      { parcel_id: FAKE_PARCELS[0] },
      withRoofPermit,
    );
    expect(detail.records).toEqual([
      {
        kind: "parcel",
        id: FAKE_PARCELS[0],
        source_name: FAKE_SOURCES.parcel,
        collected_at: "2026-11-11T16:17:40.932Z",
      },
      permitRecord(ROOF_PERMIT),
    ]);
    expect(detail.gaps).toEqual([]);
    // long_open_permits: each item's permit, then its parcel's roof-year permit (cited once).
    const longOpen = await runTool(
      "long_open_permits",
      { lat: 34.2, lon: -118.45 },
      withRoofPermit,
    );
    expect(longOpen.records).toEqual(
      [FAKE_PERMITS[0]!, ROOF_PERMIT, FAKE_PERMITS[2]!].map(permitRecord),
    );
  });
  test("§17 A1: a parcel whose roof year is a proxy cites no permit and reads no sources", async () => {
    const { queries, calls } = fakeQueries();
    const search = await runTool(
      "search_aged_roofs",
      { lat: 34.2, lon: -118.45 },
      queries,
    );
    const detail = await runTool(
      "parcel_detail",
      { parcel_id: FAKE_PARCELS[0] },
      queries,
    );
    expect(
      [...search.records, ...detail.records].every((r) => r.kind === "parcel"),
    ).toBe(true);
    expect(calls.filter((c) => c.fn === "explorer.sources")).toEqual([]);
  });
  test("§17 A1: no permit source in the run: the roof-year permit is not cited and the gap says so", async () => {
    const { queries } = fakeQueries();
    const noPermitSource: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        detail: async (i) => {
          const d = await queries.parcels.detail(i);
          return {
            ...d,
            property: {
              ...d.property,
              roof_year_permit_number: FAKE_PERMITS[0],
            },
          };
        },
      },
      explorer: {
        ...queries.explorer,
        sources: async () => {
          const src = await queries.explorer.sources();
          return {
            ...src,
            sources: src.sources.filter((x) => x.source_kind !== "permit"),
          };
        },
      },
    };
    const detail = await runTool(
      "parcel_detail",
      { parcel_id: FAKE_PARCELS[0] },
      noPermitSource,
    );
    expect(detail.records.map((r) => r.kind)).toEqual(["parcel"]);
    expect(detail.gaps).toEqual([
      "No permit source is listed in the run's sources: the permits are listed without a citation.",
    ]);
  });
  test("§17 A2: resolve_place serves every center at 5 decimals, the precision its note states", async () => {
    const { queries } = fakeQueries();
    // A data layer with 6-decimal centers (the smoke run's Pasadena center, 34.152795, -118.135784).
    const sixDecimals: DataQueries = {
      ...queries,
      places: {
        resolve: async ({ name }) =>
          name === "Pasadena"
            ? {
                status: "resolved",
                name,
                basis: "jurisdiction",
                center: { lat: 34.152795, lon: -118.135784 },
                parcel_count: 39990,
                raw_values: ["PASADENA"],
                spread_miles: 2.4,
                center_reliable: true,
                also_matched: {
                  basis: "postal_city",
                  center: { lat: 34.147812, lon: -118.144516 },
                  parcel_count: 41000,
                  raw_values: ["PASADENA"],
                  spread_miles: 2.6,
                },
                note: "(raw)",
              }
            : queries.places.resolve({ name }),
      },
    };
    const o = await runTool("resolve_place", { name: "Pasadena" }, sixDecimals);
    const r = o.content as {
      center: { lat: number; lon: number };
      also_matched: { center: { lat: number; lon: number } };
      note: string;
    };
    expect(r.center).toEqual({ lat: 34.15279, lon: -118.13578 });
    expect(r.also_matched.center).toEqual({ lat: 34.14781, lon: -118.14452 });
    expect(r.note).toContain("median center 34.15279, -118.13578 of 39,990");
    expect(r.note).toContain("median center 34.14781, -118.14452 of 41,000");
    const la = await runTool(
      "resolve_place",
      { name: "Los Angeles" },
      sixDecimals,
    );
    expect(
      (la.content as { candidates: Array<{ center: unknown }> }).candidates.map(
        (c) => c.center,
      ),
    ).toEqual([
      { lat: 34.05224, lon: -118.24368 },
      { lat: 34.098, lon: -118.32674 },
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
        "coverage",
        "terms_of_use",
        "license",
        "attribution",
        "access",
      ]),
    );
    // The coverage window: the contractor rows' permit_issue_date range; null for the permits and the roll.
    expect(sources.map((x) => x.coverage)).toEqual([
      CONTRACTOR_COVERAGE,
      null,
      null,
    ]);
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

describe("search_aged_roofs: the ownership filter (P19)", () => {
  const VN = { lat: 34.199, lon: -118.487 };
  const searchInput = (calls: Array<{ fn: string; input: unknown }>) =>
    calls.find((c) => c.fn === "parcels.search")!.input as Record<
      string,
      unknown
    >;

  test("the schema: ownership_filter (boolean, off by default) and ownership_basis (the contract's three bases, optional)", () => {
    const search = anthropicTools().find(
      (t) => t.name === "search_aged_roofs",
    )!;
    const props = search.input_schema.properties as Record<
      string,
      { type?: string; enum?: string[]; description?: string }
    >;
    expect(props.ownership_filter?.type).toBe("boolean");
    expect(props.ownership_filter?.description).toMatch(/default: false/);
    // The SDK's strict-mode transform states the enum in the description; zod refuses any other value.
    expect(props.ownership_basis?.type).toBe("string");
    expect(props.ownership_basis?.description).toContain(
      '{enum: ["recording","base_year","both"]}',
    );
    expect(search.input_schema.required).toEqual(["lat", "lon"]);
    expect(
      toolSchemas.search_aged_roofs.parse({ ...VN, ownership_filter: true }),
    ).not.toHaveProperty("ownership_basis");
    expect(
      toolSchemas.search_aged_roofs.safeParse({
        ...VN,
        ownership_filter: true,
        ownership_basis: "sale",
      }).success,
    ).toBe(false);
  });

  test("off by default: no ownership_basis reaches parcels.search; no ownership or land_base_year in the result", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool("search_aged_roofs", VN, queries);
    expect(o.ok).toBe(true);
    expect(searchInput(calls)).not.toHaveProperty("ownership_basis");
    expect(o.content).not.toHaveProperty("ownership");
    expect(keysDeep(o.content)).not.toContain("land_base_year");
    expect(o.fact).toMatchObject({ ownership_basis: null, count: 42 });
  });

  test('on without a basis: "both"; the result states the basis, its text, weakness and the proxy note as the contract has them', async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      { ...VN, ownership_filter: true },
      queries,
    );
    expect(o.ok).toBe(true);
    expect(searchInput(calls)).toEqual({
      ...VN,
      radius_miles: 5,
      threshold_years: 15,
      ownership_basis: "both",
      offset: 0,
      limit: 10,
    });
    const c = o.content as {
      count: number;
      ownership: Record<string, string>;
      items: Array<Record<string, unknown>>;
    };
    expect(c.count).toBe(OWNERSHIP_COUNT);
    expect(c.ownership).toEqual({
      basis: "both",
      text: OWNERSHIP_BASIS.both.text,
      weakness: OWNERSHIP_BASIS.both.weakness,
      proxy_note: OWNERSHIP_PROXY_NOTE,
    });
    // The same texts the API states (apps/api/src/routers/parcels.ts ownershipRule).
    expect(c.ownership).toEqual(apiOwnershipRule("both"));
    expect(c.items.map((i) => i.land_base_year)).toEqual([1975, 1976, 1977]);
    expect(o.fact).toMatchObject({
      ownership_basis: "both",
      count: OWNERSHIP_COUNT,
    });
  });

  test.each(["recording", "base_year", "both"] as const)(
    "basis %s: sent as named and stated with its own weakness",
    async (basis) => {
      const { queries, calls } = fakeQueries();
      const o = await runTool(
        "search_aged_roofs",
        { ...VN, ownership_filter: true, ownership_basis: basis },
        queries,
      );
      expect(searchInput(calls).ownership_basis).toBe(basis);
      expect((o.content as { ownership: unknown }).ownership).toEqual(
        apiOwnershipRule(basis),
      );
      expect(ownershipRuleLine(basis)).toBe(
        `Ownership filter (basis "${basis}"): ${OWNERSHIP_BASIS[basis].text} Weakness: ${OWNERSHIP_BASIS[basis].weakness} ${OWNERSHIP_PROXY_NOTE}`,
      );
    },
  );

  test("a basis with the filter off is refused (not ignored) before any data call", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      { ...VN, ownership_basis: "recording" },
      queries,
    );
    expect(o).toMatchObject({
      ok: false,
      error: "ownership_basis is set but ownership_filter is off",
    });
    expect(calls).toEqual([]);
  });

  test("a result whose stated basis differs from the one asked is an error, never shown as filtered", async () => {
    const { queries } = fakeQueries();
    const wrong: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        search: async (input) => ({
          ...(await queries.parcels.search(input)),
          ownership: null,
        }),
      },
    };
    const o = await runTool(
      "search_aged_roofs",
      { ...VN, ownership_filter: true },
      wrong,
    );
    expect(o).toMatchObject({
      ok: false,
      error: "the data API applied ownership basis none, not both",
    });
  });
});

describe("parcel_permits: the contractor identity (P19)", () => {
  test("key, canonical name and variant count as served; the permit count and any variant list are not passed on", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "parcel_permits",
      { parcel_id: FAKE_PARCELS[0] },
      queries,
    );
    const c = o.content as {
      permits: Array<{ contractors: Array<Record<string, unknown>> }>;
    };
    expect(c.permits[0]!.contractors[0]).toMatchObject({
      contractors_business_name: "ACME ROOFING INC",
      license_identifier: "123456",
      contractor_identity_key: "123456",
      canonical_business_name: "ACME ROOFING, INC.",
      name_variant_count: 2,
    });
    expect(keysDeep(o.content)).not.toContain("identity_permit_count");
  });

  test("a license without any name has no name: null canonical name, never one taken from elsewhere; variants never listed", async () => {
    const { queries } = fakeQueries();
    const nameless: DataQueries = {
      ...queries,
      permits: {
        ...queries.permits,
        forParcel: async (input) => {
          const r = await queries.permits.forParcel(input);
          const p = r.permits[0]!;
          return {
            ...r,
            permits: [
              {
                ...p,
                contractors: [
                  {
                    ...p.contractors[0]!,
                    contractors_business_name: null,
                    license_identifier: "999999",
                    contractor_identity_key: "999999",
                    canonical_business_name: null,
                    name_variant_count: 0,
                    // A list of variants is never part of the result, even if a row carried one.
                    ...{ name_variants: ["GUESSED ROOFING"] },
                  },
                ],
              },
            ],
          };
        },
      },
    };
    const o = await runTool(
      "parcel_permits",
      { parcel_id: FAKE_PARCELS[0] },
      nameless,
    );
    const c = o.content as {
      permits: Array<{ contractors: Array<Record<string, unknown>> }>;
    };
    expect(c.permits[0]!.contractors[0]).toMatchObject({
      contractors_business_name: null,
      license_identifier: "999999",
      contractor_identity_key: "999999",
      canonical_business_name: null,
      name_variant_count: 0,
    });
    expect(keysDeep(o.content)).not.toContain("name_variants");
    expect(JSON.stringify(o.content)).not.toContain("GUESSED");
    expect(JSON.stringify(o.content)).not.toContain("ACME");
  });
});
