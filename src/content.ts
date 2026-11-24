// Static descriptions shared by the x402 route config, /openapi.json, /llms.txt and the preview page.
import { MAX_RANGE_DAYS } from "./calendar.js";
import { calendar } from "./data.js";
import {
  ADVISORIES_DESCRIPTION,
  ADVISORIES_EXAMPLE_INPUT,
  ADVISORIES_EXAMPLE_OUTPUT,
  ADVISORIES_INPUT_SCHEMA,
  ADVISORIES_OUTPUT_SCHEMA,
  BATCH_DESCRIPTION,
  BATCH_EXAMPLE_INPUT,
  BATCH_EXAMPLE_OUTPUT,
  BATCH_INPUT_SCHEMA,
  BATCH_OUTPUT_SCHEMA,
  DEPS_SERVICE_NAME,
  OSV_ATTRIBUTION,
} from "./content-deps.js";
import { ECOSYSTEMS, MAX_BATCH } from "./advisories.js";
import {
  INSIDER_TRADES_DESCRIPTION,
  INSIDER_TRADES_EXAMPLE_INPUT,
  INSIDER_TRADES_EXAMPLE_OUTPUT,
  INSIDER_TRADES_INPUT_SCHEMA,
  INSIDER_TRADES_OUTPUT_SCHEMA,
  LATEST_FILINGS_DESCRIPTION,
  LATEST_FILINGS_EXAMPLE_INPUT,
  LATEST_FILINGS_EXAMPLE_OUTPUT,
  LATEST_FILINGS_INPUT_SCHEMA,
  LATEST_FILINGS_OUTPUT_SCHEMA,
  SEC_ATTRIBUTION,
  SEC_SERVICE_NAME,
} from "./content-sec.js";
import { PAID_MCP_PATH, PRIVACY_NOTE, mcpAddCommand } from "./mcp.js";

export const SERVICE_NAME = "China Workday Calendar";
export const TAGS = ["calendar", "holidays", "china", "business-days", "workday"];
export const REPO_URL = "https://github.com/walkley/x402-content-site";
// Also the openapi info.title, which `npx agentcash add` lowercases into a skill name: keep it to letters, digits and spaces, at most 64 characters.
export const SITE_NAME = "China Workday Calendar Package Advisories and SEC Insider Trades";

const DATE_SCHEMA = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;

export const WORKDAY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    date: { ...DATE_SCHEMA, description: `Calendar date in China (YYYY-MM-DD), ${calendar.firstDate}..${calendar.lastDate}` },
  },
  required: ["date"],
  additionalProperties: false,
};

export const WORKDAY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    date: DATE_SCHEMA,
    weekday: { type: "integer", minimum: 1, maximum: 7, description: "ISO weekday, 1 = Monday, 7 = Sunday" },
    is_workday: { type: "boolean", description: "true for an ordinary weekday or a makeup workday (调休补班)" },
    is_public_holiday: { type: "boolean", description: "true inside an official holiday period (放假) from the State Council notice" },
    is_makeup_workday: { type: "boolean", description: "true for a weekend day officially designated as a working day (调休上班)" },
    holiday_name: { type: ["string", "null"], description: "Holiday name as written in the notice, e.g. 春节" },
    kind: { type: "string", enum: ["workday", "weekend", "public_holiday", "makeup_workday"] },
    source_url: { type: "string", description: "gov.cn notice the answer is based on" },
    data_updated: { ...DATE_SCHEMA, description: "Publication date of the newest notice in the dataset" },
  },
  required: [
    "date",
    "weekday",
    "is_workday",
    "is_public_holiday",
    "is_makeup_workday",
    "holiday_name",
    "kind",
    "source_url",
    "data_updated",
  ],
  additionalProperties: false,
};

export const BUSINESS_DAYS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    from: { ...DATE_SCHEMA, description: "First date, inclusive (YYYY-MM-DD)" },
    to: { ...DATE_SCHEMA, description: `Last date, inclusive (YYYY-MM-DD); at most ${MAX_RANGE_DAYS} days after counting both ends` },
  },
  required: ["from", "to"],
  additionalProperties: false,
};

export const BUSINESS_DAYS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    from: DATE_SCHEMA,
    to: DATE_SCHEMA,
    calendar_days: { type: "integer", minimum: 1, maximum: MAX_RANGE_DAYS },
    workday_count: { type: "integer", minimum: 0 },
    workdays: { type: "array", items: DATE_SCHEMA, description: "Every working day in the range, ascending" },
    data_updated: DATE_SCHEMA,
  },
  required: ["from", "to", "calendar_days", "workday_count", "workdays", "data_updated"],
  additionalProperties: false,
};

export const WORKDAY_EXAMPLE_INPUT = { date: "2026-02-14" };
export const WORKDAY_EXAMPLE_OUTPUT = { ...calendar.lookup("2026-02-14"), data_updated: calendar.dataUpdated };
export const BUSINESS_DAYS_EXAMPLE_INPUT = { from: "2026-09-28", to: "2026-10-11" };
export const BUSINESS_DAYS_EXAMPLE_OUTPUT = {
  ...calendar.businessDays("2026-09-28", "2026-10-11"),
  data_updated: calendar.dataUpdated,
};

export const WORKDAY_DESCRIPTION =
  "Is a given date a working day in mainland China? Applies the State Council (国务院) holiday notice: " +
  "public holiday periods, weekend makeup workdays (调休补班) and ordinary weekends. Returns holiday name and source link.";
export const BUSINESS_DAYS_DESCRIPTION =
  "Count and list mainland China working days between two dates (inclusive, up to 366 days, may cross years), " +
  "honouring official holidays and weekend makeup workdays (调休补班) from State Council notices.";

export interface PriceInfo {
  network: string;
  workdayPrice: string;
  businessDaysPrice: string;
  advisoriesPrice: string;
  batchPrice: string;
  insiderTradesPrice: string;
  latestFilingsPrice: string;
  /** Free MCP tool calls per source IP per day. */
  freePerIpDaily: number;
}

/** Structured x-payment-info (x402scan / AgentCash discovery spec v1). */
const paymentInfo = (price: string) => ({
  price: { mode: "fixed", currency: "USD", amount: price.replace(/^\$/, "") },
  protocols: [{ x402: {} }],
});

/** Per-package price of a full batch, e.g. "$0.0004" for $0.02 / 50. */
export const perPackagePrice = (batchPrice: string) => `$${Number((Number(batchPrice.replace(/^\$/, "")) / MAX_BATCH).toPrecision(6))}`;

export function openApi(baseUrl: string, p: PriceInfo) {
  const b64 = { type: "string", description: "Base64-encoded JSON (x402 v2)" };
  const paid = (price: string) => ({
    description: `Payment required (x402 v2). Price ${price} USDC on ${p.network}. Decode the PAYMENT-REQUIRED header, sign one of its accepts, and retry with a PAYMENT-SIGNATURE header. Returned for a request with no parameters at all, so a probe sees the price. Also returned when a payment is rejected or settlement fails; no content is sent in that case.`,
    headers: {
      "PAYMENT-REQUIRED": { ...b64, description: "Base64 JSON PaymentRequired: x402Version, accepts[] (scheme, network, asset, amount, payTo), resource, extensions, error" },
      "PAYMENT-RESPONSE": { ...b64, description: "Base64 JSON settlement result; present when settlement was attempted and failed" },
    },
    content: { "application/json": { schema: { type: "object", description: "price, network, how_to_pay, docs and an example request/response" } } },
  });
  const ok = (description: string, schema: unknown, example: unknown) => ({
    description,
    headers: { "PAYMENT-RESPONSE": { ...b64, description: "Base64 JSON SettleResponse: success, transaction (tx hash), network, payer" } },
    content: { "application/json": { schema, example } },
  });
  const err = { description: "Invalid input or date outside the covered range. Not charged." };
  const upstream = { description: "Facilitator unavailable or returned an error. Not charged; retry later." };
  const osvDown = { description: "OSV.dev unavailable, timed out (5 s) or returned an error, or the facilitator failed. Not charged; retry later." };
  const depsErr = { description: "Invalid ecosystem, name, version or batch body. Not charged." };
  const secErr = { description: "Invalid ticker, cik, form or limit. Not charged." };
  const secNotFound = { description: "Ticker or CIK not known to SEC EDGAR (checked after payment). Not charged." };
  const secDown = { description: "SEC EDGAR unavailable, timed out or returned an error, or the facilitator failed. Not charged; retry later." };
  const secParams = (schema: { properties: Record<string, unknown> }) =>
    Object.entries(schema.properties).map(([name, s]) => ({ name, in: "query", required: false, schema: s }));
  // security: [] marks a route as public; paid routes are marked by x-payment-info.
  const free = (summary: string) => ({ get: { summary, security: [], responses: { "200": { description: "ok" } } } });
  return {
    openapi: "3.1.0",
    info: {
      title: SITE_NAME,
      version: "1.2.0",
      description:
        // `npx agentcash add` copies this unquoted into YAML frontmatter, so no ": " or " #" (test/app.test.ts checks).
        `Pay-per-call x402 APIs (USDC). ${SERVICE_NAME} — is a date a working day in mainland China (holidays, 调休). ` +
        `${DEPS_SERVICE_NAME} — is an npm, PyPI, Go, crates.io or Maven version safe to install; batch ${perPackagePrice(p.batchPrice)}/package. ` +
        `SEC EDGAR — insider trading (Form 4) and filings by ticker.`,
      contact: { name: "Source and issues", url: REPO_URL },
      "x-guidance":
        "Call a paid route without payment to get a 402 with the price; pay with x402 v2 (exact, USDC) and retry with PAYMENT-SIGNATURE. " +
        "Invalid input gets a free 400/404 first; 502 means upstream failed and nothing was charged. Batch package checks are cheaper per package.",
    },
    "x-discovery": { llmsTxtUrl: `${baseUrl}/llms.txt` },
    servers: [{ url: baseUrl }],
    tags: [
      { name: SERVICE_NAME, description: `Data ${calendar.firstDate}..${calendar.lastDate} from State Council (国务院) holiday notices on gov.cn, updated ${calendar.dataUpdated}.` },
      { name: DEPS_SERVICE_NAME, description: OSV_ATTRIBUTION },
      { name: SEC_SERVICE_NAME, description: SEC_ATTRIBUTION },
    ],
    paths: {
      "/cn/workday": {
        get: {
          summary: WORKDAY_DESCRIPTION,
          tags: [SERVICE_NAME],
          "x-payment-info": paymentInfo(p.workdayPrice),
          "x-x402-price": p.workdayPrice,
          parameters: [{ name: "date", in: "query", required: true, schema: WORKDAY_INPUT_SCHEMA.properties.date }],
          responses: {
            "200": ok("Day classification", WORKDAY_OUTPUT_SCHEMA, WORKDAY_EXAMPLE_OUTPUT),
            "400": err,
            "402": paid(p.workdayPrice),
            "404": err,
            "502": upstream,
          },
        },
      },
      "/cn/business-days": {
        get: {
          summary: BUSINESS_DAYS_DESCRIPTION,
          tags: [SERVICE_NAME],
          "x-payment-info": paymentInfo(p.businessDaysPrice),
          "x-x402-price": p.businessDaysPrice,
          parameters: [
            { name: "from", in: "query", required: true, schema: BUSINESS_DAYS_INPUT_SCHEMA.properties.from },
            { name: "to", in: "query", required: true, schema: BUSINESS_DAYS_INPUT_SCHEMA.properties.to },
          ],
          responses: {
            "200": ok("Workdays in range", BUSINESS_DAYS_OUTPUT_SCHEMA, BUSINESS_DAYS_EXAMPLE_OUTPUT),
            "400": err,
            "402": paid(p.businessDaysPrice),
            "404": err,
            "502": upstream,
          },
        },
      },
      "/deps/advisories": {
        get: {
          summary: ADVISORIES_DESCRIPTION,
          tags: [DEPS_SERVICE_NAME],
          "x-payment-info": paymentInfo(p.advisoriesPrice),
          "x-x402-price": p.advisoriesPrice,
          parameters: (["ecosystem", "name", "version"] as const).map((n) => ({
            name: n,
            in: "query",
            required: true,
            schema: ADVISORIES_INPUT_SCHEMA.properties[n],
          })),
          responses: {
            "200": ok("Advisories affecting this version", ADVISORIES_OUTPUT_SCHEMA, ADVISORIES_EXAMPLE_OUTPUT),
            "400": depsErr,
            "402": paid(p.advisoriesPrice),
            "502": osvDown,
          },
        },
      },
      "/deps/advisories/batch": {
        post: {
          summary: BATCH_DESCRIPTION,
          tags: [DEPS_SERVICE_NAME],
          "x-payment-info": paymentInfo(p.batchPrice),
          "x-x402-price": p.batchPrice,
          requestBody: { required: true, content: { "application/json": { schema: BATCH_INPUT_SCHEMA, example: BATCH_EXAMPLE_INPUT } } },
          responses: {
            "200": ok("Advisories per package, in request order", BATCH_OUTPUT_SCHEMA, BATCH_EXAMPLE_OUTPUT),
            "400": depsErr,
            "402": paid(p.batchPrice),
            "502": osvDown,
          },
        },
      },
      "/sec/insider-trades": {
        get: {
          summary: INSIDER_TRADES_DESCRIPTION,
          description: "Pass exactly one of ticker or cik.",
          tags: [SEC_SERVICE_NAME],
          "x-payment-info": paymentInfo(p.insiderTradesPrice),
          "x-x402-price": p.insiderTradesPrice,
          parameters: secParams(INSIDER_TRADES_INPUT_SCHEMA),
          responses: {
            "200": ok("Form 4 insider transactions, newest filing first", INSIDER_TRADES_OUTPUT_SCHEMA, INSIDER_TRADES_EXAMPLE_OUTPUT),
            "400": secErr,
            "402": paid(p.insiderTradesPrice),
            "404": secNotFound,
            "502": secDown,
          },
        },
      },
      "/sec/latest-filings": {
        get: {
          summary: LATEST_FILINGS_DESCRIPTION,
          description: "Pass exactly one of ticker or cik.",
          tags: [SEC_SERVICE_NAME],
          "x-payment-info": paymentInfo(p.latestFilingsPrice),
          "x-x402-price": p.latestFilingsPrice,
          parameters: secParams(LATEST_FILINGS_INPUT_SCHEMA),
          responses: {
            "200": ok("Latest filings, newest first", LATEST_FILINGS_OUTPUT_SCHEMA, LATEST_FILINGS_EXAMPLE_OUTPUT),
            "400": secErr,
            "402": paid(p.latestFilingsPrice),
            "404": secNotFound,
            "502": secDown,
          },
        },
      },
      "/mcp": {
        post: {
          summary: `MCP server, Streamable HTTP, stateless JSON-RPC (free, ${p.freePerIpDaily} tool calls per IP per day, then the tool error names the paid x402 route)`,
          description: `Tools cn_workday_check and package_advisories. Add with: ${mcpAddCommand(baseUrl)}`,
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: "One JSON-RPC 2.0 message (initialize, tools/list, tools/call, ping)" } } } },
          responses: {
            "200": { description: "JSON-RPC response", content: { "application/json": { schema: { type: "object" } } } },
            "202": { description: "Notification accepted, no body" },
            "400": { description: "Not a JSON-RPC message, or unsupported MCP-Protocol-Version" },
          },
        },
      },
      "/.well-known/mcp.json": free("MCP server manifest: endpoint, tools, free quota and prices (free)"),
      "/health": free("Liveness check (free)"),
      "/llms.txt": free("Agent-oriented summary of these APIs (free)"),
      "/SKILL.md": free("Agent skill (AgentSkills SKILL.md): endpoints, prices, examples and how to pay (free)"),
    },
  };
}

/**
 * AgentCash one-line setup, `add` first: it needs no wallet. `add` registers this origin in AgentCash's origin list and
 * installs a pointer skill (built from openapi info.title/description) that runs `npx agentcash discover`; it does not
 * read /SKILL.md. `try` and `onboard` create a wallet in ~/.agentcash on first run.
 */
export const agentcashCommands = (baseUrl: string) => [
  `npx agentcash add ${baseUrl}`,
  `npx agentcash try ${baseUrl}`,
  "npx agentcash onboard",
];
export const INSTALL_HEADING = "Use from Claude Code / Cursor / Codex";
export const MCP_HEADING = "MCP server (free daily quota)";
/** One paragraph on the free MCP endpoint, shared by the preview page, llms.txt and SKILL.md. */
export const mcpBlurb = (baseUrl: string, p: PriceInfo) =>
  `Remote MCP server (Streamable HTTP) at ${baseUrl}/mcp with tools cn_workday_check and package_advisories. ` +
  `${p.freePerIpDaily} free calls per IP address per day, no sign-up. After that each tool call returns an error naming the x402 URL and price of the same lookup, ` +
  `with a payment link {url, status: 402, challenge} in structuredContent. ` +
  `${baseUrl}${PAID_MCP_PATH} is the same server without the free calls, for x402 MCP clients and paid-MCP directories: every tool call returns that payment link; pay the URL over x402. ${PRIVACY_NOTE}`;

export function llmsTxt(baseUrl: string, p: PriceInfo): string {
  return `# ${SITE_NAME}

> Pay-per-call APIs for agents, paid with USDC via x402 v2 (scheme "exact", network ${p.network}). A request with no parameters returns 402 with the price and an example. Invalid input is rejected with a free 400/404 before any payment is requested; upstream or facilitator failures return 502 and are not charged.

## ${INSTALL_HEADING}

${agentcashCommands(baseUrl).join("\n")}

\`add\` needs no wallet; \`try\` and \`onboard\` create an AgentCash wallet on first run. Agent skill: ${baseUrl}/SKILL.md

## ${MCP_HEADING}

${mcpAddCommand(baseUrl)}

${mcpBlurb(baseUrl, p)} Manifest: ${baseUrl}/.well-known/mcp.json

## ${SERVICE_NAME}

Whether a date is a working day in mainland China, including official holidays and weekend makeup workdays (调休补班) from State Council (国务院) notices. Coverage ${calendar.firstDate} to ${calendar.lastDate}, data updated ${calendar.dataUpdated}.

- [GET ${baseUrl}/cn/workday?date=YYYY-MM-DD](${baseUrl}/cn/workday?date=2026-02-14): ${p.workdayPrice}. ${WORKDAY_DESCRIPTION}
- [GET ${baseUrl}/cn/business-days?from=YYYY-MM-DD&to=YYYY-MM-DD](${baseUrl}/cn/business-days?from=2026-09-28&to=2026-10-11): ${p.businessDaysPrice}. ${BUSINESS_DAYS_DESCRIPTION}

Example: GET /cn/workday?date=2026-02-14 returns
${JSON.stringify(WORKDAY_EXAMPLE_OUTPUT)}

## ${DEPS_SERVICE_NAME}

Is this package version safe to install? Known vulnerabilities for an exact version. Ecosystems: ${ECOSYSTEMS.join(", ")}.

- [GET ${baseUrl}/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20](${baseUrl}/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20): ${p.advisoriesPrice}. ${ADVISORIES_DESCRIPTION}
- POST ${baseUrl}/deps/advisories/batch with JSON {"packages":[{"ecosystem","name","version"}, ...]} (max ${MAX_BATCH}): ${p.batchPrice}. ${BATCH_DESCRIPTION}

Example: GET /deps/advisories?${new URLSearchParams(ADVISORIES_EXAMPLE_INPUT)} returns (trimmed to one advisory)
${JSON.stringify(ADVISORIES_EXAMPLE_OUTPUT)}

${OSV_ATTRIBUTION}

## ${SEC_SERVICE_NAME}

Insider trading and SEC filings for US public companies, by stock ticker or CIK, from SEC EDGAR.

- [GET ${baseUrl}/sec/insider-trades?ticker=AAPL](${baseUrl}/sec/insider-trades?ticker=AAPL): ${p.insiderTradesPrice}. ${INSIDER_TRADES_DESCRIPTION}
- [GET ${baseUrl}/sec/latest-filings?ticker=AAPL&form=8-K&limit=2](${baseUrl}/sec/latest-filings?ticker=AAPL&form=8-K&limit=2): ${p.latestFilingsPrice}. ${LATEST_FILINGS_DESCRIPTION}

An unknown ticker or CIK returns 404 and is not charged. Example: GET /sec/insider-trades?${new URLSearchParams(INSIDER_TRADES_EXAMPLE_INPUT)} returns (trimmed to one transaction)
${JSON.stringify(INSIDER_TRADES_EXAMPLE_OUTPUT)}

${SEC_ATTRIBUTION}

## Free

- [OpenAPI](${baseUrl}/openapi.json): full input/output JSON schema and examples
- [SKILL.md](${baseUrl}/SKILL.md): agent skill with endpoints, prices and examples
- [Preview page](${baseUrl}/)
- [Source code and data](${REPO_URL})
`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function previewHtml(baseUrl: string, p: PriceInfo, sources: { year: number; source_url: string }[]): string {
  const sourceList = sources
    .map((s) => `<li>${s.year}: <a href="${esc(s.source_url)}">${esc(s.source_url)}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SITE_NAME}</title>
<link rel="icon" href="/favicon.ico" type="image/x-icon">
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#222}code,pre{background:#f4f4f4;border-radius:4px}pre{padding:.8rem;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:.3rem .6rem;text-align:left}</style>
</head><body>
<h1>${SITE_NAME}</h1>
<section id="install">
<h2>${INSTALL_HEADING}</h2>
<p>Run in your terminal to add these APIs to your agent with <a href="https://github.com/Merit-Systems/agentcash">AgentCash</a>; any other x402 client works too. <code>add</code> needs no wallet; <code>try</code> and <code>onboard</code> create an AgentCash wallet on first run.</p>
<pre>${agentcashCommands(baseUrl).map(esc).join("\n")}</pre>
<h3>${MCP_HEADING}</h3>
<pre>${esc(mcpAddCommand(baseUrl))}</pre>
<p>${esc(mcpBlurb(baseUrl, p))} Manifest: <a href="/.well-known/mcp.json">/.well-known/mcp.json</a>.</p>
</section>
<p>Pay-per-call data for AI agents, paid with USDC over <a href="https://www.x402.org">x402</a> on <code>${esc(p.network)}</code>. Full schemas: <a href="/openapi.json">/openapi.json</a>. Agent summary: <a href="/llms.txt">/llms.txt</a>. Agent skill: <a href="/SKILL.md">/SKILL.md</a>.</p>
<table><tr><th>Endpoint</th><th>Price</th></tr>
<tr><td><code>GET /cn/workday?date=YYYY-MM-DD</code></td><td>${esc(p.workdayPrice)}</td></tr>
<tr><td><code>GET /cn/business-days?from=YYYY-MM-DD&amp;to=YYYY-MM-DD</code> (≤ ${MAX_RANGE_DAYS} days)</td><td>${esc(p.businessDaysPrice)}</td></tr>
<tr><td><code>GET /deps/advisories?ecosystem=&amp;name=&amp;version=</code></td><td>${esc(p.advisoriesPrice)}</td></tr>
<tr><td><code>POST /deps/advisories/batch</code> (≤ ${MAX_BATCH} packages)</td><td>${esc(p.batchPrice)}</td></tr>
<tr><td><code>GET /sec/insider-trades?ticker=</code> (or <code>cik=</code>)</td><td>${esc(p.insiderTradesPrice)}</td></tr>
<tr><td><code>GET /sec/latest-filings?ticker=&amp;form=&amp;limit=</code></td><td>${esc(p.latestFilingsPrice)}</td></tr></table>
<h1>${SERVICE_NAME}</h1>
<p>中国法定节假日与调休工作日查询。A pay-per-call API for AI agents: is a date a working day in mainland China, counting official holidays and weekend makeup workdays (调休补班) from State Council notices. Paid with USDC over <a href="https://www.x402.org">x402</a> on <code>${esc(p.network)}</code>.</p>
<p>Coverage <b>${calendar.firstDate}</b> to <b>${calendar.lastDate}</b>. Data updated <b>${calendar.dataUpdated}</b>.</p>
<h2>Example</h2>
<p><code>GET ${esc(baseUrl)}/cn/workday?date=2026-02-14</code></p>
<pre>${esc(JSON.stringify(WORKDAY_EXAMPLE_OUTPUT, null, 2))}</pre>
<h2>Schema</h2>
<p>Full input and output schemas: <a href="/openapi.json">/openapi.json</a>. Agent summary: <a href="/llms.txt">/llms.txt</a>.</p>
<pre>${esc(JSON.stringify(WORKDAY_OUTPUT_SCHEMA, null, 2))}</pre>
<h2>Sources</h2>
<p>Each year follows the State Council (国务院办公厅) holiday notice on gov.cn as actually applied nationwide. 2020 includes the Spring Festival extension (国办发明电〔2020〕1号): holiday until 2020-02-02, work resumed 2020-02-03. Provincial schedules are not included.</p>
<ul>${sourceList}</ul>
<h1>${DEPS_SERVICE_NAME}</h1>
<p>Known security advisories affecting one exact package version (${ECOSYSTEMS.join(", ")}): CVE aliases, CVSS, affected ranges, fixed versions and links. Fetched live from OSV.dev and cached up to one hour; if OSV.dev is down the call fails with 502 and is not charged.</p>
<h2>Example</h2>
<p><code>GET ${esc(baseUrl)}/deps/advisories?ecosystem=npm&amp;name=lodash&amp;version=4.17.20</code> (trimmed to one advisory)</p>
<pre>${esc(JSON.stringify(ADVISORIES_EXAMPLE_OUTPUT, null, 2))}</pre>
<h2>Sources and licenses</h2>
<p>${esc(OSV_ATTRIBUTION)} See <a href="https://google.github.io/osv.dev/data/">OSV.dev data sources</a>.</p>
<h1>${SEC_SERVICE_NAME}</h1>
<p>${esc(INSIDER_TRADES_DESCRIPTION)}</p>
<p>${esc(LATEST_FILINGS_DESCRIPTION)}</p>
<h2>Example</h2>
<p><code>GET ${esc(baseUrl)}/sec/insider-trades?ticker=AAPL</code> (trimmed to one transaction)</p>
<pre>${esc(JSON.stringify(INSIDER_TRADES_EXAMPLE_OUTPUT, null, 2))}</pre>
<p><code>GET ${esc(baseUrl)}/sec/latest-filings?${esc(new URLSearchParams(LATEST_FILINGS_EXAMPLE_INPUT).toString())}</code></p>
<pre>${esc(JSON.stringify(LATEST_FILINGS_EXAMPLE_OUTPUT, null, 2))}</pre>
<h2>Source</h2>
<p>${esc(SEC_ATTRIBUTION)}</p>
<p><a href="${REPO_URL}">Source code and data</a></p>
</body></html>`;
}

/** Frontmatter description (AgentSkills: at most 1024 characters, says what the skill does and when to use it). */
export const SKILL_DESCRIPTION =
  "Pay-per-call x402 APIs (Base USDC). 1) China workday calendar: is a date a working day in mainland China, " +
  "with official public holidays and weekend makeup workdays from State Council (国务院) notices, each answer linking the gov.cn source; " +
  "count working days between two dates. 中国法定节假日、调休、补班、工作日判断、工作日天数计算，附国务院通知原文链接。 " +
  "2) Package vulnerability advisories: is this npm, PyPI, Go, crates.io or Maven package version safe to install (CVE, GHSA, fixed versions, OSV.dev); " +
  "npm/PyPI 等包安全公告、依赖漏洞检查。 " +
  "3) SEC EDGAR: insider trading (Form 4 buys and sells by directors and officers) and latest SEC filings (8-K, 10-K, 10-Q) for a US stock ticker. " +
  "Use when a task needs China business days or holiday schedules, before adding or upgrading a dependency, or to check insider trades and recent SEC filings of a company.";

export function skillMd(baseUrl: string, p: PriceInfo, sources: { year: number; source_url: string }[]): string {
  const sourceList = sources.map((s) => `- ${s.year}: ${s.source_url}`).join("\n");
  const batchBody = JSON.stringify(BATCH_EXAMPLE_INPUT);
  return `---
name: cn-workday-package-advisories
description: ${JSON.stringify(SKILL_DESCRIPTION)}
---

# ${SITE_NAME}

Base URL: ${baseUrl}

## Setup

${agentcashCommands(baseUrl).map((c) => `    ${c}`).join("\n")}

\`add\` registers this origin with AgentCash and installs a small skill that runs \`npx agentcash discover\`; it needs no wallet. \`try\` and \`onboard\` create an AgentCash wallet on first run. You do not need AgentCash: any x402 v2 client works (see Payment).

## ${MCP_HEADING}

    ${mcpAddCommand(baseUrl)}

${mcpBlurb(baseUrl, p)}

## Endpoints

### GET /cn/workday?date=YYYY-MM-DD (${p.workdayPrice})

${WORKDAY_DESCRIPTION} Covers ${calendar.firstDate} to ${calendar.lastDate}.

Example: \`GET ${baseUrl}/cn/workday?${new URLSearchParams(WORKDAY_EXAMPLE_INPUT)}\` returns

    ${JSON.stringify(WORKDAY_EXAMPLE_OUTPUT)}

### GET /cn/business-days?from=YYYY-MM-DD&to=YYYY-MM-DD (${p.businessDaysPrice})

${BUSINESS_DAYS_DESCRIPTION}

Example: \`GET ${baseUrl}/cn/business-days?${new URLSearchParams(BUSINESS_DAYS_EXAMPLE_INPUT)}\` returns \`workday_count\` and the list \`workdays\`.

### GET /deps/advisories?ecosystem=&name=&version= (${p.advisoriesPrice})

${ADVISORIES_DESCRIPTION} Ecosystems: ${ECOSYSTEMS.join(", ")}.

Example: \`GET ${baseUrl}/deps/advisories?${new URLSearchParams(ADVISORIES_EXAMPLE_INPUT)}\` returns \`vulnerable\` and \`advisories\`.

### POST /deps/advisories/batch (${p.batchPrice})

${BATCH_DESCRIPTION}

Example: \`POST ${baseUrl}/deps/advisories/batch\` with JSON body \`${batchBody}\` (up to ${MAX_BATCH} packages).

### GET /sec/insider-trades?ticker= (or cik=) (${p.insiderTradesPrice})

${INSIDER_TRADES_DESCRIPTION}

Example: \`GET ${baseUrl}/sec/insider-trades?${new URLSearchParams(INSIDER_TRADES_EXAMPLE_INPUT)}\` returns \`transactions\` with insider, code, shares and price.

### GET /sec/latest-filings?ticker=&form=&limit= (${p.latestFilingsPrice})

${LATEST_FILINGS_DESCRIPTION}

Example: \`GET ${baseUrl}/sec/latest-filings?${new URLSearchParams(LATEST_FILINGS_EXAMPLE_INPUT)}\` returns the two latest 8-K filings with their items.

Full input and output schemas: ${baseUrl}/openapi.json

## Payment

Any x402 v2 client pays USDC on Base (network ${p.network}, scheme "exact"): agentcash, @x402/fetch (2.x), or Binance \`baw x402-payment\`.
Call the endpoint without payment to get a 402 with the price in the PAYMENT-REQUIRED header and the JSON body, sign one of its accepts, and retry with a PAYMENT-SIGNATURE header.
Invalid input gets a free 400/404 before any payment is asked for. A 502 (upstream or facilitator failure) is not charged.

## Sources

China calendar data follows the State Council General Office (国务院办公厅) holiday notices on gov.cn, data updated ${calendar.dataUpdated}:

${sourceList}

${OSV_ATTRIBUTION}

${SEC_ATTRIBUTION}

Source code and data: ${REPO_URL}
`;
}

/** 32x32 icon (ICO wrapping a PNG): white frame and dot on blue. Served at /favicon.ico; the PNG inside is ICON_PNG. */
export const FAVICON_ICO = Uint8Array.from(
  atob(
    "AAABAAEAICAAAAEAIACFAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAExJREFUeNpj+D/AgGHQOEA+/zVd8agDRh0w6oCh7wB0QDcHEAI0dQCxYHg6gFQw6oDh54DRXDAoCqJBURSP1oajDhh1wPB1wIjtHQMA+bT2JiCso/cAAAAASUVORK5CYII=",
  ),
  (ch) => ch.charCodeAt(0),
);
/** The PNG inside FAVICON_ICO (one image, data at offset 22). Served at /icon.png and used as the x402 iconUrl: CDP's listed icon formats do not include ICO. */
export const ICON_PNG = FAVICON_ICO.subarray(22);
