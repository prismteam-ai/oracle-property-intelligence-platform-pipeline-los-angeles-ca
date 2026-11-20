/**
 * Shared typed client for the Oracle LA data API (tRPC v11 over HTTP API GET routes).
 * Every app uses this; none builds its own client. URLs are absolute (from config.json, which the
 * apps fetch from location.origin), so the https://user:pass@host/ URL form works.
 */
import { createTRPCClient, httpBatchLink, httpLink } from "@trpc/client";
import type { AppRouter } from "@oracle-la/api/router";

export type { AppRouter };
export type * from "@oracle-la/api/contract";

export interface ApiClientOptions {
  /** Absolute API base URL, e.g. https://<id>.execute-api.eu-north-1.amazonaws.com */
  apiUrl: string;
  /** Bearer token from config.json (served behind the Amplify password). */
  apiToken: string;
  /**
   * One HTTP request per procedure call instead of batching the calls made together (default true: batched).
   * The agent's data adapter turns batching off so each call is counted, timed and retried on its own.
   */
  batch?: boolean;
  /** The fetch every request goes through (default: the global fetch). */
  fetch?: Parameters<typeof httpLink>[0]["fetch"];
}

export function createApiClient({
  apiUrl,
  apiToken,
  batch = true,
  fetch,
}: ApiClientOptions) {
  const url = new URL("/trpc", apiUrl).toString();
  const headers = () => ({ authorization: `Bearer ${apiToken}` });
  return createTRPCClient<AppRouter>({
    links: [
      batch
        ? httpBatchLink({
            url,
            maxURLLength: 2000,
            headers,
            ...(fetch ? { fetch } : {}),
          })
        : httpLink({ url, headers, ...(fetch ? { fetch } : {}) }),
    ],
  });
}
export type ApiClient = ReturnType<typeof createApiClient>;
