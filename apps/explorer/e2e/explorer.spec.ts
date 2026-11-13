import { expect, request, test } from "@playwright/test";
import type { SourceKind, Sources } from "@oracle-la/api-client";
import { BASE_URL, CREDS, ORIGIN } from "./env.ts";

const VN = { lat: 34.199, lon: -118.487 };
const haversine = (a: number[], b: number[]) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b[0]! - a[0]!) / 2) ** 2 +
    Math.cos(r(a[0]!)) *
      Math.cos(r(b[0]!)) *
      Math.sin(r(b[1]! - a[1]!) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
};
const trpc = (apiUrl: string, proc: string, input?: unknown) =>
  `${apiUrl}/trpc/${proc}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;
const fmt = (n: number) => n.toLocaleString("en-US");

// Serial by default (a failure stops the run); PW_SERIAL=0 runs tests independently (each loads its own config).
test.describe.configure({
  mode: process.env.PW_SERIAL === "0" ? "default" : "serial",
});
type Cfg = { apiUrl: string; apiToken: string };
let cfgP: Promise<Cfg> | undefined;
/** The hosted /config.json (the only source of the API token), fetched once per worker. */
const config = (): Promise<Cfg> =>
  (cfgP ??= (async () => {
    const r = await (
      await request.newContext({ httpCredentials: CREDS })
    ).get(`${BASE_URL}/config.json`);
    if (r.status() !== 200) throw new Error(`config.json: HTTP ${r.status()}`);
    return (await r.json()) as Cfg;
  })());
/** Expected values come from the API (no hard-coded totals). */
const apiGet = async (proc: string, input?: unknown) => {
  const cfg = await config();
  const r = await (
    await request.newContext({
      extraHTTPHeaders: { authorization: `Bearer ${cfg.apiToken}` },
    })
  ).get(trpc(cfg.apiUrl, proc, input));
  expect(r.status()).toBe(200);
  return (await r.json()).result.data;
};

test.describe("without credentials", () => {
  test("1. the site and config.json are 401", async () => {
    const anon = await request.newContext();
    expect((await anon.get(`${BASE_URL}/`)).status()).toBe(401);
    expect((await anon.get(`${BASE_URL}/config.json`)).status()).toBe(401);
  });
  test("2b. the https://user:pass@host/ URL form loads data", async ({
    browser,
  }) => {
    const ctx = await browser.newContext(); // credentials in the URL only
    const page = await ctx.newPage();
    const summary = await apiGet("explorer.runSummary");
    await page.goto(
      `https://${encodeURIComponent(CREDS.username)}:${encodeURIComponent(CREDS.password)}@${new URL(BASE_URL).host}/`,
    );
    await expect(page.getByTestId("parquet-count")).toHaveText(
      fmt(summary.run.row_counts.parquet),
    );
    await ctx.close();
  });
});

test.describe("with credentials", () => {
  test.use({ httpCredentials: CREDS });

  test("2-3. credentials are really sent: 200 where unauthenticated is 401; config.json has API URL and token", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    expect((await page.goto("/"))?.status()).toBe(200);
    const res = await page.request.get("/config.json");
    expect(res.status()).toBe(200);
    // Same URL with no credentials at all (Node fetch: nothing inherited from Playwright options) is refused.
    expect((await fetch(`${BASE_URL}/config.json`)).status).toBe(401);
    const cfg = (await res.json()) as Cfg;
    expect(cfg.apiUrl).toMatch(
      /^https:\/\/[a-z0-9]+\.execute-api\.eu-north-1\.amazonaws\.com$/,
    );
    expect(cfg.apiToken.length).toBeGreaterThanOrEqual(40);
    const summary = await apiGet("explorer.runSummary");
    await expect(page.getByTestId("parquet-count")).toHaveText(
      fmt(summary.run.row_counts.parquet),
    );
    expect(errors).toEqual([]);
  });

  test("4. API: no header 401, wrong token 403, right token 200", async () => {
    const cfg = await config();
    const anon = await request.newContext();
    expect((await anon.get(trpc(cfg.apiUrl, "meta.info"))).status()).toBe(401);
    expect(
      (
        await anon.get(trpc(cfg.apiUrl, "meta.info"), {
          headers: { authorization: `Bearer wrong-${Date.now()}` },
        })
      ).status(),
    ).toBe(403);
    const info = await apiGet("meta.info");
    expect(info.sha256_verified).toBe(true);
  });

  test("4b. authorizer edge cases never give 500", async () => {
    const cfg = await config();
    const anon = await request.newContext();
    const nonce = Date.now(); // fresh header values: no authorizer cache hits from earlier runs
    const cases: Array<[string, string]> = [
      ["malformed (no scheme)", `garbage-${nonce}`],
      ["malformed (Bearer, no space)", `Bearer${nonce}`],
      [
        "wrong scheme (Basic)",
        `Basic ${Buffer.from(`x:${nonce}`).toString("base64")}`,
      ],
      ["oversized (8 KB token)", `Bearer ${"a".repeat(8000)}${nonce}`],
      ["empty token", "Bearer "],
    ];
    const results: Record<string, number> = {};
    for (const [label, value] of cases)
      results[label] = (
        await anon.get(trpc(cfg.apiUrl, "meta.info"), {
          headers: { authorization: value },
        })
      ).status();
    console.log("AUTHZ", JSON.stringify(results));
    for (const s of Object.values(results)) expect([401, 403]).toContain(s);
  });

  test("5. CORS allows the Explorer origin and no unlisted origin", async () => {
    const cfg = await config();
    const anon = await request.newContext();
    const pre = (origin: string) =>
      anon.fetch(trpc(cfg.apiUrl, "meta.info"), {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
    expect((await pre(ORIGIN)).headers()["access-control-allow-origin"]).toBe(
      ORIGIN,
    );
    expect(
      (await pre("https://evil.example")).headers()[
        "access-control-allow-origin"
      ],
    ).toBeUndefined();
  });

  test("6. run summary, records by source, pages with provenance, record paging (counts from the API)", async ({
    page,
  }) => {
    // Three sources, each paged twice in the UI and through the API: 55.9 s against the local stand-in.
    test.slow();
    const summary = await apiGet("explorer.runSummary");
    const sources = (await apiGet("explorer.sources")) as Sources;
    const kinds = sources.sources.map((s) => s.source_kind);
    expect([...kinds].sort()).toEqual(["contractor", "parcel", "permit"]);
    const byKind = new Map(sources.sources.map((s) => [s.source_kind, s]));
    await page.goto("/");
    await expect(page.getByTestId("limitations").locator("li")).toHaveCount(
      summary.run.limitations.length,
    );
    await expect(page.getByTestId("run-history")).toContainText(
      summary.run.run_id,
    );
    await page.getByRole("tab", { name: "Sources & pages" }).click();
    const srcRows = page.getByTestId("sources").locator("tbody tr");
    await expect(srcRows).toHaveCount(sources.sources.length);
    for (const s of sources.sources) {
      const row = page
        .getByTestId("sources")
        .locator(`tbody tr[data-kind="${s.source_kind}"]`);
      await expect(row).toContainText(s.source_name);
      await expect(row).toContainText(fmt(s.record_count));
      await expect(row.getByTestId("source-license")).toHaveText(
        s.license ?? "—",
      );
      await expect(row.getByTestId("source-attribution")).toHaveText(
        s.attribution ?? "—",
      );
    }
    // The terms as recorded: the permit datasets state no license (portal terms of May 2014) and their
    // attribution field reads "TSB"; the contractor view is CC BY 4.0, attribution LADBS, with the changes made.
    const permitSrc = byKind.get("permit")!,
      contractorSrc = byKind.get("contractor")!;
    expect(permitSrc.license).toContain("May 2014");
    expect(permitSrc.attribution).toContain("LADBS");
    expect(permitSrc.attribution).toContain('"TSB"');
    expect(permitSrc.query_urls!.length).toBeGreaterThan(0);
    expect(contractorSrc.license).toBe("CC BY 4.0");
    expect(contractorSrc.attribution).toBe("LADBS");
    await expect(
      page
        .getByTestId("sources")
        .locator('tbody tr[data-kind="contractor"]')
        .getByTestId("source-changes"),
    ).toHaveText("license classes normalized");
    const rows = page.getByTestId("pages").locator("tbody tr");
    await expect(rows).toHaveCount(sources.pages.length);
    // Every row's cells in one browser call: the county run has 2,429 pages, too many for a round trip each.
    const cells = await rows.evaluateAll((trs) =>
      trs.map((tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""),
      ),
    );
    expect(cells).toHaveLength(sources.pages.length);
    const PAGE_FILE: Record<SourceKind, RegExp> = {
      parcel: /^(page-\d{4}\.json|pages\/page-\d{5}\.json\.gz)$/,
      permit: /^pages\/[a-z0-9]{4}-[a-z0-9]{4}_p\d{3}\.json\.gz$/,
      contractor: /^pages\/[a-z0-9]{4}-[a-z0-9]{4}_p\d{3}\.json\.gz$/,
    };
    const perKind: Record<string, number> = {};
    for (const c of cells) {
      const kind = c[5] as SourceKind;
      const s = byKind.get(kind)!;
      perKind[kind] = (perKind[kind] ?? 0) + 1;
      expect(c[0]).toMatch(PAGE_FILE[kind]);
      expect(c[2]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      // The exact request: the source's own query URL (the roll's ArcGIS query, or one of the LADBS datasets).
      if (kind === "parcel") {
        expect(c[3]).toMatch(/^https:\/\/services\.arcgis\.com\/.+\/query\?/);
        expect(c[3]!.startsWith(`${s.query_url}?`)).toBe(true);
      } else {
        expect(c[3]).toMatch(
          /^https:\/\/data\.lacity\.org\/resource\/[a-z0-9]{4}-[a-z0-9]{4}\.json\?/,
        );
        expect(s.query_urls!.some((u) => c[3]!.startsWith(`${u}?`))).toBe(true);
      }
      expect(c[4]).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const s of sources.sources)
      expect(perKind[s.source_kind]).toBe(s.page_count);

    await page.getByRole("tab", { name: "Records" }).click();
    // The roll first, as before; then every source from the selector, each with the API's own total.
    await expect(page.getByTestId("records-total")).toContainText(
      `${fmt(byKind.get("parcel")!.record_count)} records`,
    );
    for (const s of [
      byKind.get("parcel")!,
      ...sources.sources.filter((x) => x.source_kind !== "parcel"),
    ]) {
      const expected = await apiGet("explorer.records", {
        source_name: s.source_name,
        limit: 50,
      });
      await page.getByTestId("records-source").selectOption(s.source_name);
      await expect(page.getByTestId("records")).toHaveAttribute(
        "data-kind",
        s.source_kind,
      );
      await expect(page.getByTestId("records-total")).toHaveText(
        `${fmt(expected.total)} records · page 1`,
      );
      const firstCell = page
        .getByTestId("records")
        .locator("tbody tr td")
        .first();
      await expect(firstCell).toHaveText(
        s.source_kind === "contractor"
          ? expected.items[0].permit_number
          : expected.items[0].record_key,
      );
      if (s.source_kind === "contractor")
        await expect(page.getByTestId("records-attribution")).toHaveText(
          `Contains data from ${s.attribution}, licensed under ${s.license}; license classes normalized.`,
        );
      if (s.source_kind === "permit")
        await expect(page.getByTestId("records-attribution")).toContainText(
          String(s.attribution),
        );
      expect(expected.next_after).not.toBeNull();
      await page.getByTestId("records-next").click();
      await expect(page.getByTestId("records-total")).toContainText("page 2");
      const next = await apiGet("explorer.records", {
        source_name: s.source_name,
        after: expected.next_after,
        limit: 50,
      });
      await expect(firstCell).toHaveText(
        s.source_kind === "contractor"
          ? next.items[0].permit_number
          : next.items[0].record_key,
      );
    }
  });

  test("7. radius form: count equals the API at 15 and 80 years, rule stated, every result inside the radius", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Radius query" }).click();
    for (const years of [15, 80]) {
      const expected = await apiGet("parcels.search", {
        ...VN,
        radius_miles: 5,
        threshold_years: years,
      });
      await page
        .getByRole("spinbutton", { name: "Roof older than (years)" })
        .fill(String(years));
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page.getByTestId("radius-count")).toHaveText(
        fmt(expected.count),
      );
      await expect(page.getByTestId("rule")).toHaveText(expected.rule.text);
      await expect(page.getByTestId("rule")).toContainText(
        `effective roof year before ${expected.rule.built_before_year}`,
      );
      const rows = await page
        .getByTestId("radius-results")
        .locator("tbody tr")
        .all();
      const dists = await Promise.all(
        rows.map(async (r) =>
          Number(await r.getByTestId("distance").innerText()),
        ),
      );
      expect(Math.max(...dists)).toBeLessThanOrEqual(5);
      for (const r of rows.slice(0, 5)) {
        const [lat, lon, d] = await Promise.all(
          ["lat", "lon", "distance"].map(async (id) =>
            Number(await r.getByTestId(id).innerText()),
          ),
        );
        expect(haversine([VN.lat, VN.lon], [lat!, lon!])).toBeCloseTo(d!, 2);
      }
    }
  });

  test("8. future features are disabled placeholders", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Coming next" }).click();
    const cards = page.getByTestId("placeholder");
    await expect(cards).toHaveCount(8);
    for (const c of await cards.all()) {
      await expect(c).toHaveAttribute("aria-disabled", "true");
      await expect(c.getByRole("button")).toBeDisabled();
    }
    // Permits are delivered: no card says they are coming, and the long-open view is a tab of its own.
    for (const t of await cards.allInnerTexts())
      expect(t).not.toMatch(/not harvested|LADBS later/i);
    await expect(
      page.getByRole("tab", { name: "Long-open permits" }),
    ).toBeVisible();
  });

  test("9. long-open roofing permits: count and rule equal permits.longOpen at the default and a changed window, BBB not available, contractors from forParcel, the source cited, no description", async ({
    page,
  }) => {
    const sources = (await apiGet("explorer.sources")) as Sources;
    const permitSrc = sources.sources.find((s) => s.source_kind === "permit")!;
    await page.goto("/");
    await page.getByRole("tab", { name: "Long-open permits" }).click();
    // The default window is the API's own default (no min_open_days sent here).
    const expected = await apiGet("permits.longOpen", {
      ...VN,
      radius_miles: 5,
    });
    expect(expected.count).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Find long-open permits" }).click();
    await expect(page.getByTestId("long-open-count")).toHaveText(
      fmt(expected.count),
    );
    await expect(page.getByTestId("long-open-rule")).toHaveText(
      expected.rule.text,
    );
    await expect(page.getByTestId("long-open-rule")).toContainText(
      "Roofing work only",
    );
    await expect(
      page.getByRole("spinbutton", { name: "Open at least (days)" }),
    ).toHaveValue(String(expected.rule.min_open_days));
    const rows = page.getByTestId("long-open-row");
    await expect(rows).toHaveCount(expected.items.length);
    await expect(rows.first()).toHaveAttribute(
      "data-permit",
      expected.items[0].permit_number,
    );
    const bbb = await page.getByTestId("bbb").allInnerTexts();
    expect(bbb).toHaveLength(expected.items.length);
    for (const b of bbb) expect(b).toBe("not available");
    await expect(page.getByTestId("source").first()).toHaveText(
      permitSrc.source_name,
    );
    for (const s of await page.getByTestId("source").allInnerTexts())
      expect(s).toBe(permitSrc.source_name);
    const cite = page.getByTestId("long-open-source");
    await expect(cite).toContainText(permitSrc.source_name);
    await expect(cite).toContainText(permitSrc.last_retrieved_at);
    await expect(cite).toContainText(String(permitSrc.attribution));
    // No description: none served, no column for one, no description text on the page.
    for (const i of expected.items)
      expect(
        Object.keys(i).filter(
          (k) => /desc/i.test(k) && k !== "source_status_desc",
        ),
      ).toEqual([]);
    const headers = await page
      .getByTestId("long-open-results")
      .locator("th")
      .allInnerTexts();
    expect(headers.join("|")).not.toMatch(/desc/i);
    expect(await page.locator("main").innerText()).not.toMatch(
      /work_desc|description/i,
    );

    // Contractors of the first row come from permits.forParcel for its parcel, on expanding the row.
    const firstRowContractors = async (item: {
      parcel_id: string;
      permit_number: string;
    }) => {
      const parcel = await apiGet("permits.forParcel", {
        parcel_id: item.parcel_id,
      });
      expect(parcel.bbb.available).toBe(false);
      const contractors =
        parcel.permits.find(
          (p: { permit_number: string }) =>
            p.permit_number === item.permit_number,
        )?.contractors ?? [];
      await rows.first().getByTestId("contractors-toggle").click();
      await expect(page.getByTestId("bbb-reason")).toHaveText(
        `BBB: not available. ${parcel.bbb.reason}`,
      );
      if (contractors.length) {
        const trs = page.getByTestId("contractors").locator("tbody tr");
        await expect(trs).toHaveCount(contractors.length);
        await expect(trs.first().locator("td").first()).toHaveText(
          contractors[0].contractors_business_name ?? "—",
        );
      } else await expect(page.getByTestId("no-contractors")).toBeVisible();
      return contractors.length;
    };
    const shown = [await firstRowContractors(expected.items[0])];

    // A changed window: a larger minimum and a maximum.
    const changed = await apiGet("permits.longOpen", {
      ...VN,
      radius_miles: 5,
      min_open_days: 2000,
      max_open_days: 4383,
    });
    await page
      .getByRole("spinbutton", { name: "Open at least (days)" })
      .fill("2000");
    await page
      .getByRole("spinbutton", { name: "Open at most (days, optional)" })
      .fill("4383");
    await page.getByRole("button", { name: "Find long-open permits" }).click();
    await expect(page.getByTestId("long-open-count")).toHaveText(
      fmt(changed.count),
    );
    await expect(page.getByTestId("long-open-rule")).toHaveText(
      changed.rule.text,
    );
    // Permits open at most 4,383 days (12 years) were issued in the contractor view's years (2013 to 2023), so
    // contractor rows show here; the default window starts with the oldest permits, which have none.
    await expect(rows.first()).toHaveAttribute(
      "data-permit",
      changed.items[0].permit_number,
    );
    shown.push(await firstRowContractors(changed.items[0]));
    expect(Math.max(...shown)).toBeGreaterThan(0);
  });
});
