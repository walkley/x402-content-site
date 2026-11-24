import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createApp } from "../src/app.js";
import { FunnelLogger } from "../src/funnel.js";

const NETWORK = "eip155:84532";
const HOST = "abc123.execute-api.ap-northeast-1.amazonaws.com";

const facilitator = {
  getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: ["bazaar"], signers: {} }),
  verify: async () => ({ isValid: false, invalidReason: "invalid_payload" }),
  settle: async () => ({ success: false, errorReason: "unused", transaction: "", network: NETWORK }),
} as unknown as FacilitatorClient;

/** Minimal API Gateway REST (payload v1) proxy event as the `prod` stage sends it. */
function restEvent(method: string, path: string, query: Record<string, string> | null, headers: Record<string, string> = {}) {
  const all = { Host: HOST, "User-Agent": "vitest", ...headers };
  return {
    resource: "/{proxy+}",
    path,
    httpMethod: method,
    headers: all,
    multiValueHeaders: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, [v]])),
    queryStringParameters: query,
    multiValueQueryStringParameters: query ? Object.fromEntries(Object.entries(query).map(([k, v]) => [k, [v]])) : null,
    pathParameters: { proxy: path.slice(1) },
    stageVariables: null,
    body: null,
    isBase64Encoded: false,
    requestContext: { stage: "prod", path: `/prod${path}`, domainName: HOST, httpMethod: method, requestId: "r1" },
  };
}

let restApiHandler: typeof import("../src/lambda.js").restApiHandler;
const lines: string[] = [];
let handler: ReturnType<typeof restApiHandler>;

beforeAll(async () => {
  vi.stubEnv("X402_PAY_TO", "0x0000000000000000000000000000000000000001");
  vi.stubEnv("X402_NETWORK", NETWORK);
  // The module-level handler is built on import; point it at a closed local port so the test makes no outside call.
  vi.stubEnv("X402_FACILITATOR_URL", "http://127.0.0.1:9");
  ({ restApiHandler } = await import("../src/lambda.js"));
  handler = restApiHandler(
    createApp({
      network: NETWORK,
      payTo: "0x96B16408be584E863Ab3f05703059e302c474f0A",
      facilitatorKind: "x402org",
      facilitatorUrl: "http://unused",
      facilitator,
      publicBaseUrl: `https://${HOST}/prod`,
      funnel: new FunnelLogger((l) => lines.push(l)),
    }),
  );
});

type Result = { statusCode: number; body: string; headers?: Record<string, string>; multiValueHeaders?: Record<string, string[]> };
const header = (r: Result, name: string) => r.multiValueHeaders?.[name]?.[0] ?? r.headers?.[name];
const call = (e: ReturnType<typeof restEvent>) => handler(e as never) as Promise<Result>;

describe("REST API (stage prod) adapter", () => {
  it("routes free endpoints with the stage stripped", async () => {
    expect((await call(restEvent("GET", "/health", null))).statusCode).toBe(200);
    expect((await call(restEvent("GET", "/", null))).statusCode).toBe(200);
    const spec = JSON.parse((await call(restEvent("GET", "/openapi.json", null))).body);
    expect(spec.servers[0].url).toBe(`https://${HOST}/prod`);
  });

  it("returns 402 whose resource is the callable stage URL with the query string", async () => {
    const r = await call(restEvent("GET", "/cn/workday", { date: "2026-10-01" }));
    expect(r.statusCode).toBe(402);
    const pr = decodePaymentRequiredHeader(header(r, "payment-required")!);
    expect(pr.resource.url).toBe(`https://${HOST}/prod/cn/workday?date=2026-10-01`);
    expect(pr.accepts[0].amount).toBe("3000");
  });

  it("validates input before payment (free 400)", async () => {
    expect((await call(restEvent("GET", "/cn/workday", { date: "2026-13-01" }))).statusCode).toBe(400);
  });

  it("passes the PAYMENT-SIGNATURE request header through to the app", async () => {
    lines.length = 0;
    const r = await call(restEvent("GET", "/cn/workday", { date: "2026-10-01" }, { "PAYMENT-SIGNATURE": "not-base64-json" }));
    expect(r.statusCode).toBe(402);
    expect(lines.map((l) => JSON.parse(l).stage)).toContain("payment_header_received");
  });

  it("answers HEAD without a body", async () => {
    const r = await call(restEvent("HEAD", "/health", null));
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("");
  });
});
