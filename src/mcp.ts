// Free MCP endpoint: POST /mcp, Streamable HTTP transport, stateless, JSON responses only (no SSE stream, no session).
// Tool calls use the same calendar data and OSV.dev client as the paid routes. Each call takes one unit of the free
// daily quota; when the quota is used up, or cannot be counted, the tool answers with an error that names the paid
// x402 route and carries a payment link to it. POST /paid/mcp is the same server without the free quota: every valid
// tool call gets that payment link. Neither path ever verifies or settles a payment.
// sec_insider_trades has no free calls on either path: it never calls SEC, it only validates and returns the payment
// link to GET /sec/insider-trades. The SEC call budget (infra SEC_THROTTLE: at most 8 SEC requests per second for the
// whole API) is spent by the throttled paid routes alone; /mcp's own throttle is not part of that sum.
import type { Context, MiddlewareHandler } from "hono";
import { InputError, MAX_RANGE_DAYS, chinaToday } from "./calendar.js";
import { ECOSYSTEMS, UpstreamError, parsePackageQuery, type OsvClient } from "./advisories.js";
import type { PriceInfo } from "./content.js"; // type only: content.ts imports this module
import { ADVISORIES_INPUT_SCHEMA } from "./content-deps.js";
import { INSIDER_TRADES_INPUT_SCHEMA } from "./content-sec.js";
import { calendar } from "./data.js";
import { parseCompanyQuery } from "./sec.js";
import type { FreeQuota } from "./quota.js";

export const MCP_SERVER_NAME = "cn-calendar";
/** Official MCP Registry name, also in server.json. */
export const MCP_REGISTRY_NAME = "io.github.walkley/cn-calendar";
export const MCP_VERSION = "1.0.0";
export const MCP_TITLE = "China Workday Calendar";
/** Newest first; the server answers initialize with the client's version when it is listed, else the newest. */
// 2025-03-26 is left out (it requires accepting JSON-RPC batches) and 2024-11-05 (HTTP+SSE, not Streamable HTTP).
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];
/** Whole budget for counting one call (two DynamoDB writes and the key read); past it the call gets the paid hint. */
export const QUOTA_TIMEOUT_MS = 3_000;
/** What the free tier keeps about callers. Shown in mcp.json, on /, in llms.txt, SKILL.md and the README. */
export const PRIVACY_NOTE =
  "Quota counters store no raw IP address, only a keyed hash (HMAC-SHA256 of the day and IP), deleted by TTL after 2 days; " +
  "request logs keep only the same hash, which changes every UTC day; API Gateway access logs keep the source IP for 30 days.";

/** Query parameter the over-quota hint adds to the paid URL, so the funnel can tell MCP referrals apart. */
export const MCP_SRC = "mcp";
/** Longest client name/version and User-Agent kept in a log line. */
export const CLIENT_FIELD_MAX = 64;
export const USER_AGENT_MAX = 200;

export const mcpAddCommand = (baseUrl: string) => `claude mcp add --transport http ${MCP_SERVER_NAME} ${baseUrl}/mcp`;

type McpPrices = PriceInfo;

/** The paid MCP endpoint: no free quota, every tool call answers with a payment link to the paid HTTP route. */
export const PAID_MCP_PATH = "/paid/mcp";

export interface McpDeps {
  osv: OsvClient;
  quota?: FreeQuota;
  perIpDaily: number;
  globalDaily: number;
  prices: McpPrices;
  baseUrl: (c: Context) => string;
  /** /paid/mcp: the quota is never asked, every valid tool call gets the payment link. */
  paidOnly?: boolean;
  /**
   * The decoded PAYMENT-REQUIRED of the paid route at this URL (the app requests it in-process), or undefined when
   * the route did not answer 402 with a readable header. Without it the tool error carries the text hint only.
   */
  quote?: (url: string) => Promise<unknown>;
}

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

export const SEC_TOOL = "sec_insider_trades";
/** Ticker used when sec_insider_trades gets no arguments (directory probers send {} when no property is required). */
export const SEC_DEFAULT_TICKER = "AAPL";
const { ticker: TICKER_PROP, cik: CIK_PROP } = INSIDER_TRADES_INPUT_SCHEMA.properties;
// cik without per-property examples: a prober that merges every property's examples would send {ticker, cik}, which
// the tool refuses. The object-level examples show both forms.
const { examples: _cikExamples, ...CIK_NO_EXAMPLES } = CIK_PROP;
const SEC_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ticker: { ...TICKER_PROP, description: `${TICKER_PROP.description} Default: ${SEC_DEFAULT_TICKER}, when ticker and cik are both omitted.`, default: SEC_DEFAULT_TICKER },
    cik: CIK_NO_EXAMPLES,
  },
  additionalProperties: false,
  examples: [{ ticker: SEC_DEFAULT_TICKER }, { cik: "320193" }],
};

export const mcpTools = (d: Pick<McpDeps, "perIpDaily" | "paidOnly">) => [
  {
    name: "cn_workday_check",
    title: "China workday check",
    description:
      "Is a date a working day in mainland China? Applies State Council (国务院) holiday notices: public holidays, weekend makeup " +
      `workdays (调休补班) and ordinary weekends; returns the holiday name and the gov.cn source link. Pass date for one day, or ` +
      `from and to (inclusive, up to ${MAX_RANGE_DAYS} days) to count and list working days; with no arguments it checks today ` +
      `(Asia/Shanghai). Coverage ${calendar.firstDate}..${calendar.lastDate}. ` +
      (d.paidOnly ? "Pay-per-call over x402: the tool answers with a payment link to the paid URL." : `Free for ${d.perIpDaily} calls per day, then pay-per-call over x402.`),
    inputSchema: {
      type: "object",
      properties: {
        date: { ...DATE, description: "One date (YYYY-MM-DD). Do not combine with from/to. Default: today in Asia/Shanghai, when date, from and to are all omitted.", examples: ["2026-10-08"] },
        // No per-property examples on from/to: a prober that merges every property's examples would send
        // {date, from, to}, which the tool refuses. The object-level examples below show the range form.
        from: { ...DATE, description: "Range start, inclusive (YYYY-MM-DD)" },
        to: { ...DATE, description: "Range end, inclusive (YYYY-MM-DD)" },
      },
      additionalProperties: false,
      // date and from/to exclude each other, so whole valid argument objects are listed too (JSON Schema `examples`).
      examples: [{ date: "2026-10-08" }, { from: "2026-10-01", to: "2026-10-31" }],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "package_advisories",
    title: "Package vulnerability advisories",
    description:
      `Is this package version safe to install? Dependency check for install safety before npm install, pip install or cargo add, for one exact ${ECOSYSTEMS.join(", ")} ` +
      "package version. Known OSV.dev advisories (CVE, GHSA, PYSEC, GO, RUSTSEC vulnerabilities and OpenSSF malicious-package MAL- entries) " +
      "with CVSS, affected ranges, fixed versions and links. " +
      (d.paidOnly
        ? "Pay-per-call over x402: the tool answers with a payment link to the paid URL."
        : `Free for ${d.perIpDaily} calls per day (shared with cn_workday_check), then pay-per-call over x402.`),
    // Whole valid argument objects too, as on cn_workday_check (the shared schema is also the HTTP route's).
    inputSchema: { ...ADVISORIES_INPUT_SCHEMA, examples: [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: SEC_TOOL,
    title: "SEC insider trades (Form 4)",
    description:
      "Recent insider trading for a US public company: SEC Form 4 filings parsed into structured JSON (insider name and role, " +
      "transaction date and code, shares, price, shares owned after, Rule 10b5-1 flag, filing link), by stock ticker or SEC CIK. " +
      "Pay-per-call over x402, no free calls: the tool validates the arguments and answers with a payment link to the paid URL " +
      "GET /sec/insider-trades.",
    inputSchema: SEC_TOOL_INPUT_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

type Json = Record<string, unknown>;
type Id = string | number | null;
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (text: string, isError = false, structured?: unknown) => ({
  content: [{ type: "text", text }],
  ...(structured !== undefined ? { structuredContent: structured } : {}),
  ...(isError ? { isError: true } : {}),
});

/**
 * The paid route that serves the same call, for the over-quota answer. The URL ends in src=mcp, which the paid routes
 * only log (validation reads its own parameters by name, and the price does not depend on the query).
 */
function paidRoute(name: string, args: Json, base: string, p: McpPrices) {
  const q = (o: Record<string, unknown>) =>
    new URLSearchParams([...Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]), ["src", MCP_SRC]]).toString();
  if (name === SEC_TOOL) {
    return { url: `${base}/sec/insider-trades?${q({ ticker: args.ticker, cik: args.cik })}`, price: p.insiderTradesPrice };
  }
  if (name === "package_advisories") {
    return { url: `${base}/deps/advisories?${q({ ecosystem: args.ecosystem, name: args.name, version: args.version })}`, price: p.advisoriesPrice };
  }
  if (args.date !== undefined) return { url: `${base}/cn/workday?${q({ date: args.date })}`, price: p.workdayPrice };
  return { url: `${base}/cn/business-days?${q({ from: args.from, to: args.to })}`, price: p.businessDaysPrice };
}

/** Same lookup as the paid route returns. Throws InputError before the quota is touched. */
function prepare(name: string, args: Json, osv: OsvClient): () => Promise<unknown> {
  if (name === "cn_workday_check") {
    const hasRange = args.from !== undefined || args.to !== undefined;
    if (args.date !== undefined && hasRange) throw new InputError("invalid_arguments", "pass either date, or from and to, not both");
    if (args.date !== undefined) {
      const info = calendar.lookup(args.date);
      return async () => ({ ...info, data_updated: calendar.dataUpdated });
    }
    if (!hasRange) throw new InputError("invalid_arguments", "pass date (YYYY-MM-DD), or from and to");
    calendar.validateRange(args.from, args.to);
    return async () => ({ ...calendar.businessDays(args.from, args.to), data_updated: calendar.dataUpdated });
  }
  if (name === SEC_TOOL) {
    // parseCompanyQuery ignores non-strings, which would put e.g. cik=320193 (a number) into a link the paid route rejects.
    for (const k of ["ticker", "cik"] as const) {
      if (args[k] !== undefined && typeof args[k] !== "string") throw new InputError("invalid_arguments", `${k} must be a string`);
    }
    parseCompanyQuery(args);
    return async () => {
      throw new Error(`${SEC_TOOL} has no free calls`); // never run: callTool answers with the payment link first
    };
  }
  const query = parsePackageQuery(args);
  return () => osv.query(query);
}

type ApiGatewayEvent = { requestContext?: { requestId?: string; http?: { sourceIp?: string } } };
const eventOf = (c: Context) => (c.env as { event?: ApiGatewayEvent } | undefined)?.event;
/** API Gateway HTTP API source IP (hono/aws-lambda passes the event as c.env.event). Never X-Forwarded-For. */
export const sourceIpOf = (c: Context): string | undefined => eventOf(c)?.requestContext?.http?.sourceIp;
/** API Gateway's request id, the access log's requestId. */
export const apigwRequestIdOf = (c: Context): string | undefined => eventOf(c)?.requestContext?.requestId;
/** A client-supplied value for a log line: strings only, cut to max. */
export const clip = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
/**
 * Today's keyed hash of the caller's IP (the free quota's HMAC), or undefined when there is no IP or the key is not
 * loaded. Never the raw IP, never throws.
 */
export function ipHashOf(c: Context, quota: FreeQuota | undefined): string | undefined {
  const ip = sourceIpOf(c);
  if (!ip || !quota?.ipHash) return undefined;
  try {
    return quota.ipHash(ip);
  } catch {
    return undefined;
  }
}

const MCP_LOG = "mcpLog";
const fieldsOf = (c: Context): Json => (c.get(MCP_LOG) as Json | undefined) ?? {};

/**
 * One `{"type":"mcp"}` log line per /mcp request, written when the response is ready, whatever answered it (the
 * handler, the Origin check, the body limit, the 405). The handler adds method, client and tool-call fields.
 */
export function mcpRequestLog(quota: FreeQuota | undefined): MiddlewareHandler {
  return async (c, next) => {
    const fields: Json = {};
    c.set(MCP_LOG, fields);
    try {
      await next();
    } finally {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          type: "mcp",
          method: "-",
          path: c.req.path,
          http_method: c.req.method,
          status: c.res.status,
          user_agent: clip(c.req.header("user-agent"), USER_AGENT_MAX),
          ip_hash: ipHashOf(c, quota),
          apigw_request_id: apigwRequestIdOf(c),
          ...fields,
        }),
      );
    }
  };
}

export function mcpHandler(d: McpDeps) {
  const reasonText = {
    ip_limit: `the ${d.perIpDaily} free calls per day for your IP address are used up`,
    global_limit: `the free tier's daily cap of ${d.globalDaily} calls for all users is reached`,
    unavailable: "the free tier is unavailable right now",
    paid_only: `this endpoint (${PAID_MCP_PATH}) has no free tier`,
    paid_tool: `${SEC_TOOL} has no free calls (SEC EDGAR lookups are paid only)`,
  };

  async function callTool(c: Context, params: Json): Promise<{ error: [number, string] } | { result: unknown }> {
    const name = params.name;
    let args = (params.arguments ?? {}) as Json;
    const f = fieldsOf(c);
    f.tool = clip(name, CLIENT_FIELD_MAX);
    if (name !== "cn_workday_check" && name !== "package_advisories" && name !== SEC_TOOL) {
      Object.assign(f, { outcome: "invalid_request", reason: "unknown_tool" });
      return { error: [-32602, `Unknown tool: ${String(name)}`] };
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      Object.assign(f, { outcome: "invalid_request", reason: "arguments_not_object" });
      return { error: [-32602, "arguments must be an object"] };
    }
    // No arguments at all means today in China (directory probers send {} when no property is required).
    if (name === "cn_workday_check" && args.date === undefined && args.from === undefined && args.to === undefined) {
      args = { ...args, date: chinaToday() };
    }
    if (name === SEC_TOOL && args.ticker === undefined && args.cik === undefined) args = { ...args, ticker: SEC_DEFAULT_TICKER };
    let run: () => Promise<unknown>;
    try {
      run = prepare(name, args, d.osv);
    } catch (e) {
      if (!(e instanceof InputError)) throw e;
      Object.assign(f, { outcome: "invalid_input", reason: e.code });
      return { result: textResult(`${e.code}: ${e.message}. Not counted against the free quota.`, true) };
    }

    let outcome: "ok" | "ip_limit" | "global_limit" | "unavailable" | "paid_only" | "paid_tool";
    const ip = sourceIpOf(c);
    if (d.paidOnly) {
      outcome = "paid_only";
    } else if (name === SEC_TOOL) {
      outcome = "paid_tool"; // the free quota is not read or counted
    } else if (!d.quota || !ip) {
      outcome = "unavailable";
      f.reason = d.quota ? "no_source_ip" : "no_quota_store";
    } else {
      try {
        const use = await withTimeout(d.quota.consume(ip), QUOTA_TIMEOUT_MS);
        outcome = use.result;
        f.free_call_n = use.ipCalls;
      } catch (e) {
        // Fail closed: a store error never grants a free call; the caller gets the paid route instead of a 500.
        console.error(JSON.stringify({ ts: new Date().toISOString(), type: "quota_error", message: (e as Error).message }));
        outcome = "unavailable";
        f.reason = e instanceof QuotaTimeoutError ? "quota_timeout" : "quota_error";
      }
    }
    f.outcome = outcome;
    if (outcome !== "ok") {
      const base = d.baseUrl(c);
      const paid = paidRoute(name, args, base, d.prices);
      // Wallet first: `add` only registers this origin and cannot pay without one.
      const text =
        `1. Create an x402 wallet (once): npx agentcash onboard\n` +
        `2. Add these paid APIs to your agent: npx agentcash add ${base}\n` +
        `3. Call it pay-per-call over x402 (USDC on Base, network ${d.prices.network}, scheme exact; any x402 v2 client can pay):\n` +
        `GET ${paid.url}\nPrice: ${paid.price} USDC per call.\n` +
        `Why: ${
          outcome === "paid_only"
            ? `${reasonText[outcome]}; the free quota is at ${base}/mcp`
            : outcome === "paid_tool"
              ? reasonText[outcome]
              : `free MCP quota, ${reasonText[outcome]}`
        }. Docs: ${base}/llms.txt`;
      // Payment link (paidmcp's {url, status: 402, challenge}): the challenge is the paid route's own 402 quote, so its
      // price, payTo and network cannot differ from what that URL charges. Paying happens on the URL, never here.
      const challenge = await d.quote?.(paid.url);
      f.payment_link = challenge !== undefined;
      return { result: textResult(text, true, challenge !== undefined ? { url: paid.url, status: 402, challenge } : undefined) };
    }

    try {
      const data = await run();
      return { result: textResult(JSON.stringify(data), false, data) };
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      Object.assign(f, { outcome: "upstream_error", reason: clip(e.message, USER_AGENT_MAX) });
      return { result: textResult(`${e.message}. Retry later.`, true) };
    }
  }

  return async (c: Context) => {
    const version = c.req.header("mcp-protocol-version");
    if (version && !MCP_PROTOCOL_VERSIONS.includes(version)) {
      return c.json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${version}; supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}`), 400);
    }
    const f = fieldsOf(c);
    let msg: unknown;
    try {
      msg = await c.req.json();
    } catch {
      f.method = "parse_error";
      return c.json(rpcError(null, -32700, "Parse error: body must be one JSON-RPC message"), 400);
    }
    if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
      f.method = "invalid";
      return c.json(rpcError(null, -32600, "Invalid request: send one JSON-RPC object (batches are not supported)"), 400);
    }
    const m = msg as Json;
    const hasId = typeof m.id === "string" || typeof m.id === "number";
    const isRequest = m.jsonrpc === "2.0" && typeof m.method === "string" && hasId;
    const isNotification = m.jsonrpc === "2.0" && typeof m.method === "string" && !("id" in m);
    const isResponse = m.jsonrpc === "2.0" && m.method === undefined && hasId && ("result" in m || "error" in m);
    f.method = isRequest || isNotification ? clip(m.method, CLIENT_FIELD_MAX) : isResponse ? "response" : "invalid";
    // Only notifications and responses are accepted with 202 and no body; anything else that is not a request is a 400.
    if (isNotification || isResponse) return c.body(null, 202);
    if (!isRequest) return c.json(rpcError(null, -32600, "Invalid request: not a JSON-RPC 2.0 request, notification or response"), 400);
    const id = m.id as Id;
    const params = (m.params ?? {}) as Json;
    switch (m.method) {
      case "initialize": {
        const requested = params.protocolVersion as string;
        const info = params.clientInfo as Json | undefined;
        f.client_name = clip(info?.name, CLIENT_FIELD_MAX);
        f.client_version = clip(info?.version, CLIENT_FIELD_MAX);
        return c.json(
          rpcResult(id, {
            protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, title: MCP_TITLE, version: MCP_VERSION },
            instructions: d.paidOnly
              ? `China workday calendar (holidays and 调休 makeup workdays), package vulnerability advisories and SEC insider trades. ` +
                `Paid endpoint, no free calls: each tool call returns a payment link {url, status: 402, challenge} in structuredContent; ` +
                `pay that URL over x402 (HTTP). Free quota: ${d.baseUrl(c)}/mcp.`
              : `China workday calendar (holidays and 调休 makeup workdays), package vulnerability advisories and SEC insider trades. ` +
                `${d.perIpDaily} free tool calls per IP per day; after that each tool error names the paid x402 URL and price. ` +
                `${SEC_TOOL} has no free calls: it always answers with the payment link.`,
          }),
        );
      }
      case "ping":
        return c.json(rpcResult(id, {}));
      case "tools/list":
        return c.json(rpcResult(id, { tools: mcpTools(d) }));
      case "tools/call": {
        const out = await callTool(c, params);
        return c.json("error" in out ? rpcError(id, out.error[0], out.error[1]) : rpcResult(id, out.result));
      }
      default:
        return c.json(rpcError(id, -32601, `Method not found: ${String(m.method)}`));
    }
  };
}

/** /.well-known/mcp.json: where the MCP endpoint is, what it offers and what it costs. */
export function mcpManifest(baseUrl: string, d: Pick<McpDeps, "perIpDaily" | "globalDaily" | "prices">) {
  return {
    name: MCP_REGISTRY_NAME,
    title: MCP_TITLE,
    description:
      "China workday calendar (official holidays, 调休 makeup workdays), package vulnerability advisories (OSV.dev) and SEC insider trades (Form 4, paid only).",
    version: MCP_VERSION,
    protocolVersions: MCP_PROTOCOL_VERSIONS,
    remotes: [{ type: "streamable-http", url: `${baseUrl}/mcp` }],
    paid_mcp: {
      type: "streamable-http",
      url: `${baseUrl}${PAID_MCP_PATH}`,
      purpose:
        "Same tools without the free quota, for x402 MCP clients and directories: every tool call returns a payment link " +
        "{url, status: 402, challenge} in structuredContent; pay that URL over x402 HTTP. Nothing is settled on this endpoint.",
    },
    install: { claude_code: mcpAddCommand(baseUrl), agentcash: `npx agentcash add ${baseUrl}` },
    tools: mcpTools(d).map(({ name, description }) => ({ name, description })),
    free_tier: {
      calls_per_ip_per_day: d.perIpDaily,
      global_calls_per_day: d.globalDaily,
      excluded_tools: [SEC_TOOL],
      excluded_note: `${SEC_TOOL} is not in the free quota: it is paid only and always answers with a payment link.`,
      privacy: PRIVACY_NOTE,
      after_quota: "tool error naming the x402 pay-per-call URL and price, with a payment link {url, status: 402, challenge} in structuredContent",
    },
    payment: {
      protocol: "x402 v2",
      network: d.prices.network,
      currency: "USDC",
      prices: {
        cn_workday_check_date: d.prices.workdayPrice,
        cn_workday_check_range: d.prices.businessDaysPrice,
        package_advisories: d.prices.advisoriesPrice,
        sec_insider_trades: d.prices.insiderTradesPrice,
      },
    },
    documentation: `${baseUrl}/llms.txt`,
    openapi: `${baseUrl}/openapi.json`,
    skill: `${baseUrl}/SKILL.md`,
    repository: "https://github.com/walkley/x402-content-site",
  };
}

class QuotaTimeoutError extends Error {}

/** Rejects after ms; the abandoned promise keeps running and its result is ignored. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QuotaTimeoutError(`quota timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
