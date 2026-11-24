import { AsyncLocalStorage } from "node:async_hooks";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { RouteConfigurationError, paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { FacilitatorTimeoutError, decodePaymentRequiredHeader, type FacilitatorConfig } from "@x402/core/http";
import type { HTTPRequestContext } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { InputError } from "./calendar.js";
import { OsvClient, UpstreamError, parseBatch, parsePackageQuery } from "./advisories.js";
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
  DEPS_TAGS,
} from "./content-deps.js";
import { calendar } from "./data.js";
import { FunnelLogger } from "./funnel.js";
import { mcpHandler, mcpManifest } from "./mcp.js";
import { FREE_GLOBAL_DAILY, FREE_PER_IP_DAILY, quotaFromEnv, type FreeQuota } from "./quota.js";
import {
  CDP_FACILITATOR_URL,
  FACILITATOR_URLS,
  cdpCredentialLoader,
  cdpFacilitatorConfig,
  type FacilitatorKind,
  type SecretFetcher,
} from "./facilitator.js";
import {
  BUSINESS_DAYS_DESCRIPTION,
  BUSINESS_DAYS_EXAMPLE_INPUT,
  BUSINESS_DAYS_EXAMPLE_OUTPUT,
  BUSINESS_DAYS_INPUT_SCHEMA,
  BUSINESS_DAYS_OUTPUT_SCHEMA,
  FAVICON_ICO,
  SERVICE_NAME,
  TAGS,
  WORKDAY_DESCRIPTION,
  WORKDAY_EXAMPLE_INPUT,
  WORKDAY_EXAMPLE_OUTPUT,
  WORKDAY_INPUT_SCHEMA,
  WORKDAY_OUTPUT_SCHEMA,
  llmsTxt,
  openApi,
  previewHtml,
  skillMd,
  type PriceInfo,
} from "./content.js";

export const DEFAULT_NETWORK = "eip155:84532"; // Base Sepolia
export const MAINNET_NETWORK = "eip155:8453"; // Base
export const WORKDAY_PRICE = "$0.003";
export const BUSINESS_DAYS_PRICE = "$0.005";
export const ADVISORIES_PRICE = "$0.005";
export const BATCH_PRICE = "$0.02";

export interface AppConfig {
  network: Network;
  payTo: string;
  facilitatorKind: FacilitatorKind;
  facilitatorUrl: string;
  /** Passed to HTTPFacilitatorClient; carries the CDP auth headers in cdp mode. */
  facilitatorConfig?: FacilitatorConfig;
  /** Override the facilitator client entirely (tests). */
  facilitator?: FacilitatorClient;
  /** Public base URL used in /openapi.json and /llms.txt; defaults to the request origin. */
  publicBaseUrl?: string;
  funnel?: FunnelLogger;
  /** OSV.dev client (tests inject one with a fake fetch). */
  osv?: OsvClient;
  /** Per-attempt limit on the facilitator /supported sync. Default FACILITATOR_INIT_TIMEOUT_MS. */
  facilitatorInitTimeoutMs?: number;
  /** Time from request start by which verify/settle must have answered. Default REQUEST_DEADLINE_MS. */
  requestDeadlineMs?: number;
  /** Free MCP quota. Unset: no free tier, every MCP tool call gets the paid hint. */
  quota?: FreeQuota;
}

/**
 * The library's own /supported request has a 90 s timeout. Lambda init waits at most this for one attempt; a paid
 * request that still finds the facilitator unsynced shares this same total across its two attempts (half each), so
 * the sync never takes more than this out of the request's 25 s.
 */
export const FACILITATOR_INIT_TIMEOUT_MS = 5_000;
/**
 * Lambda's timeout is 25 s. Facilitator verify/settle calls stop waiting at request start + this, leaving 2 s to
 * build and send the response, so a slow facilitator ends in a logged settle_fail instead of a killed invocation.
 * shortcut: measured from request start inside the app, not from Lambda's getRemainingTimeInMillis; upgrade if the
 * function timeout changes. A settle cut off here may still land on chain (same as a Lambda timeout would).
 */
export const REQUEST_DEADLINE_MS = 23_000;

type Env = Record<string, string | undefined>;

export function configFromEnv(env: Env, fetchSecret?: SecretFetcher): AppConfig {
  const payTo = env.X402_PAY_TO?.trim();
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new Error("X402_PAY_TO must be set to the 0x... address that receives payments");
  }
  const network = (env.X402_NETWORK?.trim() || DEFAULT_NETWORK) as Network;
  if (!/^eip155:\d+$/.test(network)) throw new Error(`X402_NETWORK must be a CAIP-2 eip155 id, got ${network}`);
  // Default: x402.org on testnet, PayAI (no account needed) on Base mainnet.
  const kind = (env.FACILITATOR?.trim() || (network === MAINNET_NETWORK ? "payai" : "x402org")) as FacilitatorKind;
  if (!["x402org", "payai", "cdp"].includes(kind)) {
    throw new Error(`FACILITATOR must be one of cdp, payai, x402org; got ${kind}`);
  }
  if (kind === "x402org" && network === MAINNET_NETWORK) {
    throw new Error("the x402.org facilitator is testnet only; use FACILITATOR=cdp or payai on Base mainnet");
  }
  const base = {
    network,
    payTo,
    facilitatorKind: kind,
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || undefined,
    quota: quotaFromEnv(env),
  };
  if (kind === "cdp") {
    return { ...base, facilitatorUrl: CDP_FACILITATOR_URL, facilitatorConfig: cdpFacilitatorConfig(cdpCredentialLoader(env, fetchSecret)) };
  }
  // X402_FACILITATOR_URL overrides the preset URL for x402org/payai (e.g. a self-hosted facilitator).
  const facilitatorUrl = env.X402_FACILITATOR_URL?.trim() || FACILITATOR_URLS[kind];
  return { ...base, facilitatorUrl, facilitatorConfig: { url: facilitatorUrl } };
}

const advisoryQuery = (c: Context) =>
  parsePackageQuery({ ecosystem: c.req.query("ecosystem"), name: c.req.query("name"), version: c.req.query("version") });

async function batchQuery(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json(); // Hono caches the parsed body for the payment middleware and the handler.
  } catch {
    throw new InputError("invalid_body", "body must be valid JSON");
  }
  return parseBatch(body);
}

/**
 * A request with no input at all (no query string, or an empty body on POST). Discovery tools probe paid routes this
 * way and expect a 402, so such a request is quoted instead of rejected. On POST, an empty JSON object counts as bare. Input that is present but invalid still gets
 * a free 400.
 */
async function isBareRequest(c: Context, method: "GET" | "POST") {
  if (method === "GET") return new URL(c.req.url).search.length <= 1;
  const text = (await c.req.text()).trim(); // Hono caches the text; batchQuery's c.req.json() reuses it.
  if (text === "") return true;
  // Some probes POST an empty JSON object ({ } with whitespace); {"packages":[]} has a key and stays a 400.
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 0;
  } catch {
    return false;
  }
}

/** Paid routes and their free pre-payment input validation. */
const PAID_ROUTES: Record<string, { method: "GET" | "POST"; validate: (c: Context) => unknown }> = {
  "/cn/workday": { method: "GET", validate: (c) => calendar.lookup(c.req.query("date")) },
  "/cn/business-days": { method: "GET", validate: (c) => calendar.validateRange(c.req.query("from"), c.req.query("to")) },
  "/deps/advisories": { method: "GET", validate: advisoryQuery },
  "/deps/advisories/batch": { method: "POST", validate: batchQuery },
};

interface RequestMeta {
  route: string;
  request_id: string;
  user_agent: string;
  verified?: boolean;
  settled?: boolean;
}

/**
 * Copies x402Version, accepts and resource from the PAYMENT-REQUIRED header into the top of a JSON 402 body, so
 * clients that only read the body (market402, x402 v1-style clients) see the same quote. The values come from the
 * decoded header itself, so body and header cannot drift. Other body fields (error, price, how_to_pay...) are kept.
 */
async function quoteInBody(c: Context) {
  const header = c.res.headers.get("payment-required");
  if (c.res.status !== 402 || !header || !(c.res.headers.get("content-type") ?? "").startsWith("application/json")) return;
  let quote: ReturnType<typeof decodePaymentRequiredHeader>;
  try {
    quote = decodePaymentRequiredHeader(header);
  } catch {
    return; // leave the 402 as the middleware built it; the funnel logs the undecodable header
  }
  const { x402Version, accepts, resource } = quote;
  let body: unknown;
  try {
    body = await c.res.clone().json();
  } catch {
    body = {};
  }
  const rest = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = undefined; // otherwise Hono's setter copies the old headers (incl. content-length) onto the new response
  c.res = new Response(JSON.stringify({ x402Version, accepts, resource, ...rest }), { status: 402, headers });
}

function inputErrorResponse(c: Context, e: InputError) {
  return c.json({ error: e.code, message: e.message }, e.status);
}

export function createApp(cfg: AppConfig) {
  const funnel = cfg.funnel ?? new FunnelLogger();
  const osv = cfg.osv ?? new OsvClient();
  // Correlates x402 hook callbacks (which only see the request context) with the HTTP request.
  // Keyed by the payment header string; entries are removed when the request finishes.
  const inflight = new Map<string, RequestMeta>();
  const metaOf = (ctx: { transportContext?: unknown }): RequestMeta | undefined => {
    const header = (ctx.transportContext as { request?: { paymentHeader?: string } } | undefined)?.request?.paymentHeader;
    return header ? inflight.get(header) : undefined;
  };

  // Every verify/settle answers by the request's deadline (set by the first middleware below). The client's own
  // timeoutMs also aborts the underlying fetch instead of the library's 90 s default.
  const requestDeadlineMs = cfg.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
  const deadline = new AsyncLocalStorage<number>();
  const byDeadline = <T>(op: string, p: Promise<T>): Promise<T> => {
    const end = deadline.getStore();
    return end === undefined ? p : withTimeout(p, Math.max(end - Date.now(), 0), () => new FacilitatorTimeoutError(op, requestDeadlineMs));
  };
  const client =
    cfg.facilitator ?? new HTTPFacilitatorClient({ ...(cfg.facilitatorConfig ?? { url: cfg.facilitatorUrl }), timeoutMs: requestDeadlineMs });
  const facilitator: FacilitatorClient = {
    getSupported: () => client.getSupported(),
    verify: (p, r) => byDeadline("verify", client.verify(p, r)),
    settle: (p, r) => byDeadline("settle", client.settle(p, r)),
  };
  const server = new x402ResourceServer(facilitator)
    .register(cfg.network, new ExactEvmScheme())
    .onAfterVerify(async (ctx) => {
      const m = metaOf(ctx);
      if (!m) return;
      m.verified = ctx.result.isValid;
      funnel.log({
        stage: ctx.result.isValid ? "verify_ok" : "verify_fail",
        ...m,
        payer: ctx.result.payer,
        reason: ctx.result.isValid ? undefined : ctx.result.invalidReason ?? "invalid",
        network: ctx.requirements.network,
      });
    })
    .onVerifyFailure(async (ctx) => {
      const m = metaOf(ctx);
      if (!m) return;
      m.verified = false;
      funnel.log({ stage: "verify_fail", ...m, reason: `error: ${ctx.error.message}`, network: ctx.requirements.network });
    })
    .onAfterSettle(async (ctx) => {
      const m = metaOf(ctx);
      if (!m) return;
      m.settled = true;
      funnel.log({
        stage: "settle_ok",
        ...m,
        tx: ctx.result.transaction,
        payer: ctx.result.payer,
        network: ctx.result.network,
      });
    })
    .onSettleFailure(async (ctx) => {
      const m = metaOf(ctx);
      if (!m) return;
      m.settled = false;
      funnel.log({ stage: "settle_fail", ...m, reason: ctx.error.message, network: ctx.requirements.network });
    });

  const accepts = (price: string) => ({ scheme: "exact", price, network: cfg.network, payTo: cfg.payTo });
  const originOf = (ctx: HTTPRequestContext) => cfg.publicBaseUrl ?? new URL(ctx.adapter.getUrl()).origin;
  /** iconUrl, and a 402 body that a plain-fetch agent (which never decodes PAYMENT-REQUIRED) can act on. */
  const listing = (price: string, request: { method: "GET" | "POST"; path: string; body?: unknown }, response: unknown) => ({
    ...(cfg.publicBaseUrl ? { iconUrl: `${cfg.publicBaseUrl}/favicon.ico` } : {}),
    unpaidResponseBody: (ctx: HTTPRequestContext) => {
      const base = originOf(ctx);
      return {
        contentType: "application/json",
        body: {
          error: "Payment required",
          price,
          currency: "USDC",
          network: cfg.network,
          how_to_pay:
            "x402 v2: decode the base64 PAYMENT-REQUIRED response header, sign one of its accepts, and retry the same request with a PAYMENT-SIGNATURE header. Invalid input is rejected with a free 400 before payment.",
          docs: `${base}/openapi.json`,
          llms_txt: `${base}/llms.txt`,
          install: `npx agentcash add ${base}`,
          example: { request: { method: request.method, url: `${base}${request.path}`, ...(request.body ? { body: request.body } : {}) }, response },
        },
      };
    },
  });
  const routes: RoutesConfig = {
    "GET /cn/workday": {
      accepts: accepts(WORKDAY_PRICE),
      ...listing(WORKDAY_PRICE, { method: "GET", path: `/cn/workday?${new URLSearchParams(WORKDAY_EXAMPLE_INPUT)}` }, WORKDAY_EXAMPLE_OUTPUT),
      description: WORKDAY_DESCRIPTION,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: TAGS,
      extensions: declareDiscoveryExtension({
        input: WORKDAY_EXAMPLE_INPUT,
        inputSchema: WORKDAY_INPUT_SCHEMA,
        output: { example: WORKDAY_EXAMPLE_OUTPUT, schema: WORKDAY_OUTPUT_SCHEMA },
      }),
    },
    "GET /cn/business-days": {
      accepts: accepts(BUSINESS_DAYS_PRICE),
      ...listing(
        BUSINESS_DAYS_PRICE,
        { method: "GET", path: `/cn/business-days?${new URLSearchParams(BUSINESS_DAYS_EXAMPLE_INPUT)}` },
        BUSINESS_DAYS_EXAMPLE_OUTPUT,
      ),
      description: BUSINESS_DAYS_DESCRIPTION,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: TAGS,
      extensions: declareDiscoveryExtension({
        input: BUSINESS_DAYS_EXAMPLE_INPUT,
        inputSchema: BUSINESS_DAYS_INPUT_SCHEMA,
        output: { example: BUSINESS_DAYS_EXAMPLE_OUTPUT, schema: BUSINESS_DAYS_OUTPUT_SCHEMA },
      }),
    },
    "GET /deps/advisories": {
      accepts: accepts(ADVISORIES_PRICE),
      ...listing(
        ADVISORIES_PRICE,
        { method: "GET", path: `/deps/advisories?${new URLSearchParams(ADVISORIES_EXAMPLE_INPUT)}` },
        ADVISORIES_EXAMPLE_OUTPUT,
      ),
      description: ADVISORIES_DESCRIPTION,
      mimeType: "application/json",
      serviceName: DEPS_SERVICE_NAME,
      tags: DEPS_TAGS,
      extensions: declareDiscoveryExtension({
        input: ADVISORIES_EXAMPLE_INPUT,
        inputSchema: ADVISORIES_INPUT_SCHEMA,
        output: { example: ADVISORIES_EXAMPLE_OUTPUT, schema: ADVISORIES_OUTPUT_SCHEMA },
      }),
    },
    "POST /deps/advisories/batch": {
      accepts: accepts(BATCH_PRICE),
      ...listing(BATCH_PRICE, { method: "POST", path: "/deps/advisories/batch", body: BATCH_EXAMPLE_INPUT }, BATCH_EXAMPLE_OUTPUT),
      description: BATCH_DESCRIPTION,
      mimeType: "application/json",
      serviceName: DEPS_SERVICE_NAME,
      tags: DEPS_TAGS,
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: BATCH_EXAMPLE_INPUT,
        inputSchema: BATCH_INPUT_SCHEMA,
        output: { example: BATCH_EXAMPLE_OUTPUT, schema: BATCH_OUTPUT_SCHEMA },
      }),
    },
  };

  // The library's default (syncFacilitatorOnStart) starts GET /supported at module load and never waits for it. When
  // the instance's first request is free, Lambda freezes the instance with that request in flight; its 90 s abort
  // timer then fires on wake and the next paid request got a 502. We sync ourselves instead: during Lambda init
  // (lambda.ts awaits initFacilitator), and again before a paid request if that did not succeed.
  const httpServer = new x402HTTPResourceServer(server, routes);
  const initTimeoutMs = cfg.facilitatorInitTimeoutMs ?? FACILITATOR_INIT_TIMEOUT_MS;
  let synced = false;
  /** Set when the facilitator answered but our routes do not fit it: a bug or a config error, retrying cannot help. */
  let configError: Error | undefined;
  let syncing: Promise<boolean> | undefined;
  /** One attempt, at most timeoutMs; never throws. Concurrent callers share the attempt. */
  const initFacilitator = (timeoutMs = initTimeoutMs): Promise<boolean> =>
    (syncing ??= (async () => {
      try {
        await withTimeout(httpServer.initialize(), timeoutMs);
        synced = true;
      } catch (e) {
        if (e instanceof RouteConfigurationError) configError = e;
        const err = e as Error;
        const cause = err.cause instanceof Error ? err.cause.message : undefined;
        console.warn(JSON.stringify({ ts: new Date().toISOString(), type: "facilitator_sync_failed", message: err.message, cause }));
      } finally {
        syncing = undefined;
      }
      return synced;
    })());
  // Before the payment middleware: a failed sync is retried once in this request, the two attempts sharing
  // initTimeoutMs; only a second failure is an error, a 503 with nothing charged (no payment is verified or settled
  // without a synced facilitator). A route configuration error is not retried: it is a 500 until redeployed.
  const facilitatorGate: MiddlewareHandler = async (c, next) => {
    const attempt = () => !configError && initFacilitator(initTimeoutMs / 2);
    if (synced || (await attempt()) || (await attempt())) return next();
    if (configError) {
      c.set("failure", "route_configuration_error");
      return c.json({ error: "internal_error" }, 500);
    }
    c.set("failure", "facilitator_unavailable");
    c.header("Retry-After", "5");
    return c.json(
      { error: "facilitator_unavailable", message: "The payment facilitator did not answer. You were not charged; retry shortly." },
      503,
    );
  };

  // Runs before the payment middleware: funnel bookkeeping, and input validation so a bad
  // request gets a free 400/404 instead of a 402 the agent would pay for and then fail.
  // A bare request without a payment is quoted (402) unvalidated; with a payment it is validated, so it is never charged.
  const funnelAndValidate: MiddlewareHandler = async (c, next) => {
    const paid = PAID_ROUTES[c.req.path];
    if (!paid || c.req.method !== paid.method) return next();
    const meta: RequestMeta = {
      route: c.req.path,
      request_id: crypto.randomUUID(),
      user_agent: c.req.header("user-agent") ?? "",
    };
    const paymentHeader = c.req.header("payment-signature") || c.req.header("x-payment");
    try {
      if (paymentHeader || !(await isBareRequest(c, paid.method))) await paid.validate(c);
    } catch (e) {
      if (!(e instanceof InputError)) throw e;
      funnel.log({ stage: "request", ...meta, status: e.status, reason: `rejected_input: ${e.code}` });
      return inputErrorResponse(c, e);
    }
    funnel.log({ stage: "request", ...meta });
    if (paymentHeader) {
      funnel.log({ stage: "payment_header_received", ...meta });
      inflight.set(paymentHeader, meta);
    }
    try {
      await next();
    } finally {
      if (paymentHeader) inflight.delete(paymentHeader);
    }
    await quoteInBody(c);
    const status = c.res.status;
    if (status === 402) {
      let reason: string | undefined;
      const pr = c.res.headers.get("payment-required");
      if (pr) {
        try {
          reason = decodePaymentRequiredHeader(pr).error;
        } catch {
          reason = "undecodable PAYMENT-REQUIRED header";
        }
      }
      // Rejections before the facilitator was asked (bad header, wrong network...) do not hit a verify hook.
      if (paymentHeader && meta.verified === undefined) {
        funnel.log({ stage: "verify_fail", ...meta, reason: reason ?? "payment rejected before verify" });
      }
      funnel.log({ stage: "402_returned", ...meta, status, reason });
    } else if (status < 400 && meta.settled) {
      funnel.log({ stage: "content_returned", ...meta, status });
    } else if (status >= 500) {
      // Upstream or facilitator failure after verification: settlement is skipped, nothing is charged.
      funnel.log({ stage: "handler_error", ...meta, status, reason: c.get("failure") ?? `http ${status}` });
    }
  };

  const prices: PriceInfo = {
    network: cfg.network,
    workdayPrice: WORKDAY_PRICE,
    businessDaysPrice: BUSINESS_DAYS_PRICE,
    advisoriesPrice: ADVISORIES_PRICE,
    batchPrice: BATCH_PRICE,
    freePerIpDaily: cfg.quota?.perIpDaily ?? FREE_PER_IP_DAILY,
  };
  const freeLimits = { perIpDaily: prices.freePerIpDaily, globalDaily: cfg.quota?.globalDaily ?? FREE_GLOBAL_DAILY };
  const baseUrl = (c: Context) => cfg.publicBaseUrl ?? new URL(c.req.url).origin;

  const app = new Hono<{ Variables: { failure?: string } }>();
  app.onError((err, c) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), type: "error", route: c.req.path, message: err.message }));
    return c.json({ error: "internal_error" }, 500);
  });

  // Browser-based agents must be able to read the x402 headers and send the payment header cross-origin.
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT", "MCP-Protocol-Version"],
      exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
      maxAge: 86400,
    }),
  );

  app.get("/", (c) => c.html(previewHtml(baseUrl(c), prices, calendar.sources)));
  app.get("/llms.txt", (c) => c.text(llmsTxt(baseUrl(c), prices)));
  app.get("/SKILL.md", (c) =>
    c.body(skillMd(baseUrl(c), prices, calendar.sources), 200, { "Content-Type": "text/markdown; charset=utf-8" }),
  );
  app.get("/openapi.json", (c) => c.json(openApi(baseUrl(c), prices)));
  app.get("/.well-known/openapi.json", (c) => c.json(openApi(baseUrl(c), prices)));
  app.get("/favicon.ico", (c) =>
    c.body(FAVICON_ICO, 200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" }),
  );
  app.get("/.well-known/mcp.json", (c) => c.json(mcpManifest(baseUrl(c), { ...freeLimits, prices })));

  // Free MCP endpoint: outside /cn/* and /deps/*, so the payment middleware never runs on it.
  app.use("/mcp", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "body_too_large" }, 413) }));
  app.post("/mcp", mcpHandler({ osv, quota: cfg.quota, ...freeLimits, prices, baseUrl }));
  // Stateless and JSON-only: no SSE stream to open (GET) and no session to end (DELETE).
  app.on(["GET", "DELETE"], "/mcp", (c) => c.json({ error: "method_not_allowed", message: "POST one JSON-RPC message" }, 405, { Allow: "POST" }));
  app.get("/health", (c) =>
    c.json({ ok: true, network: cfg.network, facilitator: cfg.facilitatorKind, data_updated: calendar.dataUpdated }),
  );

  // Batch bodies are at most 50 small objects; refuse anything larger before parsing.
  app.use("/deps/advisories/batch", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "body_too_large" }, 413) }));
  const payment = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);
  for (const prefix of ["/cn/*", "/deps/*"]) {
    app.use(prefix, (_c, next) => deadline.run(Date.now() + requestDeadlineMs, next));
    app.use(prefix, funnelAndValidate);
    app.use(prefix, facilitatorGate);
    app.use(prefix, payment);
  }

  app.get("/cn/workday", (c) => c.json({ ...calendar.lookup(c.req.query("date")), data_updated: calendar.dataUpdated }));
  app.get("/cn/business-days", (c) =>
    c.json({ ...calendar.businessDays(c.req.query("from"), c.req.query("to")), data_updated: calendar.dataUpdated }),
  );

  // A handler status >= 400 makes the payment middleware skip settlement, so an OSV.dev failure is never charged.
  const upstreamFailure = (c: Context, e: unknown) => {
    if (!(e instanceof UpstreamError)) throw e;
    c.set("failure", e.message);
    return c.json({ error: "upstream_unavailable", message: `${e.message}. You were not charged; retry later.` }, 502);
  };
  app.get("/deps/advisories", async (c) => {
    try {
      return c.json(await osv.query(advisoryQuery(c)));
    } catch (e) {
      return upstreamFailure(c, e);
    }
  });
  app.post("/deps/advisories/batch", async (c) => {
    try {
      const results = await osv.queryMany(await batchQuery(c));
      return c.json({ count: results.length, vulnerable_count: results.filter((r) => r.vulnerable).length, results });
    } catch (e) {
      return upstreamFailure(c, e);
    }
  });

  return Object.assign(app, { initFacilitator });
}

/** Rejects after ms; the abandoned promise keeps running and its result is ignored. */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  error = () => new Error(`facilitator /supported sync timed out after ${ms} ms`),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
