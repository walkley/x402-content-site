import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { handle } from "hono/aws-lambda";
import { createApp } from "../src/app.js";
import { FunnelLogger } from "../src/funnel.js";

const NETWORK = "eip155:84532";
const HOST = "abc123.execute-api.ap-northeast-1.amazonaws.com";

const facilitator = {
  getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: ["bazaar"], signers: {} }),
  verify: async () => ({ isValid: false, invalidReason: "invalid_payload" }),
  settle: async () => ({ success: false, errorReason: "unused", transaction: "", network: NETWORK }),
} as unknown as FacilitatorClient;

/** Minimal API Gateway HTTP API (payload format 2.0) event as the `$default` stage sends it. */
function httpEvent(method: string, path: string, query: Record<string, string> | null, headers: Record<string, string> = {}) {
  const all = { host: HOST, "user-agent": "vitest", ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  const rawQueryString = query ? new URLSearchParams(query).toString() : "";
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString,
    headers: all,
    ...(query ? { queryStringParameters: query } : {}),
    isBase64Encoded: false,
    body: undefined as string | undefined,
    requestContext: {
      stage: "$default",
      domainName: HOST,
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "203.0.113.1", userAgent: "vitest" },
      requestId: "r1",
      routeKey: "$default",
      timeEpoch: 0,
    },
  };
}

const lines: string[] = [];
let handler: (event: never) => Promise<unknown>;

beforeAll(async () => {
  vi.stubEnv("X402_PAY_TO", "0x0000000000000000000000000000000000000001");
  vi.stubEnv("X402_NETWORK", NETWORK);
  // The module-level handler is built on import; point it at a closed local port so the test makes no outside call.
  vi.stubEnv("X402_FACILITATOR_URL", "http://127.0.0.1:9");
  const mod = await import("../src/lambda.js");
  expect(typeof mod.handler).toBe("function");
  handler = handle(
    createApp({
      network: NETWORK,
      payTo: "0x96B16408be584E863Ab3f05703059e302c474f0A",
      facilitatorKind: "x402org",
      facilitatorUrl: "http://unused",
      facilitator,
      publicBaseUrl: `https://${HOST}`,
      funnel: new FunnelLogger((l) => lines.push(l)),
    }),
  ) as never;
});

type Result = { statusCode: number; body: string; isBase64Encoded?: boolean; headers?: Record<string, string> };
const header = (r: Result, name: string) => r.headers?.[name];
const call = (e: ReturnType<typeof httpEvent>) => handler(e as never) as Promise<Result>;

describe("HTTP API ($default stage) adapter", () => {
  it("serves the free endpoints at the origin root, including /.well-known/openapi.json and a favicon", async () => {
    expect((await call(httpEvent("GET", "/health", null))).statusCode).toBe(200);
    expect((await call(httpEvent("GET", "/", null))).statusCode).toBe(200);
    expect((await call(httpEvent("GET", "/llms.txt", null))).statusCode).toBe(200);
    for (const path of ["/openapi.json", "/.well-known/openapi.json"]) {
      const spec = JSON.parse((await call(httpEvent("GET", path, null))).body);
      expect(spec.servers[0].url).toBe(`https://${HOST}`);
    }
    const ico = await call(httpEvent("GET", "/favicon.ico", null));
    expect(ico.statusCode).toBe(200);
    expect(header(ico, "content-type")).toBe("image/x-icon");
    expect(ico.isBase64Encoded).toBe(true);
  });

  it("returns 402 whose resource is the callable URL with the query string", async () => {
    const r = await call(httpEvent("GET", "/cn/workday", { date: "2026-10-01" }));
    expect(r.statusCode).toBe(402);
    const pr = decodePaymentRequiredHeader(header(r, "payment-required")!);
    expect(pr.resource.url).toBe(`https://${HOST}/cn/workday?date=2026-10-01`);
    expect(pr.accepts[0].amount).toBe("3000");
  });

  it("validates input before payment (free 400)", async () => {
    expect((await call(httpEvent("GET", "/cn/workday", { date: "2026-13-01" }))).statusCode).toBe(400);
  });

  it("passes the PAYMENT-SIGNATURE request header through to the app", async () => {
    lines.length = 0;
    const r = await call(httpEvent("GET", "/cn/workday", { date: "2026-10-01" }, { "PAYMENT-SIGNATURE": "not-base64-json" }));
    expect(r.statusCode).toBe(402);
    expect(lines.map((l) => JSON.parse(l).stage)).toContain("payment_header_received");
  });

  it("answers HEAD without a body", async () => {
    const r = await call(httpEvent("HEAD", "/health", null));
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("");
  });
});

describe("package advisories behind the HTTP API", () => {
  const withBody = (e: ReturnType<typeof httpEvent>, body: string) => ({
    ...e,
    body,
    headers: { ...e.headers, "content-type": "application/json" },
  });

  it("GET /deps/advisories returns 402 with a callable resource URL", async () => {
    const r = await call(httpEvent("GET", "/deps/advisories", { ecosystem: "npm", name: "lodash", version: "4.17.20" }));
    expect(r.statusCode).toBe(402);
    const pr = decodePaymentRequiredHeader(header(r, "payment-required")!);
    expect(pr.resource.url).toContain(`https://${HOST}/deps/advisories?`);
    expect(pr.accepts[0].amount).toBe("5000");
  });

  it("POST /deps/advisories/batch passes the JSON body through: 402 when valid, free 400 when not", async () => {
    const body = JSON.stringify({ packages: [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }] });
    const ok = await call(withBody(httpEvent("POST", "/deps/advisories/batch", null), body) as never);
    expect(ok.statusCode).toBe(402);
    expect(decodePaymentRequiredHeader(header(ok, "payment-required")!).accepts[0].amount).toBe("20000");
    const bad = await call(withBody(httpEvent("POST", "/deps/advisories/batch", null), "{}") as never);
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe("invalid_body");
  });

  it("bare probes (no query, no body) get 402 through the HTTP API event path", async () => {
    for (const [method, path] of [["GET", "/deps/advisories"], ["POST", "/deps/advisories/batch"]]) {
      const r = await call(httpEvent(method, path, null));
      expect(r.statusCode).toBe(402);
      expect(JSON.parse(r.body)).toMatchObject({ error: "Payment required", docs: `https://${HOST}/openapi.json` });
    }
  });

  it("exposes the x402 headers via CORS and answers preflight", async () => {
    const r = await call(httpEvent("GET", "/cn/workday", { date: "2026-02-14" }, { Origin: "https://agent.example" }));
    expect(header(r, "access-control-expose-headers")?.toLowerCase()).toContain("payment-required");
    const pre = await call(
      httpEvent("OPTIONS", "/deps/advisories/batch", null, {
        Origin: "https://agent.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,payment-signature",
      }),
    );
    expect(pre.statusCode).toBe(204);
  });
});
