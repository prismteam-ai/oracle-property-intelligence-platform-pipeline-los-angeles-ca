import { expect, test } from "vitest";
import { scanJson } from "../src/publish-scans.ts";

const local = { user: "someuser", host: "somehost" };
const scan = (v: unknown) =>
  scanJson("f.json", JSON.stringify(v), local).map(
    (h) => `${h.check} @ ${h.where}`,
  );

test("a counts-only document with URLs, dates and the allowed proxy names has no hits", () => {
  expect(
    scan({
      coverage: { owner_unchanged_10y_proxy_true: 5, with_coordinates: 2 },
      permits: { contractors: { owner_builder_rows: 3 } },
      reference_date: "2026-11-12",
      terms: "https://data.lacity.org/terms-of-use",
      url: "https://services.arcgis.com/x/query?where=SitusZIP5+IN+%2791405%27&resultOffset=1000&resultRecordCount=1000",
      sha256:
        "3f22ec65deba994ca34c0f5350da8b2692e2314049e19fab9761342f703ba895",
      tables: [
        {
          columns: [
            { name: "out_of_area_owner" },
            { name: "parcel_identifier" },
          ],
        },
      ],
      text: "Contractor rows exist only for permits issued 2013-01-02 to 2023-05-19.",
    }),
  ).toEqual([]);
});

test("personal-data column names are found as JSON keys and as schema column names", () => {
  expect(
    scan({
      owner_name: "x",
      a: { mailing_address: 1 },
      tables: [
        { columns: [{ name: "contact_phone" }, { name: "parcel_identifier" }] },
      ],
    }),
  ).toEqual([
    "personal-data column name @ $.owner_name",
    "personal-data column name @ $.a.mailing_address",
    "personal-data column name @ $.tables[0].columns[0].name",
  ]);
});

test("e-mail addresses and NANP phone numbers in values are found; the value is never reported", () => {
  const hits = scanJson(
    "f.json",
    JSON.stringify({
      a: "write to someone@example.com",
      b: ["call (213) 555-0100", "+1 213.555.0100", "213-555-0100"],
    }),
    local,
  );
  expect(hits.map((h) => `${h.check} @ ${h.where}`)).toEqual([
    "e-mail address @ $.a",
    "phone number @ $.b[0]",
    "phone number @ $.b[1]",
    "phone number @ $.b[2]",
  ]);
  expect(JSON.stringify(hits)).not.toMatch(/example\.com|555/);
});

test("home paths and the local user and host names are found", () => {
  expect(scan({ p: "/" + "home/alice/x" })).toEqual(["home path @ text"]);
  expect(scan({ p: "/Users/bob/x" })).toEqual(["home path @ text"]);
  expect(scan({ p: "see ~/" + "docs/x" })).toEqual(["home path @ text"]);
  expect(scan({ p: "C:\\Users\\carol\\x" })).toEqual(["home path @ text"]);
  expect(scan({ p: "built by SomeUser on somehost" })).toEqual([
    "local user name @ text",
    "local host name @ text",
  ]);
});
