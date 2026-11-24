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

export const SERVICE_NAME = "China Workday Calendar";
export const TAGS = ["calendar", "holidays", "china", "business-days", "workday"];
export const REPO_URL = "https://github.com/walkley/x402-content-site";
export const SITE_NAME = "China Workday Calendar and Package Vulnerability Advisories (x402 pay-per-call APIs)";

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
  // security: [] marks a route as public; paid routes are marked by x-payment-info.
  const free = (summary: string) => ({ get: { summary, security: [], responses: { "200": { description: "ok" } } } });
  return {
    openapi: "3.1.0",
    info: {
      title: SITE_NAME,
      version: "1.2.0",
      description:
        `Pay-per-call x402 APIs (USDC). ${SERVICE_NAME}: is a date a working day in mainland China, with official holidays and makeup workdays (调休). ` +
        `${DEPS_SERVICE_NAME}: is this npm, PyPI, Go, crates.io or Maven package version safe to install; batch ${perPackagePrice(p.batchPrice)} per package.`,
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
      "/health": free("Liveness check (free)"),
      "/llms.txt": free("Agent-oriented summary of these APIs (free)"),
      "/SKILL.md": free("Agent skill (AgentSkills SKILL.md): endpoints, prices, examples and how to pay (free)"),
    },
  };
}

/** AgentCash one-line setup: `add` installs the origin's routes into the agent directly, without the AgentCash catalog. */
export const agentcashCommands = (baseUrl: string) => [
  "npx agentcash onboard",
  `npx agentcash try ${baseUrl}`,
  `npx agentcash add ${baseUrl}`,
];
export const INSTALL_HEADING = "Use from Claude Code / Cursor / Codex";

export function llmsTxt(baseUrl: string, p: PriceInfo): string {
  return `# ${SITE_NAME}

> Pay-per-call APIs for agents, paid with USDC via x402 v2 (scheme "exact", network ${p.network}). A request with no parameters returns 402 with the price and an example. Invalid input is rejected with a free 400/404 before any payment is requested; upstream or facilitator failures return 502 and are not charged.

## ${INSTALL_HEADING}

${agentcashCommands(baseUrl).join("\n")}

Agent skill: ${baseUrl}/SKILL.md

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
<p>Run in your terminal to add these APIs to your agent with <a href="https://github.com/Merit-Systems/agentcash">AgentCash</a>; any other x402 client works too.</p>
<pre>${agentcashCommands(baseUrl).map(esc).join("\n")}</pre>
</section>
<p>Pay-per-call data for AI agents, paid with USDC over <a href="https://www.x402.org">x402</a> on <code>${esc(p.network)}</code>. Full schemas: <a href="/openapi.json">/openapi.json</a>. Agent summary: <a href="/llms.txt">/llms.txt</a>. Agent skill: <a href="/SKILL.md">/SKILL.md</a>.</p>
<table><tr><th>Endpoint</th><th>Price</th></tr>
<tr><td><code>GET /cn/workday?date=YYYY-MM-DD</code></td><td>${esc(p.workdayPrice)}</td></tr>
<tr><td><code>GET /cn/business-days?from=YYYY-MM-DD&amp;to=YYYY-MM-DD</code> (≤ ${MAX_RANGE_DAYS} days)</td><td>${esc(p.businessDaysPrice)}</td></tr>
<tr><td><code>GET /deps/advisories?ecosystem=&amp;name=&amp;version=</code></td><td>${esc(p.advisoriesPrice)}</td></tr>
<tr><td><code>POST /deps/advisories/batch</code> (≤ ${MAX_BATCH} packages)</td><td>${esc(p.batchPrice)}</td></tr></table>
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
<p><a href="${REPO_URL}">Source code and data</a></p>
</body></html>`;
}

/** Frontmatter description (AgentSkills: at most 1024 characters, says what the skill does and when to use it). */
export const SKILL_DESCRIPTION =
  "Pay-per-call x402 APIs (Base USDC). 1) China workday calendar: is a date a working day in mainland China, " +
  "with official public holidays and weekend makeup workdays from State Council (国务院) notices, each answer linking the gov.cn source; " +
  "count working days between two dates. 中国法定节假日、调休、补班、工作日判断、工作日天数计算，附国务院通知原文链接。 " +
  "2) Package vulnerability advisories: is this npm, PyPI, Go, crates.io or Maven package version safe to install (CVE, GHSA, fixed versions, OSV.dev); " +
  "npm/PyPI 等包安全公告、依赖漏洞检查。Use when a task needs China business days or holiday schedules, or before adding or upgrading a dependency.";

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

\`add\` saves these routes in AgentCash so the agent can call them later. You do not need AgentCash: any x402 client works (see Payment).

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

Full input and output schemas: ${baseUrl}/openapi.json

## Payment

Any x402 v2 client pays USDC on Base (network ${p.network}, scheme "exact"): agentcash, x402-fetch / @x402/fetch, or Binance \`baw x402-payment\`.
Call the endpoint without payment to get a 402 with the price in the PAYMENT-REQUIRED header and the JSON body, sign one of its accepts, and retry with a PAYMENT-SIGNATURE header.
Invalid input gets a free 400/404 before any payment is asked for. A 502 (upstream or facilitator failure) is not charged.

## Sources

China calendar data follows the State Council General Office (国务院办公厅) holiday notices on gov.cn, data updated ${calendar.dataUpdated}:

${sourceList}

${OSV_ATTRIBUTION}

Source code and data: ${REPO_URL}
`;
}

/** 32x32 icon (ICO wrapping a PNG): white frame and dot on blue. Served at /favicon.ico and used as the x402 iconUrl. */
export const FAVICON_ICO = Uint8Array.from(
  atob(
    "AAABAAEAICAAAAEAIACFAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAExJREFUeNpj+D/AgGHQOEA+/zVd8agDRh0w6oCh7wB0QDcHEAI0dQCxYHg6gFQw6oDh54DRXDAoCqJBURSP1oajDhh1wPB1wIjtHQMA+bT2JiCso/cAAAAASUVORK5CYII=",
  ),
  (ch) => ch.charCodeAt(0),
);
