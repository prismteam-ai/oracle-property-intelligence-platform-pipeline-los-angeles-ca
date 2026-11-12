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

const h = vi.hoisted(() => ({ search: vi.fn(), runSummary: vi.fn() }));
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
      explorer: { runSummary: { query: h.runSummary } },
      parcels: { search: { query: h.search } },
    }),
}));

import { App } from "../src/App.tsx";

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
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
