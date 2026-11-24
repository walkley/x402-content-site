// R10: a facilitator /supported sync that fails or hangs once must not turn the next paid request into a 502/5xx.
import { describe, expect, it, vi } from "vitest";
import { FacilitatorTimeoutError, decodePaymentRequiredHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.js";
import { FunnelLogger } from "../src/funnel.js";

const PAY_TO = "0x96B16408be584E863Ab3f05703059e302c474f0A";
const NETWORK = "eip155:84532";
const SUPPORTED = { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: ["bazaar"], signers: {} };
const hang = () => new Promise<never>(() => {});
const slow = (ms: number) => new Promise((r) => setTimeout(() => r(SUPPORTED), ms));

/** Each getSupported call takes the next behaviour; after the list, it answers at once. */
function setup(behaviours: Array<() => Promise<unknown>>, timeoutMs = 50) {
  const lines: string[] = [];
  const getSupported = vi.fn(async () => (behaviours.shift() ?? (async () => SUPPORTED))());
  const verify = vi.fn(async () => ({ isValid: false, invalidReason: "invalid_payload" }));
  const facilitator = { getSupported, verify, settle: vi.fn() } as unknown as FacilitatorClient;
  const app = createApp({
    network: NETWORK,
    payTo: PAY_TO,
    facilitatorKind: "payai",
    facilitatorUrl: "http://unused",
    facilitator,
    funnel: new FunnelLogger((l) => lines.push(l)),
    facilitatorInitTimeoutMs: timeoutMs,
  });
  return { app, getSupported, verify, events: () => lines.map((l) => JSON.parse(l)) };
}

const workday = (app: ReturnType<typeof createApp>, headers: Record<string, string> = {}) =>
  app.request("/cn/workday?date=2026-10-01", { headers });

async function expectQuote(res: Response) {
  expect(res.status).toBe(402);
  const accepts = decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts[0];
  expect(accepts.payTo).toBe(PAY_TO);
  expect(accepts.amount).toBe("3000");
}

describe("facilitator sync (R10 cold-start 502)", () => {
  it("init sync times out once; a free first request, then the next paid request still gets 402", async () => {
    const { app, getSupported } = setup([hang]);
    expect(await app.initFacilitator()).toBe(false); // Lambda init gives up after the short timeout, does not throw
    expect((await app.request("/openapi.json")).status).toBe(200);
    await expectQuote(await workday(app));
    expect(getSupported).toHaveBeenCalledTimes(2);
  });

  it("the incident: the init request rejects with FacilitatorTimeoutError, the first paid request gets 402", async () => {
    const { app } = setup([async () => Promise.reject(new FacilitatorTimeoutError("supported", 90_000))]);
    await app.initFacilitator();
    expect((await app.request("/llms.txt")).status).toBe(200);
    await expectQuote(await workday(app));
  });

  it("retries a failed sync once in the same paid request", async () => {
    const { app, getSupported } = setup([hang, hang]);
    expect(await app.initFacilitator()).toBe(false);
    await expectQuote(await workday(app)); // attempt 2 hangs, attempt 3 answers
    expect(getSupported).toHaveBeenCalledTimes(3);
  });

  it("slow but within the timeout: synced at init, and never asked again", async () => {
    const { app, getSupported } = setup([() => slow(20)], 500);
    expect(await app.initFacilitator()).toBe(true);
    await expectQuote(await workday(app));
    await expectQuote(await workday(app));
    expect(getSupported).toHaveBeenCalledTimes(1);
  });

  it("a cold instance whose first request is paid (no init call) syncs in that request", async () => {
    const { app, getSupported } = setup([]);
    await expectQuote(await workday(app));
    expect(getSupported).toHaveBeenCalledTimes(1);
  });

  it("two failures in one request: 503 with Retry-After, nothing verified, then 402 once the facilitator is back", async () => {
    const fail = async () => Promise.reject(new Error("ECONNRESET"));
    const { app, verify, events } = setup([fail, fail, fail]);
    expect(await app.initFacilitator()).toBe(false);
    const res = await workday(app, { "payment-signature": "not-base64-json" });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect((await res.json()).error).toBe("facilitator_unavailable");
    expect(verify).not.toHaveBeenCalled();
    expect(events().find((e) => e.stage === "handler_error")).toMatchObject({ status: 503, reason: "facilitator_unavailable" });
    await expectQuote(await workday(app));
  });

  it("invalid input is still a free 400 without waiting for the facilitator", async () => {
    const { app, getSupported } = setup([hang, hang, hang], 5_000);
    const res = await app.request("/cn/workday?date=2026-13-01");
    expect(res.status).toBe(400);
    expect(getSupported).not.toHaveBeenCalled();
  });
});
