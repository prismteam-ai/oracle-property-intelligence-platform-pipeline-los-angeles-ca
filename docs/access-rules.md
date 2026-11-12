# Access rules and known limits (data API)

How access to the hosted data API works, and where it stops. Each limit is known and accepted for this
assignment, with the code that causes it. The CRM's side (the token in the browser, the leads API and the
leads table) is in the CRM repository's `docs/access-rules.md`, which lists every limit of both
repositories.

## How access works

- Clients send `Authorization: Bearer <token>`. The token authorizer hashes the token and compares it, in
  constant time, with the sha256 stored per client in SSM under `/oracle-la/api/clients/<client>/token-sha256`
  (`apps/api/src/authorizer.ts:1-5`, `apps/api/cdk/lib/data-api-stack.ts:139-143`). Tokens are never stored or
  logged. A missing or wrong token gets 401 or 403.
- The clients are listed in `apps/api/cdk/clients.json`: today one client, `crm`. Their token hashes come
  from the gitignored `.secrets/api-clients.json`.
- The data bucket blocks public access and requires TLS (`data-api-stack.ts:55-57`). The API Lambda may only
  read objects under `runs/` (`data-api-stack.ts:106`). The API is read-only: no route writes.

## Known limits

1. **Any valid client may call every route.** The authorizer passes the matched client's name in its
   context, but the data API does not check it (`apps/api/src/authorizer.ts:4-5`). Only the CRM's leads API
   restricts by client.
2. **The `crm` token is long-lived and sits in the browser.** The CRM site serves it in its `config.json`,
   behind the site's basic auth (CRM `scripts/write-config.ts:55`). Anyone with the basic-auth credentials
   can read it and call this API until the token is rotated (a new token, its hash in
   `.secrets/api-clients.json`, and an OracleLaDataApi deploy).
3. **The authorizer caches its answer for 300 seconds** (`apps/api/cdk/lib/data-api-stack.ts:155`). A
   rotated or removed token keeps working for up to 5 minutes for a caller that used it just before.
4. **CORS is not access control.** It tells browsers which origins may read responses
   (`data-api-stack.ts:161`, from `apps/api/cdk/clients.json`). A request without an `Origin` header, from
   curl or a script, is served whenever the token is valid.
5. **The Explorer's basic-auth password would be in the template.** It goes in through
   `SecretValue.unsafePlainText` (`apps/explorer/cdk/lib/explorer-web-stack.ts:26`), so it sits in the
   synthesized CloudFormation template and in `cdk.out`. This avoids a Secrets Manager standing cost
   (decision D3). The Explorer is not deployed; the CRM site has the same limit.
