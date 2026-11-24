// Free MCP endpoint: POST /mcp, Streamable HTTP transport, stateless, JSON responses only (no SSE stream, no session).
// Tool calls use the same calendar data and OSV.dev client as the paid routes. Each call takes one unit of the free
// daily quota; when the quota is used up, or cannot be counted, the tool answers with an error that names the paid
// x402 route. This path never verifies or settles a payment.
import type { Context } from "hono";
import { InputError, MAX_RANGE_DAYS } from "./calendar.js";
import { ECOSYSTEMS, UpstreamError, parsePackageQuery, type OsvClient } from "./advisories.js";
import type { PriceInfo } from "./content.js"; // type only: content.ts imports this module
import { ADVISORIES_INPUT_SCHEMA } from "./content-deps.js";
import { calendar } from "./data.js";
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
  "API Gateway access logs keep the source IP for 30 days.";

export const mcpAddCommand = (baseUrl: string) => `claude mcp add --transport http ${MCP_SERVER_NAME} ${baseUrl}/mcp`;

type McpPrices = PriceInfo;

export interface McpDeps {
  osv: OsvClient;
  quota?: FreeQuota;
  perIpDaily: number;
  globalDaily: number;
  prices: McpPrices;
  baseUrl: (c: Context) => string;
}

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

export const mcpTools = (d: Pick<McpDeps, "perIpDaily">) => [
  {
    name: "cn_workday_check",
    title: "China workday check",
    description:
      "Is a date a working day in mainland China? Applies State Council (国务院) holiday notices: public holidays, weekend makeup " +
      `workdays (调休补班) and ordinary weekends; returns the holiday name and the gov.cn source link. Pass date for one day, or ` +
      `from and to (inclusive, up to ${MAX_RANGE_DAYS} days) to count and list working days. Coverage ${calendar.firstDate}..${calendar.lastDate}. ` +
      `Free for ${d.perIpDaily} calls per day, then pay-per-call over x402.`,
    inputSchema: {
      type: "object",
      properties: {
        date: { ...DATE, description: "One date (YYYY-MM-DD). Do not combine with from/to." },
        from: { ...DATE, description: "Range start, inclusive (YYYY-MM-DD)" },
        to: { ...DATE, description: "Range end, inclusive (YYYY-MM-DD)" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "package_advisories",
    title: "Package vulnerability advisories",
    description:
      `Is this package version safe to install? Known advisories (CVE, GHSA, PYSEC, GO, RUSTSEC) for one exact ${ECOSYSTEMS.join(", ")} ` +
      "package version from OSV.dev: CVSS, affected ranges, fixed versions and links. " +
      `Free for ${d.perIpDaily} calls per day (shared with cn_workday_check), then pay-per-call over x402.`,
    inputSchema: ADVISORIES_INPUT_SCHEMA,
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

/** The paid route that serves the same call, for the over-quota answer. */
function paidRoute(name: string, args: Json, base: string, p: McpPrices) {
  const q = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
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
  const query = parsePackageQuery(args);
  return () => osv.query(query);
}

/** API Gateway HTTP API source IP (hono/aws-lambda passes the event as c.env.event). Never X-Forwarded-For. */
const sourceIpOf = (c: Context): string | undefined =>
  (c.env as { event?: { requestContext?: { http?: { sourceIp?: string } } } } | undefined)?.event?.requestContext?.http?.sourceIp;

const log = (fields: Json) => console.log(JSON.stringify({ ts: new Date().toISOString(), type: "mcp_call", ...fields }));

export function mcpHandler(d: McpDeps) {
  const reasonText = {
    ip_limit: `the ${d.perIpDaily} free calls per day for your IP address are used up`,
    global_limit: `the free tier's daily cap of ${d.globalDaily} calls for all users is reached`,
    unavailable: "the free tier is unavailable right now",
  };

  async function callTool(c: Context, params: Json): Promise<{ error: [number, string] } | { result: unknown }> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Json;
    if (name !== "cn_workday_check" && name !== "package_advisories") return { error: [-32602, `Unknown tool: ${String(name)}`] };
    if (typeof args !== "object" || args === null || Array.isArray(args)) return { error: [-32602, "arguments must be an object"] };
    const request_id = crypto.randomUUID();
    let run: () => Promise<unknown>;
    try {
      run = prepare(name, args, d.osv);
    } catch (e) {
      if (!(e instanceof InputError)) throw e;
      log({ request_id, tool: name, outcome: "invalid_input", reason: e.code });
      return { result: textResult(`${e.code}: ${e.message}. Not counted against the free quota.`, true) };
    }

    let outcome: "ok" | "ip_limit" | "global_limit" | "unavailable";
    const ip = sourceIpOf(c);
    if (!d.quota || !ip) outcome = "unavailable";
    else {
      try {
        outcome = await withTimeout(d.quota.consume(ip), QUOTA_TIMEOUT_MS);
      } catch (e) {
        // Fail closed: a store error never grants a free call; the caller gets the paid route instead of a 500.
        console.error(JSON.stringify({ ts: new Date().toISOString(), type: "quota_error", message: (e as Error).message }));
        outcome = "unavailable";
      }
    }
    if (outcome !== "ok") {
      const base = d.baseUrl(c);
      const paid = paidRoute(name, args, base, d.prices);
      log({ request_id, tool: name, outcome });
      const text =
        `Free MCP quota: ${reasonText[outcome]}. This call is available pay-per-call over x402 ` +
        `(USDC on Base, network ${d.prices.network}, scheme exact):\n` +
        `GET ${paid.url}\nPrice: ${paid.price} USDC per call.\n` +
        `Any x402 v2 client can pay it. Add these paid APIs to your agent: npx agentcash add ${base}\n` +
        `Docs: ${base}/llms.txt`;
      return { result: textResult(text, true) };
    }

    try {
      const data = await run();
      log({ request_id, tool: name, outcome: "ok" });
      return { result: textResult(JSON.stringify(data), false, data) };
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      log({ request_id, tool: name, outcome: "upstream_error" });
      return { result: textResult(`${e.message}. Retry later.`, true) };
    }
  }

  return async (c: Context) => {
    const version = c.req.header("mcp-protocol-version");
    if (version && !MCP_PROTOCOL_VERSIONS.includes(version)) {
      return c.json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${version}; supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}`), 400);
    }
    let msg: unknown;
    try {
      msg = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error: body must be one JSON-RPC message"), 400);
    }
    if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
      return c.json(rpcError(null, -32600, "Invalid request: send one JSON-RPC object (batches are not supported)"), 400);
    }
    const m = msg as Json;
    const hasId = typeof m.id === "string" || typeof m.id === "number";
    const isRequest = m.jsonrpc === "2.0" && typeof m.method === "string" && hasId;
    const isNotification = m.jsonrpc === "2.0" && typeof m.method === "string" && !("id" in m);
    const isResponse = m.jsonrpc === "2.0" && m.method === undefined && hasId && ("result" in m || "error" in m);
    // Only notifications and responses are accepted with 202 and no body; anything else that is not a request is a 400.
    if (isNotification || isResponse) return c.body(null, 202);
    if (!isRequest) return c.json(rpcError(null, -32600, "Invalid request: not a JSON-RPC 2.0 request, notification or response"), 400);
    const id = m.id as Id;
    const params = (m.params ?? {}) as Json;
    switch (m.method) {
      case "initialize": {
        const requested = params.protocolVersion as string;
        return c.json(
          rpcResult(id, {
            protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, title: MCP_TITLE, version: MCP_VERSION },
            instructions:
              `China workday calendar (holidays and 调休 makeup workdays) and package vulnerability advisories. ` +
              `${d.perIpDaily} free tool calls per IP per day; after that each tool error names the paid x402 URL and price.`,
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
    description: "China workday calendar (official holidays, 调休 makeup workdays) and package vulnerability advisories (OSV.dev).",
    version: MCP_VERSION,
    protocolVersions: MCP_PROTOCOL_VERSIONS,
    remotes: [{ type: "streamable-http", url: `${baseUrl}/mcp` }],
    install: { claude_code: mcpAddCommand(baseUrl), agentcash: `npx agentcash add ${baseUrl}` },
    tools: mcpTools(d).map(({ name, description }) => ({ name, description })),
    free_tier: {
      calls_per_ip_per_day: d.perIpDaily,
      global_calls_per_day: d.globalDaily,
      privacy: PRIVACY_NOTE,
      after_quota: "tool error naming the x402 pay-per-call URL and price",
    },
    payment: {
      protocol: "x402 v2",
      network: d.prices.network,
      currency: "USDC",
      prices: {
        cn_workday_check_date: d.prices.workdayPrice,
        cn_workday_check_range: d.prices.businessDaysPrice,
        package_advisories: d.prices.advisoriesPrice,
      },
    },
    documentation: `${baseUrl}/llms.txt`,
    openapi: `${baseUrl}/openapi.json`,
    skill: `${baseUrl}/SKILL.md`,
    repository: "https://github.com/walkley/x402-content-site",
  };
}

/** Rejects after ms; the abandoned promise keeps running and its result is ignored. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`quota timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
