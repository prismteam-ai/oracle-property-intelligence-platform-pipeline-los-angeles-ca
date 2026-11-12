import { expect, request, test } from "@playwright/test";
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
    const summary = await apiGet("explorer.runSummary");
    const sources = await apiGet("explorer.sources");
    await page.goto("/");
    await expect(page.getByTestId("limitations").locator("li")).toHaveCount(
      summary.run.limitations.length,
    );
    await expect(page.getByTestId("run-history")).toContainText(
      summary.run.run_id,
    );
    await page.getByRole("tab", { name: "Sources & pages" }).click();
    for (const s of sources.sources) {
      await expect(page.getByTestId("sources")).toContainText(s.source_name);
      await expect(page.getByTestId("sources")).toContainText(
        fmt(s.record_count),
      );
    }
    const rows = page.getByTestId("pages").locator("tbody tr");
    await expect(rows).toHaveCount(sources.pages.length);
    // Every row's cells in one browser call: the county run has 2,429 pages, too many for a round trip each.
    const cells = await rows.evaluateAll((trs) =>
      trs.map((tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""),
      ),
    );
    expect(cells).toHaveLength(sources.pages.length);
    for (const c of cells) {
      expect(c[2]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(c[3]).toMatch(/^https:\/\/services\.arcgis\.com\/.+\/query\?/);
      expect(c[4]).toMatch(/^[0-9a-f]{64}$/);
    }
    await page.getByRole("tab", { name: "Records" }).click();
    await expect(page.getByTestId("records-total")).toContainText(
      `${fmt(sources.sources[0].record_count)} records`,
    );
    const first = await page
      .getByTestId("records")
      .locator("tbody tr td")
      .first()
      .innerText();
    await page.getByTestId("records-next").click();
    await expect(page.getByTestId("records-total")).toContainText("page 2");
    expect(
      await page
        .getByTestId("records")
        .locator("tbody tr td")
        .first()
        .innerText(),
    ).not.toBe(first);
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
      await expect(page.getByTestId("rule")).toContainText(
        `built before ${expected.rule.built_before_year}`,
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
        const c = await r.locator("td").allInnerTexts();
        expect(
          haversine([VN.lat, VN.lon], [Number(c[5]), Number(c[6])]),
        ).toBeCloseTo(Number(c[4]), 2);
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
  });
});
