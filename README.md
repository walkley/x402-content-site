# x402-content-site

Pay-per-call data APIs for AI agents, paid in USDC over [x402](https://www.x402.org). Three products:

- **China workday calendar:** is this date a working day in mainland China? It applies the State Council's holiday notices, including weekend makeup workdays (调休补班), which generic holiday APIs get wrong.
- **Package vulnerability advisories:** is this package version safe to install? Which known advisories (CVE/GHSA/PYSEC/GO/RUSTSEC) affect one exact version of an npm, PyPI, Go, crates.io or Maven package, with CVSS, affected ranges and fixed versions. Data from [OSV.dev](https://osv.dev).
- **SEC EDGAR insider trades and filings:** recent insider trading (Form 4: insider, role, date, code, shares, price, holdings after) and the latest SEC filings (8-K with item titles, 10-K, 10-Q...) of a US public company by ticker or CIK. Data from [SEC EDGAR](https://www.sec.gov/edgar); not affiliated with or endorsed by the SEC.

The service is a [Hono](https://hono.dev) app with `@x402/hono` 2.32.0. It runs on AWS Lambda (Node 22) behind an Amazon API Gateway HTTP API, defined with AWS CDK in `infra/`. Locally it runs as a plain Node server.

## Endpoints

| Route | Price | Returns |
|---|---|---|
| `GET /cn/workday?date=YYYY-MM-DD` | $0.003 | `is_workday`, `is_public_holiday`, `is_makeup_workday`, `holiday_name`, `kind`, `weekday`, `source_url`, `data_updated`; `date` is optional (default: today in Asia/Shanghai) |
| `GET /cn/business-days?from=YYYY-MM-DD&to=YYYY-MM-DD` | $0.005 | `calendar_days`, `workday_count`, `workdays[]` (inclusive range, at most 366 days, may cross years); `from`/`to` are optional together (default: the current month in Asia/Shanghai) |
| `GET /deps/advisories?ecosystem=npm\|PyPI\|Go\|crates.io\|Maven&name=…&version=…` | $0.005 | `vulnerable`, `advisory_count`, `advisories[]` (`id`, `aliases`, `summary`, `severity.level`, `severity.cvss[]`, `affected[].ranges`, `fixed_versions`, `published`, `modified`, `references`, `url`, `license`), `data_fetched_at`, `queried_at` |
| `POST /deps/advisories/batch` with `{"packages":[{ecosystem,name,version}, …]}` (1–50) | $0.02 | `count`, `vulnerable_count`, `results[]` in request order, each shaped like the single query |
| `GET /sec/insider-trades?ticker=AAPL` (or `cik=320193`) | $0.003 | `issuer`, `filings_checked`, `transactions[]` from the 4 most recent Form 4 / 4/A filings (`reporting_owners[]` with role and officer title, `transaction_date`, `code`, `code_description`, `acquired_disposed`, `shares`, `price_per_share`, `shares_owned_after`, `ownership`, `rule_10b5_1`, `filing_url`), `data_fetched_at`, `source` |
| `GET /sec/latest-filings?ticker=AAPL&form=8-K&limit=20` | $0.003 | `issuer`, `count`, `filings[]` newest first (`form`, `filing_date`, `report_date`, `accepted_at`, 8-K `items[]` with titles, `document_url`, `index_url`); `form` and `limit` (1–50, default 20) are optional |
| `GET /` | free | Human preview page: description, schema, examples, data update date, source links |
| `GET /llms.txt` | free | Agent-oriented summary |
| `GET /openapi.json`, `GET /.well-known/openapi.json` | free | OpenAPI 3.1 with full input/output schemas and examples, `x-payment-info` on each paid operation, `x-discovery.llmsTxtUrl` |
| `GET /favicon.ico`, `GET /icon.png` | free | Service icon; the PNG (the same image) is sent as the x402 `iconUrl`, because CDP's listed icon formats do not include ICO |
| `GET /health` | free | Liveness |
| `POST /mcp` | free quota, then x402 | MCP server (Streamable HTTP, stateless), tools `cn_workday_check`, `package_advisories` and `sec_insider_trades` (paid only), see "Free MCP endpoint" |
| `POST /paid/mcp` | x402 (pay the linked URL) | The same MCP server without the free quota: every tool call returns a payment link to the paid route, see "Paid MCP endpoint" |
| `GET /.well-known/mcp.json` | free | MCP manifest: endpoint, tools, free quota, prices |

Calendar coverage is 2020-01-01 to 2027-12-31. Every paid route validates its input **before** asking for payment: a missing or malformed date, a reversed or too-long range, a year without data, an unknown ecosystem, a missing name or version (Maven names must be `groupId:artifactId`), or a bad batch body gets a free `400`/`404` and never a `402`. Batch bodies over 64 KB get `413`. The one exception is a request with **no input at all** (no query string on a GET, an empty body on the batch POST) and no payment header: it gets the `402` quote, because discovery tools such as x402scan probe paid routes that way. If such a bare request does carry a payment, it is validated as usual and rejected with a free `400`, so it is never charged.

Without a payment header a paid route returns `402` with a `PAYMENT-REQUIRED` header (x402 v2, scheme `exact`). All paid routes declare the Bazaar discovery extension (`declareDiscoveryExtension`) with input/output JSON schema, an example, `serviceName`, tags and `iconUrl`. The 402 JSON body starts with `x402Version`, `accepts` and `resource`, copied from the decoded `PAYMENT-REQUIRED` header so the two cannot differ, for clients and directories that only read the body (market402). It also explains what a plain `fetch` client needs without decoding the header: `price`, `currency`, `network`, `how_to_pay`, links to `docs` (`/openapi.json`) and `llms_txt`, and an `example` request with its response. Payment is settled only after the handler succeeds. If settlement fails the client gets the settlement error and none of the paid content.

### Free MCP endpoint

```bash
claude mcp add --transport http cn-calendar https://<origin>/mcp
```

`POST /mcp` speaks MCP over Streamable HTTP without sessions: every request is one JSON-RPC message answered with one JSON response (`initialize`, `ping`, `tools/list`, `tools/call`; notifications get `202`). `GET`/`DELETE /mcp` answer `405` because there is no SSE stream or session. Two tools run the same code and data as the paid routes; the third, `sec_insider_trades`, only returns a payment link:

| Tool | Arguments | Same data as | Paid route named after the quota |
|---|---|---|---|
| `cn_workday_check` | `date`, or `from` and `to` | `/cn/workday`, `/cn/business-days` | `GET /cn/workday?date=…` ($0.003) or `GET /cn/business-days?from=…&to=…` ($0.005) |
| `package_advisories` | `ecosystem`, `name`, `version` | `/deps/advisories` | `GET /deps/advisories?…` ($0.005) |
| `sec_insider_trades` | `ticker` or `cik` (none: `ticker=AAPL`) | `/sec/insider-trades` | `GET /sec/insider-trades?…` ($0.003), on every call |

- **`sec_insider_trades` has no free calls**, on `/mcp` as on `/paid/mcp`. It validates the arguments (an invalid ticker or CIK gets the input error) and answers every valid call with the payment link to `GET /sec/insider-trades`; it never calls SEC and never reads or counts the free quota. This keeps the SEC budget in "How the SEC endpoints use SEC EDGAR" (at most 8 SEC requests per second for the whole API) on the two throttled paid routes alone: `/mcp`'s own 2 rps throttle is not part of that sum. Its log `outcome` is `paid_tool`.

- **Free quota:** 20 tool calls per source IP per UTC day and 2,000 per UTC day for everyone together (`-c freePerIpDaily`, `-c freeGlobalDaily`). Invalid arguments are a tool error and are not counted.
- **After the quota** the tool returns an MCP tool error (`isError: true`). Its text starts with creating a wallet, `npx agentcash onboard` (without a wallet nothing can pay), then `npx agentcash add <origin>`, then the paid x402 URL for the same lookup with its price and network. Its `structuredContent` is a payment link in the format paidmcp-client and the paidmcp directory read, `{"url": <that URL>, "status": 402, "challenge": <PaymentRequired>}` (see "Paid MCP endpoint"). That URL ends in `src=mcp`: the paid routes only log it (`src` in the funnel `request` event); input validation reads its own parameters by name and the price does not depend on the query, so the 402 and the price are the same as without it.
- **Fail closed:** if the counter cannot be read or written (DynamoDB error or timeout, no table configured, no source IP), the call gets the same paid hint and payment link. It is never a free call and never a 500.
- **No payment on this path:** `/mcp` is outside the payment middleware; it never asks the facilitator to verify or settle.
- **Privacy:** Quota counters store no raw IP address, only a keyed hash (HMAC-SHA256 of the day and IP), deleted by TTL after 2 days; request logs keep only the same hash, which changes every UTC day; API Gateway access logs keep the source IP for 30 days. The IP is taken from the HTTP API's `requestContext.http.sourceIp` (not `X-Forwarded-For`) and only used to build the key `ip#<day>#<HMAC-SHA256(key, day|ip), 32 hex>`. Items hold a counter and an `expires_at` TTL. The HMAC key is generated by Secrets Manager when the stack is created (`QuotaHmacKey`); without it the hashes cannot be checked against the 2^32 IPv4 addresses. The Lambda log lines (`mcp` and the paid routes' `x402_funnel` `request`) carry the same hash as `ip_hash`, the 32 hex characters of the counter key. Because the day is part of the HMAC input, one caller's `ip_hash` is the same all UTC day and different the next day, so `ip_hash` alone links an MCP caller to its paid requests on the same day only. The `mcp` lines also carry `apigw_request_id`, which matches the `requestId` of the API Gateway access log, and that log keeps the raw source IP for 30 days. So for 30 days an `mcp` line can be traced back to its IP, and a caller can be linked across days. No Lambda log line contains the raw IP. While the key is not loaded, `ip_hash` is left out.
- **Storage:** an on-demand DynamoDB table with TTL. The API function's role may only `dynamodb:UpdateItem` on that table, and nothing else can access it. Each counted tool call is at most two conditional `UpdateItem`s (per IP, then global). The function reads the HMAC key once at cold start (`GetSecretValue` on that one secret, which only it may read); if the read fails, MCP calls get the paid hint and the next call retries it. Counting a call has a 3 s budget in total; past it the call gets the paid hint.
- **Origin:** a request to `/mcp` with an `Origin` header that is not in `MCP_ALLOWED_ORIGINS` (default: empty) gets `403`, as Streamable HTTP requires. `/mcp` never sends `Access-Control-Allow-Origin: *`; a listed origin gets CORS for itself only. Claude Code, Cursor and other non-browser clients send no `Origin`.
- **Protocol versions:** `2025-11-25` and `2025-06-18`. Anything that is not a JSON-RPC 2.0 request, notification or response gets `400`.
- **Request log:** every `/mcp` request writes one `{"type":"mcp"}` line, including `initialize`, `tools/list`, notifications, and answers from outside the handler (Origin `403`, `405`, `413`). Fields: `method` (the JSON-RPC method; `response`, `invalid`, `parse_error`, or `-` when no message was read), `http_method`, `status`, `user_agent` (first 200 characters), `ip_hash` (see Privacy), `apigw_request_id` (the access log's `requestId`). `initialize` adds `client_name` and `client_version` from `clientInfo` (64 characters each). `tools/call` adds `tool`, `outcome` (`ok`, `invalid_input`, `invalid_request`, `ip_limit`, `global_limit`, `unavailable`, `upstream_error`, `paid_only` on `/paid/mcp`, and `paid_tool` for `sec_insider_trades` on `/mcp`), `reason` where there is one (the input error code; `no_quota_store`, `no_source_ip`, `quota_error`, `quota_timeout` for `unavailable`), `free_call_n`, this IP's count of free calls today including this one (absent on `ip_limit`, which counts nothing), and `payment_link` (`true` when the answer carries the payment link, `false` when the paid route's 402 could not be read and only the text hint was sent). Every line has `path` (`/mcp` or `/paid/mcp`). Lines before this change used `"type":"mcp_call"` and covered tool calls only.

### Paid MCP endpoint

`POST /paid/mcp` is the same MCP server (same tools, protocol versions, Origin check, 16 KB body limit, CORS rules, request log and `405` for `GET`/`DELETE`) without the free quota. It is for x402 MCP clients such as paidmcp-client and for paid-MCP directories, whose checker calls `<endpoint>/mcp` unpaid and needs a payment requirement on the first call; list it with the endpoint `https://<origin>/paid`.

- Every valid `tools/call` returns `isError: true`, the same text hint as `/mcp` after the quota, and in `structuredContent` the payment link `{"url", "status": 402, "challenge"}`. `url` is the paid HTTP route for the same lookup (ending in `src=mcp`). `challenge` is that route's own `PAYMENT-REQUIRED` header: the app requests the URL in-process and decodes the header with `decodePaymentRequiredHeader`, so price, `payTo`, network and `resource` are exactly what the URL charges. Those in-process requests write no funnel events. If the route does not answer `402` with a readable header (for example while the facilitator cannot be reached), the answer has the text hint only.
- Pay the link by calling `url` with an x402 v2 client. Nothing is verified or settled on `/paid/mcp` itself; payment in `_meta["x402/payment"]` (x402 MCP transport) is not supported.
- Invalid arguments still get the input error, without a link. The free quota is never read or counted.

### Seller payer audit and x402 payments report

- `GET /x402/payer-audit/preview?payTo=0x...` (free): payer counts per label and the probe share for one Base payTo.
- `GET /x402/payer-audit?payTo=0x...` ($0.05): every payer of the last 30 days labelled `probe` (wallet in `data/payer-audit/probe-wallets.json`, 164 wallets), `self` (funded by the payTo or by a wallet it funded), `fleet` (one EOA funder sent the same amount to 3+ payers; every payer it funded), `real` (3+ payments on 2+ days) or `once`, with funders, settling facilitator, CDP/PayAI listing and suggestions. A payTo not in the data is a free 404 before payment; unreadable data is a free 502.
- `GET /reports/x402-real-payers` (free summary), `/reports/x402-real-payers/full` ($2, HTML; browsers get the official `@x402/paywall` EVM page, no CDP key), `/reports/x402-real-payers.json` ($0.5).

The audit data is built offline, one JSON per payTo, and read from the stack's private S3 bucket (output `PayerAuditBucket`, prefix `payer-audit/`; the function can only read it):

```bash
npx tsx scripts/payer-audit/build.ts --rows <directory snapshot rows.json.gz> [--payto 0x..,0x..] \
  [--state .payer-audit/state] [--out .payer-audit/out] [--upload s3://<PayerAuditBucket>/payer-audit/]
```

Reruns are incremental (cursors in `--state`). Locally, `PAYER_AUDIT_DIR=.payer-audit/out npm run dev` serves the files from disk. Payments by a Coinbase Smart Wallet settle on PayAI only once the wallet is deployed (ERC-1271); a counterfactual (ERC-6492) wallet is refused with `eip6492_factory_not_allowed` (Base Sepolia, 2026-11-25).

### How the advisory endpoints use OSV.dev

- OSV.dev is called only after the payment is verified: `POST https://api.osv.dev/v1/query` with an identifying `User-Agent`, following `next_page_token` for up to 5 pages per package (`truncated: true` beyond that). Each call times out after 5 s, and all calls for one paid request share a **15 s deadline**, which leaves time to settle before the HTTP API's 30 s integration timeout. A batch runs single queries 10 at a time and makes at most **60 OSV calls in total** (one first page per package plus up to 10 follow-up pages), so one payment cannot trigger more upstream work than that. A result cut short by that budget is marked `truncated` and not cached.
- Package names are matched as published. npm names are case-sensitive (`lodash`, not `Lodash`), so a wrongly-cased name returns `vulnerable: false`. The API does not lowercase them because some legacy npm packages keep capitals (for example `JSONStream`). PyPI names are normalised by OSV.dev.
- Results are cached in memory per Lambda container for 1 hour (at most 5,000 package versions; concurrent misses for the same version share one upstream call). `data_fetched_at` says when the data came from OSV.dev.
- **Upstream failure is not charged.** If OSV.dev times out, is unreachable, or returns an error or invalid JSON, the handler answers `502 upstream_unavailable`. The x402 middleware only settles after a response below 400, so the verified payment is never settled and no USDC moves. In a batch, one failed package fails the whole call, again unsettled. The funnel log records this as stage `handler_error`.
- Only the queried package's `affected` entries are returned (a GHSA record for lodash also lists lodash-es and others).
- All routes send CORS headers (`Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE`, preflight allows `PAYMENT-SIGNATURE`/`X-PAYMENT`), so browser-based agents can read the payment headers.

### How the SEC endpoints use SEC EDGAR

- SEC is called only after the payment is verified, with `User-Agent: x402-content-site <PUBLIC_BASE_URL>` as SEC's [fair-access policy](https://www.sec.gov/os/accessing-edgar-data) requires. The policy's example is a company name plus an e-mail; we name the site instead. SEC answers `403` to a User-Agent containing `github` (tested 2026-11-24), so the repository URL is not used.
- Calls per paid request: the ticker list (`www.sec.gov/files/company_tickers.json`, cached 24 h), the company's submissions JSON (`data.sec.gov/submissions/CIK##########.json`, cached 10 min, newest 300 filings kept), and for insider trades the raw XML of the 4 most recent Form 4 filings (cached by accession number until evicted: a filed document never changes). That is at most **6 SEC calls** on a cold container and usually 0–1 on a warm one; latest filings needs at most 2. Memory per container stays bounded: at most 100 companies' submissions and 1,000 parsed Form 4 documents, about 50 MB with every cache full (measured).
- Rate: each container spaces its SEC calls at 4 per second. That alone does not bound the total (10 containers × 4/s = 40/s). The bound is three API Gateway routes, each throttled to 1 rps with burst 1: `GET /sec/insider-trades` (at most 6 SEC calls per request), `GET /sec/latest-filings` (at most 2) and the fallback `ANY /sec/{proxy+}`, which takes every other method and path under `/sec` (`HEAD`, a trailing slash) so none of them counts against `$default`'s 10 rps. API Gateway matches routes on the decoded path, so `/sec/insider%2Dtrades` counts against the `GET /sec/insider-trades` route. The app serves SEC data only for `GET` on the literal paths that arrived on their own GET route; everything else gets a free `405`/`404` before payment is verified, so the fallback makes no SEC call. Worst case for the whole API: 1 × 6 + 1 × 2 + 0 = **8 SEC calls per second**, below SEC's 10. The two paid endpoints have separate throttles, so a directory probing both in the same second gets a `402` from each. Cost of burst 1: a client that sends its paid retry less than a second after the unpaid 402 gets `429` from API Gateway and must retry; nothing is charged.
- Time: each SEC call has its own 5 s timeout. All calls of one request must finish by the earlier of 12 s after the handler starts and 15 s after the request starts (the 23 s request deadline minus 8 s kept for settlement). Past that the request fails as `502`, before settlement, so it is not charged.
- **Not charged:** an SEC timeout or error, including a `403`/`429`, is `502 upstream_unavailable`; a ticker or CIK SEC does not know is `404` (checked after payment, because checking costs an SEC call). Neither is settled; the funnel logs `handler_error`. **Charged:** a known company with no Form 4 among its latest 200 filings returns `200` with an empty `transactions` list; that is an answer, and it is settled.
- After a deploy, run `scripts/sec-lambda-probe.sh` once: it invokes the API function directly (IAM, not over HTTP) and reports whether `data.sec.gov` and `www.sec.gov` answer `200` from the function's egress IP.

### Data sources and licenses

| Data | Source | License |
|---|---|---|
| China holidays | State Council notices on www.gov.cn, see `data/cn-holidays/SOURCES.md` | Official administrative documents, excluded from copyright by Art. 5 of the PRC Copyright Law |
| SEC insider trades and filings | [SEC EDGAR](https://www.sec.gov/edgar) APIs and filing archives | U.S. government public data, no copyright restriction on redistribution. Responses name SEC EDGAR as the source and say the service is not affiliated with or endorsed by the SEC. Not investment advice. |
| Package advisories | [OSV.dev](https://osv.dev) API and aggregation | The OSV.dev software is Apache-2.0, and its maintainers say it can be used in commercial products without restriction ([google/osv.dev#1884](https://github.com/google/osv.dev/issues/1884)). That answer covers the software, not the data. The data keeps each source's license, listed below. All of them (CC-BY 4.0, CC0 1.0, Apache-2.0) allow commercial redistribution. |
| ↳ `GHSA-*` | GitHub Advisory Database | CC-BY 4.0 |
| ↳ `PYSEC-*` | PyPI Advisory Database | CC-BY 4.0 |
| ↳ `GO-*` | Go Vulnerability Database | CC-BY 4.0 |
| ↳ `RUSTSEC-*` | Rust Advisory Database | CC0 1.0 |
| ↳ `MAL-*` | OpenSSF Malicious Packages | Apache-2.0 |
| ↳ `PSF-*` | Python Software Foundation Database | CC-BY 4.0 |

Source licenses are listed on [OSV.dev data sources](https://google.github.io/osv.dev/data/). Every advisory in a response carries its `license`, `source_database` and osv.dev `url`, which is the attribution CC-BY 4.0 requires. Records are **excerpted and modified**: the `details` text is omitted, and affected ranges are restructured and filtered to the queried package. The response's `source` field says so, as CC-BY 4.0 requires an indication of changes. A record whose ID prefix is not in the table is returned with ids, versions and links only; its `summary` is `null` and `license` is `see source record`. The OSV.dev sources with restrictive licenses (Chainguard CC-BY-NC-ND, Ubuntu CC-BY-SA) cover OS packages, not the five ecosystems this API accepts.

## Configuration

All payment settings come from environment variables. The defaults are testnet values.

| Variable | Default | Notes |
|---|---|---|
| `X402_PAY_TO` | none, required | Address that receives USDC |
| `X402_NETWORK` | `eip155:84532` (Base Sepolia) | CAIP-2 id |
| `FACILITATOR` | `x402org` on testnet, `payai` on `eip155:8453` | `x402org`, `payai` or `cdp`, see below |
| `X402_FACILITATOR_URL` | preset of `FACILITATOR` | Overrides the URL for `x402org`/`payai` only |
| `CDP_SECRET_NAME` | `x402-content-site/cdp-api-key` | `cdp` only: Secrets Manager secret holding the CDP API key |
| `PUBLIC_BASE_URL` | request origin | Base URL written into `/openapi.json` and `/llms.txt` |
| `QUOTA_TABLE` | none | DynamoDB table for the free MCP quota. Unset: no free tier, every MCP tool call gets the paid hint |
| `QUOTA_HMAC_SECRET_ARN` | none | Secrets Manager secret holding the quota HMAC key (set by the stack). Unset or unreadable: every MCP tool call gets the paid hint |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed to call `/mcp`; any other `Origin` gets 403 |
| `FREE_PER_IP_DAILY` / `FREE_GLOBAL_DAILY` | `20` / `2000` | Free MCP tool calls per IP per UTC day / for everyone per UTC day |
| `PORT` | `8787` | Local server only |

| `FACILITATOR` | URL | Use |
|---|---|---|
| `x402org` | `https://x402.org/facilitator` | Testnet only. Refused at startup on `eip155:8453`. |
| `payai` | `https://facilitator.payai.network` | Mainnet without an account: no API key; about 680 free settlements per `payTo`, then top up at merchant.payai.network. Lists in the PayAI directory only. |
| `cdp` | `https://api.cdp.coinbase.com/platform/v2/x402` | Mainnet with a CDP API key (`@coinbase/x402` builds the JWT auth headers). Needed to be listed in the CDP Bazaar, which is where directory-crawling buyer wallets pay. |

### CDP API key (cdp mode)

The key is read at runtime, never from code or the CDK app. Only `FACILITATOR=cdp` reads it; other modes never touch Secrets Manager and get no IAM permission for it. A missing secret does not stop a deploy or a cold start: free routes keep working and paid routes answer with an error (no content) until the secret exists. On first use the Lambda reads the secret named by `CDP_SECRET_NAME` from AWS Secrets Manager, caches it for the container's lifetime, and retries on the next request if the read failed. The secret is created by a person, not by the stack:

```bash
aws secretsmanager create-secret --region ap-northeast-1 \
  --name x402-content-site/cdp-api-key \
  --secret-string '{"CDP_API_KEY_ID":"<key id>","CDP_API_KEY_SECRET":"<key secret>"}'
```

The CDK stack grants the function `secretsmanager:GetSecretValue`/`DescribeSecret` on that one secret only, and only when deployed with `-c facilitator=cdp`. For a local cdp run, `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` in the environment skip Secrets Manager.

### Mainnet values (not in any default)

| Variable | Value |
|---|---|
| `X402_NETWORK` | `eip155:8453` (Base mainnet) |
| `FACILITATOR` | `payai` (default on mainnet, no account) or `cdp` (CDP Bazaar listing, needs the CDP key secret) |
| `X402_PAY_TO` | The user's own Base mainnet receiving address (public address only) |

On Base mainnet the asset the server asks for is native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

## Local development

```bash
npm ci
X402_PAY_TO=0xYourTestnetAddress npm run dev      # http://localhost:8787
npm test                                          # unit + payment-flow tests (fake facilitator)
npm run typecheck                                 # app and infra
```

### Base Sepolia end to end

1. Create a test buyer key in a file outside the repo, for example `/tmp/x402-buyer.key` (one `0x…` line, mode 600). `*.key` is git-ignored. Never commit or print it.
2. Fund the buyer address with Base Sepolia USDC from [Circle's faucet](https://faucet.circle.com) (needs a reCAPTCHA click). No ETH is needed: the facilitator pays gas.
3. Start the server (`npm run dev` as above), then:

```bash
BUYER_KEY_FILE=/tmp/x402-buyer.key BASE_URL=http://localhost:8787 npm run e2e:sepolia
```

The script pays both routes with `@x402/fetch` and prints status, the decoded `PAYMENT-RESPONSE` (with the transaction hash) and the buyer's USDC balance before and after.

## Deploy (AWS CDK)

Not deployed yet. It needs AWS credentials for the target account and a one-time `cdk bootstrap`.

```bash
cd infra
npx cdk synth  -c payTo=0x...                                   # works without credentials
npx cdk deploy -c payTo=0x...                                   # testnet defaults, ap-northeast-1
npx cdk deploy -c payTo=0x... -c network=eip155:8453 -c facilitator=payai -c budgetEmail=you@example.com   # mainnet, no account (also the mainnet default)
npx cdk deploy -c payTo=0x... -c network=eip155:8453 -c facilitator=cdp -c budgetEmail=you@example.com     # mainnet, CDP Bazaar (needs the CDP key secret)
```

Optional context keys: `region` (default `ap-northeast-1`), `stackName`, `publicBaseUrl`, `facilitatorUrl`, `cdpSecretName`, `reservedConcurrency` (default `10`), `budgetEmail`, `budgetUsd` (default `10`), `noBudget` (`true` to deploy Base mainnet without `budgetEmail`), `breakerDailyInvocations` (default `300000`, see "Cost breaker"), `freePerIpDaily` (default `20`), `freeGlobalDaily` (default `2000`).

The stack is one arm64 Lambda (256 MB, 25 s timeout, under the HTTP API's 30 s integration timeout; logs kept 90 days, JSON log format) behind an API Gateway HTTP API with a Lambda proxy integration (payload format 2.0) on the `$default` route of the `$default` stage. That stage has no path prefix, so the public base URL is the origin itself, `https://<api-id>.execute-api.<region>.amazonaws.com`, and `/openapi.json`, `/.well-known/openapi.json`, `/llms.txt` and `/favicon.ico` sit at the root where discovery tools look for them. The URL is printed as the `ApiUrl` output and passed to the function as `PUBLIC_BASE_URL` (unless `-c publicBaseUrl` is given). There is no Lambda Function URL. The function's only invoke permission is for `apigateway.amazonaws.com` with a `SourceArn` on this HTTP API.

Two limits stop a flood of free 402/400 responses from running up cost. The `$default` stage's default route throttling is **10 requests per second with a burst of 20**; extra requests get HTTP 429 from API Gateway before reaching Lambda. `POST /mcp` and `POST /paid/mcp` each have their own route (same Lambda integration, no extra invoke permission) with route-level throttling of **2 requests per second with a burst of 5** each, which replaces the default for that route only, so a flood of MCP requests is throttled on its own limit instead of using the paid routes' 10 rps. `OPTIONS`, `GET` and `DELETE` on both paths stay on `$default`; they are answered without any DynamoDB or upstream call, like `/health`. The function also has **10 reserved concurrent executions**, so it cannot use up the account's concurrency. AWS requires at least 10 unreserved executions to remain in the account, so a new account whose concurrency quota is still 10 must first request a higher Lambda concurrency quota (Service Quotas, free).

The proxy integration passes request headers (`PAYMENT-SIGNATURE`, `X-PAYMENT`), the query string, the body and `HEAD`/`OPTIONS` requests to the app unchanged, and returns its response headers (`PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`) unchanged. CORS is answered by the app, not by API Gateway. Because the path has no stage prefix, the x402 `resource` URL is the request URL and can be called as is.

Moving from the earlier REST API (stage `prod`) to the HTTP API changes the public URL: the deploy creates the HTTP API and deletes the REST API with its stage, deployment, methods and permissions in the same update. Clients and directory entries holding the old `…/prod/` URL stop working; re-register with the new `ApiUrl`.

**Roll back forward only.** Do not `git revert` this entry change and redeploy: the earlier template creates a Lambda Function URL with `AuthType NONE` and two `lambda:InvokeFunction*` permissions for principal `*`, which makes the function publicly callable without API Gateway's throttling. To undo a bad deploy, fix forward on the API Gateway template, or redeploy an earlier commit that already has an API Gateway entry (REST API or HTTP API).

Optional, not in the stack: AWS WAF for per-IP rate rules and managed rule groups. A web ACL cannot be associated with an HTTP API directly, so it would need a CloudFront distribution in front of the API. WAF costs money (about $5 per web ACL per month, $1 per rule per month, plus $0.60 per million requests), so it is left to the operator to decide and add.

With `-c budgetEmail=you@example.com` the stack also creates an account-wide monthly AWS Budgets cost budget of `budgetUsd` (default $10) that emails at 80% and 100% of actual spend and when the forecast passes 100%. Without `budgetEmail` no budget is created. On Base mainnet (`network=eip155:8453`) synth fails without `budgetEmail` unless `-c noBudget=true` is passed, so a missing cost alert is a deliberate choice, not an omission.

### Cost breaker

The breaker caps cost without anyone reading email. A CloudWatch alarm sums the API function's `AWS/Lambda` `Invocations` in the last 24 hours: a sliding window with a 1-day period, evaluated every minute, not aligned to UTC days, and missing data counts as not breaching. When the sum passes `breakerDailyInvocations`, the alarm publishes to an SNS topic. The topic's policy lets only `cloudwatch.amazonaws.com` publish, and only for this alarm (`aws:SourceArn`). The topic's only subscriber is a small breaker Lambda. It acts only on this alarm's transition into `ALARM`, and calls `PutFunctionConcurrency` to set the API function's reserved concurrency to **0**. From then on API Gateway answers every request with a 5xx without running the function, so Lambda, CloudWatch Logs and egress cost stop. Only the HTTP API request charge (about $1 per million, at most 10 rps) continues.

The default threshold of 300,000 invocations in 24 hours is about $1–2 per day. That figure is a rough per-request cost of $3–6 per million invocations: about $1.0–1.3 for HTTP API requests, $0.2 for Lambda requests, $0.2–3.3 for Lambda duration (50 ms to 1 s at 256 MB arm64), about $1.1 for log ingestion (about 1.5 KB per request) and $0.2 for egress. At the stage limit of 10 rps the threshold is reached after about 8 hours. The alarm is evaluated every minute and Lambda metrics arrive a few minutes late, so the breaker trips a few minutes after the crossing. The most a flood can cost before it trips is therefore about one such day. This delay has not been measured. Real traffic is far below the threshold. Change it with `-c breakerDailyInvocations=<n>`.

`/mcp` shares the API function, its reserved concurrency and this breaker with the paid routes, and the alarm still counts `/mcp` invocations. It is not changed to exclude them, for two reasons. AWS publishes no per-route invocation count for free: Lambda's `Invocations` has no route dimension, and API Gateway's per-route metrics need detailed metrics or a log metric filter, both billed as custom CloudWatch metrics. And subtracting `/mcp` from the alarm would loosen it: a mix of `/mcp` and paid-route traffic could then pass 300,000 invocations a day without tripping it. Instead, the `POST /mcp` route's throttle keeps a `POST /mcp` flood alone below the threshold: 2 rps for 24 hours is at most 172,800 invocations, under the default 300,000, so `POST /mcp` by itself can no longer trip the breaker and take the paid routes down. `GET`, `DELETE` and `OPTIONS /mcp` go to `$default` (10 rps, burst 20) like every other path; flooding them is the same risk as flooding `/health`, which main already had. If `$default` and `POST /mcp` are both flooded at their limits (12 rps together), the breaker trips after about 6.9 hours. A `POST /mcp` flood at the limit plus more than about 127,000 other invocations in the same 24 hours still trips it, as it should for cost. `cdk synth` warns if `-c breakerDailyInvocations` is set at or below 172,800, where this no longer holds. The worst a `POST /mcp` flood costs without tripping the breaker is that 172,800 invocations a day, under $1 at the per-request cost below. `POST /paid/mcp` has the same 2 rps limit on its own route, so it alone cannot trip the breaker either; flooding `POST /mcp` and `POST /paid/mcp` together at their limits (4 rps, 345,600 a day) does trip it, after about 20.8 hours.

The breaker's IAM role allows only `lambda:PutFunctionConcurrency` on the API function and `logs:CreateLogStream`/`logs:PutLogEvents` on its own log group. It has no other permissions and no Function URL, and only `sns.amazonaws.com` from that topic may invoke it. The alarm runs its action only on a state change into `ALARM`. While the 24-hour sum stays above the threshold the alarm stays in `ALARM`, and the breaker does not fire again on its own.

**After it trips**, the breaker log group has a `cost_breaker` line, and the alarm shows `ALARM`. The stack outputs `ApiFunctionName` and `BreakerAlarmName` hold the names used below. To restore service:

1. Decide whether the traffic is legitimate: look at the funnel logs (`stats count() by route, user_agent`). If it is, raise `-c breakerDailyInvocations` above the real 24-hour volume and redeploy. If it is not, wait until the 24-hour sum falls back below the threshold, which means the flood has stopped for long enough. Check this with `Invocations` Sum over the last 24 hours in CloudWatch.
2. Restore the reserved concurrency: `aws lambda put-function-concurrency --region ap-northeast-1 --function-name <ApiFunctionName> --reserved-concurrent-executions 10`. Do not rely on a redeploy to reset it: CloudFormation only applies template changes and does not correct drift.
3. Re-arm the breaker: `aws cloudwatch set-alarm-state --region ap-northeast-1 --alarm-name <BreakerAlarmName> --state-value OK --state-reason "manual reset after restore"`. At the next evaluation, about a minute later, the alarm returns to `ALARM` if the 24-hour sum is still above the threshold, and the breaker trips again. That is why step 1 comes first. Without this step the alarm stays in `ALARM` until the sum drops below the threshold on its own, and only then re-arms itself. A new flood during that time does not trip the breaker.

### MCP Registry

`server.json` describes the remote server `io.github.walkley/cn-calendar` for the [official MCP Registry](https://registry.modelcontextprotocol.io). `.github/workflows/publish-mcp.yml` publishes it with `mcp-publisher` (pinned, Sigstore-verified) and GitHub OIDC. It runs only by hand (`workflow_dispatch`, main branch only), never on a push or pull request. Run it after the stack with `POST /mcp` is deployed: its first step fails unless the remote URL answers `initialize`. Bump `version` in `server.json` and `MCP_VERSION` in `src/mcp.ts` together before publishing a change (a test checks they match).

## Funnel logs

Every paid request writes one JSON line per stage to stdout, which Lambda sends to CloudWatch Logs:

```json
{"ts":"2026-11-24T07:25:35.805Z","type":"x402_funnel","stage":"settle_ok","route":"/cn/workday","request_id":"…","user_agent":"…","payer":"0x…","tx":"0x…","network":"eip155:84532"}
```

The `request` stage also carries `src` and `ip_hash`. `src` is `mcp` when the URL came from the MCP over-quota hint (`src=mcp`); any other value is dropped and the field is left out. `ip_hash` is the same daily HMAC of the source IP as the free MCP quota and the `mcp` log lines, never the raw IP; it changes every UTC day and is left out while the HMAC key is not loaded. Together they show whether an MCP caller went on to the paid routes on the same day. Paid requests that came from the MCP hint, and one caller's day across both logs:

```
filter type = "x402_funnel" and stage = "request" and src = "mcp" | stats count() by route, ip_hash
fields @timestamp, type, method, tool, outcome, free_call_n, stage, route, src | filter ip_hash = "<ip_hash>" | sort @timestamp asc
```

| Stage | When |
|---|---|
| `request` | A paid route was called. Carries `status` and `reason: rejected_input: …` if input validation refused it. |
| `402_returned` | The response was a 402 (no payment, or the payment was refused). `reason` is the x402 error. |
| `payment_header_received` | The request carried `PAYMENT-SIGNATURE` / `X-PAYMENT`. |
| `handler_error` | The handler failed after verification (OSV.dev or SEC down, facilitator error: status ≥ 500; unknown ticker or CIK: 404): not settled, not charged. |
| `verify_ok` / `verify_fail` | Facilitator verification result. `verify_fail` has `reason`, also for headers rejected before reaching the facilitator. |
| `settle_ok` / `settle_fail` | Settlement result. `settle_ok` has `tx`; `settle_fail` has `reason`. |
| `content_returned` | Paid content was sent after a successful settlement. |

Payment headers and signatures are never logged. CloudWatch Logs Insights example:

```
fields @timestamp, stage, route, payer, tx | filter type = "x402_funnel" | stats count() by stage, route
```

## known-addresses.json

`known-addresses.json` lists wallets controlled by the team, test buyers, the user, and the self-payment used to get indexed by the Bazaar directory. **Payments from these addresses do not count as external paid calls.** When checking for an external payment, take the payer from the USDC `Transfer` event's `from` (with the `exact` scheme `tx.from` is the facilitator), and add every new team/test/self-pay wallet here before using it.

## Data

`data/cn-holidays/<year>.json` holds one State Council notice per year, 2020–2027. The format is documented in `data/cn-holidays/README.md`; sources and the verification run are in `data/cn-holidays/SOURCES.md`. Each year follows the schedule actually in force nationally: the annual notice, plus later national amendments. The only amendment so far is the 2020 Spring Festival extension (国办发明电〔2020〕1号): 2020-01-31 to 2020-02-02 are holidays and 2020-02-03 is the first workday. Provincial schedules are not included.

## What the user needs to provide before mainnet

1. A Base mainnet receiving address (public address only).
2. AWS credentials for the target account (and permission to run `cdk bootstrap` once).
3. For `FACILITATOR=cdp`: a CDP account and API key, stored by the user in the Secrets Manager secret above.
4. A wallet with about $1 of Base USDC, kept by the user, for the first self-payment that gets the endpoint indexed. Add it to `known-addresses.json`.
5. An email address for the cost alert (`-c budgetEmail=…`).

## Mainnet launch checklist

Do these on the day of the switch to `eip155:8453`; they cannot be checked on testnet alone.

- [ ] Deploy with `-c network=eip155:8453 -c facilitator=cdp` (or `payai`) and `-c budgetEmail=…` (or an explicit `-c noBudget=true`); confirm the `ApiUrl` output and `/health`.
- [ ] Replay test (review item 4): send the same signed `PAYMENT-SIGNATURE` twice in a row and twice concurrently, on Sepolia and on the mainnet facilitator in use. Expected: the second request gets `402` and no content. The server has no own de-duplication; it relies on the EIP-3009 nonce, so a facilitator that answers a repeated settle with success would serve the content twice.
- [ ] Self-pay once at the lowest price from the wallet in `known-addresses.json` (role `self_pay`) with `X402_BASE_URL=<ApiUrl> npm run self-pay:mainnet` (key read from Secrets Manager `x402/buyer-wallet`, never printed; capped at 0.01 USDC), and confirm the USDC `Transfer` reaches `payTo` on Basescan and a `settle_ok` line with the same tx appears in CloudWatch Logs.
- [ ] Bazaar listing (review item 5): after the self-payment, query the facilitator's `/discovery/resources` and confirm each route has exactly one entry. `resource.url` currently includes the query string, so one entry per date would mean the URL must be normalised.
- [ ] Check origin discovery with `npx -y @agentcash/discovery <ApiUrl> -v` (no warnings expected), then register with x402scan, agentic.market and x402-list, and record each registration.

## Legal and tax

The operator is responsible for tax reporting and regulatory compliance of the payments received. This repository and its maintainers give no tax or legal advice.

Access logs (API Gateway, one line per request) are kept for 30 days and include the caller's source IP address.
