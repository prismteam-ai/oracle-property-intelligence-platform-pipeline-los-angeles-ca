# Access rules and known limits (data API)

How access to the hosted data API works, and where it stops. Each limit is known and accepted for this
assignment, with the code that causes it. The CRM's side (the token in the browser, the leads API and the
leads table) is in the CRM repository's `docs/access-rules.md`, which lists every limit of both
repositories.

## How access works

- Clients send `Authorization: Bearer <token>`. The token authorizer hashes the token and compares it, in
  constant time, with the sha256 stored per client in SSM under `/oracle-la/api/clients/<client>/token-sha256`
  (`apps/api/src/authorizer.ts` (`loadHashes`, `matchClient`), `apps/api/cdk/lib/data-api-stack.ts` (`DataApiStack`, parameters `TokenHash-<client>`)). Tokens are never stored or
  logged. A missing or wrong token gets 401 or 403.
- The clients are listed in `apps/api/cdk/clients.json`: `crm` and `explorer`. Each is a branch of the CRM's
  Amplify app (`main` and `explorer`), and its CORS origin is built at deploy time from the app ID in
  `/roofing-crm/web/app-id` (`apps/api/cdk/lib/clients.ts` (`clientOrigin`)). Their token hashes come from
  the gitignored `.secrets/api-clients.json`.
- The data bucket blocks public access and requires TLS (`data-api-stack.ts` (`DataApiStack`, bucket `Data`)). The API Lambda may only
  read objects under `runs/` (`data-api-stack.ts` (`DataApiStack`, `bucket.grantRead(apiFn, "runs/*")`)). The API is read-only: no route writes.

## Known limits

1. **Any valid client may call every route.** The authorizer passes the matched client's name in its
   context, but the data API does not check it (`apps/api/src/authorizer.ts` (`handler`, which passes `context.client`)). Only the CRM's leads API
   restricts by client.
2. **The `crm` and `explorer` tokens are long-lived and sit in the browser.** Each site serves its token in
   its `config.json`, behind that site's basic auth (CRM `scripts/write-config.ts` (`apiToken` in the
   `config.json` it writes); `scripts/write-explorer-config.ts` here). Anyone with a site's basic-auth
   credentials can read its token and call this API until the token is rotated (a new token, its hash in
   `.secrets/api-clients.json`, an OracleLaDataApi deploy, and the site's config and deploy again).
3. **The authorizer caches its answer for 300 seconds** (`apps/api/cdk/lib/data-api-stack.ts` (`DataApiStack`, `TokenAuthorizer` `resultsCacheTtl`)). A
   rotated or removed token keeps working for up to 5 minutes for a caller that used it just before.
4. **CORS is not access control.** It tells browsers which origins may read responses
   (`data-api-stack.ts` (`DataApiStack`, `HttpApi` `corsPreflight`), from `apps/api/cdk/clients.json`). A request without an `Origin` header, from
   curl or a script, is served whenever the token is valid.
5. **The Explorer's basic-auth password is in the template.** It goes in through
   `SecretValue.unsafePlainText` (`apps/explorer/cdk/lib/explorer-web-stack.ts` (`ExplorerWebStack`, `basicAuth`)), so it sits in the
   synthesized CloudFormation template and in `cdk.out`. This avoids a Secrets Manager standing cost.
   The CRM site has the same limit.
6. **The Explorer and the CRM share one Amplify app.** The Explorer is the `explorer` branch of the CRM's
   app `roofing-crm` (`apps/explorer/cdk/lib/explorer-web-stack.ts` (`ExplorerWebStack`); the account allows
   one Amplify app).
   - Each branch has its own basic-auth credentials, so neither site's password opens the other.
   - The app-level settings belong to the CRM's RoofingCrmWeb and apply to both sites: the single-page
     rewrite rule, basic auth (off at app level), the service role, and deleting the app, which deletes both
     branches.
   - Anyone who can deploy either stack can deploy a site to either branch: the Amplify asset-deployment
     provider in each stack may call `amplify:StartDeployment` on any app.
   - The Explorer's token is refused by the CRM's leads API, which accepts only the client `crm`, and the
     Explorer's origin is in neither the leads API's CORS nor the map key's Referer list. The Explorer's
     `config.json` has no leads API URL and no map key.
