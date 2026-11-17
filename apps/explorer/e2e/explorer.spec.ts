import {
  expect,
  request,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type {
  OwnershipBasis,
  SourceKind,
  SourcePages,
  SourceRow,
  Sources,
} from "@oracle-la/api-client";
import { TOOL_NAMES } from "../../../packages/agent/src/tools.ts";
import type { AnswerResponse } from "../src/agent-api.ts";
import { dateOnly } from "../src/dates.ts";
import { EXAMPLE } from "../src/mcp-tools.ts";
import {
  ANSWERED,
  FOLLOW_UP,
  QUESTION_1,
  QUESTION_2,
  REFUSED,
  STANDING_GAPS,
  STOPPED,
} from "./agent-fixtures.ts";
import { BASE_URL, CREDS, ORIGIN } from "./env.ts";

/** The Radius query and Long-open forms' default center (Van Nuys, as the agent resolves it). */
const VN = { lat: 34.20155, lon: -118.45361 };
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
/** A source's coverage window as the Explorer prints it; "—" without one. */
const windowText = (s: SourceRow) =>
  s.coverage
    ? `${s.coverage.field} ${s.coverage.first} to ${s.coverage.last}`
    : "—";
/** The contractor note: the attribution, then the window when the source states one. */
const contractorNoteText = (s: SourceRow) =>
  `Contains data from ${s.attribution}, licensed under ${s.license}; license classes normalized.` +
  (s.coverage
    ? ` Contractor rows exist only for permits issued ${s.coverage.first} to ${s.coverage.last} (${s.coverage.field}).`
    : "");
/** A cell as the Explorer prints a nullable value. */
const cell = (v: unknown) => (v === null || v === undefined ? "—" : String(v));

/**
 * The inputs of the GET requests to a data API procedure, in order (batched calls included: the path lists the
 * procedures and the input is keyed by position).
 */
const trpcInputs = (page: Page, proc: string) => {
  const inputs: Array<Record<string, unknown>> = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() !== "GET" || !u.pathname.startsWith("/trpc/")) return;
    const i = u.pathname.slice("/trpc/".length).split(",").indexOf(proc);
    if (i < 0) return;
    const input = JSON.parse(u.searchParams.get("input") ?? "{}");
    inputs.push(u.searchParams.has("batch") ? input[i] : input);
  });
  return inputs;
};
/**
 * Empties a field with the keyboard (it must stay empty), then types the text key by key (it must show exactly
 * that: before, a cleared number field showed 0 again and "5" came out as "05").
 */
const retype = async (field: Locator, text: string) => {
  await field.click();
  await field.press("ControlOrMeta+a");
  await field.press("Backspace");
  await expect(field).toHaveValue("");
  await field.pressSequentially(text);
  await expect(field).toHaveValue(text);
};

// Serial by default (a failure stops the run); PW_SERIAL=0 runs tests independently (each loads its own config).
test.describe.configure({
  mode: process.env.PW_SERIAL === "0" ? "default" : "serial",
});

/**
 * HARD RULE: no test ever sends a real request to /agent/answer (it would be a model call). Every browser context
 * gets this catch-all: a request to /agent/answer that no test mock answered is aborted and fails the test.
 * (A page route of a test, page.route, takes precedence over this context route.)
 */
const unmockedAnswers: string[] = [];
async function guardAgentAnswer(ctx: BrowserContext) {
  await ctx.route("**/agent/answer", async (route) => {
    unmockedAnswers.push(
      `${route.request().method()} ${route.request().url()}`,
    );
    await route.abort("blockedbyclient");
  });
}
test.beforeEach(async ({ context }) => {
  unmockedAnswers.length = 0;
  await guardAgentAnswer(context);
});
test.afterEach(() => {
  expect(unmockedAnswers, "requests to /agent/answer without a mock").toEqual(
    [],
  );
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
    await guardAgentAnswer(ctx);
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

  test("3b. the site's own favicon: /favicon.ico (16 and 32 px) and /favicon.svg are served and linked", async ({
    page,
  }) => {
    const ico = await page.request.get("/favicon.ico");
    expect(ico.status()).toBe(200);
    const b = await ico.body();
    expect([...b.subarray(0, 6)]).toEqual([0, 0, 1, 0, 2, 0]); // an icon with two images
    const svg = await page.request.get("/favicon.svg");
    expect(svg.status()).toBe(200);
    expect(await svg.text()).toMatch(/^<svg /);
    await page.goto("/");
    expect(
      await page
        .locator('link[rel="icon"]')
        .evaluateAll((ls) => ls.map((l) => l.getAttribute("href"))),
    ).toEqual(["/favicon.ico", "/favicon.svg"]);
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
    // The run kind as the API records it: "rebuild of <run ID>, no source changes"; nothing where none.
    if (summary.run.run_kind === "rebuild")
      await expect(page.getByTestId("run-kind")).toHaveText(
        `Run kind: rebuild of ${summary.run.rebuild_of}${summary.run.source_changes === "none" ? ", no source changes" : ""}`,
      );
    else if (summary.run.run_kind)
      await expect(page.getByTestId("run-kind")).toHaveText(
        `Run kind: ${summary.run.run_kind}`,
      );
    else await expect(page.getByTestId("run-kind")).toHaveCount(0);
    // Every history row's kind cell: the API's run_kind, empty where the row has none.
    const historyRows = page.getByTestId("run-history").locator("tbody tr");
    await expect(historyRows).toHaveCount(summary.history.length);
    expect(
      await historyRows.evaluateAll((trs) =>
        trs.map((tr) => [
          tr.querySelectorAll("td")[0]!.textContent,
          tr.querySelectorAll("td")[1]!.textContent,
        ]),
      ),
    ).toEqual(
      summary.history.map((h: { run_id: string; run_kind?: string | null }) => [
        h.run_id,
        h.run_kind ?? "",
      ]),
    );
    // The delta vs the previous run: parcels added/removed, and the permit and permit-to-parcel link counts' net
    // change from the previous run's history row (delta.previous_run_id), where both runs recorded them.
    await expect(page.getByTestId("delta-parcels")).toHaveText(
      `+${fmt(summary.run.delta.added)} / −${fmt(summary.run.delta.removed)} parcels`,
    );
    type PermitCounts = { permits?: number; permit_parcels?: number };
    const prevCounts = (
      summary.history as Array<{
        run_id: string;
        row_counts?: { permits?: { parquet?: PermitCounts } };
      }>
    ).find((h) => h.run_id === summary.run.delta.previous_run_id)?.row_counts
      ?.permits?.parquet;
    const curCounts = summary.run.row_counts.permits?.parquet as
      PermitCounts | undefined;
    for (const [key, testId, label] of [
      ["permits", "delta-permits", "permits"],
      ["permit_parcels", "delta-permit-parcels", "permit-to-parcel links"],
    ] as const) {
      const a = prevCounts?.[key];
      const b = curCounts?.[key];
      if (typeof a === "number" && typeof b === "number") {
        const d = b - a;
        await expect(page.getByTestId(testId)).toHaveText(
          `${label}: net ${d > 0 ? "+" : d < 0 ? "−" : ""}${fmt(Math.abs(d))} (${fmt(a)} → ${fmt(b)})`,
        );
      } else await expect(page.getByTestId(testId)).toHaveCount(0);
    }
    // The Contractor rows card states the contractor source's window from explorer.sources.
    const contractorWindow = byKind.get("contractor")!.coverage;
    if (summary.run.row_counts.permits && contractorWindow)
      await expect(page.getByTestId("contractor-window")).toHaveText(
        windowText(byKind.get("contractor")!),
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
      await expect(row.getByTestId("source-coverage")).toHaveText(
        windowText(s),
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
    // Each source's pages from the selector, 100 at a time through explorer.sourcePages: the rows exactly as the
    // API serves them, then (for a source with more than 100 pages: the roll) the next 100 after Next.
    const PAGE_FILE: Record<SourceKind, RegExp> = {
      parcel: /^(page-\d{4}\.json|pages\/page-\d{5}\.json\.gz)$/,
      permit: /^pages\/[a-z0-9]{4}-[a-z0-9]{4}_p\d{3}\.json\.gz$/,
      contractor: /^pages\/[a-z0-9]{4}-[a-z0-9]{4}_p\d{3}\.json\.gz$/,
    };
    const rows = page.getByTestId("pages").locator("tbody tr");
    // Every row's cells in one browser call (100 rows; too many for a round trip each).
    const shownCells = () =>
      rows.evaluateAll((trs) =>
        trs.map((tr) =>
          [...tr.querySelectorAll("td")].map((td) => td.textContent ?? ""),
        ),
      );
    const asCells = (r: SourcePages) =>
      r.items.map((p) => [
        p.source_page_file,
        String(p.record_count),
        p.source_retrieved_at,
        p.source_request_url,
        p.source_page_sha256,
        p.source_kind,
      ]);
    const checkCells = (s: SourceRow, cells: string[][]) => {
      for (const c of cells) {
        expect(c[5]).toBe(s.source_kind);
        expect(c[0]).toMatch(PAGE_FILE[s.source_kind]);
        expect(c[2]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        // The exact request: the source's own query URL (the roll's ArcGIS query, or one of the LADBS datasets).
        if (s.source_kind === "parcel") {
          expect(c[3]).toMatch(/^https:\/\/services\.arcgis\.com\/.+\/query\?/);
          expect(c[3]!.startsWith(`${s.query_url}?`)).toBe(true);
        } else {
          expect(c[3]).toMatch(
            /^https:\/\/data\.lacity\.org\/resource\/[a-z0-9]{4}-[a-z0-9]{4}\.json\?/,
          );
          expect(s.query_urls!.some((u) => c[3]!.startsWith(`${u}?`))).toBe(
            true,
          );
        }
        expect(c[4]).toMatch(/^[0-9a-f]{64}$/);
      }
    };
    for (const s of sources.sources) {
      const first = (await apiGet("explorer.sourcePages", {
        source_name: s.source_name,
        offset: 0,
        limit: 100,
      })) as SourcePages;
      expect(first.total).toBe(s.page_count);
      await page.getByTestId("pages-source").selectOption(s.source_name);
      await expect(page.getByTestId("pages")).toHaveAttribute(
        "data-kind",
        s.source_kind,
      );
      await expect(rows).toHaveCount(first.items.length);
      await expect(rows.first().locator("td").first()).toHaveText(
        first.items[0]!.source_page_file,
      );
      await expect(page.getByTestId("pages-total")).toHaveText(
        `${fmt(first.total)} pages · 1–${fmt(first.items.length)}`,
      );
      const cells = await shownCells();
      expect(cells).toEqual(asCells(first));
      checkCells(s, cells);
      if (first.next_offset === null) {
        await expect(page.getByTestId("pages-next")).toBeDisabled();
        continue;
      }
      const second = (await apiGet("explorer.sourcePages", {
        source_name: s.source_name,
        offset: first.next_offset,
        limit: 100,
      })) as SourcePages;
      await page.getByTestId("pages-next").click();
      await expect(rows.first().locator("td").first()).toHaveText(
        second.items[0]!.source_page_file,
      );
      const cells2 = await shownCells();
      expect(cells2).toEqual(asCells(second));
      checkCells(s, cells2);
    }

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
      if (s.source_kind === "contractor") {
        await expect(page.getByTestId("records-attribution")).toHaveText(
          contractorNoteText(s),
        );
        // The first row's identity: license key, canonical name and variant count, as the API serves them.
        const first = expected.items[0];
        const cells = await page
          .getByTestId("records")
          .locator("tbody tr")
          .first()
          .locator("td")
          .allInnerTexts();
        expect(cells.slice(6, 9)).toEqual([
          cell(first.contractor_identity_key),
          cell(first.canonical_business_name),
          cell(first.name_variant_count),
        ]);
      }
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
    // The ownership filter: off by default; on, "both" preselected; each basis's count, texts and the first
    // row's land base year equal parcels.search with that basis.
    const ownershipOn = page.getByRole("checkbox", {
      name: /Owner unchanged for 10 years or more/,
    });
    await expect(ownershipOn).not.toBeChecked();
    await page
      .getByRole("spinbutton", { name: "Roof older than (years)" })
      .fill("15");
    await ownershipOn.check();
    await expect(
      page.locator('input[name="ownership-basis"]:checked'),
    ).toHaveValue("both");
    const bases: OwnershipBasis[] = ["both", "recording", "base_year"];
    const weaknesses: string[] = [];
    for (const basis of bases) {
      const expected = await apiGet("parcels.search", {
        ...VN,
        radius_miles: 5,
        threshold_years: 15,
        ownership_basis: basis,
      });
      expect(expected.ownership.basis).toBe(basis);
      weaknesses.push(`Weakness: ${expected.ownership.weakness}`);
      await page
        .locator(`input[name="ownership-basis"][value="${basis}"]`)
        .check();
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page.getByTestId("ownership-rule")).toHaveAttribute(
        "data-basis",
        basis,
      );
      await expect(page.getByTestId("radius-count")).toHaveText(
        fmt(expected.count),
      );
      await expect(page.getByTestId("ownership-rule")).toHaveText(
        `Ownership filter (${basis}): ${expected.ownership.text} Weakness: ${expected.ownership.weakness} ${expected.ownership.proxy_note}`,
      );
      await expect(page.getByTestId("ownership-proxy-note")).toHaveText(
        expected.ownership.proxy_note,
      );
      await expect(page.getByTestId("land-base-year").first()).toHaveText(
        cell(expected.items[0].land_base_year),
      );
    }
    // The three weakness texts shown with the selector are the API's.
    await expect(page.getByTestId("ownership-weakness")).toHaveText(weaknesses);
  });

  test("7b. radius form fields are text entries: each can be emptied and retyped; an empty or invalid field gives a message and sends nothing; the search sends what was typed and the count equals the API", async ({
    page,
  }) => {
    const sent = trpcInputs(page, "parcels.search");
    await page.goto("/");
    await page.getByRole("tab", { name: "Radius query" }).click();
    const search = page.getByRole("button", { name: "Search" });
    const error = page.getByTestId("radius-error");
    const lat = page.getByRole("textbox", { name: "Latitude" });
    const lon = page.getByRole("textbox", { name: "Longitude" });
    const radius = page.getByRole("spinbutton", { name: "Radius (miles)" });
    const years = page.getByRole("spinbutton", {
      name: "Roof older than (years)",
    });
    // Each field emptied: a plain message on Search, nothing sent.
    for (const [field, message] of [
      [lat, "Latitude is empty"],
      [lon, "Longitude is empty"],
      [radius, "Radius (miles) is empty"],
      [years, "Roof older than (years) is empty"],
    ] as const) {
      const before = await field.inputValue();
      await retype(field, "");
      await search.click();
      await expect(error).toContainText(message);
      await field.fill(before);
    }
    // Text the browser cannot read as a number (it shows it, but reports no value), and a value out of
    // range: a message, nothing sent.
    await retype(radius, "");
    await radius.pressSequentially("1e");
    await search.click();
    await expect(error).toHaveText(
      "Radius (miles) must be a number from 0.1 to 10.",
    );
    await retype(years, "200");
    await search.click();
    await expect(error).toContainText(
      "Roof older than (years) must be a whole number from 1 to 120.",
    );
    expect(sent).toEqual([]);
    // Retyped (not the default center): exactly what was typed is shown and sent.
    const typed = {
      lat: 34.199,
      lon: -118.487,
      radius_miles: 1,
      threshold_years: 20,
    };
    await retype(lat, "34.199");
    await retype(lon, "-118.487");
    await retype(radius, "1");
    await retype(years, "20");
    const expected = await apiGet("parcels.search", typed);
    await search.click();
    await expect(page.getByTestId("radius-count")).toHaveText(
      fmt(expected.count),
    );
    await expect(error).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ...typed, offset: 0 });
    // The arrows step whole miles (from a typed decimal too) and whole years.
    await radius.press("ArrowUp");
    await expect(radius).toHaveValue("2");
    await retype(radius, "0.5");
    await radius.press("ArrowUp");
    await expect(radius).toHaveValue("1");
    await years.press("ArrowDown");
    await expect(years).toHaveValue("19");
  });

  test("8. future features are disabled placeholders", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Coming next" }).click();
    const cards = page.getByTestId("placeholder");
    // The agent and MCP are tabs of their own now: 6 placeholders remain.
    await expect(cards).toHaveCount(6);
    for (const c of await cards.all()) {
      await expect(c).toHaveAttribute("aria-disabled", "true");
      await expect(c.getByRole("button")).toBeDisabled();
    }
    // Permits are delivered: no card says they are coming, and the long-open view is a tab of its own.
    for (const t of await cards.allInnerTexts())
      expect(t).not.toMatch(
        /not harvested|LADBS later|Agent query|MCP interface/i,
      );
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
        // Each row's identity as the API serves it; no canonical name where the license has none.
        for (const [k, id] of [
          ["contractor_identity_key", "identity-key"],
          ["canonical_business_name", "canonical-name"],
          ["name_variant_count", "name-variants"],
        ] as const)
          await expect(page.getByTestId(id)).toHaveText(
            contractors.map((c: Record<string, unknown>) => cell(c[k])),
          );
        const contractorSrc = sources.sources.find(
          (x) => x.source_kind === "contractor",
        )!;
        await expect(page.getByText(/^Contains data from /).first()).toHaveText(
          contractorNoteText(contractorSrc),
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

  test("9b. long-open form fields are text entries, including the maximum-days field: emptied and retyped, the search sends what was typed and the count equals the API; an empty minimum or a maximum below it sends nothing", async ({
    page,
  }) => {
    const sent = trpcInputs(page, "permits.longOpen");
    await page.goto("/");
    await page.getByRole("tab", { name: "Long-open permits" }).click();
    const find = page.getByRole("button", { name: "Find long-open permits" });
    const error = page.getByTestId("long-open-error");
    const min = page.getByRole("spinbutton", { name: "Open at least (days)" });
    const max = page.getByRole("spinbutton", {
      name: "Open at most (days, optional)",
    });
    await expect(max).toHaveValue("");
    await retype(min, "");
    await find.click();
    await expect(error).toHaveText(
      "Open at least (days) is empty: enter a whole number from 0 to 36,525.",
    );
    await retype(min, "3000");
    await retype(max, "100");
    await find.click();
    await expect(error).toHaveText(
      "Open at most (100 days) is below open at least (3,000 days): set a larger maximum or clear it.",
    );
    expect(sent).toEqual([]);
    // Not the default center: what was typed is sent.
    for (const [name, text] of [
      ["Latitude", "34.199"],
      ["Longitude", "-118.487"],
    ] as const)
      await retype(page.getByRole("textbox", { name }), text);
    await retype(page.getByRole("spinbutton", { name: "Radius (miles)" }), "2");
    await retype(max, "5000");
    const typed = {
      lat: 34.199,
      lon: -118.487,
      radius_miles: 2,
      min_open_days: 3000,
      max_open_days: 5000,
    };
    const expected = await apiGet("permits.longOpen", typed);
    await find.click();
    await expect(page.getByTestId("long-open-count")).toHaveText(
      fmt(expected.count),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject(typed);
    // The maximum emptied again: no maximum is sent.
    await retype(max, "");
    await find.click();
    await expect.poll(() => sent.length).toBe(2);
    expect("max_open_days" in sent[1]!).toBe(false);
    // The arrows step whole days.
    await min.press("ArrowUp");
    await expect(min).toHaveValue("3001");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Ask the agent (POST /agent/answer always mocked; the panel may call the real /agent/warm and the data API) and
// the MCP tab.

type Reply = AnswerResponse | { httpStatus: number; body: unknown };
/** CORS headers for the mocked agent API: the Explorer origin only, as the agent stack's CORS does. */
const AGENT_CORS = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

/**
 * Mocks POST /agent/answer with the given replies in order (page route, ahead of the catch-all) and records each
 * request body; a request with no reply left is aborted and fails the test.
 */
async function mockAnswers(page: Page, replies: Reply[], log?: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  await page.route("**/agent/answer", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: AGENT_CORS });
    const next = replies.shift();
    if (!next) {
      unmockedAnswers.push(
        `${req.method()} ${req.url()} (no mocked reply left)`,
      );
      return route.abort("blockedbyclient");
    }
    bodies.push(req.postDataJSON() as Record<string, unknown>);
    log?.push("answer");
    const [status, body] =
      "httpStatus" in next ? [next.httpStatus, next.body] : [200, next];
    await route.fulfill({
      status,
      headers: { ...AGENT_CORS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  });
  return bodies;
}

/**
 * Records the warm-up traffic in order: "warm:req", "warm:res", "data:req", "data:res" (explorer.sources sent
 * unbatched; the tabs' own explorer.sources call is batched and not counted).
 */
function watchWarmup(page: Page, log: string[]) {
  const kind = (url: string) => {
    const u = new URL(url);
    return /\/agent\/warm$/.test(u.pathname)
      ? "warm"
      : /\/trpc\/explorer\.sources$/.test(u.pathname) &&
          !u.searchParams.has("batch")
        ? "data"
        : null;
  };
  page.on("request", (r) => {
    const k = kind(r.url());
    if (k && r.method() === "GET") log.push(`${k}:req`);
  });
  page.on("response", (r) => {
    const k = kind(r.url());
    if (k && r.request().method() === "GET") log.push(`${k}:res`);
  });
}

const ask = async (page: Page, q: string) => {
  await page.getByRole("textbox", { name: /question/i }).fill(q);
  await page.getByTestId("agent-send").click();
};
const count = (log: string[], e: string) => log.filter((x) => x === e).length;

test.describe("Ask the agent (answers mocked) and MCP", () => {
  test.use({ httpCredentials: CREDS });

  test("10. config.json names the agent API; the tab shows; opening it warms the agent and two unbatched explorer.sources requests at once; the notice is shown", async ({
    page,
  }) => {
    const cfg = (await (
      await page.request.get(`${BASE_URL}/config.json`)
    ).json()) as Cfg & {
      agentApiUrl?: string;
    };
    expect(cfg.agentApiUrl).toMatch(
      /^https:\/\/[a-z0-9]+\.execute-api\.eu-north-1\.amazonaws\.com$/,
    );
    const log: string[] = [];
    watchWarmup(page, log);
    await page.goto("/");
    await page.getByRole("tab", { name: "Ask the agent" }).click();
    // 15 s: the second explorer.sources request starts a second data API environment, 5.4–6.2 s cold (6.2 s on 16 Nov).
    await expect
      .poll(() => [count(log, "warm:res"), count(log, "data:res")], {
        timeout: 15_000,
      })
      .toEqual([1, 2]);
    // Both data requests went out before either answered (sent at once).
    const data = log.filter((x) => x.startsWith("data:"));
    expect(data.slice(0, 2)).toEqual(["data:req", "data:req"]);
    await expect(page.getByTestId("agent-notice")).toHaveText(
      "Your questions in this conversation, the center when you enter one, and the data the agent reads are sent to Anthropic to answer them.",
    );
    await expect(page.getByTestId("agent-send")).toBeEnabled();
  });

  test("11. an answered reply: markdown text, How I got this collapsed, Sources by kind, Gaps with Always true, unverified ID flagged", async ({
    page,
  }) => {
    const bodies = await mockAnswers(page, [ANSWERED]);
    await page.goto("/");
    await page.getByRole("tab", { name: "Ask the agent" }).click();
    await ask(page, QUESTION_1);
    const a = page.getByTestId("agent-answer");
    await expect(a).toHaveAttribute("data-status", "answered");
    expect(bodies).toEqual([{ question: QUESTION_1 }]);
    await expect(
      a.getByTestId("agent-text").locator("strong").first(),
    ).toHaveText(
      "115,373 parcels within 5 miles of Van Nuys have roofs older than 15 years.",
    );
    await expect(a.getByTestId("agent-text").locator("tbody tr")).toHaveCount(
      2,
    );
    await expect(a.getByTestId("unverified-id")).toHaveText([
      "2218099999 (unverified)",
    ]);
    const how = a.getByTestId("agent-how");
    await expect(how).not.toHaveAttribute("open", /.*/);
    await expect(how.getByText(ANSWERED.reasoning)).toBeHidden();
    await how.locator("summary").click();
    await expect(how.getByText(ANSWERED.reasoning)).toBeVisible();
    // Sources: closed, the count in the summary; opened, by kind with dates as YYYY-MM-DD.
    const sourcesBox = a.getByTestId("agent-sources-details");
    await expect(sourcesBox).not.toHaveAttribute("open", /.*/);
    await expect(sourcesBox.locator("summary")).toHaveText(
      `Sources (${ANSWERED.records.length})`,
    );
    await expect(a.getByTestId("agent-sources").first()).toBeHidden();
    await sourcesBox.locator("summary").click();
    await expect(a.getByTestId("agent-sources").first()).toBeVisible();
    await expect(a.getByTestId("agent-sources")).toHaveCount(3);
    for (const r of ANSWERED.records) {
      const row = a.locator(
        `[data-testid="agent-sources"][data-kind="${r.kind}"] tbody tr`,
      );
      await expect(row.locator("td")).toHaveText([
        r.id,
        r.source_name,
        r.license ?? "—",
        r.attribution ?? "—",
        dateOnly(r.collected_at),
      ]);
      await expect(row.locator("td").last()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Gaps: collapsible and open.
    await expect(a.getByTestId("agent-gaps-details")).toHaveAttribute(
      "open",
      "",
    );
    await expect(a.getByTestId("agent-gaps").locator("li")).toHaveText(
      ANSWERED.gaps.slice(STANDING_GAPS.length),
    );
    await expect(a.getByTestId("agent-standing-gaps").locator("li")).toHaveText(
      STANDING_GAPS,
    );
    await expect(page.getByRole("textbox", { name: /question/i })).toHaveValue(
      "",
    );
  });

  test("11b. the center fields are text entries: emptied and retyped, the question sends what was typed; an invalid center is refused in the panel and nothing is sent", async ({
    page,
  }) => {
    const bodies = await mockAnswers(page, [ANSWERED]);
    await page.goto("/");
    await page.getByRole("tab", { name: "Ask the agent" }).click();
    const lat = page.getByRole("textbox", { name: "Latitude" });
    const lon = page.getByRole("textbox", { name: "Longitude" });
    await retype(lat, "34.2");
    await retype(lon, "1e2");
    await ask(page, QUESTION_1);
    await expect(page.getByTestId("agent-message")).toHaveText(
      "Longitude must be a number from -180 to 180.",
    );
    expect(bodies).toEqual([]);
    await retype(lat, "34.20155");
    await retype(lon, "-118.45361");
    await ask(page, QUESTION_1);
    await expect(page.getByTestId("agent-answer")).toHaveAttribute(
      "data-status",
      "answered",
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.center).toEqual({
      lat: 34.20155,
      lon: -118.45361,
      label: "coordinates entered",
    });
  });

  test("12. a refused reply is a normal message with its gaps; a stopped reply is a plain message and keeps the question", async ({
    page,
  }) => {
    await mockAnswers(page, [
      REFUSED,
      STOPPED,
      { httpStatus: 503, body: { error: "agent not configured" } },
    ]);
    await page.goto("/");
    await page.getByRole("tab", { name: "Ask the agent" }).click();
    await ask(page, "Who owns parcel 2218022020?");
    const a = page.getByTestId("agent-answer");
    await expect(a).toHaveAttribute("data-status", "refused");
    await expect(a.getByTestId("agent-text")).toHaveText(REFUSED.text);
    await expect(page.getByTestId("agent-message")).toHaveCount(0);
    await expect(a.getByTestId("agent-standing-gaps").locator("li")).toHaveText(
      STANDING_GAPS,
    );

    await ask(page, QUESTION_1);
    await expect(page.getByTestId("agent-message")).toContainText(
      "The answer stopped before it was complete (time_budget)",
    );
    await expect(page.getByRole("textbox", { name: /question/i })).toHaveValue(
      QUESTION_1,
    );
    await expect(page.getByTestId("agent-answer")).toHaveCount(1);

    await page.getByTestId("agent-send").click();
    await expect(page.getByTestId("agent-message")).toContainText(
      "not available right now (HTTP 503: agent not configured)",
    );
    await expect(page.getByRole("textbox", { name: /question/i })).toHaveValue(
      QUESTION_1,
    );
  });

  test("13. a follow-up sends the history, session and signature; New conversation clears them and the center fields", async ({
    page,
  }) => {
    const bodies = await mockAnswers(page, [ANSWERED, FOLLOW_UP, ANSWERED]);
    await page.goto("/");
    await page.getByRole("tab", { name: "Ask the agent" }).click();
    await ask(page, QUESTION_1);
    await expect(page.getByTestId("agent-turn")).toHaveCount(1);
    await ask(page, QUESTION_2);
    await expect(page.getByTestId("agent-turn")).toHaveCount(2);
    expect(bodies[1]).toEqual({
      question: QUESTION_2,
      history: ANSWERED.history,
      session: ANSWERED.session,
      signature: ANSWERED.signature,
    });
    // Nothing of the conversation is stored in the browser.
    expect(
      await page.evaluate(() => [localStorage.length, sessionStorage.length]),
    ).toEqual([0, 0]);
    // New conversation also clears the center fields (filled here, never sent).
    const lat = page.getByRole("textbox", { name: "Latitude" });
    const lon = page.getByRole("textbox", { name: "Longitude" });
    await lat.fill("34.2");
    await lon.fill("-118.45");
    await page.getByTestId("agent-new").click();
    await expect(page.getByTestId("agent-turn")).toHaveCount(0);
    await expect(lat).toHaveValue("");
    await expect(lon).toHaveValue("");
    await ask(page, QUESTION_1);
    await expect(page.getByTestId("agent-turn")).toHaveCount(1);
    expect(bodies[2]).toEqual({ question: QUESTION_1 });
  });

  test("14. a question asked before the warm-up answered is held with a waking-up status and sent when both answer", async ({
    page,
  }) => {
    const log: string[] = [];
    watchWarmup(page, log);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    // The real /agent/warm, held back until the test releases it.
    await page.route("**/agent/warm", async (route) => {
      await released;
      await route.continue();
    });
    const bodies = await mockAnswers(page, [ANSWERED], log);
    await page.goto("/");
    await page.getByRole("tab", { name: "Ask the agent" }).click();
    await ask(page, QUESTION_1);
    await expect(page.getByTestId("agent-status")).toHaveAttribute(
      "data-state",
      "waking",
    );
    await expect(page.getByTestId("agent-status")).toContainText("Waking up");
    // A held question is pending: Send and New conversation are disabled.
    await expect(page.getByTestId("agent-send")).toBeDisabled();
    await expect(page.getByTestId("agent-new")).toBeDisabled();
    await expect.poll(() => count(log, "data:res")).toBe(2);
    expect(bodies).toEqual([]);
    release();
    await expect(page.getByTestId("agent-answer")).toHaveAttribute(
      "data-status",
      "answered",
    );
    // The answer went out only after the warm-up's agent and data responses.
    expect(log.indexOf("answer")).toBeGreaterThan(log.lastIndexOf("warm:res"));
    expect(log.indexOf("answer")).toBeGreaterThan(log.lastIndexOf("data:res"));
    await expect(page.getByTestId("agent-send")).toBeEnabled();
    await expect(page.getByTestId("agent-new")).toBeEnabled();
  });

  test("14b. Send and New conversation are disabled from the click until the answer or an error, and enabled when nothing is pending", async ({
    page,
  }) => {
    // The answer is held back until the test releases it (mocked: never a real /agent/answer).
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const bodies: Array<Record<string, unknown>> = [];
    const replies: Reply[] = [
      ANSWERED,
      { httpStatus: 503, body: { error: "agent not configured" } },
    ];
    await page.route("**/agent/answer", async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: AGENT_CORS });
      bodies.push(req.postDataJSON() as Record<string, unknown>);
      const next = replies.shift();
      if (!next) {
        unmockedAnswers.push(`${req.method()} ${req.url()} (no reply left)`);
        return route.abort("blockedbyclient");
      }
      if (bodies.length === 1) await released;
      const [status, body] =
        "httpStatus" in next ? [next.httpStatus, next.body] : [200, next];
      await route.fulfill({
        status,
        headers: { ...AGENT_CORS, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    });
    await page.goto("/");
    await page.getByRole("tab", { name: "Ask the agent" }).click();
    const sendBtn = page.getByTestId("agent-send");
    const newBtn = page.getByTestId("agent-new");
    await expect(sendBtn).toBeEnabled();
    await ask(page, QUESTION_1);
    await expect(sendBtn).toBeDisabled();
    await expect(newBtn).toBeDisabled();
    // A second question typed meanwhile stays in the box; nothing more is sent.
    await page.getByRole("textbox", { name: /question/i }).fill(QUESTION_2);
    await expect.poll(() => bodies.length).toBe(1);
    release();
    await expect(page.getByTestId("agent-answer")).toHaveCount(1);
    await expect(sendBtn).toBeEnabled();
    await expect(newBtn).toBeEnabled();
    await expect(page.getByRole("textbox", { name: /question/i })).toHaveValue(
      QUESTION_2,
    );
    // An error ends the pending question too.
    await sendBtn.click();
    await expect(page.getByTestId("agent-message")).toContainText(
      "not available right now (HTTP 503: agent not configured)",
    );
    await expect(sendBtn).toBeEnabled();
    expect(bodies).toHaveLength(2);
  });

  test("15. re-warm: more than 4 minutes after the last data API response, the warm-up runs again before the question", async ({
    page,
  }) => {
    await page.clock.install();
    const log: string[] = [];
    watchWarmup(page, log);
    await mockAnswers(page, [ANSWERED, FOLLOW_UP], log);
    await page.goto("/");
    await page.getByRole("tab", { name: "Ask the agent" }).click();
    await expect.poll(() => count(log, "data:res")).toBe(2);
    await ask(page, QUESTION_1);
    await expect(page.getByTestId("agent-turn")).toHaveCount(1);
    expect(count(log, "warm:req")).toBe(1);
    await page.clock.fastForward("04:01");
    await ask(page, QUESTION_2);
    await expect(page.getByTestId("agent-turn")).toHaveCount(2);
    expect(count(log, "warm:req")).toBe(2);
    expect(count(log, "data:req")).toBe(4);
    // The second question went out after the second warm-up had answered.
    expect(log.lastIndexOf("answer")).toBeGreaterThan(
      log.lastIndexOf("data:res"),
    );
    expect(log.lastIndexOf("answer")).toBeGreaterThan(
      log.lastIndexOf("warm:res"),
    );
  });

  test("15b. the page shows the Explorer's commit and the agent's commit as GET /agent/warm reports it", async ({
    page,
  }) => {
    const warmBodies: unknown[] = [];
    page.on("response", async (r) => {
      if (/\/agent\/warm$/.test(new URL(r.url()).pathname) && r.ok())
        warmBodies.push(await r.json());
    });
    await page.goto("/");
    // The Explorer's own commit, fixed at build: a 7-character hash (never "-dirty" or "unbundled" when hosted).
    await expect(page.getByTestId("explorer-commit")).toHaveText(
      /^[0-9a-f]{7}$/,
    );
    await expect(page.getByTestId("agent-commit")).toHaveText(
      "not checked yet (the Ask the agent tab checks it)",
    );
    await page.getByRole("tab", { name: "Ask the agent" }).click();
    await expect.poll(() => warmBodies.length).toBe(1);
    const warm = warmBodies[0] as { status: string; commit?: string };
    expect(warm.status).toBe("warm");
    await expect(page.getByTestId("agent-commit")).toHaveText(
      warm.commit ?? "not reported",
    );
    // No data API commit on the page.
    await expect(page.getByTestId("commits")).not.toContainText(/data api/i);
  });

  test("15c. a Radius query row and a Long-open row open their record with its source: one parcels.detail request per click, from the keyboard too", async ({
    page,
  }) => {
    const sources = (await apiGet("explorer.sources")) as Sources;
    const roll = sources.sources.find((s) => s.source_kind === "parcel")!;
    const permitSrc = sources.sources.find((s) => s.source_kind === "permit")!;
    const details = trpcInputs(page, "parcels.detail");
    await page.goto("/");
    await page.getByRole("tab", { name: "Radius query" }).click();
    await page.getByRole("button", { name: "Search" }).click();
    const radiusRows = page.getByTestId("radius-row");
    await expect(radiusRows.first()).toBeVisible();
    const parcelId = (await radiusRows
      .first()
      .getAttribute("data-parcel")) as string;
    const detail = await apiGet("parcels.detail", { parcel_id: parcelId });
    // Keyboard: the row's ID is a button in the tab order; Enter opens the record.
    const open = page.getByRole("button", {
      name: `Open the record of parcel ${parcelId}`,
    });
    await open.focus();
    await page.keyboard.press("Enter");
    const view = page.getByTestId("record-view");
    await expect(view).toHaveAttribute("data-record", parcelId);
    await expect(view.getByTestId("record-parcel")).toBeVisible();
    await expect.poll(() => details.length).toBe(1);
    expect(details[0]).toEqual({ parcel_id: parcelId });
    const dd = (testId: string, label: string) =>
      view
        .getByTestId(testId)
        .locator("div")
        .filter({ has: page.locator(`dt:text-is("${label}")`) })
        .locator("dd");
    await expect(dd("record-parcel", "Parcel (AIN)")).toHaveText(parcelId);
    await expect(dd("record-parcel", "Address")).toHaveText(
      cell(detail.property.address),
    );
    await expect(dd("record-parcel", "Year built")).toHaveText(
      cell(detail.property.year_built),
    );
    await expect(dd("record-provenance", "Request URL")).toHaveText(
      detail.provenance.source_request_url,
    );
    await expect(dd("record-provenance", "Page sha256")).toHaveText(
      detail.provenance.source_page_sha256,
    );
    await expect(dd("record-parcel-source", "Source")).toHaveText(
      roll.source_name,
    );
    // Only fields the Explorer shows elsewhere: the labels, exactly.
    await expect(view.getByTestId("record-parcel").locator("dt")).toHaveText([
      "Parcel (AIN)",
      "Address",
      "Year built",
      "Effective roof year",
      "Basis",
      "Land base year",
      "Latitude",
      "Longitude",
    ]);
    // The same row again: no request; a click on another row: one.
    await open.click();
    await radiusRows.nth(1).locator("td").nth(3).click();
    await expect.poll(() => details.length).toBe(2);
    await page.getByTestId("record-close").click();
    await expect(view).toHaveCount(0);

    await page.getByRole("tab", { name: "Long-open permits" }).click();
    await page.getByRole("button", { name: "Find long-open permits" }).click();
    const longRows = page.getByTestId("long-open-row");
    await expect(longRows.first()).toBeVisible();
    const permit = (await longRows
      .first()
      .getAttribute("data-permit")) as string;
    // The contractors toggle opens no record.
    await longRows.first().getByTestId("contractors-toggle").click();
    await expect(page.getByTestId("record-view")).toHaveCount(0);
    await longRows.first().locator("td").nth(1).click();
    await expect(page.getByTestId("record-view")).toHaveAttribute(
      "data-record",
      permit,
    );
    await expect.poll(() => details.length).toBe(3);
    await expect(dd("record-permit", "Permit number")).toContainText(permit);
    await expect(dd("record-permit-source", "Source")).toHaveText(
      permitSrc.source_name,
    );
    await expect(dd("record-parcel-source", "Source")).toHaveText(
      roll.source_name,
    );
    expect(await page.getByTestId("record-view").innerText()).not.toMatch(
      /work_desc|description|owner/i,
    );
  });

  test("16. the MCP tab lists the server's tools and runs the radius example through the data API in the tool-result shape", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "MCP" }).click();
    await expect(page.getByTestId("mcp-tool-name")).toHaveText(TOOL_NAMES);
    await page.getByTestId("mcp-example-run").click();
    const pre = page.getByTestId("mcp-example-result");
    await expect(pre).toBeVisible({ timeout: 30_000 });
    const result = JSON.parse((await pre.textContent())!) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content.map((c) => c.type)).toEqual(["text"]);
    const body = JSON.parse(result.content[0]!.text) as {
      result: { count: number; items: unknown[] };
      records: unknown[];
      gaps: string[];
    };
    expect(Object.keys(body)).toEqual(["result", "records", "gaps"]);
    const a = EXAMPLE.arguments;
    const expected = await apiGet("parcels.search", {
      lat: a.lat,
      lon: a.lon,
      radius_miles: a.radius_miles,
      threshold_years: a.threshold_years,
      offset: 0,
      limit: 1,
    });
    expect(body.result.count).toBe(expected.count);
    expect(body.result.items.length).toBe(Math.min(a.limit, expected.count));
    expect(body.records.length).toBeGreaterThan(0);
    expect(body.gaps.length).toBeGreaterThan(0);
  });
});
