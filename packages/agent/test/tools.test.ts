import { OWNERSHIP_BASIS, OWNERSHIP_PROXY_NOTE } from "@oracle-la/api/contract";
import type {
  LongOpenResult,
  ParcelPermits,
  PermitContractor,
  PointsResult,
} from "@oracle-la/api/contract";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ownershipRuleLine } from "../src/ownership.ts";
import { basisWord, onceSources, type DataQueries } from "../src/permit-api.ts";
import { dropDescriptions } from "../src/policy.ts";
import {
  CANONICAL_NAME_NOTE,
  CONTRACTOR_READS_MS,
  PLACE_UNKNOWN_HOW_TO_ASK,
  TOOL_NAMES,
  WITHIN_WINDOW_LIMIT,
  anthropicTools,
  daysBetween,
  runTool,
  toolSchemas,
} from "../src/tools.ts";
import { DataApiUnavailableError, httpDataQueries } from "../src/http-data.ts";
import { FAKE_API_URL, fakeDataApi } from "./fake-data-api.ts";
import {
  CONTRACTOR_COVERAGE,
  CONTRACTOR_RETRIEVED,
  CONTRACTOR_RETRIEVED as CONTRACTOR_CITED_AT,
  FAKE_LONG_OPEN,
  FAKE_PARCELS,
  FAKE_PERMITS,
  FAKE_SOURCES,
  MIXED_CENTER,
  OWNERSHIP_COUNT,
  PASADENA_RESOLVED,
  PERMIT_RETRIEVED,
  ROOF_AGE_BASIS,
  SECRET_DESCRIPTION,
  apiOwnershipRule,
  blockNetwork,
  fakeQueries,
} from "./helpers.ts";

beforeAll(blockNetwork);
afterEach(() => {
  vi.useRealTimers();
});

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
        long_open_permit: false,
      },
    );
    expect(toolSchemas.long_open_permits.parse({ lat: 34, lon: -118 })).toEqual(
      {
        lat: 34,
        lon: -118,
        radius_miles: 5,
        min_open_days: 1826,
        limit: 10,
        with_contractor_window: false,
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
    // Per record, the source name and collection time only; URLs once per source in run_summary, page
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
      // The circle's permit data: parcels.points at the coverage threshold with the call's window.
      {
        fn: "parcels.points",
        input: {
          lat: 34.2,
          lon: -118.45,
          radius_miles: 5,
          threshold_years: 1,
          min_open_days: 1826,
        },
      },
    ]);
    const c = o.content as {
      rule: string;
      scope: string;
      source: unknown;
      items: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    // The route's rule.text, unchanged.
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
    // The fake's points are truncated (the nearest 3 of 42, all with permit data): the list covers the whole circle,
    // and how many parcels lie outside the City of Los Angeles is known for the nearest 3 only.
    expect(o.gaps).toEqual([
      "The count and the list cover every permit within 5 mi. How many of the 42 parcels within 5 mi that have a roof year lie outside the City of Los Angeles, where there is no permit data, was counted only for the nearest 3 (the data API marks at most 3 parcels): none of those 3 does; for the other 39 it is not known.",
      "Results truncated: long_open_permits returned 2 of 57 long-open permits (longest open first).",
    ]);
    const all = await runTool(
      "long_open_permits",
      { lat: 34.2, lon: -118.45, max_open_days: 9000, limit: 25 },
      queries,
    );
    expect(all.ok).toBe(true);
    expect(calls[3]!.input).toMatchObject({ max_open_days: 9000, limit: 25 });
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
      "canonical_name_note",
      "bbb",
      "sources",
    ]);
    // What the canonical name is, once: the latest name on the license's permits, not a registration.
    expect(c.canonical_name_note).toBe(CANONICAL_NAME_NOTE);
    expect(c.canonical_name_note).toBe(
      "canonical_business_name is the latest business name on the license's LADBS permits, not a registered or legal name of the license.",
    );
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
      "city_name",
      "state_code",
    ]);
    // The API's license_expiration_date (the date recorded with the permit, not the license's status today) is
    // not passed to the model.
    expect(c.permits[0]!.contractors[0]!).not.toHaveProperty(
      "license_expiration_date",
    );
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
      // The permit that set the parcel's roof year (roof_year_permit_number), under the permit source.
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
  test("every tool that returns a roof_year_permit_number cites it as a permit record under the permit source", async () => {
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
        points: queries.parcels.points,
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
    // The PERMIT row's own citation names the permit source too (not only the roll's).
    const citations = (
      search.content as { items: Array<{ citation: unknown }> }
    ).items.map((it) => it.citation);
    expect(citations[1]).toEqual({
      source_name: FAKE_SOURCES.parcel,
      collected_at: "2026-11-11T16:17:40.932Z",
      roof_year_source: {
        source_name: FAKE_SOURCES.permit,
        retrieved: PERMIT_RETRIEVED,
      },
    });
    expect(citations[0]).toEqual({
      source_name: FAKE_SOURCES.parcel,
      collected_at: "2026-11-11T16:17:40.932Z",
    });
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
    expect(
      (detail.content as { roof_year_source?: unknown }).roof_year_source,
    ).toEqual({
      source_name: FAKE_SOURCES.permit,
      retrieved: PERMIT_RETRIEVED,
    });
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
  test("a parcel whose roof year is a proxy cites no permit and reads no sources", async () => {
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
  test("no permit source in the run: the roof-year permit is not cited and the gap says so", async () => {
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
  test("resolve_place, unknown: the data API's note unchanged, plus how_to_ask (a point by latitude and longitude); both in the gaps", async () => {
    const { queries } = fakeQueries();
    const direct = await queries.places.resolve({ name: "Springfield" });
    const o = await runTool("resolve_place", { name: "Springfield" }, queries);
    expect(o.ok).toBe(true);
    expect(PLACE_UNKNOWN_HOW_TO_ASK).toBe(
      "Ask again with a point: its latitude and longitude (the Explorer's Latitude and Longitude fields above the question, or the CRM's map pin).",
    );
    expect(o.content).toEqual({
      ...direct,
      how_to_ask: PLACE_UNKNOWN_HOW_TO_ASK,
    });
    expect(o.gaps).toEqual([direct.note, PLACE_UNKNOWN_HOW_TO_ASK]);
    // A resolved or ambiguous place has no how_to_ask.
    for (const name of ["Van Nuys", "Los Angeles"]) {
      const r = await runTool("resolve_place", { name }, queries);
      expect(r.content).not.toHaveProperty("how_to_ask");
      expect(r.gaps).not.toContain(PLACE_UNKNOWN_HOW_TO_ASK);
    }
  });
  test("resolve_place serves every center at 5 decimals, the precision its note states", async () => {
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
  test("run_summary: BBB ratings are not available, and why, in one sentence", async () => {
    const { queries } = fakeQueries();
    const o = await runTool("run_summary", {}, queries);
    expect((o.content as { bbb: unknown }).bbb).toEqual({
      available: false,
      reason:
        "BBB ratings are not available: no source in this data includes them.",
    });
    // The only BBB text in the result; no gap added (the standard gap stays the answer's).
    expect(JSON.stringify(o.content).match(/BBB/g)).toHaveLength(1);
    expect(o.gaps).toEqual([]);
  });
  test("run_summary: each source once with its URLs, terms, license, attribution, page count and window", async () => {
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

describe("search_aged_roofs: the ownership filter", () => {
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

describe("parcel_permits: the contractor identity", () => {
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

describe("long_open_permits: with_contractor_window", () => {
  const at = { lat: 34.2, lon: -118.45, radius_miles: 5 };
  type Lists = {
    contractor_window: Record<string, unknown>;
    longest_open: Record<string, unknown> & {
      items: { permit_number: string }[];
    };
    within_contractor_window: Record<string, unknown>;
  };

  test("days from the window's first day to the reference date, computed in code", () => {
    expect(daysBetween("2013-01-02", "2026-11-12")).toBe(5062);
    expect(daysBetween("2026-11-12", "2026-11-12")).toBe(0);
    expect(daysBetween("2013-01-02", "12 Nov 2026")).toBeNull();
  });

  test("off (the default): one long-open call, the result shape unchanged", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool("long_open_permits", at, queries);
    expect(o.ok).toBe(true);
    expect(calls.filter((c) => c.fn === "permits.longOpen")).toHaveLength(1);
    // permit_data: the fake's points are truncated (only the nearest checked).
    expect(Object.keys(o.content as object)).toEqual([
      "count",
      "returned",
      "rule",
      "scope",
      "source",
      "permit_data",
      "items",
      "truncated",
    ]);
  });

  test("on: the default call, then explorer.sources, then parcels.points (the circle's permit data), then the within-window call (one at a time); both lists labeled, the limit and the two dates stated", async () => {
    const { queries, calls } = fakeQueries();
    let inFlight = 0;
    let most = 0;
    const tracked =
      <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        most = Math.max(most, ++inFlight);
        try {
          return await f(...a);
        } finally {
          inFlight--;
        }
      };
    const q: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        points: tracked(queries.parcels.points),
      },
      explorer: {
        runSummary: queries.explorer.runSummary,
        sources: tracked(queries.explorer.sources),
      },
      permits: {
        longOpen: tracked(queries.permits.longOpen),
        forParcel: queries.permits.forParcel,
      },
    };
    const o = await runTool(
      "long_open_permits",
      { ...at, limit: 5, with_contractor_window: true },
      q,
    );
    expect(o.ok).toBe(true);
    expect(most).toBe(1);
    // Then the contractor rows of the within-window list: one permits.forParcel per listed parcel.
    expect(calls.map((c) => c.fn)).toEqual([
      "permits.longOpen",
      "explorer.sources",
      "parcels.points",
      "permits.longOpen",
      "permits.forParcel",
      "permits.forParcel",
    ]);
    expect(calls[0]!.input).not.toHaveProperty("max_open_days");
    // The points with the call's window (no maximum) at the coverage threshold.
    expect(calls[2]!.input).toEqual({
      ...at,
      threshold_years: 1,
      min_open_days: 1826,
    });
    expect(calls[3]!.input).toMatchObject({
      min_open_days: 1826,
      max_open_days: 5062,
      limit: 5,
    });
    const c = o.content as Lists;
    // permit_data: the fake's points are truncated (only the nearest checked).
    expect(Object.keys(c)).toEqual([
      "scope",
      "source",
      "permit_data",
      "contractor_window",
      "longest_open",
      "within_contractor_window",
    ]);
    expect(c.contractor_window).toEqual({
      source_name: FAKE_SOURCES.contractor,
      first: CONTRACTOR_COVERAGE.first,
      last: CONTRACTOR_COVERAGE.last,
      reference_date: "2026-11-12",
      max_open_days: 5062,
      text: "The contractor rows (LADBS Contractors) cover permits issued 2013-01-02 to 2023-05-19. A permit issued on or after 2013-01-02 has been open at most 5,062 days on the run's reference date 2026-11-12, so the within-window list is limited to 5,062 days open.",
    });
    expect(c.longest_open.label).toBe(
      "Longest-open permits, any issue date (open at least 1,826 days)",
    );
    expect(c.within_contractor_window).toMatchObject({
      label:
        "Longest-open permits issued within the contractor window (open at least 1,826 days and at most 5,062 days)",
      count: 57,
      max_open_days: 5062,
      truncated: true,
    });
    // Both lists' truncation gaps, each naming its list; the IDs of both lists are known.
    // The fake's parcels list permits 0 and 1 only, so permit 2's contractor is not read, and said so.
    expect(o.gaps).toEqual([
      "The counts and both lists cover every permit within 5 mi. How many of the 42 parcels within 5 mi that have a roof year lie outside the City of Los Angeles, where there is no permit data, was counted only for the nearest 3 (the data API marks at most 3 parcels): none of those 3 does; for the other 39 it is not known.",
      "Results truncated: the longest-open list returned 2 of 57 long-open permits (longest open first).",
      "Results truncated: the within-window list returned 2 of 57 long-open permits (longest open first).",
      `The contractor of permit ${FAKE_PERMITS[2]} (parcel ${FAKE_PARCELS[2]}) was not read (permit ${FAKE_PERMITS[2]} is not among parcel ${FAKE_PARCELS[2]}'s permits (permits.forParcel)); it is listed without its contractor.`,
    ]);
    expect(o.ids).toEqual(
      expect.arrayContaining([FAKE_PERMITS[0], FAKE_PARCELS[0]]),
    );
    expect(o.fact).toMatchObject({
      tool: "long_open_permits",
      within_window: {
        status: "read",
        max_open_days: 5062,
        count: 57,
        returned: 2,
      },
    });
  });

  test("on: the within-window call asks for min(limit, WITHIN_WINDOW_LIMIT) permits; the longest-open call keeps limit (default 10)", async () => {
    expect(WITHIN_WINDOW_LIMIT).toBe(5);
    for (const [limit, first, within] of [
      [undefined, 10, 5],
      [10, 10, 5],
      [25, 25, 5],
      [5, 5, 5],
      [3, 3, 3],
    ] as const) {
      const { queries, calls } = fakeQueries();
      const o = await runTool(
        "long_open_permits",
        {
          ...at,
          ...(limit !== undefined ? { limit } : {}),
          with_contractor_window: true,
        },
        queries,
      );
      expect(o.ok).toBe(true);
      const longOpen = calls.filter((c) => c.fn === "permits.longOpen");
      expect(longOpen).toHaveLength(2);
      expect(longOpen[0]!.input).toMatchObject({ limit: first });
      expect(longOpen[0]!.input).not.toHaveProperty("max_open_days");
      expect(longOpen[1]!.input).toMatchObject({
        max_open_days: 5062,
        limit: within,
      });
    }
  });

  test("on: a within-window list cut at 5 states its truncation gap; the longest-open list lists its 10", async () => {
    const { queries } = fakeQueries();
    const twelve = Array.from({ length: 12 }, (_, i) => i);
    const q: DataQueries = {
      ...queries,
      permits: {
        ...queries.permits,
        async longOpen(input) {
          const r = await queries.permits.longOpen(input);
          const base = r.items[0]!;
          const items = twelve.slice(0, input.limit).map((i) => ({
            ...base,
            permit_number: `13016-20000-${String(i).padStart(5, "0")}`,
          }));
          return { ...r, count: 12, items };
        },
      },
    };
    const o = await runTool(
      "long_open_permits",
      { ...at, with_contractor_window: true },
      q,
    );
    const c = o.content as Lists;
    expect(c.longest_open.items).toHaveLength(10);
    expect(c.within_contractor_window).toMatchObject({
      count: 12,
      returned: 5,
      truncated: true,
    });
    expect(o.gaps).toContain(
      "Results truncated: the longest-open list returned 10 of 12 long-open permits (longest open first).",
    );
    expect(o.gaps).toContain(
      "Results truncated: the within-window list returned 5 of 12 long-open permits (longest open first).",
    );
  });

  test("on, with the call's own smaller max_open_days: the within-window limit is lowered to it, and said so", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "long_open_permits",
      { ...at, max_open_days: 4000, with_contractor_window: true },
      queries,
    );
    expect(
      calls.filter((c) => c.fn === "permits.longOpen")[1]!.input,
    ).toMatchObject({
      max_open_days: 4000,
    });
    expect((o.content as Lists).contractor_window.text).toContain(
      "so the within-window list is limited to 4,000 days open (the call's own max_open_days).",
    );
  });

  test("on, the second call fails: the first list with a stated gap", async () => {
    const { queries, calls } = fakeQueries();
    let n = 0;
    const q: DataQueries = {
      ...queries,
      permits: {
        longOpen: async (input) => {
          if (++n === 2) {
            calls.push({ fn: "permits.longOpen", input });
            throw new DataApiUnavailableError("permits.longOpen", "busy", 503);
          }
          return queries.permits.longOpen(input);
        },
        forParcel: queries.permits.forParcel,
      },
    };
    const o = await runTool(
      "long_open_permits",
      { ...at, with_contractor_window: true },
      q,
    );
    expect(o.ok).toBe(true);
    const c = o.content as Lists;
    expect(c.longest_open.items.map((i) => i.permit_number)).toEqual([
      FAKE_PERMITS[0],
      FAKE_PERMITS[2],
    ]);
    const gap =
      "The within-window list was not read (data API busy: permits.longOpen not read): only the longest-open list is given.";
    expect(c.within_contractor_window).toEqual({
      label:
        "Longest-open permits issued within the contractor window: not listed",
      not_listed: gap,
    });
    expect(o.gaps).toContain(gap);
    expect(o.fact).toMatchObject({
      within_window: { status: "not_listed", gap },
    });
  });

  test("on, with no contractor window in the run's sources, or a limit below min_open_days: no second call, the gap stated", async () => {
    const { queries, calls } = fakeQueries();
    const noWindow: DataQueries = {
      ...queries,
      explorer: {
        runSummary: queries.explorer.runSummary,
        sources: async () => {
          const src = await queries.explorer.sources();
          return {
            sources: src.sources.map((s) => ({ ...s, coverage: null })),
          };
        },
      },
    };
    const o = await runTool(
      "long_open_permits",
      { ...at, with_contractor_window: true },
      noWindow,
    );
    expect(calls.filter((c) => c.fn === "permits.longOpen")).toHaveLength(1);
    expect(o.gaps).toContain(
      "The within-window list is not given: the run's sources state no contractor window.",
    );
    const { queries: q2, calls: c2 } = fakeQueries();
    const below = await runTool(
      "long_open_permits",
      { ...at, min_open_days: 6000, with_contractor_window: true },
      q2,
    );
    expect(c2.filter((c) => c.fn === "permits.longOpen")).toHaveLength(1);
    expect(below.gaps).toContain(
      "No permit issued within the contractor window (from 2013-01-02) can be open 6,000 days on 2026-11-12: the limit of 5,062 days is below the minimum, so no within-window list is given.",
    );
  });
});

describe("long_open_permits: the contractor of every within-window item", () => {
  const at = { lat: 34.2, lon: -118.45, radius_miles: 5 };
  const [P0, P1, P2] = FAKE_PARCELS as [string, string, string];
  const OTHER = "16010-10000-00009";
  const AFTER = "24016-10000-00001";
  const row = (extra: Partial<PermitContractor>): PermitContractor => ({
    contractors_business_name: "ACME ROOFING INC",
    license_identifier: "123456",
    contractor_identity_key: "123456",
    canonical_business_name: "ACME ROOFING, INC.",
    name_variant_count: 2,
    identity_permit_count: 9,
    source_license_type: "C39",
    license_class: "C-39",
    license_class_note: null,
    is_owner_builder: false,
    license_expiration_date: "2024-01-31",
    city_name: "VAN NUYS",
    state_code: "CA",
    ...extra,
  });
  const OWNER_BUILDER = row({
    contractors_business_name: "OWNER-BUILDER",
    license_identifier: null,
    contractor_identity_key: null,
    canonical_business_name: null,
    name_variant_count: 0,
    license_class: null,
    source_license_type: "Owner-Builder",
    license_class_note: "owner-builder",
    is_owner_builder: true,
  });
  /**
   * The within-window call lists four permits on three parcels: permit 0 (P0, a named contractor), permit 2 (P2, an
   * owner-builder), OTHER (P0 again, no contractor row) and AFTER (P1, issued after the rows end, no row).
   */
  function within(
    base: DataQueries,
    forParcel?: DataQueries["permits"]["forParcel"],
  ) {
    const reads: string[] = [];
    const q: DataQueries = {
      ...base,
      permits: {
        longOpen: async (i): Promise<LongOpenResult> => {
          const r = await base.permits.longOpen(i);
          if (i.max_open_days === undefined) return r;
          const [a, b] = r.items as [
            LongOpenResult["items"][number],
            LongOpenResult["items"][number],
          ];
          return {
            ...r,
            count: 4,
            items: [
              a,
              b,
              { ...a, permit_number: OTHER },
              {
                ...a,
                permit_number: AFTER,
                parcel_id: P1,
                permit_issue_date: "2024-01-02",
              },
            ],
          };
        },
        forParcel:
          forParcel ??
          (async ({ parcel_id }): Promise<ParcelPermits> => {
            reads.push(parcel_id);
            const r = await base.permits.forParcel({ parcel_id });
            const [p0] = r.permits as [ParcelPermits["permits"][number]];
            const permits =
              parcel_id === P0
                ? [
                    {
                      ...p0,
                      contractors: [
                        row({
                          description: "SECRET",
                        } as Partial<PermitContractor>),
                      ],
                    },
                    { ...p0, permit_number: OTHER, contractors: [] },
                  ]
                : parcel_id === P2
                  ? [
                      {
                        ...p0,
                        permit_number: FAKE_PERMITS[2]!,
                        contractors: [OWNER_BUILDER],
                      },
                    ]
                  : [{ ...p0, permit_number: AFTER, contractors: [] }];
            return { ...r, parcel_id, permits };
          }),
      },
    };
    return { q, reads };
  }
  type Within = {
    contractor_source: unknown;
    contractors: string;
    canonical_name_note: string;
    items: Array<Record<string, unknown>>;
  };
  const withinOf = (o: { content: unknown }) =>
    (o.content as { within_contractor_window: Within })
      .within_contractor_window;

  test("every item carries its contractor rows and status; one permits.forParcel per listed parcel; contractor rows cited under the contractor source", async () => {
    const { queries, calls } = fakeQueries();
    const { q, reads } = within(queries);
    const o = await runTool(
      "long_open_permits",
      { ...at, with_contractor_window: true },
      q,
    );
    expect(o.ok).toBe(true);
    expect(reads).toEqual([P0, P2, P1]);
    const w = withinOf(o);
    expect(w.canonical_name_note).toBe(CANONICAL_NAME_NOTE);
    expect(
      w.items.map((it) => [it.permit_number, it.contractor_status]),
    ).toEqual([
      [FAKE_PERMITS[0], "named"],
      [FAKE_PERMITS[2], "owner-builder"],
      [OTHER, "none stated"],
      [AFTER, "after the contractor window"],
    ]);
    // The license identity of each row: business name, license number, class, canonical name, variant count.
    expect(w.items[0]!.contractors).toEqual([
      {
        contractors_business_name: "ACME ROOFING INC",
        license_identifier: "123456",
        license_class: "C-39",
        license_class_note: null,
        is_owner_builder: false,
        canonical_business_name: "ACME ROOFING, INC.",
        name_variant_count: 2,
      },
    ]);
    expect(w.items[1]!.contractors).toEqual([
      {
        contractors_business_name: "OWNER-BUILDER",
        license_identifier: null,
        license_class: null,
        license_class_note: "owner-builder",
        is_owner_builder: true,
        canonical_business_name: null,
        name_variant_count: 0,
      },
    ]);
    expect(w.items[2]!.contractors).toEqual([]);
    // No expiration date and no description reach the result.
    expect(JSON.stringify(o.content)).not.toContain("2024-01-31");
    expect(JSON.stringify(o.content)).not.toContain("SECRET");
    expect(w.contractors).toBe(
      "Contractor of each listed permit: 1 named, 1 owner-builder, 1 none stated, 1 after the contractor window.",
    );
    expect(w.contractor_source).toEqual({
      source_name: FAKE_SOURCES.contractor,
      license: "CC BY 4.0",
      attribution: "LADBS",
      retrieved: CONTRACTOR_CITED_AT,
    });
    expect(
      o.records.filter((r) => r.kind === "contractor").map((r) => r.id),
    ).toEqual([FAKE_PERMITS[0], FAKE_PERMITS[2]]);
    expect(o.gaps.join(" ")).not.toContain("not read");
    expect(o.fact).toMatchObject({
      within_window: {
        status: "read",
        contractors: {
          named: 1,
          "owner-builder": 1,
          "none stated": 1,
          "after the contractor window": 1,
          "not read": 0,
        },
      },
    });
    // The longest-open list (before the window) carries no contractor fields.
    const longest = (
      o.content as { longest_open: { items: Array<Record<string, unknown>> } }
    ).longest_open;
    expect(longest.items.every((it) => !("contractor_status" in it))).toBe(
      true,
    );
    expect(calls.filter((c) => c.fn === "explorer.sources")).toHaveLength(1);
  });

  test("a failed read: that parcel's items are not read, with why and a gap; the others keep their contractors", async () => {
    const { queries } = fakeQueries();
    const base = within(queries).q.permits.forParcel;
    const { q } = within(queries, async (i) => {
      if (i.parcel_id === P2)
        throw new DataApiUnavailableError("permits.forParcel", "busy", 503);
      return base(i);
    });
    const o = await runTool(
      "long_open_permits",
      { ...at, with_contractor_window: true },
      q,
    );
    expect(o.ok).toBe(true);
    const item = withinOf(o).items[1]!;
    expect(item).toMatchObject({
      permit_number: FAKE_PERMITS[2],
      contractor_status: "not read",
      contractor_not_read: "data API busy: permits.forParcel not read",
      contractors: null,
    });
    expect(o.gaps).toContain(
      `The contractor of permit ${FAKE_PERMITS[2]} (parcel ${P2}) was not read (data API busy: permits.forParcel not read); it is listed without its contractor.`,
    );
    expect(withinOf(o).items[0]!.contractor_status).toBe("named");
  });

  test(`reads still running after CONTRACTOR_READS_MS (${CONTRACTOR_READS_MS} ms, one call's worst case) are stated as not read`, async () => {
    expect(CONTRACTOR_READS_MS).toBe(10_500);
    vi.useFakeTimers();
    const { queries } = fakeQueries();
    const base = within(queries).q.permits.forParcel;
    const { q } = within(queries, (i) =>
      i.parcel_id === P1 ? new Promise<ParcelPermits>(() => {}) : base(i),
    );
    const pending = runTool(
      "long_open_permits",
      { ...at, with_contractor_window: true },
      q,
    );
    await vi.advanceTimersByTimeAsync(CONTRACTOR_READS_MS);
    const o = await pending;
    expect(o.ok).toBe(true);
    expect(withinOf(o).items.map((it) => it.contractor_status)).toEqual([
      "named",
      "owner-builder",
      "none stated",
      "not read",
    ]);
    expect(withinOf(o).items[3]!.contractor_not_read).toBe(
      "permits.forParcel not read within 10.5 s",
    );
  });

  test("through the HTTP adapter: the reads wait for the one slot, never more than 1 data call in flight", async () => {
    const { queries } = fakeQueries();
    const { q: inner } = within(queries);
    const api = fakeDataApi(inner, { delayMs: 20 });
    const q = httpDataQueries({
      apiUrl: FAKE_API_URL,
      apiToken: "test-bearer-token-not-secret",
      fetch: api.fetch,
    });
    const o = await runTool(
      "long_open_permits",
      { ...at, with_contractor_window: true },
      q,
    );
    expect(o.ok).toBe(true);
    expect(
      api.requests.filter((r) => r.route === "permits.forParcel"),
    ).toHaveLength(3);
    expect(api.peak()).toBe(1);
    expect(withinOf(o).items.map((it) => it.contractor_status)).toEqual([
      "named",
      "owner-builder",
      "none stated",
      "after the contractor window",
    ]);
  });
});

describe("search_aged_roofs: long_open_permit", () => {
  const VN = { lat: 34.2, lon: -118.45, radius_miles: 1, threshold_years: 15 };
  type Stated = {
    count: number;
    returned: number;
    long_open_permit?: Record<string, unknown>;
    items: Array<Record<string, unknown>>;
  };
  /** The fake with every parcel drawn: the search counts the three parcels points draws. */
  function complete(base: DataQueries): DataQueries {
    return {
      ...base,
      parcels: {
        detail: base.parcels.detail,
        search: async (i) => ({ ...(await base.parcels.search(i)), count: 3 }),
        points: async (i) => ({
          ...(await base.parcels.points(i)),
          count: 3,
          truncated: false,
        }),
      },
    };
  }

  test("the schema: long_open_permit, boolean, off by default", () => {
    expect(
      toolSchemas.search_aged_roofs.parse({ lat: 34.2, lon: -118.45 }),
    ).toMatchObject({
      long_open_permit: false,
    });
  });

  test("off: parcels.points with the same filter, after the search (one data call in flight), for permit data only; no long_open_permit in the result", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool("search_aged_roofs", VN, queries);
    expect(calls.slice(0, 2)).toEqual([
      { fn: "parcels.search", input: { ...VN, offset: 0, limit: 10 } },
      { fn: "parcels.points", input: { ...VN, min_open_days: 1826 } },
    ]);
    expect(o.content).not.toHaveProperty("long_open_permit");
    // Roof age covers every matching parcel; how many lie outside the City of Los Angeles is counted for the nearest
    // 3 of the 42 only (truncated points; none of them does): stated, with how many match in all; no place is said to
    // be outside the City.
    const nearest =
      "Roof age covers all 42 parcels that match the roof-age rule. How many of them lie outside the City of Los Angeles, where there is no permit data, was counted only for the nearest 3 (the data API marks at most 3 parcels): none of those 3 does; for the other 39 it is not known.";
    expect((o.content as { permit_data?: unknown }).permit_data).toEqual({
      roof_age_covers_all_matching: true,
      checked: 3,
      matched: 42,
      without_permit_data: 0,
      complete: false,
      text: nearest,
    });
    expect(o.gaps).toContain(nearest);
    expect(o.gaps.some((g) => g.includes("is outside the City"))).toBe(false);
    expect(o.fact).toMatchObject({
      long_open: null,
      count: 42,
      matched: 42,
      matched_permit_data: {
        checked: 3,
        with_permit_data: 3,
        without_permit_data: 0,
        complete: false,
      },
    });
  });

  test("on: the search (count and rule) and parcels.points with the same filter, then the marked parcels nearest first; the count is of parcels, not permits", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      { ...VN, long_open_permit: true },
      complete(queries),
    );
    expect(o.ok).toBe(true);
    expect(calls.slice(0, 2)).toEqual([
      { fn: "parcels.search", input: { ...VN, offset: 0, limit: 1 } },
      { fn: "parcels.points", input: { ...VN, min_open_days: 1826 } },
    ]);
    expect(
      calls.filter((c) => c.fn === "parcels.detail").map((c) => c.input),
    ).toEqual(FAKE_LONG_OPEN.map((parcel_id) => ({ parcel_id })));
    const c = o.content as Stated;
    expect(c.count).toBe(2);
    expect(c.items.map((it) => it.parcel_id)).toEqual(FAKE_LONG_OPEN);
    expect(c.long_open_permit).toEqual({
      unit: "parcels",
      status: "available",
      count: 2,
      of: 3,
      checked: 3,
      with_permit_data: 3,
      complete: true,
      min_open_days: 1826,
      text: "2 of the 3 parcels that match the roof-age rule have a long-open roofing permit (an issued LADBS roofing-work permit still open at least 1,826 days). This counts parcels, not permits: a parcel with several long-open permits counts once, and a building-level (condominium) permit marks every unit it links.",
    });
    // The item's facts from the parcel's detail, as the search computes them (the fake parcel lies at 34.2, -118.48).
    expect(c.items[0]).toMatchObject({
      address: "1 TEST ST",
      year_built: 1950,
      effective_roof_year: 1950,
      roof_age_years: 76,
      roof_age_basis: "PROXY",
      permit_data_available: true,
      distance_miles: 1.714,
      citation: { source_name: FAKE_SOURCES.parcel },
    });
    expect(o.fact).toMatchObject({
      count: 2,
      long_open: { count: 2, of: 3, min_open_days: 1826, complete: true },
    });
  });

  test("on, with more parcels than the data API draws: a lower bound, stated as such and as a gap", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      { ...VN, long_open_permit: true, limit: 1 },
      queries,
    );
    const c = o.content as Stated;
    expect(c.long_open_permit).toMatchObject({
      count: 2,
      of: 42,
      checked: 3,
      complete: false,
    });
    const text = String(c.long_open_permit!.text);
    expect(text).toMatch(
      /^At least 2 of the 42 parcels that match the roof-age rule have a long-open roofing permit/,
    );
    expect(text).toContain("only the nearest 3 were checked");
    expect(o.gaps).toContain(text);
    expect(o.gaps).toContain(
      "Results truncated: search_aged_roofs returned 1 of 2 matching parcels (nearest first).",
    );
  });

  test("on, with the ownership filter: both calls carry its basis, and the text says so", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      { ...VN, long_open_permit: true, ownership_filter: true },
      queries,
    );
    expect(o.ok).toBe(true);
    expect(calls.find((c) => c.fn === "parcels.points")!.input).toMatchObject({
      ownership_basis: "both",
    });
    expect(String((o.content as Stated).long_open_permit!.text)).toContain(
      "parcels that match the roof-age rule and the ownership filter",
    );
  });

  test("points that disagree with the search, or carry no long-open marks, are an error, never shown as filtered", async () => {
    const { queries } = fakeQueries();
    const noMarks: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        points: async (i) => {
          const p = await queries.parcels.points(i);
          return {
            ...p,
            long_open_permit: undefined as unknown as typeof p.long_open_permit,
          };
        },
      },
    };
    expect(
      await runTool(
        "search_aged_roofs",
        { ...VN, long_open_permit: true },
        noMarks,
      ),
    ).toMatchObject({
      ok: false,
      error: "the data API's parcels.points did not mark the long-open parcels",
    });
    const otherCount: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        points: async (i) => ({
          ...(await queries.parcels.points(i)),
          count: 41,
        }),
      },
    };
    expect(
      await runTool(
        "search_aged_roofs",
        { ...VN, long_open_permit: true },
        otherCount,
      ),
    ).toMatchObject({
      ok: false,
      error:
        "the data API's parcels.points counted 41 parcels and its search 42",
    });
  });
});

describe("search_aged_roofs: permit data of the matching parcels (the City of Los Angeles only)", () => {
  const filter = { radius_miles: 1, threshold_years: 20 };
  const PASADENA = { ...PASADENA_RESOLVED, ...filter };
  const MIXED = { ...MIXED_CENTER, ...filter };
  type Stated = {
    count: number | null;
    returned: number;
    truncated: boolean;
    long_open_permit?: Record<string, unknown>;
    permit_data?: Record<string, unknown>;
    items: Array<Record<string, unknown>>;
  };
  /** The fake with every parcel drawn: the search counts the three parcels points draws. */
  function complete(base: DataQueries): DataQueries {
    return {
      ...base,
      parcels: {
        detail: base.parcels.detail,
        search: async (i) => ({ ...(await base.parcels.search(i)), count: 3 }),
        points: async (i) => ({
          ...(await base.parcels.points(i)),
          count: 3,
          truncated: false,
        }),
      },
    };
  }
  const NOT_AVAILABLE =
    "Not available: none of the 3 parcels that match the roof-age rule has permit data (all are outside the City of Los Angeles), so whether they have a long-open roofing permit (an issued LADBS roofing-work permit still open at least 1,826 days) is unknown, not 0; the filter can't be evaluated there.";

  test("all outside, long_open_permit: not available (count null, never 0), nothing listed, the outside statement in the result and its gaps", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      { ...PASADENA, limit: 10, long_open_permit: true },
      complete(queries),
    );
    expect(o.ok).toBe(true);
    const c = o.content as Stated;
    expect(c.count).toBeNull();
    expect(c.returned).toBe(0);
    expect(c.items).toEqual([]);
    expect(c.truncated).toBe(false);
    expect(c.long_open_permit).toEqual({
      unit: "parcels",
      status: "not_available",
      count: null,
      of: 3,
      checked: 3,
      with_permit_data: 0,
      complete: true,
      min_open_days: 1826,
      text: NOT_AVAILABLE,
    });
    expect(c.permit_data).toEqual({
      checked: 3,
      without_permit_data: 3,
      complete: true,
      text: "All 3 parcels that match the roof-age rule are outside the City of Los Angeles: no permit data there.",
    });
    // The outside statement and the not-available text are the gaps; they name no place (the agent adds the
    // place's gap).
    expect(o.gaps).toEqual([
      "All 3 parcels that match the roof-age rule are outside the City of Los Angeles: no permit data there.",
      NOT_AVAILABLE,
    ]);
    expect(calls.map((x) => x.fn)).not.toContain("parcels.detail");
    expect(o.fact).toMatchObject({
      count: null,
      matched: 3,
      returned: 0,
      matched_permit_data: {
        checked: 3,
        with_permit_data: 0,
        without_permit_data: 3,
        complete: true,
      },
      long_open: { count: null, of: 3, complete: true },
    });
  });

  test("all outside among the nearest checked (truncated points): not available among those, stated as such", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      { ...PASADENA, long_open_permit: true },
      queries,
    );
    const c = o.content as Stated;
    expect(c.count).toBeNull();
    expect(c.long_open_permit).toMatchObject({
      status: "not_available",
      count: null,
      of: 42,
      checked: 3,
      complete: false,
    });
    expect(String(c.long_open_permit!.text)).toBe(
      "Not available: none of the nearest 3 of the 42 parcels that match the roof-age rule has permit data (all are outside the City of Los Angeles; only those were checked: the data API marks at most 3 parcels), so whether they have a long-open roofing permit (an issued LADBS roofing-work permit still open at least 1,826 days) is unknown, not 0; the filter can't be evaluated there. A smaller radius gives a full check.",
    );
    const outside =
      "Roof age covers all 42 parcels that match the roof-age rule. How many of them lie outside the City of Los Angeles, where there is no permit data, was counted only for the nearest 3 (the data API marks at most 3 parcels): all 3 do; for the other 39 it is not known.";
    // With the filter the block is as before (no matched: long_open_permit.of states it).
    expect(c.permit_data).toEqual({
      roof_age_covers_all_matching: true,
      checked: 3,
      without_permit_data: 3,
      complete: false,
      text: outside,
    });
    expect(o.gaps).toEqual([outside, c.long_open_permit!.text]);
  });

  test("mixed, long_open_permit: the count is of the parcels with permit data, and how many have none is stated", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      { ...MIXED, long_open_permit: true },
      complete(queries),
    );
    const c = o.content as Stated;
    expect(c.count).toBe(1);
    expect(c.items.map((it) => it.parcel_id)).toEqual([FAKE_PARCELS[0]]);
    expect(c.long_open_permit).toMatchObject({
      status: "available",
      count: 1,
      of: 3,
      checked: 3,
      with_permit_data: 2,
      complete: true,
      text: "1 of the 2 parcels that match the roof-age rule and have permit data have a long-open roofing permit (an issued LADBS roofing-work permit still open at least 1,826 days). The other 1 of the 3 are outside the City of Los Angeles (no permit data there): whether they have one is unknown. This counts parcels, not permits: a parcel with several long-open permits counts once, and a building-level (condominium) permit marks every unit it links.",
    });
    const outside =
      "1 of the 3 parcels that match the roof-age rule are outside the City of Los Angeles: no permit data there.";
    expect(c.permit_data).toMatchObject({
      without_permit_data: 1,
      text: outside,
    });
    expect(o.gaps).toContain(outside);
    expect(o.fact).toMatchObject({
      count: 1,
      matched_permit_data: { with_permit_data: 2, without_permit_data: 1 },
    });
  });

  /** The complete fake with the given long-open marks (permit_data_available as fakePermitData gives it). */
  function withMarks(marks: Array<0 | 1>): DataQueries {
    const base = complete(fakeQueries().queries);
    return {
      ...base,
      parcels: {
        ...base.parcels,
        points: async (i) => ({
          ...(await base.parcels.points(i)),
          long_open_permit: marks,
        }),
      },
    };
  }

  test("a long-open mark on a parcel without permit data counts it as having permit data: in the count and in with_permit_data", async () => {
    // MIXED: the third parcel has no permit data (permit_data_available 0) but a long-open mark (a joined permit).
    const o = await runTool(
      "search_aged_roofs",
      { ...MIXED, long_open_permit: true },
      withMarks([1, 0, 1]),
    );
    const c = o.content as Stated;
    expect(c.count).toBe(2);
    expect(c.items.map((it) => it.parcel_id)).toEqual([
      FAKE_PARCELS[0],
      FAKE_PARCELS[2],
    ]);
    expect(c.long_open_permit).toMatchObject({
      status: "available",
      count: 2,
      of: 3,
      checked: 3,
      with_permit_data: 3,
      complete: true,
      text: "2 of the 3 parcels that match the roof-age rule have a long-open roofing permit (an issued LADBS roofing-work permit still open at least 1,826 days). This counts parcels, not permits: a parcel with several long-open permits counts once, and a building-level (condominium) permit marks every unit it links.",
    });
    expect(c).not.toHaveProperty("permit_data");
    expect(o.gaps.some((g) => g.includes("City of Los Angeles"))).toBe(false);
    expect(o.fact).toMatchObject({
      count: 2,
      matched_permit_data: { with_permit_data: 3, without_permit_data: 0 },
      long_open: { count: 2, of: 3 },
    });
    // Without the filter the same marked parcel has permit data too: nothing stated about the City.
    const plain = await runTool(
      "search_aged_roofs",
      MIXED,
      withMarks([1, 0, 1]),
    );
    expect(plain.content).not.toHaveProperty("permit_data");
    expect(plain.fact).toMatchObject({
      matched_permit_data: { with_permit_data: 3, without_permit_data: 0 },
    });
  });

  test("no parcel with permit data but one with a long-open mark: available (not not-available), the others stated as outside", async () => {
    // PASADENA: no parcel has permit data (permit_data_available 0); the second carries a long-open mark.
    const o = await runTool(
      "search_aged_roofs",
      { ...PASADENA, long_open_permit: true },
      withMarks([0, 1, 0]),
    );
    const c = o.content as Stated;
    expect(c.count).toBe(1);
    expect(c.items.map((it) => it.parcel_id)).toEqual([FAKE_PARCELS[1]]);
    expect(c.long_open_permit).toMatchObject({
      status: "available",
      count: 1,
      with_permit_data: 1,
    });
    const outside =
      "2 of the 3 parcels that match the roof-age rule are outside the City of Los Angeles: no permit data there.";
    expect(c.permit_data).toMatchObject({
      without_permit_data: 2,
      text: outside,
    });
    expect(o.gaps).toContain(outside);
    expect(o.gaps.some((g) => g.startsWith("Not available"))).toBe(false);
  });

  test("all inside, long_open_permit: the count and text as before, nothing about permit data added", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "search_aged_roofs",
      { lat: 34.2, lon: -118.45, ...filter, long_open_permit: true },
      complete(queries),
    );
    const c = o.content as Stated;
    expect(c.count).toBe(2);
    expect(c).not.toHaveProperty("permit_data");
    expect(String(c.long_open_permit!.text)).toBe(
      "2 of the 3 parcels that match the roof-age rule have a long-open roofing permit (an issued LADBS roofing-work permit still open at least 1,826 days). This counts parcels, not permits: a parcel with several long-open permits counts once, and a building-level (condominium) permit marks every unit it links.",
    );
    expect(o.gaps.some((g) => g.includes("City of Los Angeles"))).toBe(false);
  });

  test("without the filter: all outside and mixed are stated from the matching parcels, the listed ones unchanged", async () => {
    const { queries } = fakeQueries();
    const all = await runTool("search_aged_roofs", PASADENA, complete(queries));
    expect(all.ok).toBe(true);
    expect((all.content as Stated).count).toBe(3);
    expect((all.content as Stated).returned).toBe(3);
    const allText =
      "All 3 parcels that match the roof-age rule are outside the City of Los Angeles: no permit data there.";
    expect((all.content as Stated).permit_data).toMatchObject({
      without_permit_data: 3,
      text: allText,
    });
    expect(all.gaps).toContain(allText);
    const mixed = await runTool("search_aged_roofs", MIXED, queries);
    const mixedText =
      "Roof age covers all 42 parcels that match the roof-age rule. How many of them lie outside the City of Los Angeles, where there is no permit data, was counted only for the nearest 3 (the data API marks at most 3 parcels): 1 of those 3 does; for the other 39 it is not known.";
    expect((mixed.content as Stated).count).toBe(42);
    expect((mixed.content as Stated).permit_data).toEqual({
      roof_age_covers_all_matching: true,
      checked: 3,
      matched: 42,
      without_permit_data: 1,
      complete: false,
      text: mixedText,
    });
    expect(mixed.gaps).toContain(mixedText);
  });

  test("without the filter, a points read that fails or disagrees is a stated gap, never a failed search", async () => {
    const { queries } = fakeQueries();
    const failing: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        points: async () => {
          throw new Error("boom");
        },
      },
    };
    const o = await runTool("search_aged_roofs", PASADENA, failing);
    expect(o.ok).toBe(true);
    expect((o.content as Stated).count).toBe(42);
    expect((o.content as Stated).returned).toBe(3);
    expect(o.gaps).toContain(
      "Roof age covers all 42 parcels that match the roof-age rule. parcels.points failed (boom): how many of them lie outside the City of Los Angeles, where there is no permit data, is not known.",
    );
    expect(o.fact).toMatchObject({ matched_permit_data: null });
    const otherCount: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        points: async (i) => ({
          ...(await queries.parcels.points(i)),
          count: 41,
        }),
      },
    };
    const d = await runTool("search_aged_roofs", PASADENA, otherCount);
    expect(d.ok).toBe(true);
    expect(d.gaps).toContain(
      "Roof age covers all 42 parcels that match the roof-age rule. the data API's parcels.points counted 41 parcels and its search 42: how many of them lie outside the City of Los Angeles, where there is no permit data, is not known.",
    );
    const otherBasis: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        points: async (i) => ({
          ...(await queries.parcels.points(i)),
          ownership: apiOwnershipRule("recording"),
        }),
      },
    };
    const b = await runTool("search_aged_roofs", PASADENA, otherBasis);
    expect(b.ok).toBe(true);
    expect(b.gaps).toContain(
      "Roof age covers all 42 parcels that match the roof-age rule. the data API parcels.points applied ownership basis recording, not none: how many of them lie outside the City of Los Angeles, where there is no permit data, is not known.",
    );
    // Permit data is also read from the long-open marks: points without them leave it unchecked.
    const noMarks: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        points: async (i) => {
          const r: Partial<PointsResult> = {
            ...(await queries.parcels.points(i)),
          };
          delete r.long_open_permit;
          return r as PointsResult;
        },
      },
    };
    const m = await runTool("search_aged_roofs", PASADENA, noMarks);
    expect(m.ok).toBe(true);
    expect(m.gaps).toContain(
      "Roof age covers all 42 parcels that match the roof-age rule. the data API's parcels.points did not mark the long-open parcels: how many of them lie outside the City of Los Angeles, where there is no permit data, is not known.",
    );
    expect(m.content).not.toHaveProperty("permit_data");
    // With the filter the same failure is an error: the filter can't be applied.
    expect(
      await runTool(
        "search_aged_roofs",
        { ...PASADENA, long_open_permit: true },
        failing,
      ),
    ).toMatchObject({ ok: false, error: "boom" });
  });

  test("through the HTTP adapter: the search and points both start, never more than 1 data call in flight", async () => {
    const { queries } = fakeQueries();
    const api = fakeDataApi(queries, { delayMs: 20 });
    const q = httpDataQueries({
      apiUrl: FAKE_API_URL,
      apiToken: "test-bearer-token-not-secret",
      fetch: api.fetch,
    });
    const o = await runTool("search_aged_roofs", PASADENA, q);
    expect(o.ok).toBe(true);
    expect(
      api.requests
        .slice(0, 2)
        .map((r) => r.route)
        .sort(),
    ).toEqual(["parcels.points", "parcels.search"]);
    expect(api.peak()).toBe(1);
  });
});

describe("long_open_permits: permit data of the circle's parcels (the City of Los Angeles only)", () => {
  const PASADENA = { ...PASADENA_RESOLVED, radius_miles: 1 };
  const MIXED = { ...MIXED_CENTER, radius_miles: 1 };
  const AT = { lat: 34.2, lon: -118.45, radius_miles: 1 };
  /** The fake with every parcel in the circle drawn (3 of 3, not truncated). */
  function complete(base: DataQueries): DataQueries {
    return {
      ...base,
      parcels: {
        ...base.parcels,
        points: async (i) => ({
          ...(await base.parcels.points(i)),
          count: 3,
          truncated: false,
        }),
      },
    };
  }
  /** The fake where permits.longOpen finds no permit (as at a place outside the City of Los Angeles). */
  function noPermits(base: DataQueries): DataQueries {
    return {
      ...base,
      permits: {
        ...base.permits,
        longOpen: async (i) => ({
          ...(await base.permits.longOpen(i)),
          count: 0,
          items: [],
          next_offset: null,
        }),
      },
    };
  }
  const ALL_OUTSIDE =
    "All 3 parcels within 1 mi that have a roof year are outside the City of Los Angeles: no permit data there.";
  const NOT_AVAILABLE =
    "Not available: none of the 3 parcels within 1 mi that have a roof year has permit data (all are outside the City of Los Angeles), so whether there are long-open roofing permits (an issued LADBS roofing-work permit still open at least 1,826 days) is unknown, not 0.";

  test("all outside: count null with status not_available and its text, never 0; permit_data and both statements in the gaps; the fact's count null", async () => {
    const { queries, calls } = fakeQueries();
    const o = await runTool(
      "long_open_permits",
      PASADENA,
      noPermits(complete(queries)),
    );
    expect(o.ok).toBe(true);
    expect(o.content).toEqual({
      count: null,
      status: "not_available",
      text: NOT_AVAILABLE,
      returned: 0,
      rule: "Open at least min_open_days days (fake rule).",
      scope: "roofing work only",
      source: {
        source_name: FAKE_SOURCES.permit,
        license: null,
        attribution: "LADBS",
        retrieved: PERMIT_RETRIEVED,
      },
      permit_data: {
        checked: 3,
        without_permit_data: 3,
        complete: true,
        text: ALL_OUTSIDE,
      },
      items: [],
      truncated: false,
    });
    // The outside statement (no place: the agent adds the place's gap), then the not-available text.
    expect(o.gaps).toEqual([ALL_OUTSIDE, NOT_AVAILABLE]);
    expect(o.fact).toMatchObject({
      tool: "long_open_permits",
      count: null,
      returned: 0,
      permit_data: {
        checked: 3,
        with_permit_data: 0,
        without_permit_data: 3,
        complete: true,
        parcels: 3,
      },
    });
    expect(calls.find((c) => c.fn === "parcels.points")!.input).toEqual({
      ...PASADENA,
      threshold_years: 1,
      min_open_days: 1826,
    });
  });

  test("all outside among the nearest checked (truncated points): not available among those, stated as such", async () => {
    const { queries } = fakeQueries();
    const o = await runTool("long_open_permits", PASADENA, noPermits(queries));
    const text =
      "Not available: the list found no permit within 1 mi, and all of the nearest 3 of the 42 parcels within 1 mi that have a roof year lie outside the City of Los Angeles, where there is no permit data (for the other 39 it is not known: the data API marks at most 3 parcels), so whether there are long-open roofing permits (an issued LADBS roofing-work permit still open at least 1,826 days) is unknown, not 0.";
    const outside =
      "The list covers every permit within 1 mi. How many of the 42 parcels within 1 mi that have a roof year lie outside the City of Los Angeles, where there is no permit data, was counted only for the nearest 3 (the data API marks at most 3 parcels): all 3 do; for the other 39 it is not known.";
    expect(o.content).toMatchObject({
      count: null,
      status: "not_available",
      text,
      permit_data: {
        permit_search_covers_whole_circle: true,
        checked: 3,
        without_permit_data: 3,
        complete: false,
        text: outside,
      },
    });
    expect(o.gaps).toEqual([outside, text]);
  });

  test("all outside with with_contractor_window: both lists not available (null, each with its window's text), permit_data once", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "long_open_permits",
      { ...PASADENA, with_contractor_window: true },
      noPermits(complete(queries)),
    );
    expect(o.ok).toBe(true);
    const withinText =
      "Not available: none of the 3 parcels within 1 mi that have a roof year has permit data (all are outside the City of Los Angeles), so whether there are long-open roofing permits (an issued LADBS roofing-work permit still open at least 1,826 days and at most 5,062 days) is unknown, not 0.";
    const c = o.content as Record<string, Record<string, unknown>>;
    expect(Object.keys(c)).toEqual([
      "scope",
      "source",
      "permit_data",
      "contractor_window",
      "longest_open",
      "within_contractor_window",
    ]);
    expect(c.permit_data).toEqual({
      checked: 3,
      without_permit_data: 3,
      complete: true,
      text: ALL_OUTSIDE,
    });
    expect(c.longest_open).toMatchObject({
      count: null,
      status: "not_available",
      text: NOT_AVAILABLE,
      returned: 0,
      items: [],
    });
    expect(c.within_contractor_window).toMatchObject({
      count: null,
      status: "not_available",
      text: withinText,
      returned: 0,
      max_open_days: 5062,
      items: [],
    });
    expect(o.gaps).toEqual([ALL_OUTSIDE, NOT_AVAILABLE, withinText]);
    expect(o.fact).toMatchObject({
      count: null,
      within_window: { status: "read", count: null, returned: 0 },
    });
  });

  test("mixed: the count stands; permit_data says how many parcels in the circle have no permit data", async () => {
    const { queries } = fakeQueries();
    const o = await runTool("long_open_permits", MIXED, complete(queries));
    const outside =
      "1 of the 3 parcels within 1 mi that have a roof year are outside the City of Los Angeles: no permit data there.";
    const c = o.content as Record<string, unknown>;
    expect(c).toMatchObject({
      count: 57,
      returned: 2,
      permit_data: {
        checked: 3,
        without_permit_data: 1,
        complete: true,
        text: outside,
      },
    });
    expect(c).not.toHaveProperty("status");
    expect(o.gaps).toEqual([
      outside,
      "Results truncated: long_open_permits returned 2 of 57 long-open permits (longest open first).",
    ]);
    expect(o.fact).toMatchObject({
      count: 57,
      permit_data: { with_permit_data: 2, without_permit_data: 1 },
    });
  });

  test("all inside, every parcel checked: the result and gaps are as before (no permit_data, no status), with and without with_contractor_window", async () => {
    const { queries } = fakeQueries();
    const q = complete(queries);
    const o = await runTool("long_open_permits", AT, q);
    expect(Object.keys(o.content as object)).toEqual([
      "count",
      "returned",
      "rule",
      "scope",
      "source",
      "items",
      "truncated",
    ]);
    expect(o.gaps).toEqual([
      "Results truncated: long_open_permits returned 2 of 57 long-open permits (longest open first).",
    ]);
    const w = await runTool(
      "long_open_permits",
      { ...AT, with_contractor_window: true },
      q,
    );
    const c = w.content as Record<string, Record<string, unknown>>;
    expect(Object.keys(c)).toEqual([
      "scope",
      "source",
      "contractor_window",
      "longest_open",
      "within_contractor_window",
    ]);
    expect(c.longest_open).not.toHaveProperty("status");
    expect(c.within_contractor_window).not.toHaveProperty("status");
    expect(w.gaps.some((g) => g.includes("City of Los Angeles"))).toBe(false);
  });

  test("no parcel with permit data but a permit found: the count stands (a permit found is never unknown)", async () => {
    const { queries } = fakeQueries();
    const o = await runTool("long_open_permits", PASADENA, complete(queries));
    expect(o.content).toMatchObject({
      count: 57,
      permit_data: { without_permit_data: 3, text: ALL_OUTSIDE },
    });
    expect(o.content).not.toHaveProperty("status");
    expect(o.gaps).toContain(ALL_OUTSIDE);
  });

  test("the points read fails or applies another window: a stated gap, the count as read; max_open_days reaches the points", async () => {
    const { queries, calls } = fakeQueries();
    const failing: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        points: async () => {
          throw new Error("boom");
        },
      },
    };
    const o = await runTool("long_open_permits", PASADENA, failing);
    expect(o.ok).toBe(true);
    expect(o.content).toMatchObject({ count: 57 });
    expect(o.gaps[0]).toBe(
      "The count and the list cover every permit within 1 mi. parcels.points failed (boom): how many of the parcels within 1 mi that have a roof year lie outside the City of Los Angeles, where there is no permit data, is not known.",
    );
    expect(o.fact).toMatchObject({ count: 57, permit_data: null });
    const otherWindow: DataQueries = {
      ...queries,
      parcels: {
        ...queries.parcels,
        points: async (i) => ({
          ...(await queries.parcels.points(i)),
          long_open: { min_open_days: 1826, max_open_days: null },
        }),
      },
    };
    const w = await runTool(
      "long_open_permits",
      { ...PASADENA, max_open_days: 4000 },
      otherWindow,
    );
    expect(w.gaps[0]).toBe(
      "The count and the list cover every permit within 1 mi. the data API's parcels.points applied another open-duration window than the call's: how many of the parcels within 1 mi that have a roof year lie outside the City of Los Angeles, where there is no permit data, is not known.",
    );
    await runTool(
      "long_open_permits",
      { ...PASADENA, max_open_days: 4000 },
      queries,
    );
    expect(
      calls.filter((c) => c.fn === "parcels.points").at(-1)!.input,
    ).toEqual({
      ...PASADENA,
      threshold_years: 1,
      min_open_days: 1826,
      max_open_days: 4000,
    });
  });

  test("all inside among the nearest counted (truncated points): permit_data and its gap say first that the count and lists cover every permit, then that the others are not known; the count stands", async () => {
    const { queries } = fakeQueries();
    const nearest =
      "The count and the list cover every permit within 1 mi. How many of the 42 parcels within 1 mi that have a roof year lie outside the City of Los Angeles, where there is no permit data, was counted only for the nearest 3 (the data API marks at most 3 parcels): none of those 3 does; for the other 39 it is not known.";
    const permitData = {
      permit_search_covers_whole_circle: true,
      checked: 3,
      matched: 42,
      without_permit_data: 0,
      complete: false,
      text: nearest,
    };
    const o = await runTool("long_open_permits", AT, queries);
    expect(Object.keys(o.content as object)).toEqual([
      "count",
      "returned",
      "rule",
      "scope",
      "source",
      "permit_data",
      "items",
      "truncated",
    ]);
    expect(o.content).toMatchObject({ count: 57, permit_data: permitData });
    expect(o.content).not.toHaveProperty("status");
    expect(o.gaps).toEqual([
      nearest,
      "Results truncated: long_open_permits returned 2 of 57 long-open permits (longest open first).",
    ]);
    expect(o.fact).toMatchObject({
      count: 57,
      permit_data: { checked: 3, without_permit_data: 0, complete: false },
    });
    const w = await runTool(
      "long_open_permits",
      { ...AT, with_contractor_window: true },
      queries,
    );
    const c = w.content as Record<string, Record<string, unknown>>;
    const both = nearest.replace(
      "The count and the list cover",
      "The counts and both lists cover",
    );
    expect(c.permit_data).toEqual({ ...permitData, text: both });
    expect(c.longest_open).not.toHaveProperty("status");
    expect(c.within_contractor_window).not.toHaveProperty("status");
    expect(w.gaps[0]).toBe(both);
  });

  /** The fake whose parcels.points read fails. */
  function pointsFail(base: DataQueries): DataQueries {
    return {
      ...base,
      parcels: {
        ...base.parcels,
        points: async () => {
          throw new Error("boom");
        },
      },
    };
  }
  /** The gap of the failed read, after what the result covers (`lead`). */
  const notKnown = (lead: string) =>
    `${lead} parcels.points failed (boom): how many of the parcels within 1 mi that have a roof year lie outside the City of Los Angeles, where there is no permit data, is not known.`;
  const notCheckedText = (rule: string) =>
    `Not available: how many of the parcels within 1 mi that have a roof year lie outside the City of Los Angeles, where there is no permit data, is not known, so whether there are long-open roofing permits (${rule}) is unknown, not 0.`;
  const RULE =
    "an issued LADBS roofing-work permit still open at least 1,826 days";

  test("the points read fails and the list finds no permit: count null with status not_available and its text, never 0", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "long_open_permits",
      PASADENA,
      pointsFail(noPermits(queries)),
    );
    expect(o.ok).toBe(true);
    const text = notCheckedText(RULE);
    expect(o.content).toMatchObject({
      count: null,
      status: "not_available",
      text,
      returned: 0,
      items: [],
    });
    expect(o.content).not.toHaveProperty("permit_data");
    expect(o.gaps).toEqual([
      notKnown("The list covers every permit within 1 mi."),
      text,
    ]);
    expect(o.fact).toMatchObject({ count: null, permit_data: null });
  });

  test("the points read fails with with_contractor_window: each list that finds no permit is not available with its window's text; a list that finds one keeps its count", async () => {
    const { queries } = fakeQueries();
    const o = await runTool(
      "long_open_permits",
      { ...PASADENA, with_contractor_window: true },
      pointsFail(noPermits(queries)),
    );
    const c = o.content as Record<string, Record<string, unknown>>;
    const first = notCheckedText(RULE);
    const within = notCheckedText(`${RULE} and at most 5,062 days`);
    expect(c).not.toHaveProperty("permit_data");
    expect(c.longest_open).toMatchObject({
      count: null,
      status: "not_available",
      text: first,
    });
    expect(c.within_contractor_window).toMatchObject({
      count: null,
      status: "not_available",
      text: within,
      max_open_days: 5062,
    });
    expect(o.gaps).toEqual([
      notKnown("Both lists cover every permit within 1 mi."),
      first,
      within,
    ]);
    expect(o.fact).toMatchObject({
      count: null,
      within_window: { status: "read", count: null },
    });
    const found = await runTool(
      "long_open_permits",
      { ...PASADENA, with_contractor_window: true },
      pointsFail(queries),
    );
    const f = found.content as Record<string, Record<string, unknown>>;
    expect(f.longest_open).toMatchObject({ count: 57 });
    expect(f.longest_open).not.toHaveProperty("status");
    expect(f.within_contractor_window).not.toHaveProperty("status");
    expect(found.gaps[0]).toBe(
      notKnown("The counts and both lists cover every permit within 1 mi."),
    );
    expect(found.gaps.filter((g) => g.startsWith("Not available"))).toEqual([]);
  });
});
