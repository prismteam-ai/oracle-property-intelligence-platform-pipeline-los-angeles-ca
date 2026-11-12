import { defineConfig } from "@playwright/test";

/**
 * Runs against the hosted Amplify URL only. Inputs are ONLY environment variables:
 *   EXPLORER_URL  base URL of the hosted Explorer (https://main.<appId>.amplifyapp.com)
 *   EXPLORER_USER basic-auth username
 *   EXPLORER_PASS basic-auth password
 * No credentials in the global `use`: tests that need them set them with test.use / context options,
 * scoped to the Amplify origin. The API token is read from the hosted /config.json.
 */
const baseURL = process.env.EXPLORER_URL;
if (!baseURL) throw new Error("set EXPLORER_URL");
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL },
});
