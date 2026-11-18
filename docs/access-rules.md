# Access rules and known limits (data API and agent)

How access to the hosted data API and the hosted agent works, and where it stops. Each limit is known and accepted for this
assignment, with the code that causes it. The CRM's side (the token in the browser, the leads API and the
leads table) is in the CRM repository's `docs/access-rules.md`. The agent's caps and known limits are listed
in full only here.

## How access works

- Clients send `Authorization: Bearer <token>`. The token authorizer hashes the token and compares it, in
  constant time, with the sha256 stored per client in SSM under `/oracle-la/api/clients/<client>/token-sha256`
  (`apps/api/src/authorizer.ts` (`loadHashes`, `matchClient`), `apps/api/cdk/lib/data-api-stack.ts` (`DataApiStack`, parameters `TokenHash-<client>`)). Tokens are never stored or
  logged. A missing or wrong token gets 401 or 403.
- The clients are listed in `apps/api/cdk/clients.json`: `crm`, `explorer` and `mcp`. `crm` and `explorer`
  are branches of the CRM's Amplify app (`main` and `explorer`), and their CORS origins are built at deploy
  time from the app ID in `/roofing-crm/web/app-id` (`apps/api/cdk/lib/clients.ts` (`clientOrigin`)). `mcp`
  is the local MCP server (`apps/agent-mcp`), never a browser (`browser: false`), so it gets no CORS origin;
  it has its own token, which no site holds. The token hashes come from the gitignored
  `.secrets/api-clients.json`.
- Every route sits behind the same authorizer: `meta.info`, `explorer.runSummary`, `explorer.sources`,
  `explorer.sourcePages`, `explorer.records`, `parcels.search`, `parcels.points`, `parcels.match`,
  `parcels.detail`, `permits.longOpen`, `permits.forParcel` and `places.resolve` (`apps/api/src/routers/`).
  Every client token reads parcels, permits and contractor rows alike.
- What the permit routes serve: City of Los Angeles (LADBS) permits with their status, dates, open duration,
  roofing flags and join method, and their contractor rows: business name, license number, license type as
  printed, license class and its note, owner-builder flag, license expiration date, city and state, as LADBS
  publishes them, and each row's contractor identity: the identity key (the license number, trimmed), the
  canonical business name, the number of name variants and the identity's permit count
  (`apps/api/src/contract.ts` (`PermitContractor`, `ContractorIdentity`)). One identity is one license number,
  not verified against CSLB; where a license has no name, the canonical name is null and no name is shown,
  never a guessed one. Permit work descriptions are not served:
  the free text can hold people's names (`docs/los-angeles-county-findings.md` section 14c). No owner names, mailing
  addresses or contact fields exist in the source, so none are served.
- What the parcel routes add from the 12 Nov rebuild run on: the land base year on search items, and the ownership
  filter on `parcels.search`, `parcels.points` and `parcels.match` with its basis (`recording`, `base_year` or
  `both`), each with its text, its weakness and the note that all three are proxies from the County roll, not
  sales records (`apps/api/src/contract.ts` (`OWNERSHIP_BASIS`, `OWNERSHIP_PROXY_NOTE`)). At the Van Nuys test center (34.199, -118.487), on the served run
  `2026-11-17T00-55-12-521Z-b1f1fbb377948`, for roofs older than 15 years within 1 / 5 / 10 miles, the filter keeps
  1,968 / 51,571 / 138,822 parcels on the recording basis, 2,896 / 78,715 / 212,531 on the base-year basis and
  1,936 / 50,786 / 136,643 on both (counted on the run's Parquet files with the shared view contract,
  `packages/views`).
- `parcels.match` also takes the long-open window and says which of the given parcels have a long-open roofing
  permit. At the same center, 1 mile, on that run and on the 12 Nov rebuild run alike: 112 long-open roofing permits link to 215 parcels, 164 of which have roofs
  older than 15 years; those 164 are what the CRM's map and lead toggle mark.
- The data bucket blocks public access and requires TLS (`data-api-stack.ts` (`DataApiStack`, bucket `Data`)). The API Lambda may only
  read objects under `runs/` (`data-api-stack.ts` (`DataApiStack`, `bucket.grantRead(apiFn, "runs/*")`)). The API is read-only: no route writes.
- The IPFS publication is outside these rules: its files (a County roll extract, a 5-mile sample of it, and per
  run a coverage summary and an artifact manifest) are public and fetched by CID, with no token
  (`docs/los-angeles-county-findings.md` section 7). No permit or contractor row is in it.

## Known limits

1. **Any valid client may call every route.** The authorizer passes the matched client's name in its
   context, but the data API does not check it (`apps/api/src/authorizer.ts` (`handler`, which passes `context.client`)). The CRM's leads API
   (only `crm`) and the agent API (only `crm` and `explorer`) restrict by client.
2. **The `crm` and `explorer` tokens are long-lived and sit in the browser.** Each site serves its token in
   its `config.json`, behind that site's basic auth (CRM `scripts/write-config.ts` (`apiToken` in the
   `config.json` it writes); `scripts/write-explorer-config.ts` here). Anyone with a site's basic-auth
   credentials can read its token and call this API until the token is rotated (a new token, its hash in
   `.secrets/api-clients.json`, an OracleLaDataApi deploy, and the site's config and deploy again).
3. **Two caches delay a token change.** API Gateway caches the authorizer's answer for 300 seconds
   (`apps/api/cdk/lib/data-api-stack.ts` (`DataApiStack`, `TokenAuthorizer` `resultsCacheTtl`)), and the
   authorizer keeps the token hashes it read from SSM for 5 minutes (`apps/api/src/authorizer.ts` (`CACHE_MS`)). A
   rotated or removed token can keep working for up to about 10 minutes, and a new token can be refused for as long.
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
7. **The data API takes at most 10 requests a second, 5 at a time.** Its stage throttle is 10 requests a second
   with a burst of 20 (`apps/api/cdk/lib/data-api-stack.ts` (`DataApiStack`, the stage `throttle`)), and its
   function's reserved concurrency is 5. A request beyond either is refused, not queued (HTTP 429 or 503): on
   14 Nov 2026 the sixth of six simultaneous first requests got 503.

## The hosted agent (OracleLaAgentApi)

The agent answers questions about this data from the two sites' "Ask the agent" panels. It reads the data only
through the data API's routes, with the caller's own token, and cites the records it read.

### How access works

- **Same token, same authorizer.** `POST /agent/answer` and `GET /agent/warm` sit behind the data API's token
  authorizer (results cached 300 seconds). The agent accepts only the clients `crm` and `explorer` and answers
  403 to any other, the `mcp` client included (`apps/agent-api/cdk/lib/agent-api-stack.ts` (`AGENT_API_CLIENTS`);
  `apps/agent-api/src/handler.ts` (`createHandler`)). It forwards the caller's token to the data API, so it
  reads exactly what that client may read.
- **CORS** allows the two Amplify branches only, as for the data API (`AgentApiStack`, `HttpApi`
  `corsPreflight`).
- **What leaves AWS for Anthropic.** Each model call sends the conversation's questions, the center the panel
  gives (the pin or the fields typed in), from the CRM also the screen's radius and roof age threshold, and the
  data the agent's tools read. Both panels say so under the question box. The Explorer's reads "Your questions in
  this conversation, the center when you enter one, and the data the agent reads are sent to Anthropic to answer
  them." (`apps/explorer/src/AskAgent.tsx` (`NOTICE`)); the CRM's names "the map center, the radius, the roof age
  threshold" (CRM `apps/crm/src/AskAgent.tsx` (`NOTICE`)). Contractor business names go to the model as LADBS
  publishes them; some may be a person's own name used as a business name.
- **License expiration dates are not given to the model,** nor to the MCP server, which uses the same tools
  (`packages/agent/src/tools.ts` (`CONTRACTOR_FIELDS`)). The date is the one recorded with the permit, not the
  license's status today, and nothing is verified against CSLB; a hosted answer once read it as "had expired".
  The data API, the Explorer and the CRM still show it.
- **The conversation is held by the client, signed by the server.** The answer returns the history and a
  session with an HMAC-SHA256 signature made with the history signing secret; the panel sends them back
  unchanged with the next question, and an unsigned or altered history is refused with 400, so a client cannot
  plant tool results or earlier turns (`apps/agent-api/src/history.ts` (`signConversation`,
  `verifyConversation`)). A request body over 200 KB is refused with 413 before it is parsed
  (`MAX_BODY_BYTES`). The panels keep history, session and signature in the page's state while it is open:
  they are gone on reload, and nothing is written to browser storage.
- **The warm-up.** When a panel opens, it sends `GET /agent/warm` and two data API requests (`explorer.sources`)
  at once (`apps/explorer/src/warmup.ts` (`DATA_WARM_REQUESTS`); the CRM's `apps/crm/src/warmup.ts`). Each takes
  about 0.8 s when warm, so the two are in flight together and reach two data API environments, as the data API's
  log showed on 18 Nov 2026: the agent's function and two data API environments are warmed before the first
  question (two cold ones took 5.4 and 6.2 s at the function on 14 Nov; the Explorer's hosted test 10 waits 15 s
  for the warm-up). The Explorer's code comment still says one environment is kept warm; its code sends the same
  two requests as the CRM's. It is best effort and holds at most 2 of the data API's
  5 concurrent slots while it runs. A question asked before the warm-up has answered is held, with a visible
  "waking up" status, until every warm-up request has answered or 20 seconds have passed. Send is disabled
  while a question is pending, a held one included. When the panel's last data API response is more than 4 minutes
  old, the warm-up runs again before the question (`HOLD_MAX_MS`, `REWARM_AFTER_MS`).

### Per-answer caps

| Cap                   | Value                                                                             | Where                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Question              | 1 to 2,000 characters                                                             | `packages/agent/src/agent.ts` (the request schema)                                                              |
| Output per model call | 2,048 tokens                                                                      | `AGENT_MAX_OUTPUT_TOKENS` (stack environment)                                                                   |
| Tokens per answer     | 80,000, input and output, counting the next call's input before it is sent        | `AGENT_MAX_TOKENS`                                                                                              |
| Tool rounds           | 5                                                                                 | `AGENT_MAX_TOOL_TURNS`                                                                                          |
| Time per answer       | 25 s (the Lambda timeout is 29 s, the HTTP API's limit 30 s)                      | `AGENT_TIME_BUDGET_MS`; `AgentApiStack` (`timeout`)                                                             |
| Answers at a time     | 2 (reserved concurrency 2; stage throttle rate 1, burst 2)                        | `AgentApiStack` (`reservedConcurrentExecutions`, the stage `throttle`)                                          |
| History               | 200 KB request body                                                               | `apps/agent-api/src/history.ts` (`MAX_BODY_BYTES`)                                                              |
| Data calls            | at most 1 in flight; 5 s per attempt, 10 s for the answer's first call; one retry | `packages/agent/src/http-data.ts` (`MAX_IN_FLIGHT`, `CALL_TIMEOUT_MS`, `FIRST_CALL_TIMEOUT_MS`, `MAX_ATTEMPTS`) |

- An answer that reaches a cap stops and says which (`stopped_by`), with what it had read.
- The first data call's 10 s covers a cold data API environment (two took 5.4 and 6.2 s at the function on
  14 Nov, [metrics.md](metrics.md)). Its worst case is
  10 s, a wait of up to 0.5 s, then 10 s again: 20.5 s. With the 1.5 s the agent keeps in reserve
  (`packages/agent/src/agent.ts` (`TIME_RESERVE_MS`)), that leaves about 3 s of the 25 s. The model call is still
  made, with what is left as its time limit: if it does not finish, the answer is stopped with `stopped_by`
  "error"; when nothing is left before a model call or a tool call, with "time_budget".
- A later call can still land on a cold environment and be cut at 5 s; its retry usually finds a warm one (on
  15 Nov one `parcels.detail` attempt was cut at 4.95 s and its retry answered in 154 ms). A call refused by the
  data API's cap, or cut twice, is reported in the answer as a gap, never as an empty result.
- With 2 answers at once, each with at most 1 data call in flight on the agent's side, the agent normally holds 2
  of the data API's 5 slots. An attempt the agent gave up at its time limit can still be running in the data API
  when its retry starts, so one answer can hold 2 slots for a few seconds (`packages/agent/src/http-data.ts`, file
  header). One call at a time keeps an answer on one data API environment. A refused call is retried once.

### The agent's tools (as in the code)

`packages/agent/src/tools.ts` defines six tools, served the same way by the hosted agent and the local MCP
server:

- `resolve_place`: a place name to a center through `places.resolve`; an ambiguous or unknown name is a gap,
  never a guessed center.
- `search_aged_roofs`: parcels with roofs older than a threshold within a radius, with the ownership filter and
  its basis, and an optional long-open filter (`long_open_permit`): parcels with an issued LADBS roofing-work
  permit open at least 1,826 days. With that filter the count is of parcels, not permits.
- `long_open_permits`: long-open roofing permits within a radius, longest open first. With
  `with_contractor_window` it adds a second, labeled list of the longest-open permits issued within the
  contractor window (permits issued 2013-01-02 to 2023-05-19), each with its contractor rows (business name, license number, class, canonical name,
  variant count, or owner-builder / no license), read one data call at a time.
- `parcel_detail`, `parcel_permits` and `run_summary`. A listed roof year with a PERMIT basis cites the LADBS
  permit source as well as the roll.

The hosted agent runs these tools. The Explorer page and `GET /agent/warm` show the commit of the agent code it
runs, computed at build time from the agent's own source paths.

### Defenses against abuse

- The system prompt is on the server, with a scope rule: only properties, permits and contractors in this data;
  anything else is declined in one sentence (`packages/agent/src/prompt.ts`).
- The no-tool-call rule: an answer produced with no tool result, in this turn or in the signed history, is
  replaced by a fixed reply that says what to ask, and its status is "refused" (`packages/agent/src/policy.ts`
  (`NO_TOOL_CALL_TEXT`)).
- The people guard refuses questions about owners, residents, occupants, tenants or anyone's contact details
  before any data call or model call (`packages/agent/src/policy.ts` (`isPeopleQuestion`,
  `PEOPLE_REFUSAL_TEXT`)). Questions about how long a property has gone without an ownership change are
  allowed and answered through the ownership filter with its basis and weakness.
- The signed history and the per-answer caps above; 2 answers at a time.
- The spend alarms: more than $2 in a UTC day, and $1 or more within 5 minutes ([metrics.md](metrics.md)).
- The Anthropic workspace's monthly limit of $20, on a key used only by the hosted agent.
- The refusal prompts of the eval: off-topic, a writing task, an instruction to ignore the rules, and three
  owner questions (`apps/agent-mcp/eval/prompts.json`: `g-owner-refused`, `j-off-topic-refused`,
  `k-writing-task-refused`, `l-ignore-the-rules-refused`, `m-who-is-the-owner-refused`, `r-owner-bbb-refused`).
- The local MCP server has its own client and token (`mcp`), which reaches the data routes only.

### Known limits of the agent

1. **Anyone with a site's basic-auth password can use the agent,** with that site's token, until the token is
   rotated. There is no per-user sign-in and no per-user quota; the caps above are per answer.
2. **The people guard is a pattern, not an understanding of the question.** It matches words about people and
   contact details; a bare personal name with no such word passes it (the scope rule and the no-tool-call rule
   still apply, and no owner data exists to be read).
3. **A refusal by the people guard does not state the contractor window.** Every other answer first reads the
   run's sources and, when that read succeeds, lists the window (2013-01-02 to 2023-05-19) among its gaps. This
   refusal is made before any data call, so it reads no data: its gaps are the five fixed ones, which give the
   contractor rows' end only as "May 2023" (`packages/agent/src/policy.ts` (`STANDARD_GAPS`)).
4. **The Anthropic workspace limit is monthly and may lag,** so it may stop requests only after the limit has
   been passed. No payment method is attached: the final stop is the credit balance.
5. **The long-open parcel count is a lower bound above 25,000 parcels.** `search_aged_roofs` with
   `long_open_permit` counts the parcels that `parcels.points` marks, and `parcels.points` draws at most
   25,000 parcels, nearest first (`apps/api/src/contract.ts` (`MAX_POINTS`)). When more parcels match, only
   the nearest 25,000 are checked and the answer says the count is a lower bound; an exact count would need a
   data API change. It counts parcels, not permits.
6. **Outside the City of Los Angeles a permit count is "not available", never 0.** Parcels outside the City
   carry no permit data. Where no parcel checked has permit data, `long_open_permits` and `search_aged_roofs`
   give the count as null with the status `not_available`, and the answer says "unknown, not 0"
   (`packages/agent/src/tools.ts`, `packages/agent/src/agent.ts`). The data API marks at most 25,000 parcels,
   nearest first, so how many matching parcels lie outside the City is counted only for the nearest 25,000; the
   long-open count and its lists still cover every permit within the radius, and the roof-age count every
   matching parcel.
7. **The spend alarms are estimates and come late:** they sum the agent's own estimate from token counts and list
   prices; the daily one fires up to about 24 hours after the spend passes $2, the burst one within about 10
   minutes.
8. **A signed conversation has no expiry and is bound to no client.** The signature covers the history and the
   session only (`apps/agent-api/src/history.ts` (`signConversation`)), so anyone with a valid `crm` or `explorer`
   token can send a signed conversation back with a new question, from either site and at any later time, until
   the history signing secret is changed.
9. **The model call has no retry and no circuit breaker.** Each model call is one request
   (`packages/agent/src/model-client.ts`, `maxRetries: 0`) whose time limit is what is left of the 25 s budget
   less the 1.5 s reserve, so up to 23.5 s; a call that fails or runs out of time ends the answer with
   `stopped_by` "error" (`packages/agent/src/agent.ts`).

### "RAG-backed": what it means here

The CRM README asks for a "RAG-backed agent". Here, retrieval is done by tool calls over the data API, and the
answer cites the records the tools returned (parcel IDs, permit numbers, source pages). There are no
embeddings and no vector index: no free-text corpus is served (permit work descriptions are withheld, above),
so there is nothing to embed, and Amazon Bedrock, which the kit's retrieval stack uses, is not available in this
account. The deviation is recorded in [kit-deviations.md](kit-deviations.md).
