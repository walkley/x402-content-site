import { Hono, type Context, type MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { decodePaymentRequiredHeader, type FacilitatorConfig } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { InputError } from "./calendar.js";
import { calendar } from "./data.js";
import { FunnelLogger } from "./funnel.js";
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
  type PriceInfo,
} from "./content.js";

export const DEFAULT_NETWORK = "eip155:84532"; // Base Sepolia
export const MAINNET_NETWORK = "eip155:8453"; // Base
export const WORKDAY_PRICE = "$0.003";
export const BUSINESS_DAYS_PRICE = "$0.005";

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
}

type Env = Record<string, string | undefined>;

export function configFromEnv(env: Env, fetchSecret?: SecretFetcher): AppConfig {
  const payTo = env.X402_PAY_TO?.trim();
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new Error("X402_PAY_TO must be set to the 0x... address that receives payments");
  }
  const network = (env.X402_NETWORK?.trim() || DEFAULT_NETWORK) as Network;
  if (!/^eip155:\d+$/.test(network)) throw new Error(`X402_NETWORK must be a CAIP-2 eip155 id, got ${network}`);
  const kind = (env.FACILITATOR?.trim() || "x402org") as FacilitatorKind;
  if (!["x402org", "payai", "cdp"].includes(kind)) {
    throw new Error(`FACILITATOR must be one of cdp, payai, x402org; got ${kind}`);
  }
  if (kind === "x402org" && network === MAINNET_NETWORK) {
    throw new Error("the x402.org facilitator is testnet only; use FACILITATOR=cdp or payai on Base mainnet");
  }
  const base = { network, payTo, facilitatorKind: kind, publicBaseUrl: env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || undefined };
  if (kind === "cdp") {
    return { ...base, facilitatorUrl: CDP_FACILITATOR_URL, facilitatorConfig: cdpFacilitatorConfig(cdpCredentialLoader(env, fetchSecret)) };
  }
  // X402_FACILITATOR_URL overrides the preset URL for x402org/payai (e.g. a self-hosted facilitator).
  const facilitatorUrl = env.X402_FACILITATOR_URL?.trim() || FACILITATOR_URLS[kind];
  return { ...base, facilitatorUrl, facilitatorConfig: { url: facilitatorUrl } };
}

const PAID_ROUTES: Record<string, (c: Context) => void> = {
  "/cn/workday": (c) => calendar.lookup(c.req.query("date")),
  "/cn/business-days": (c) => calendar.validateRange(c.req.query("from"), c.req.query("to")),
};

interface RequestMeta {
  route: string;
  request_id: string;
  user_agent: string;
  verified?: boolean;
  settled?: boolean;
}

function inputErrorResponse(c: Context, e: InputError) {
  return c.json({ error: e.code, message: e.message }, e.status);
}

export function createApp(cfg: AppConfig) {
  const funnel = cfg.funnel ?? new FunnelLogger();
  // Correlates x402 hook callbacks (which only see the request context) with the HTTP request.
  // Keyed by the payment header string; entries are removed when the request finishes.
  const inflight = new Map<string, RequestMeta>();
  const metaOf = (ctx: { transportContext?: unknown }): RequestMeta | undefined => {
    const header = (ctx.transportContext as { request?: { paymentHeader?: string } } | undefined)?.request?.paymentHeader;
    return header ? inflight.get(header) : undefined;
  };

  const facilitator = cfg.facilitator ?? new HTTPFacilitatorClient(cfg.facilitatorConfig ?? { url: cfg.facilitatorUrl });
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
  const routes: RoutesConfig = {
    "GET /cn/workday": {
      accepts: accepts(WORKDAY_PRICE),
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
  };

  // Runs before the payment middleware: funnel bookkeeping, and input validation so a bad
  // request gets a free 400/404 instead of a 402 the agent would pay for and then fail.
  const funnelAndValidate: MiddlewareHandler = async (c, next) => {
    const validate = PAID_ROUTES[c.req.path];
    if (!validate || c.req.method !== "GET") return next();
    const meta: RequestMeta = {
      route: c.req.path,
      request_id: crypto.randomUUID(),
      user_agent: c.req.header("user-agent") ?? "",
    };
    const paymentHeader = c.req.header("payment-signature") || c.req.header("x-payment");
    try {
      validate(c);
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
    }
  };

  const prices: PriceInfo = { network: cfg.network, workdayPrice: WORKDAY_PRICE, businessDaysPrice: BUSINESS_DAYS_PRICE };
  const baseUrl = (c: Context) => cfg.publicBaseUrl ?? new URL(c.req.url).origin;

  const app = new Hono();
  app.onError((err, c) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), type: "error", route: c.req.path, message: err.message }));
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/", (c) => c.html(previewHtml(baseUrl(c), prices, calendar.sources)));
  app.get("/llms.txt", (c) => c.text(llmsTxt(baseUrl(c), prices)));
  app.get("/openapi.json", (c) => c.json(openApi(baseUrl(c), prices)));
  app.get("/health", (c) =>
    c.json({ ok: true, network: cfg.network, facilitator: cfg.facilitatorKind, data_updated: calendar.dataUpdated }),
  );

  app.use("/cn/*", funnelAndValidate);
  app.use("/cn/*", paymentMiddleware(routes, server));

  app.get("/cn/workday", (c) => c.json({ ...calendar.lookup(c.req.query("date")), data_updated: calendar.dataUpdated }));
  app.get("/cn/business-days", (c) =>
    c.json({ ...calendar.businessDays(c.req.query("from"), c.req.query("to")), data_updated: calendar.dataUpdated }),
  );

  return app;
}
