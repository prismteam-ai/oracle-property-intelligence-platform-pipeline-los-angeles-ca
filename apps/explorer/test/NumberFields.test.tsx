// @vitest-environment jsdom
/**
 * Every number field of the Explorer's forms behaves like a text entry: it can be emptied and retyped, shows
 * what was typed (never a 0 put back after clearing, so "5" typed after clearing shows "5", not "05"), and is
 * read only when the search runs: an empty or invalid value gives a plain message and no call. The arrows step
 * whole units. The agent panel's centre fields are covered in AskAgent.test.tsx.
 * Mocks: ../src/config.ts and @oracle-la/api-client (a callable object like the tRPC proxy, vi.fn() procedures).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  NOT_A_NUMBER,
  readAll,
  readNumber,
  readOptional,
  RADIUS,
} from "../src/numeric.ts";

const h = vi.hoisted(() => ({
  search: vi.fn(),
  longOpen: vi.fn(),
  any: vi.fn(),
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
        runSummary: { query: h.any },
        sources: { query: h.any },
        sourcePages: { query: h.any },
        records: { query: h.any },
      },
      parcels: { search: { query: h.search } },
      permits: { longOpen: { query: h.longOpen }, forParcel: { query: h.any } },
    }),
}));

import { App } from "../src/App.tsx";

const RULE = { text: "rule", min_open_days: 1826 };
beforeEach(() => {
  h.any.mockReset().mockReturnValue(new Promise(() => {}));
  h.search
    .mockReset()
    .mockResolvedValue({ count: 7, rule: RULE, next_offset: null, items: [] });
  h.longOpen
    .mockReset()
    .mockResolvedValue({ count: 4, rule: RULE, next_offset: null, items: [] });
});
afterEach(() => cleanup());

const field = (role: "textbox" | "spinbutton", name: string) =>
  screen.getByRole(role, { name }) as HTMLInputElement;
/**
 * Clears a field, then types after what it shows (as a keyboard does). Before the fix a cleared number field
 * showed 0 again, so the typed text came out as "0" + text.
 */
const retype = (el: HTMLInputElement, text: string) => {
  fireEvent.change(el, { target: { value: "" } });
  expect(el.value).toBe("");
  fireEvent.change(el, { target: { value: el.value + text } });
  expect(el.value).toBe(text);
};
const flush = () => new Promise((r) => setTimeout(r, 0));

type Case = {
  role: "textbox" | "spinbutton";
  name: string;
  typed: string;
  sent: Record<string, number>;
  empty: string;
  invalid: [string, string];
};

const RADIUS_FIELDS: Case[] = [
  {
    role: "textbox",
    name: "Latitude",
    typed: "34.20155",
    sent: { lat: 34.20155 },
    empty:
      "Latitude is empty: enter a number from 33.2 to 34.9 (Los Angeles County).",
    invalid: [
      "34,2",
      "Latitude must be a number from 33.2 to 34.9 (Los Angeles County).",
    ],
  },
  {
    role: "textbox",
    name: "Longitude",
    typed: "-118.45361",
    sent: { lon: -118.45361 },
    empty:
      "Longitude is empty: enter a number from -119 to -117.6 (Los Angeles County).",
    invalid: [
      "118.4",
      "Longitude must be a number from -119 to -117.6 (Los Angeles County).",
    ],
  },
  {
    role: "spinbutton",
    name: "Radius (miles)",
    typed: "1",
    sent: { radius_miles: 1 },
    empty: "Radius (miles) is empty: enter a number from 0.1 to 10.",
    invalid: ["0.05", "Radius (miles) must be a number from 0.1 to 10."],
  },
  {
    role: "spinbutton",
    name: "Roof older than (years)",
    typed: "20",
    sent: { threshold_years: 20 },
    empty:
      "Roof older than (years) is empty: enter a whole number from 1 to 120.",
    invalid: [
      "2.5",
      "Roof older than (years) must be a whole number from 1 to 120.",
    ],
  },
];

describe("Explorer radius form: number fields", () => {
  const open = async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Radius query" }));
  };
  const search = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await flush();
  };

  test.each(RADIUS_FIELDS)(
    "$name: cleared and retyped, it shows what was typed and the search sends it",
    async (c) => {
      await open();
      retype(field(c.role, c.name), c.typed);
      await search();
      expect(h.search).toHaveBeenCalledTimes(1);
      expect(h.search.mock.calls[0]![0]).toMatchObject(c.sent);
      expect(screen.queryByTestId("radius-error")).toBeNull();
      expect(await screen.findByTestId("radius-count")).toBeTruthy();
    },
  );

  test.each(RADIUS_FIELDS)(
    "$name: left empty or invalid, the search shows a plain message and sends nothing",
    async (c) => {
      await open();
      const el = field(c.role, c.name);
      fireEvent.change(el, { target: { value: "" } });
      await search();
      expect(h.search).not.toHaveBeenCalled();
      expect(el.value).toBe("");
      expect(screen.getByTestId("radius-error").textContent).toBe(c.empty);
      fireEvent.change(el, { target: { value: c.invalid[0] } });
      await search();
      expect(h.search).not.toHaveBeenCalled();
      expect(screen.getByTestId("radius-error").textContent).toBe(c.invalid[1]);
      // Corrected: the message goes and the search runs.
      fireEvent.change(el, { target: { value: c.typed } });
      await search();
      expect(h.search).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("radius-error")).toBeNull();
    },
  );

  test("the arrows step whole units: radius by 1 mile (decimals can still be typed), roof age by 1 year; lat and lon have no arrows", async () => {
    await open();
    const radius = field("spinbutton", "Radius (miles)");
    expect([radius.step, radius.min, radius.max]).toEqual(["1", "1", "10"]);
    const years = field("spinbutton", "Roof older than (years)");
    expect([years.step, years.min, years.max]).toEqual(["1", "1", "120"]);
    for (const name of ["Latitude", "Longitude"])
      expect(field("textbox", name).type).toBe("text");
    // The browser's own validation (a step mismatch for 0.5) never blocks the search: the form reads it.
    expect(screen.getByTestId("radius-form").hasAttribute("novalidate")).toBe(
      true,
    );
    retype(radius, "0.5");
    await search();
    expect(h.search.mock.calls[0]![0]).toMatchObject({ radius_miles: 0.5 });
  });

  test("two invalid fields: both messages, in form order", async () => {
    await open();
    fireEvent.change(field("textbox", "Latitude"), { target: { value: "" } });
    fireEvent.change(field("spinbutton", "Radius (miles)"), {
      target: { value: "11" },
    });
    await search();
    expect(h.search).not.toHaveBeenCalled();
    expect(screen.getByTestId("radius-error").textContent).toBe(
      "Latitude is empty: enter a number from 33.2 to 34.9 (Los Angeles County). Radius (miles) must be a number from 0.1 to 10.",
    );
  });
});

const LONG_FIELDS: Case[] = [
  { ...RADIUS_FIELDS[0]! },
  { ...RADIUS_FIELDS[1]! },
  { ...RADIUS_FIELDS[2]! },
  {
    role: "spinbutton",
    name: "Open at least (days)",
    typed: "3652",
    sent: { min_open_days: 3652 },
    empty:
      "Open at least (days) is empty: enter a whole number from 0 to 36,525.",
    invalid: [
      "40000",
      "Open at least (days) must be a whole number from 0 to 36,525.",
    ],
  },
  {
    role: "spinbutton",
    name: "Open at most (days, optional)",
    typed: "7305",
    sent: { max_open_days: 7305 },
    // Optional: empty sends no maximum (see the test below).
    empty: "",
    invalid: [
      "1.5",
      "Open at most (days, optional) must be a whole number from 0 to 36,525.",
    ],
  },
];

describe("Explorer long-open form: number fields", () => {
  const open = async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("tab", { name: "Long-open permits" }),
    );
  };
  const find = async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Find long-open permits" }),
    );
    await flush();
  };

  test("the form has a maximum-days field next to the minimum; by default no maximum is sent", async () => {
    await open();
    expect(field("spinbutton", "Open at least (days)").value).toBe("1826");
    expect(field("spinbutton", "Open at most (days, optional)").value).toBe("");
    await find();
    expect(h.longOpen.mock.calls[0]![0]).toMatchObject({
      lat: 34.199,
      lon: -118.487,
      radius_miles: 5,
      min_open_days: 1826,
    });
    expect("max_open_days" in h.longOpen.mock.calls[0]![0]).toBe(false);
  });

  test.each(LONG_FIELDS)(
    "$name: cleared and retyped, it shows what was typed and the search sends it",
    async (c) => {
      await open();
      retype(field(c.role, c.name), c.typed);
      await find();
      expect(h.longOpen).toHaveBeenCalledTimes(1);
      expect(h.longOpen.mock.calls[0]![0]).toMatchObject(c.sent);
      expect(screen.queryByTestId("long-open-error")).toBeNull();
      expect(await screen.findByTestId("long-open-count")).toBeTruthy();
    },
  );

  test.each(LONG_FIELDS.filter((c) => c.empty))(
    "$name: left empty, the search shows a plain message and sends nothing",
    async (c) => {
      await open();
      fireEvent.change(field(c.role, c.name), { target: { value: "" } });
      await find();
      expect(h.longOpen).not.toHaveBeenCalled();
      expect(screen.getByTestId("long-open-error").textContent).toBe(c.empty);
    },
  );

  test.each(LONG_FIELDS)(
    "$name: an invalid value shows a plain message and sends nothing",
    async (c) => {
      await open();
      fireEvent.change(field(c.role, c.name), {
        target: { value: c.invalid[0] },
      });
      await find();
      expect(h.longOpen).not.toHaveBeenCalled();
      expect(screen.getByTestId("long-open-error").textContent).toBe(
        c.invalid[1],
      );
    },
  );

  test("the maximum: typed, cleared again (no maximum sent), and below the minimum (a message, nothing sent)", async () => {
    await open();
    const max = field("spinbutton", "Open at most (days, optional)");
    retype(max, "2000");
    await find();
    expect(h.longOpen.mock.calls[0]![0]).toMatchObject({
      max_open_days: 2000,
    });
    fireEvent.change(max, { target: { value: "" } });
    await find();
    expect("max_open_days" in h.longOpen.mock.calls[1]![0]).toBe(false);
    fireEvent.change(max, { target: { value: "10" } });
    await find();
    expect(h.longOpen).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("long-open-error").textContent).toBe(
      "Open at most (10 days) is below open at least (1,826 days): set a larger maximum or clear it.",
    );
  });

  test("the arrows step whole units: radius by 1 mile, days by 1 day", async () => {
    await open();
    const radius = field("spinbutton", "Radius (miles)");
    expect([radius.step, radius.min, radius.max]).toEqual(["1", "1", "10"]);
    for (const name of [
      "Open at least (days)",
      "Open at most (days, optional)",
    ]) {
      const el = field("spinbutton", name);
      expect([el.step, el.min, el.max]).toEqual(["1", "0", "36525"]);
    }
    expect(
      screen.getByTestId("long-open-form").hasAttribute("novalidate"),
    ).toBe(true);
  });
});

describe("readNumber", () => {
  test("plain decimals in range only", () => {
    for (const [text, value] of [
      ["1", 1],
      [" 2.5 ", 2.5],
      [".5", 0.5],
      ["10", 10],
      ["0.1", 0.1],
    ] as const)
      expect(readNumber(text, RADIUS)).toEqual({ value });
    for (const text of [
      "",
      " ",
      "0",
      "10.01",
      "1e1",
      "0x1",
      "Infinity",
      "1,5",
      "1.2.3",
      "-",
      NOT_A_NUMBER,
    ])
      expect(readNumber(text, RADIUS)).toHaveProperty("error");
    expect(readNumber(NOT_A_NUMBER, RADIUS)).toEqual({
      error: "Radius (miles) must be a number from 0.1 to 10.",
    });
  });
  test("optional: empty is no value; text the browser could not read is an error", () => {
    expect(readOptional("", RADIUS)).toEqual({ value: undefined });
    expect(readOptional(NOT_A_NUMBER, RADIUS)).toHaveProperty("error");
  });
  test("readAll: the values, or every message in order", () => {
    expect(
      readAll({ a: readNumber("1", RADIUS), b: readOptional("", RADIUS) }),
    ).toEqual({ values: { a: 1, b: undefined } });
    expect(
      readAll({ a: readNumber("", RADIUS), b: readNumber("x", RADIUS) }),
    ).toEqual({
      error:
        "Radius (miles) is empty: enter a number from 0.1 to 10. Radius (miles) must be a number from 0.1 to 10.",
    });
  });
});
