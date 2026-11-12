import { afterEach, expect, test, vi } from "vitest";
// The shared client exactly as the apps use it (source import; packages/api-client itself is unchanged).
import { createApiClient } from "../../../packages/api-client/src/index.ts";
import { MAX_MATCH_IDS } from "../src/contract.ts";

// The longest values the API accepts: 17 significant digits for the doubles, a 10-character API ID in the
// execute-api host (eu-north-1), a 3-digit threshold and 10-digit parcel IDs.
const LONGEST = {
  lat: 34.123456789012344,
  lon: -118.12345678901235,
  radius_miles: 9.999999999999998,
  threshold_years: 120,
};
const API_URL = "https://abcdefghij.execute-api.eu-north-1.amazonaws.com";
/** HTTP API quota: "Total combined size of request line and header values: 10240 bytes" (AWS docs). */
const HTTP_API_REQUEST_LINE_AND_HEADERS = 10_240;

afterEach(() => vi.unstubAllGlobals());

/** The URL of the GET the shared client sends for one parcels.match call with n IDs. */
async function matchUrl(n: number): Promise<string> {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify([{ result: { data: { parcel_ids: [] } } }]),
      { headers: { "content-type": "application/json" } },
    );
  });
  const api = createApiClient({ apiUrl: API_URL, apiToken: "t" });
  await api.parcels.match.query({
    ...LONGEST,
    parcel_ids: Array.from({ length: n }, (_, i) => String(9_999_999_999 - i)),
  });
  expect(urls).toHaveLength(1);
  return urls[0]!;
}

test("a parcels.match GET with MAX_MATCH_IDS IDs and the longest filter fits the client and the HTTP API", async () => {
  const url = new URL(await matchUrl(MAX_MATCH_IDS));
  expect(url.pathname).toBe("/trpc/parcels.match");
  // The client refuses a single call longer than its maxURLLength (2,000); 80 IDs leave about 200 characters
  // for a longer API host.
  expect(url.href.length).toBeLessThanOrEqual(1800);
  // Request line "GET <path and query> HTTP/1.1" plus a generous 4 KB of headers stays under the quota.
  const requestLine = `GET ${url.pathname}${url.search} HTTP/1.1`;
  expect(requestLine.length + 4096).toBeLessThan(
    HTTP_API_REQUEST_LINE_AND_HEADERS,
  );
});

test("the client itself refuses a match call too long for one GET (so MAX_MATCH_IDS must stay below it)", async () => {
  await expect(matchUrl(100)).rejects.toThrow(/too big for a single dispatch/);
});
