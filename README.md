# x402-content-site

Pay-per-call data APIs for AI agents, paid in USDC over [x402](https://www.x402.org). The first product answers one question that generic holiday APIs get wrong: **is this date a working day in mainland China?** It applies the State Council's annual holiday notice, including weekend makeup workdays (调休补班).

The service is a [Hono](https://hono.dev) app with `@x402/hono` 2.32.0. It runs on AWS Lambda (Node 22) behind a Lambda Function URL, defined with AWS CDK in `infra/`. Locally it runs as a plain Node server.

## Endpoints

| Route | Price | Returns |
|---|---|---|
| `GET /cn/workday?date=YYYY-MM-DD` | $0.003 | `is_workday`, `is_public_holiday`, `is_makeup_workday`, `holiday_name`, `kind`, `weekday`, `source_url`, `data_updated` |
| `GET /cn/business-days?from=YYYY-MM-DD&to=YYYY-MM-DD` | $0.005 | `calendar_days`, `workday_count`, `workdays[]` (inclusive range, at most 366 days, may cross years) |
| `GET /` | free | Human preview page: description, schema, one example, data update date, source links |
| `GET /llms.txt` | free | Agent-oriented summary |
| `GET /openapi.json` | free | OpenAPI 3.1 with full input/output schemas and examples |
| `GET /health` | free | Liveness |

Coverage is 2020-01-01 to 2027-12-31. A paid route validates its input **before** asking for payment: a malformed date, a reversed or too-long range, or a year without data gets a free `400`/`404` and never a `402`.

Without a payment header a paid route returns `402` with a `PAYMENT-REQUIRED` header (x402 v2, scheme `exact`). Both paid routes declare the Bazaar discovery extension (`declareDiscoveryExtension`) with input/output JSON schema, an example, `serviceName` and tags. Payment is settled only after the handler succeeds. If settlement fails the client gets the settlement error and none of the paid content.

## Configuration

All payment settings come from environment variables. The defaults are testnet values.

| Variable | Default | Notes |
|---|---|---|
| `X402_PAY_TO` | none, required | Address that receives USDC |
| `X402_NETWORK` | `eip155:84532` (Base Sepolia) | CAIP-2 id |
| `FACILITATOR` | `x402org` | `x402org`, `payai` or `cdp`, see below |
| `X402_FACILITATOR_URL` | preset of `FACILITATOR` | Overrides the URL for `x402org`/`payai` only |
| `CDP_SECRET_NAME` | `x402-content-site/cdp-api-key` | `cdp` only: Secrets Manager secret holding the CDP API key |
| `PUBLIC_BASE_URL` | request origin | Base URL written into `/openapi.json` and `/llms.txt` |
| `PORT` | `8787` | Local server only |

| `FACILITATOR` | URL | Use |
|---|---|---|
| `x402org` | `https://x402.org/facilitator` | Testnet only. Refused at startup on `eip155:8453`. |
| `payai` | `https://facilitator.payai.network` | Mainnet without an account: no API key; about 680 free settlements per `payTo`, then top up at merchant.payai.network. Lists in the PayAI directory only. |
| `cdp` | `https://api.cdp.coinbase.com/platform/v2/x402` | Mainnet with a CDP API key (`@coinbase/x402` builds the JWT auth headers). Needed to be listed in the CDP Bazaar, which is where directory-crawling buyer wallets pay. |

### CDP API key (cdp mode)

The key is read at runtime, never from code or the CDK app. On first use the Lambda reads the secret named by `CDP_SECRET_NAME` from AWS Secrets Manager, caches it for the container's lifetime, and retries on the next request if the read failed. The secret is created by a person, not by the stack:

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
| `FACILITATOR` | `cdp` (CDP Bazaar listing, needs the CDP key secret) or `payai` (no account) |
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
npx cdk deploy -c payTo=0x... -c network=eip155:8453 -c facilitator=cdp     # mainnet, CDP Bazaar
npx cdk deploy -c payTo=0x... -c network=eip155:8453 -c facilitator=payai   # mainnet, no account
```

Optional context keys: `region` (default `ap-northeast-1`), `stackName`, `publicBaseUrl`, `facilitatorUrl`, `cdpSecretName`. The stack is one arm64 Lambda (256 MB, 30 s timeout, logs kept 90 days, JSON log format) with a public Function URL, printed as the `ApiUrl` output.

## Funnel logs

Every paid request writes one JSON line per stage to stdout, which Lambda sends to CloudWatch Logs:

```json
{"ts":"2026-11-24T07:25:35.805Z","type":"x402_funnel","stage":"settle_ok","route":"/cn/workday","request_id":"…","user_agent":"…","payer":"0x…","tx":"0x…","network":"eip155:84532"}
```

| Stage | When |
|---|---|
| `request` | A paid route was called. Carries `status` and `reason: rejected_input: …` if input validation refused it. |
| `402_returned` | The response was a 402 (no payment, or the payment was refused). `reason` is the x402 error. |
| `payment_header_received` | The request carried `PAYMENT-SIGNATURE` / `X-PAYMENT`. |
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

`data/cn-holidays/<year>.json` holds one State Council notice per year, 2020–2027. The format is documented in `data/cn-holidays/README.md`; sources and the verification run are in `data/cn-holidays/SOURCES.md`. Each year follows the annual notice as published. Later ad-hoc notices are not applied (notably the 2020 Spring Festival extension).

## What the user needs to provide before mainnet

1. A Base mainnet receiving address (public address only).
2. AWS credentials for the target account (and permission to run `cdk bootstrap` once).
3. For `FACILITATOR=cdp`: a CDP account and API key, stored by the user in the Secrets Manager secret above.
4. A wallet with about $1 of Base USDC, kept by the user, for the first self-payment that gets the endpoint indexed. Add it to `known-addresses.json`.
