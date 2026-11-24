import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { configFromEnv, createApp } from "../src/app.js";
import { FunnelLogger } from "../src/funnel.js";

const PAY_TO = "0x96B16408be584E863Ab3f05703059e302c474f0A";
const PAYER = "0x41836Aaa4799D787a0f02D22Ff584C3d72aC979a";
const NETWORK = "eip155:84532";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FAKE_SIGNATURE = "0x" + "ab".repeat(65);

class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  constructor(private mode: { verify: boolean; settle: boolean | "throw" }) {}
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: ["bazaar"], signers: {} } as never;
  }
  async verify(_p: PaymentPayload, _r: PaymentRequirements) {
    this.verifyCalls++;
    return this.mode.verify ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: "insufficient_funds", payer: PAYER };
  }
  async settle(_p: PaymentPayload, r: PaymentRequirements) {
    this.settleCalls++;
    if (this.mode.settle === "throw") throw new Error("facilitator down");
    return this.mode.settle
      ? { success: true, transaction: "0x" + "12".repeat(32), network: r.network, payer: PAYER }
      : { success: false, errorReason: "transaction_failed", transaction: "", network: r.network, payer: PAYER };
  }
}

function setup(mode: { verify: boolean; settle: boolean | "throw" }) {
  const lines: string[] = [];
  const facilitator = new FakeFacilitator(mode);
  const app = createApp({
    network: NETWORK,
    payTo: PAY_TO,
    facilitatorUrl: "http://unused",
    facilitator,
    funnel: new FunnelLogger((l) => lines.push(l)),
  });
  const events = () => lines.map((l) => JSON.parse(l));
  return { app, facilitator, lines, events };
}

const UA = { "user-agent": "vitest-agent/1.0" };

async function paidRequest(app: ReturnType<typeof createApp>, path: string) {
  const first = await app.request(path, { headers: UA });
  const required = decodePaymentRequiredHeader(first.headers.get("payment-required")!);
  const accepted = required.accepts[0];
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: FAKE_SIGNATURE,
      authorization: {
        from: PAYER,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: "0x" + "00".repeat(31) + "01",
      },
    },
    extensions: required.extensions,
  } as PaymentPayload;
  return app.request(path, { headers: { ...UA, "payment-signature": encodePaymentSignatureHeader(payload) } });
}

describe("402 without payment", () => {
  it.each([
    ["/cn/workday?date=2026-02-14", "10000"],
    ["/cn/business-days?from=2026-09-28&to=2026-10-11", "20000"],
  ])("%s returns 402 with correct accepts", async (path, amount) => {
    const { app, events } = setup({ verify: true, settle: true });
    const res = await app.request(path, { headers: UA });
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: NETWORK,
      payTo: PAY_TO,
      amount,
      asset: USDC_BASE_SEPOLIA,
    });
    expect(required.resource.url).toContain(path.split("?")[0]);
    const bazaar = required.extensions?.bazaar as { info: { output: { example: unknown } }; schema: unknown };
    expect(bazaar.info.output.example).toBeTruthy();
    expect(bazaar.schema).toBeTruthy();
    expect(required.resource).toMatchObject({ serviceName: "China Workday Calendar" });
    expect(await res.text()).not.toContain("is_workday\":"); // no paid content
    expect(events().map((e) => e.stage)).toEqual(["request", "402_returned"]);
    expect(events()[0]).toMatchObject({ route: path.split("?")[0], user_agent: "vitest-agent/1.0", type: "x402_funnel" });
    expect(events()[0].ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("invalid input is rejected before payment (not charged)", () => {
  it.each([
    ["/cn/workday", 400, "invalid_date"],
    ["/cn/workday?date=2026-02-30", 400, "invalid_date"],
    ["/cn/workday?date=2030-01-01", 404, "year_not_covered"],
    ["/cn/business-days?from=2026-01-01&to=2027-01-02", 400, "range_too_large"],
    ["/cn/business-days?from=2026-02-02&to=2026-02-01", 400, "invalid_range"],
  ])("%s -> %i", async (path, status, code) => {
    const { app, events } = setup({ verify: true, settle: true });
    const res = await app.request(path, { headers: UA });
    expect(res.status).toBe(status);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(await res.json()).toMatchObject({ error: code });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ stage: "request", status });
  });
});

describe("paid flow", () => {
  it("verify ok + settle ok returns content and PAYMENT-RESPONSE", async () => {
    const { app, events, lines } = setup({ verify: true, settle: true });
    const res = await paidRequest(app, "/cn/workday?date=2026-02-14");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ date: "2026-02-14", is_workday: true, is_makeup_workday: true });
    const settle = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(settle).toMatchObject({ success: true, network: NETWORK });
    const stages = events().map((e) => e.stage);
    expect(stages).toEqual(["request", "402_returned", "request", "payment_header_received", "verify_ok", "settle_ok", "content_returned"]);
    const settleOk = events().find((e) => e.stage === "settle_ok");
    expect(settleOk).toMatchObject({ tx: "0x" + "12".repeat(32), payer: PAYER, route: "/cn/workday" });
    // The signature (and the encoded header containing it) must never be logged.
    expect(lines.join("\n")).not.toContain("abababab");
  });

  it("settle failure returns no paid content", async () => {
    const { app, events, facilitator } = setup({ verify: true, settle: false });
    const res = await paidRequest(app, "/cn/business-days?from=2026-09-28&to=2026-10-11");
    const body = await res.text();
    expect(res.status).toBe(402);
    expect(body).not.toContain("workdays");
    expect(body).not.toContain("2026-10-10");
    expect(facilitator.settleCalls).toBe(1);
    const stages = events().map((e) => e.stage);
    expect(stages).toContain("settle_fail");
    expect(stages).not.toContain("content_returned");
    expect(events().find((e) => e.stage === "settle_fail").reason).toContain("transaction_failed");
  });

  it("settle throwing returns no paid content", async () => {
    const { app, events } = setup({ verify: true, settle: "throw" });
    const res = await paidRequest(app, "/cn/workday?date=2026-02-14");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain("is_makeup_workday");
    expect(events().map((e) => e.stage)).not.toContain("content_returned");
  });

  it("verify failure returns 402, never settles", async () => {
    const { app, events, facilitator } = setup({ verify: false, settle: true });
    const res = await paidRequest(app, "/cn/workday?date=2026-02-14");
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("is_makeup_workday");
    expect(facilitator.settleCalls).toBe(0);
    const fail = events().find((e) => e.stage === "verify_fail");
    expect(fail).toMatchObject({ reason: "insufficient_funds", payer: PAYER });
  });

  it("garbage payment header is a verify_fail without calling the facilitator", async () => {
    const { app, events, facilitator } = setup({ verify: true, settle: true });
    const res = await app.request("/cn/workday?date=2026-02-14", { headers: { ...UA, "payment-signature": "not-base64!" } });
    expect(res.status).toBe(402);
    expect(facilitator.verifyCalls).toBe(0);
    expect(events().map((e) => e.stage)).toEqual(["request", "payment_header_received", "verify_fail", "402_returned"]);
  });
});

describe("free routes", () => {
  it("serve preview, llms.txt, openapi and health without payment", async () => {
    const { app, events } = setup({ verify: true, settle: true });
    const home = await app.request("/");
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("gov.cn");
    expect(html).toContain("2026-11-05"); // data updated = newest notice
    expect(html).toContain("2026-02-14");
    const llms = await app.request("/llms.txt");
    expect(await llms.text()).toContain("/cn/business-days");
    const oa = await (await app.request("/openapi.json")).json();
    expect(oa.paths["/cn/workday"].get.responses["402"]).toBeTruthy();
    expect(await (await app.request("/health")).json()).toMatchObject({ ok: true, network: NETWORK });
    expect(events()).toHaveLength(0);
  });
});

describe("configFromEnv", () => {
  it("defaults to Base Sepolia and the x402.org facilitator", () => {
    expect(configFromEnv({ X402_PAY_TO: PAY_TO })).toMatchObject({
      network: "eip155:84532",
      facilitatorUrl: "https://x402.org/facilitator",
    });
  });
  it("reads overrides and requires a valid payTo", () => {
    expect(configFromEnv({ X402_PAY_TO: PAY_TO, X402_NETWORK: "eip155:8453", X402_FACILITATOR_URL: "https://facilitator.payai.network" }))
      .toMatchObject({ network: "eip155:8453", facilitatorUrl: "https://facilitator.payai.network" });
    expect(() => configFromEnv({})).toThrow(/X402_PAY_TO/);
    expect(() => configFromEnv({ X402_PAY_TO: "0x123" })).toThrow(/X402_PAY_TO/);
    expect(() => configFromEnv({ X402_PAY_TO: PAY_TO, X402_NETWORK: "base" })).toThrow(/CAIP-2/);
  });
});
