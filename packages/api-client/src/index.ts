/**
 * Shared typed client for the Oracle LA data API (tRPC v11 over HTTP API GET routes).
 * Every app uses this; none builds its own client. URLs are absolute (from config.json, which the
 * apps fetch from location.origin), so the https://user:pass@host/ URL form works.
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@oracle-la/api/router";

export type { AppRouter };
export type * from "@oracle-la/api/contract";

export interface ApiClientOptions {
  /** Absolute API base URL, e.g. https://<id>.execute-api.eu-north-1.amazonaws.com */
  apiUrl: string;
  /** Bearer token from config.json (served behind the Amplify password). */
  apiToken: string;
}

export function createApiClient({ apiUrl, apiToken }: ApiClientOptions) {
  const url = new URL("/trpc", apiUrl).toString();
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url,
        maxURLLength: 2000,
        headers: () => ({ authorization: `Bearer ${apiToken}` }),
      }),
    ],
  });
}
export type ApiClient = ReturnType<typeof createApiClient>;
