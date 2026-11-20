/** Suite inputs: base URL and basic-auth credentials from the environment only. */
export const BASE_URL = process.env.EXPLORER_URL!;
const username = process.env.EXPLORER_USER,
  password = process.env.EXPLORER_PASS;
if (!BASE_URL || !username || !password)
  throw new Error("set EXPLORER_URL, EXPLORER_USER and EXPLORER_PASS");
export const ORIGIN = new URL(BASE_URL).origin;
/** Basic-auth credentials, sent only to the Amplify origin (never to the API). */
export const CREDS = { username, password, origin: ORIGIN };
