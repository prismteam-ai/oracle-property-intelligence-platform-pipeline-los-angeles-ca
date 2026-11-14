// @vitest-environment jsdom
/**
 * Component test of the Explorer (React Testing Library on jsdom, fake timers).
 * Mocks: ../src/config.ts (fixed config, no network) and @oracle-la/api-client, whose createApiClient returns a
 * CALLABLE object like the real tRPC v11 proxy (typeof client === "function"), with vi.fn() procedures.
 * No map in the Explorer (the CRM owns the map), so nothing else is stubbed.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// The API contract's wording constants (import-free), to check that the Explorer shows them verbatim.
import {
  OWNERSHIP_BASIS,
  OWNERSHIP_PROXY_NOTE,
} from "../../api/src/contract.ts";

const h = vi.hoisted(() => ({
  search: vi.fn(),
  runSummary: vi.fn(),
  sources: vi.fn(),
  records: vi.fn(),
  longOpen: vi.fn(),
  forParcel: vi.fn(),
}));
vi.mock("../src/config.ts", () => ({
  loadConfig: vi.fn(async () => ({
    client: "explorer",
    apiUrl: "https://api.test",
    apiToken: "t",
  })),
}));
vi.mock("@oracle-la/api-client", () => ({
  createApiClient: () =>
    Object.assign(() => undefined, {
      explorer: {
        runSummary: { query: h.runSummary },
        sources: { query: h.sources },
        records: { query: h.records },
      },
      parcels: { search: { query: h.search } },
      permits: {
        longOpen: { query: h.longOpen },
        forParcel: { query: h.forParcel },
      },
    }),
}));

import { App } from "../src/App.tsx";

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const PROXY_BASIS =
  "PROXY: assessor year built / effective year built; not a roof installation date";
const PERMIT_BASIS =
  "PERMIT: latest finaled LADBS roofing permit (status date); a roof coating alone does not count";
const rule = {
  roll_year: 2026,
  threshold_years: 15,
  built_before_year: 2011,
  text: "older than 15 years means built before 2011",
};

describe("Explorer radius query", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.runSummary.mockReset().mockResolvedValue({
      run: {
        run_id: "r1",
        row_counts: { parquet: 3 },
        coverage: {},
        delta: {},
        scope: {},
        readiness: {},
        limitations: [],
      },
      history: [],
    });
    h.search.mockReset().mockResolvedValue({
      count: 3,
      rule,
      next_offset: null,
      items: [1, 2, 3].map((i) => ({
        parcel_id: `000000000${i}`,
        address: `${i} TEST ST`,
        year_built: 1980,
        roof_age_years_proxy: 46,
        effective_roof_year: i === 1 ? 2004 : 1980,
        roof_age_years: i === 1 ? 22 : 46,
        roof_age_basis: i === 1 ? PERMIT_BASIS : PROXY_BASIS,
        roof_year_permit_number: i === 1 ? "11111-22222-33333" : null,
        permit_data_available: true,
        distance_miles: i / 10,
        latitude: 34.2,
        longitude: -118.49,
      })),
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("the radius-query input produces rendered results with one API call per submit, and none while idle", async () => {
    render(<App />);
    await wait(0);
    expect(h.runSummary).toHaveBeenCalledTimes(1); // the API client was created and stored
    fireEvent.click(screen.getByRole("tab", { name: "Radius query" }));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await wait(0);
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search.mock.calls[0]![0]).toMatchObject({
      lat: 34.199,
      lon: -118.487,
      radius_miles: 5,
      threshold_years: 15,
      offset: 0,
    });
    expect(screen.getByTestId("radius-count").textContent).toBe("3");
    expect(
      screen.getByTestId("radius-results").querySelectorAll("tbody tr"),
    ).toHaveLength(3);

    await wait(5000);
    expect(h.search).toHaveBeenCalledTimes(1);

    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Roof older than (years)" }),
      { target: { value: "80" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await wait(0);
    expect(h.search).toHaveBeenCalledTimes(2);
    expect(h.search.mock.calls[1]![0]).toMatchObject({ threshold_years: 80 });
    await wait(5000);
    expect(h.search).toHaveBeenCalledTimes(2);
    expect(h.runSummary).toHaveBeenCalledTimes(1);
  });
});

describe("Explorer run summary", () => {
  const summary = (readiness: Record<string, string>) => ({
    run: {
      run_id: "r1",
      row_counts: { parquet: 3 },
      coverage: {},
      delta: {},
      scope: {},
      readiness,
      limitations: [],
    },
    history: [],
  });
  afterEach(() => cleanup());

  test("shows the county run's readiness result (overall) and no pilot-slice wording", async () => {
    h.runSummary
      .mockReset()
      .mockResolvedValue(summary({ overall: "PASS", scope_guard: "PASS" }));
    render(<App />);
    expect((await screen.findByTestId("readiness")).textContent).toContain(
      "Readiness: PASS; scope guard PASS",
    );
    expect(document.querySelector("header")!.textContent).not.toMatch(
      /Pilot slice|91405/,
    );
  });

  test("falls back to the pilot run's preflight result", async () => {
    h.runSummary
      .mockReset()
      .mockResolvedValue(summary({ preflight: "PASS", scope_guard: "PASS" }));
    render(<App />);
    expect((await screen.findByTestId("readiness")).textContent).toContain(
      "Readiness: PASS; scope guard PASS",
    );
  });
});

/** The three sources as explorer.sources serves them (fixture values; the field texts follow the run manifest). */
const ROLL = "LA County Assessor - Assessor Parcel Data Roll 2026";
const PERMITS = "LADBS building permits (City of Los Angeles, data.lacity.org)";
const CONTRACTORS =
  "LADBS roofing permits, contractor view (data.lacity.org 8guu-8f5m)";
const PERMIT_LICENSE =
  "none stated in the dataset metadata; the portal's terms of use (May 2014) apply";
const PERMIT_ATTRIBUTION =
  'LADBS (City of Los Angeles Department of Building and Safety); the datasets\' attribution field reads "TSB"';
const source = (
  source_kind: "parcel" | "permit" | "contractor",
  source_name: string,
  record_count: number,
  page_count: number,
  extra: Record<string, unknown>,
) => ({
  source_kind,
  source_name,
  record_count,
  page_count,
  first_retrieved_at: "2026-11-12T13:00:00.000Z",
  last_retrieved_at: "2026-11-12T13:10:00.000Z",
  role: null,
  hub_page: null,
  query_url: null,
  query_urls: null,
  terms_of_use: "https://data.lacity.org/terms-of-use",
  license: null,
  attribution: null,
  access: null,
  coverage: null,
  ...extra,
});
const WINDOW = {
  field: "permit_issue_date",
  first: "2013-01-02",
  last: "2023-05-19",
};
const CONTRACTOR_NOTE =
  "Contains data from LADBS, licensed under CC BY 4.0; license classes normalized. Contractor rows exist only for permits issued 2013-01-02 to 2023-05-19 (permit_issue_date).";
const SOURCES = {
  sources: [
    source("parcel", ROLL, 4, 2, {
      query_url: "https://services.arcgis.com/x/FeatureServer/0/query",
      terms_of_use: "https://egis-lacounty.hub.arcgis.com/pages/terms-of-use",
    }),
    source("permit", PERMITS, 3, 2, {
      query_urls: [
        "https://data.lacity.org/resource/aaaa-0001.json",
        "https://data.lacity.org/resource/aaaa-0002.json",
      ],
      license: PERMIT_LICENSE,
      attribution: PERMIT_ATTRIBUTION,
    }),
    source("contractor", CONTRACTORS, 5, 1, {
      query_urls: ["https://data.lacity.org/resource/8guu-8f5m.json"],
      license: "CC BY 4.0",
      attribution: "LADBS",
      coverage: WINDOW,
    }),
  ],
  pages: [
    ["parcel", ROLL, "pages/page-00001.json.gz"],
    ["permit", PERMITS, "pages/aaaa-0001_p000.json.gz"],
    ["contractor", CONTRACTORS, "pages/8guu-8f5m_p000.json.gz"],
    ["parcel", ROLL, "pages/page-00000.json.gz"],
    ["permit", PERMITS, "pages/aaaa-0002_p000.json.gz"],
  ].map(([source_kind, source_name, source_page_file]) => ({
    source_kind,
    source_name,
    source_page_file,
    source_request_url: `https://example.test/${source_page_file}?q`,
    source_retrieved_at: "2026-11-12T13:00:00.000Z",
    source_page_sha256: "a".repeat(64),
    record_count: 2,
  })),
};
const prov = (name: string) => ({
  source_name: name,
  source_request_url: "https://example.test/page?q",
  source_retrieved_at: "2026-11-12T13:00:00.000Z",
  source_page_sha256: "b".repeat(64),
  source_page_file: "pages/aaaa-0001_p000.json.gz",
});
const RECORDS: Record<string, unknown> = {
  [ROLL]: {
    source_kind: "parcel",
    total: 4,
    next_after: "0000000002",
    items: [1, 2].map((i) => ({
      kind: "parcel",
      record_key: `000000000${i}`,
      parcel_id: `000000000${i}`,
      address: `${i} ROLL ST`,
      year_built: 1950,
      ...prov(ROLL),
    })),
  },
  [PERMITS]: {
    source_kind: "permit",
    total: 3,
    next_after: null,
    items: [
      {
        kind: "permit",
        record_key: "10000-20000-00001",
        parcel_id: null,
        address: "1 PERMIT AVE",
        year_built: null,
        permit_number: "10000-20000-00001",
        source_status_desc: "Permit Finaled",
        permit_status_class: "closed",
        permit_issue_date: "2015-03-04",
        join_method: "condo-building",
        parcel_count: 12,
        ...prov(PERMITS),
      },
      {
        kind: "permit",
        record_key: "10000-20000-00002",
        parcel_id: null,
        address: "2 PERMIT AVE",
        year_built: null,
        permit_number: "10000-20000-00002",
        source_status_desc: "Issued",
        permit_status_class: "open-issued",
        permit_issue_date: "2012-01-02",
        join_method: null,
        parcel_count: 0,
        ...prov(PERMITS),
      },
    ],
  },
  [CONTRACTORS]: {
    source_kind: "contractor",
    total: 5,
    next_after: "10000-20000-00001:2",
    items: [
      {
        kind: "contractor",
        record_key: "10000-20000-00001:1",
        parcel_id: null,
        address: null,
        year_built: null,
        permit_number: "10000-20000-00001",
        contractor_row: 1,
        contractors_business_name: "ACME ROOFING INC",
        license_identifier: "123456",
        source_license_type: "C39",
        license_class: "C-39",
        license_class_note: null,
        is_owner_builder: false,
        contractor_identity_key: "123456",
        canonical_business_name: "ACME ROOFING & SOLAR INC",
        name_variant_count: 3,
        identity_permit_count: 40,
        ...prov(CONTRACTORS),
      },
      {
        kind: "contractor",
        record_key: "10000-20000-00001:2",
        parcel_id: null,
        address: null,
        year_built: null,
        permit_number: "10000-20000-00001",
        contractor_row: 2,
        contractors_business_name: null,
        license_identifier: null,
        source_license_type: "NA",
        license_class: null,
        license_class_note: "owner-builder",
        is_owner_builder: true,
        contractor_identity_key: null,
        canonical_business_name: null,
        name_variant_count: null,
        identity_permit_count: null,
        ...prov(CONTRACTORS),
      },
    ],
  },
};
const LONG_RULE_TEXT =
  "Long-open: an issued LADBS permit for roofing work still open (status class open-issued) for at least 1,826 days. Roofing work only.";
const longItem = (n: number, parcel_id: string) => ({
  permit_number: `20000-30000-0000${n}`,
  address: `${n} LONG OPEN WAY`,
  postal_code: "91405",
  source_permit_type: "Bldg-Alter/Repair",
  source_permit_sub_type: "1 or 2 Family Dwelling",
  source_status_desc: "Issued",
  permit_status_class: "open-issued",
  application_received_date: null,
  permit_issue_date: "2015-06-0" + n,
  status_date: "2015-06-0" + n,
  open_since: "2015-06-0" + n,
  open_days: 4000 - n,
  roofing_work: true,
  roof_coating_only: n === 3,
  join_method: "direct",
  building_level: false,
  parcel_count: 1,
  parcel_id,
  distance_miles: n / 10,
  effective_roof_year: n === 1 ? 2009 : 1962,
  roof_age_basis: n === 1 ? PERMIT_BASIS : PROXY_BASIS,
  roof_year_permit_number: n === 1 ? "09000-10000-00001" : null,
});
const LONG = {
  count: 3,
  rule: {
    reference_date: "2026-11-12",
    status_class: "open-issued",
    min_open_days: 1826,
    max_open_days: null,
    roof_age: null,
    text: LONG_RULE_TEXT,
  },
  // Items 1 and 2 share a parcel: expanding both makes one forParcel call.
  items: [
    longItem(1, "1111111111"),
    longItem(2, "1111111111"),
    longItem(3, "3333333333"),
  ],
  next_offset: null,
};
const BBB_REASON =
  "BBB ratings are not in this data: no BBB source is ingested.";
const parcelPermits = (parcel_id: string) => ({
  parcel_id,
  permit_data_available: true,
  jurisdiction: "LOS ANGELES",
  effective_roof_year: 1962,
  roof_age_basis: PROXY_BASIS,
  roof_year_permit_number: null,
  permits: LONG.items
    .filter((i) => i.parcel_id === parcel_id)
    .map((i) => ({
      ...i,
      contractors:
        i.permit_number === "20000-30000-00001"
          ? [
              {
                contractors_business_name: "ACME ROOFING INC",
                license_identifier: "123456",
                source_license_type: "C39",
                license_class: "C-39",
                license_class_note: null,
                is_owner_builder: false,
                license_expiration_date: "2027-01-31",
                city_name: "VAN NUYS",
                state_code: "CA",
                contractor_identity_key: "123456",
                canonical_business_name: "ACME ROOFING & SOLAR INC",
                name_variant_count: 3,
                identity_permit_count: 40,
              },
              // A license whose rows carry no name: no canonical name shown, never a guessed one.
              {
                contractors_business_name: null,
                license_identifier: "654321",
                source_license_type: "C39",
                license_class: "C-39",
                license_class_note: null,
                is_owner_builder: false,
                license_expiration_date: null,
                city_name: null,
                state_code: null,
                contractor_identity_key: "654321",
                canonical_business_name: null,
                name_variant_count: 0,
                identity_permit_count: 1,
              },
            ]
          : [],
    })),
  bbb: { available: false, reason: BBB_REASON },
});

const tbodyText = (testId: string) =>
  [...screen.getByTestId(testId).querySelectorAll("tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""),
  );

describe("Explorer sources, records and long-open permits", () => {
  beforeEach(() => {
    h.runSummary.mockReset().mockResolvedValue({
      run: { run_id: "r1", row_counts: { parquet: 4 }, limitations: [] },
      history: [],
    });
    h.sources.mockReset().mockResolvedValue(SOURCES);
    h.records
      .mockReset()
      .mockImplementation(
        async (i: { source_name: string }) => RECORDS[i.source_name],
      );
    h.longOpen.mockReset().mockResolvedValue(LONG);
    h.forParcel
      .mockReset()
      .mockImplementation(async (i: { parcel_id: string }) =>
        parcelPermits(i.parcel_id),
      );
  });
  afterEach(() => cleanup());

  test("the sources tab lists the three sources with their license, attribution and changes made, and every page grouped by source", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("tab", { name: "Sources & pages" }),
    );
    await screen.findByTestId("sources");
    const rows = tbodyText("sources");
    expect(rows.map((r) => [r[0], r[1], r[2], r[3]])).toEqual([
      [ROLL, "parcel", "4", "2"],
      [PERMITS, "permit", "3", "2"],
      [CONTRACTORS, "contractor", "5", "1"],
    ]);
    // License, attribution, changes made and coverage window per source, as served (none for the roll).
    expect(rows.map((r) => [r[6], r[7], r[8], r[9]])).toEqual([
      ["—", "—", "—", "—"],
      [PERMIT_LICENSE, PERMIT_ATTRIBUTION, "—", "—"],
      [
        "CC BY 4.0",
        "LADBS",
        "license classes normalized",
        "permit_issue_date 2013-01-02 to 2023-05-19",
      ],
    ]);
    expect(rows[1]![7]).toContain('reads "TSB"');
    expect(rows[1]![5]).toContain("aaaa-0001.json");
    expect(rows[1]![5]).toContain("aaaa-0002.json");
    // Every page, grouped in the sources' order, then by page file.
    expect(tbodyText("pages").map((r) => [r[0], r[5]])).toEqual([
      ["pages/page-00000.json.gz", "parcel"],
      ["pages/page-00001.json.gz", "parcel"],
      ["pages/aaaa-0001_p000.json.gz", "permit"],
      ["pages/aaaa-0002_p000.json.gz", "permit"],
      ["pages/8guu-8f5m_p000.json.gz", "contractor"],
    ]);
    expect(document.body.textContent).not.toMatch(/licen[^s]/i); // the British spelling: "license" throughout
  });

  test("the records tab pages each source chosen from the selector, with counts from the API and the attribution for permit and contractor rows; sources are fetched once", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Records" }));
    const select = (await screen.findByTestId(
      "records-source",
    )) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      ROLL,
      PERMITS,
      CONTRACTORS,
    ]);
    expect(select.value).toBe(ROLL);
    await screen.findByText("4 records", { exact: false });
    expect(h.records).toHaveBeenLastCalledWith({
      source_name: ROLL,
      after: undefined,
      limit: 50,
    });
    expect(tbodyText("records")[0]!.slice(0, 3)).toEqual([
      "0000000001",
      "1 ROLL ST",
      "1950",
    ]);
    // Page 2 of the roll, then another source starts again at its first page.
    fireEvent.click(screen.getByTestId("records-next"));
    await screen.findByText("page 2", { exact: false });
    expect(h.records).toHaveBeenLastCalledWith({
      source_name: ROLL,
      after: "0000000002",
      limit: 50,
    });

    fireEvent.change(select, { target: { value: PERMITS } });
    await screen.findByText("3 records", { exact: false });
    expect(screen.getByTestId("records-total").textContent).toContain("page 1");
    expect(h.records).toHaveBeenLastCalledWith({
      source_name: PERMITS,
      after: undefined,
      limit: 50,
    });
    expect(screen.getByTestId("records").getAttribute("data-kind")).toBe(
      "permit",
    );
    expect(tbodyText("records").map((r) => r.slice(0, 7))).toEqual([
      [
        "10000-20000-00001",
        "Permit Finaled",
        "closed",
        "2015-03-04",
        "condo-building",
        "12",
        "1 PERMIT AVE",
      ],
      [
        "10000-20000-00002",
        "Issued",
        "open-issued",
        "2012-01-02",
        "not joined",
        "0",
        "2 PERMIT AVE",
      ],
    ]);
    expect(screen.getByTestId("records-attribution").textContent).toBe(
      `Attribution: ${PERMIT_ATTRIBUTION}. License: ${PERMIT_LICENSE}.`,
    );
    expect(screen.getByTestId("records-next")).toHaveProperty("disabled", true);

    fireEvent.change(select, { target: { value: CONTRACTORS } });
    await screen.findByText("5 records", { exact: false });
    // The identity follows: the license number, the canonical name and the variant count (no variant named);
    // a row without a license has none.
    expect(tbodyText("records").map((r) => r.slice(0, 9))).toEqual([
      [
        "10000-20000-00001",
        "ACME ROOFING INC",
        "123456",
        "C39",
        "C-39",
        "no",
        "123456",
        "ACME ROOFING & SOLAR INC",
        "3",
      ],
      [
        "10000-20000-00001",
        "—",
        "—",
        "NA",
        "owner-builder",
        "yes",
        "—",
        "—",
        "—",
      ],
    ]);
    expect(
      [...screen.getByTestId("records").querySelectorAll("th")]
        .map((th) => th.textContent)
        .slice(6, 9),
    ).toEqual(["Identity (license)", "Canonical name", "Name variants"]);
    // The attribution and the contractor source's coverage window.
    expect(screen.getByTestId("records-attribution").textContent).toBe(
      CONTRACTOR_NOTE,
    );
    expect(document.body.textContent).not.toMatch(/licen[^s]|work_desc/i);
    // explorer.sources (about 1.4 MB on the county run) is fetched once for every tab that shows it.
    fireEvent.click(screen.getByRole("tab", { name: "Sources & pages" }));
    await screen.findByTestId("sources");
    fireEvent.click(screen.getByRole("tab", { name: "Long-open permits" }));
    expect(
      (await screen.findByTestId("long-open-source")).textContent,
    ).toContain(PERMITS);
    expect(h.sources).toHaveBeenCalledTimes(1);
  });

  test("the radius query states the API's rule text and shows the effective roof year with its basis", async () => {
    vi.useFakeTimers();
    try {
      h.search.mockReset().mockResolvedValue({
        count: 3,
        rule: {
          ...rule,
          text: "Roof age counts from the effective roof year: … an effective roof year before 2011 …",
        },
        next_offset: null,
        items: [1, 2, 3].map((i) => ({
          parcel_id: `000000000${i}`,
          address: `${i} TEST ST`,
          year_built: i === 3 ? null : 1980,
          roof_age_years_proxy: i === 3 ? null : 46,
          effective_roof_year: i === 1 ? 2004 : 1980,
          roof_age_years: i === 1 ? 22 : 46,
          roof_age_basis: i === 1 ? PERMIT_BASIS : PROXY_BASIS,
          roof_year_permit_number: i === 1 ? "11111-22222-33333" : null,
          permit_data_available: true,
          land_base_year: i === 3 ? null : 2001,
          distance_miles: i / 10,
          latitude: 34.2,
          longitude: -118.49,
        })),
        ownership: null,
      });
      render(<App />);
      await wait(0);
      fireEvent.click(screen.getByRole("tab", { name: "Radius query" }));
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      await wait(0);
      expect(screen.getByTestId("rule").textContent).toBe(
        "Roof age counts from the effective roof year: … an effective roof year before 2011 …",
      );
      expect(tbodyText("radius-results").map((r) => r.slice(2, 8))).toEqual([
        ["1980", "2004", "permit 11111-22222-33333", "22", "2001", "0.1"],
        ["1980", "1980", "year built (proxy)", "46", "2001", "0.2"],
        ["—", "1980", "year built (proxy)", "46", "—", "0.3"],
      ]);
      // No ownership filter was asked for: none stated.
      expect(screen.queryByTestId("ownership-rule")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("the long-open view sends the default window, shows the API's count and rule, BBB not available and the cited source, and no description", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("tab", { name: "Long-open permits" }),
    );
    expect(
      (
        screen.getByRole("spinbutton", {
          name: "Open at least (days)",
        }) as HTMLInputElement
      ).value,
    ).toBe("1826");
    fireEvent.click(
      screen.getByRole("button", { name: "Find long-open permits" }),
    );
    await screen.findByTestId("long-open-count");
    expect(h.longOpen).toHaveBeenCalledTimes(1);
    const input = h.longOpen.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toEqual({
      lat: 34.199,
      lon: -118.487,
      radius_miles: 5,
      min_open_days: 1826,
      sort: "open_days",
      offset: 0,
      limit: 50,
    });
    expect("max_open_days" in input).toBe(false);
    expect(screen.getByTestId("long-open-count").textContent).toBe("3");
    expect(screen.getByTestId("long-open-rule").textContent).toBe(
      LONG_RULE_TEXT,
    );
    const rows = tbodyText("long-open-results");
    expect(rows.map((r) => [r[0], r[2], r[4], r[7], r[9], r[10]])).toEqual([
      [
        "20000-30000-00001",
        "Issued (open-issued)",
        "3999",
        "2009 (permit 09000-10000-00001)",
        "not available",
        PERMITS,
      ],
      [
        "20000-30000-00002",
        "Issued (open-issued)",
        "3998",
        "1962 (year built (proxy))",
        "not available",
        PERMITS,
      ],
      [
        "20000-30000-00003 (roof coating only)",
        "Issued (open-issued)",
        "3997",
        "1962 (year built (proxy))",
        "not available",
        PERMITS,
      ],
    ]);
    const cite = (await screen.findByTestId("long-open-source")).textContent!;
    expect(cite).toContain(PERMITS);
    expect(cite).toContain(
      "retrieved 2026-11-12T13:00:00.000Z → 2026-11-12T13:10:00.000Z",
    );
    expect(cite).toContain(`Attribution: ${PERMIT_ATTRIBUTION}.`);
    expect(cite).toContain(`License: ${PERMIT_LICENSE}.`);
    // No description anywhere: no such column, no such text.
    const headers = [
      ...screen.getByTestId("long-open-results").querySelectorAll("th"),
    ].map((th) => th.textContent);
    expect(headers.join("|")).not.toMatch(/desc/i);
    expect(document.body.textContent).not.toMatch(/work_desc|description/i);
    // Contractors are not fetched until a row is expanded.
    expect(h.forParcel).not.toHaveBeenCalled();
  });

  test("the long-open view gets a row's contractors from forParcel on expanding it, once per parcel, with the CC BY attribution and the API's BBB reason", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("tab", { name: "Long-open permits" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Find long-open permits" }),
    );
    await screen.findByTestId("long-open-count");
    const toggles = screen.getAllByTestId("contractors-toggle");
    fireEvent.click(toggles[0]!);
    expect(h.forParcel).toHaveBeenCalledTimes(1);
    expect(h.forParcel).toHaveBeenLastCalledWith({ parcel_id: "1111111111" });
    const table = await screen.findByTestId("contractors");
    expect(
      // The table sits inside the long-open table's body: its own rows only.
      [...table.querySelectorAll(":scope > tbody > tr")].map((tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent),
      ),
    ).toEqual([
      [
        "ACME ROOFING INC",
        "123456",
        "C39",
        "C-39",
        "no",
        "2027-01-31",
        "VAN NUYS, CA",
        "123456",
        "ACME ROOFING & SOLAR INC",
        "3",
      ],
      // No name on any row of the license: none shown.
      ["—", "654321", "C39", "C-39", "no", "—", "—", "654321", "—", "0"],
    ]);
    expect(screen.getByText(/^Contains data from LADBS/).textContent).toBe(
      CONTRACTOR_NOTE,
    );
    expect(screen.getByTestId("bbb-reason").textContent).toBe(
      `BBB: not available. ${BBB_REASON}`,
    );
    // The second permit is on the same parcel: no new call; it has no contractor row.
    fireEvent.click(toggles[1]!);
    expect(h.forParcel).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("no-contractors")).toBeTruthy();
    // Another parcel: one more call. Collapsing and expanding again: none.
    fireEvent.click(toggles[2]!);
    expect(h.forParcel).toHaveBeenCalledTimes(2);
    expect(h.forParcel).toHaveBeenLastCalledWith({ parcel_id: "3333333333" });
    fireEvent.click(toggles[0]!);
    fireEvent.click(toggles[0]!);
    expect(h.forParcel).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("contractors-row")).toHaveLength(3);
  });

  test("the long-open view sends a changed minimum and an optional maximum, and shows the API's refusal", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("tab", { name: "Long-open permits" }),
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Open at least (days)" }),
      { target: { value: "3652" } },
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Open at most (days, optional)" }),
      { target: { value: "7305" } },
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Order" }), {
      target: { value: "distance" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Find long-open permits" }),
    );
    await screen.findByTestId("long-open-count");
    expect(h.longOpen.mock.calls[0]![0]).toMatchObject({
      min_open_days: 3652,
      max_open_days: 7305,
      sort: "distance",
    });
    h.longOpen
      .mockReset()
      .mockRejectedValue(
        new Error("max_open_days must not be below min_open_days"),
      );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Open at most (days, optional)" }),
      { target: { value: "10" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Find long-open permits" }),
    );
    expect(
      await screen.findByText("max_open_days must not be below min_open_days"),
    ).toBeTruthy();
  });

  test("permits are no longer a placeholder; the remaining placeholders are disabled", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Coming next" }));
    const cards = screen.getAllByTestId("placeholder");
    expect(cards).toHaveLength(8);
    for (const c of cards) {
      expect(c.getAttribute("aria-disabled")).toBe("true");
      expect(c.querySelector("button")!.disabled).toBe(true);
    }
    const text = cards.map((c) => c.textContent).join(" ");
    expect(text).not.toMatch(/not harvested|LADBS later|licen[^s]/i);
    expect(text).toContain("Permits outside the City of Los Angeles");
    expect(text).toContain("BBB");
  });

  test("the run summary shows the permit run's permit counts", async () => {
    h.runSummary.mockReset().mockResolvedValue({
      run: {
        run_id: "r1",
        row_counts: {
          parquet: 4,
          permits: {
            staged: 3,
            parquet: {
              permits: 296909,
              permit_parcels: 607702,
              permit_contractors: 113642,
            },
          },
        },
        coverage: {
          permit_data: {
            parcels_with_permit_data: 805901,
            parcels_with_permits: 279900,
          },
        },
        derived_field_reference_date: "2026-11-12",
        limitations: [],
      },
      history: [],
    });
    render(<App />);
    const cards = await screen.findByTestId("permit-counts");
    expect(screen.getByTestId("permit-count").textContent).toBe("296,909");
    expect(cards.textContent).toContain("607,702");
    expect(cards.textContent).toContain("113,642");
    expect(cards.textContent).toContain("805,901");
    expect(cards.textContent).toContain("2026-11-12");
  });
});

describe("Explorer ownership filter, run kind and contractor window", () => {
  const item = {
    parcel_id: "0000000001",
    address: "1 TEST ST",
    year_built: 1980,
    roof_age_years_proxy: 46,
    effective_roof_year: 1980,
    roof_age_years: 46,
    roof_age_basis: PROXY_BASIS,
    roof_year_permit_number: null,
    permit_data_available: true,
    land_base_year: 1998,
    distance_miles: 0.1,
    latitude: 34.2,
    longitude: -118.49,
  };
  beforeEach(() => {
    h.runSummary.mockReset().mockResolvedValue({
      run: { run_id: "r1", row_counts: { parquet: 4 }, limitations: [] },
      history: [],
    });
    h.sources.mockReset().mockResolvedValue(SOURCES);
    h.search
      .mockReset()
      .mockImplementation(async (i: { ownership_basis?: string }) => ({
        count: 1,
        rule,
        next_offset: null,
        items: [item],
        ownership: i.ownership_basis
          ? {
              basis: i.ownership_basis,
              ...OWNERSHIP_BASIS[i.ownership_basis as "both"],
              proxy_note: OWNERSHIP_PROXY_NOTE,
            }
          : null,
      }));
  });
  afterEach(() => cleanup());
  const openRadius = async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Radius query" }));
  };
  const search = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByTestId("radius-count");
  };

  test("the ownership filter is off by default: no basis sent, no basis text shown", async () => {
    await openRadius();
    const on = screen.getByRole("checkbox", {
      name: /Owner unchanged for 10 years or more/,
    }) as HTMLInputElement;
    expect(on.checked).toBe(false);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    await search();
    expect("ownership_basis" in h.search.mock.calls[0]![0]).toBe(false);
    expect(screen.queryByTestId("ownership-rule")).toBeNull();
  });

  test("turned on, it preselects both and shows the three bases with their weakness and the proxy note, verbatim from the contract", async () => {
    await openRadius();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Owner unchanged for 10 years or more/,
      }),
    );
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ["both", true],
      ["recording", false],
      ["base_year", false],
    ]);
    const box = screen.getByTestId("ownership").textContent!;
    for (const b of ["recording", "base_year", "both"] as const) {
      expect(box).toContain(OWNERSHIP_BASIS[b].text);
      expect(box).toContain(OWNERSHIP_BASIS[b].weakness);
    }
    expect(
      screen.getAllByTestId("ownership-weakness").map((p) => p.textContent),
    ).toEqual(
      (["both", "recording", "base_year"] as const).map(
        (b) => `Weakness: ${OWNERSHIP_BASIS[b].weakness}`,
      ),
    );
    expect(screen.getByTestId("ownership-proxy-note").textContent).toBe(
      OWNERSHIP_PROXY_NOTE,
    );
    await search();
    expect(h.search.mock.calls[0]![0]).toMatchObject({
      ownership_basis: "both",
    });
    const stated = screen.getByTestId("ownership-rule");
    expect(stated.getAttribute("data-basis")).toBe("both");
    expect(stated.textContent).toBe(
      `Ownership filter (both): ${OWNERSHIP_BASIS.both.text} Weakness: ${OWNERSHIP_BASIS.both.weakness} ${OWNERSHIP_PROXY_NOTE}`,
    );
    expect(screen.getByTestId("land-base-year").textContent).toBe("1998");
  });

  test("each basis sends its value; turning the filter off sends none again", async () => {
    await openRadius();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Owner unchanged for 10 years or more/,
      }),
    );
    for (const b of ["recording", "base_year", "both"] as const) {
      fireEvent.click(
        screen
          .getAllByRole("radio")
          .find((r) => r.getAttribute("value") === b)!,
      );
      await search();
      expect(h.search.mock.lastCall![0]).toMatchObject({ ownership_basis: b });
      expect(
        screen.getByTestId("ownership-rule").getAttribute("data-basis"),
      ).toBe(b);
    }
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Owner unchanged for 10 years or more/,
      }),
    );
    await search();
    expect("ownership_basis" in h.search.mock.lastCall![0]).toBe(false);
  });

  test("a rebuild run: the summary states the kind and its source; the history table says rebuild, new data, or nothing where the row has no kind", async () => {
    h.runSummary.mockReset().mockResolvedValue({
      run: {
        run_id: "r4",
        row_counts: { parquet: 4 },
        limitations: [],
        run_kind: "rebuild",
        rebuild_of: "r3",
        source_changes: "none",
      },
      history: [
        {
          run_id: "r1",
          run_kind: null,
          rebuild_of: null,
          source_changes: null,
        },
        {
          run_id: "r2",
          run_kind: "new data",
          rebuild_of: null,
          source_changes: null,
        },
        {
          run_id: "r3",
          run_kind: null,
          rebuild_of: null,
          source_changes: null,
        },
        {
          run_id: "r4",
          run_kind: "rebuild",
          rebuild_of: "r3",
          source_changes: "none",
        },
      ],
    });
    render(<App />);
    expect((await screen.findByTestId("run-kind")).textContent).toBe(
      "Run kind: rebuild of r3, no source changes",
    );
    expect(tbodyText("run-history").map((r) => [r[0], r[1]])).toEqual([
      ["r1", ""],
      ["r2", "new data"],
      ["r3", ""],
      ["r4", "rebuild"],
    ]);
  });

  test("a run without run_kind shows no kind at all, never a guess", async () => {
    render(<App />);
    await screen.findByTestId("run-summary");
    expect(screen.queryByTestId("run-kind")).toBeNull();
    expect(document.body.textContent).not.toMatch(/rebuild|new data/);
  });

  test("the Contractor rows card shows the contractor source's coverage window", async () => {
    h.runSummary.mockReset().mockResolvedValue({
      run: {
        run_id: "r1",
        row_counts: {
          parquet: 4,
          permits: { parquet: { permits: 3, permit_contractors: 5 } },
        },
        limitations: [],
      },
      history: [],
    });
    render(<App />);
    expect((await screen.findByTestId("contractor-window")).textContent).toBe(
      "permit_issue_date 2013-01-02 to 2023-05-19",
    );
    expect(screen.getByTestId("contractor-rows-card").textContent).toContain(
      "5",
    );
    expect(h.sources).toHaveBeenCalledTimes(1);
  });
});
