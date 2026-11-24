// R10: a facilitator /supported sync that fails or hangs once must not turn the next paid request into a 502/5xx.
import { describe, expect, it, vi } from "vitest";
import { FacilitatorTimeoutError, decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.js";
import { FunnelLogger } from "../src/funnel.js";

const PAY_TO = "0x96B16408be584E863Ab3f05703059e302c474f0A";
const NETWORK = "eip155:84532";
const SUPPORTED = { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: ["bazaar"], signers: {} };
const hang = () => new Promise<never>(() => {});
const slow = (ms: number) => new Promise((r) => setTimeout(() => r(SUPPORTED), ms));

interface Options {
  verify?: () => Promise<unknown>;
  settle?: () => Promise<unknown>;
  requestDeadlineMs?: number;
}

/** Each getSupported call takes the next behaviour; after the list, it answers at once. */
function setup(behaviours: Array<() => Promise<unknown>>, timeoutMs = 50, opts: Options = {}) {
  const lines: string[] = [];
  const getSupported = vi.fn(async () => (behaviours.shift() ?? (async () => SUPPORTED))());
  const verify = vi.fn(opts.verify ?? (async () => ({ isValid: false, invalidReason: "invalid_payload" })));
  const settle = vi.fn(opts.settle ?? (async () => ({ success: false, errorReason: "unused", transaction: "", network: NETWORK })));
  const facilitator = { getSupported, verify, settle } as unknown as FacilitatorClient;
  const app = createApp({
    network: NETWORK,
    payTo: PAY_TO,
    facilitatorKind: "payai",
    facilitatorUrl: "http://unused",
    facilitator,
    funnel: new FunnelLogger((l) => lines.push(l)),
    facilitatorInitTimeoutMs: timeoutMs,
    requestDeadlineMs: opts.requestDeadlineMs,
  });
  return { app, getSupported, verify, settle, events: () => lines.map((l) => JSON.parse(l)) };
}

/** A well-formed signed payment for the quoted requirements (the fake facilitator decides whether it is valid). */
async function signedWorkday(app: ReturnType<typeof createApp>) {
  const required = decodePaymentRequiredHeader((await workday(app)).headers.get("payment-required")!);
  const accepted = required.accepts[0];
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: "0x41836Aaa4799D787a0f02D22Ff584C3d72aC979a",
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: "0x" + "00".repeat(31) + "01",
      },
    },
    extensions: required.extensions,
  } as PaymentPayload;
  return { "payment-signature": encodePaymentSignatureHeader(payload) };
}

const timed = async <T>(p: T | Promise<T>) => {
  const t0 = Date.now();
  const value = await p;
  return { value, ms: Date.now() - t0 };
};

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

  it("the request path's two attempts share one sync budget (no more than the init timeout in total)", async () => {
    const budget = 400;
    const { app, getSupported } = setup([hang, hang, hang], budget);
    expect(await app.initFacilitator()).toBe(false);
    const { value: res, ms } = await timed(workday(app));
    expect(res.status).toBe(503);
    expect(getSupported).toHaveBeenCalledTimes(3); // init + two request attempts
    expect(ms).toBeGreaterThanOrEqual(budget - 20); // both halves were waited for ...
    expect(ms).toBeLessThan(budget + 150); // ... but not two full budgets
  });

  it("a route configuration error is a 500 at once and is not retried", async () => {
    const otherNetwork = { ...SUPPORTED, kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:1" }] };
    const { app, getSupported } = setup([async () => otherNetwork], 5_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await app.initFacilitator()).toBe(false);
    const ours = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("{"));
    expect(JSON.parse(ours.at(-1)!).type).toBe("facilitator_sync_failed");
    warn.mockRestore();
    for (let i = 0; i < 2; i++) {
      const res = await workday(app);
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("internal_error");
    }
    expect(getSupported).toHaveBeenCalledTimes(1);
  });

  it("logs the cause of a failed sync (e.g. FacilitatorTimeoutError), not only the library's wrapper message", async () => {
    const { app } = setup([async () => Promise.reject(new FacilitatorTimeoutError("supported", 90_000))]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await app.initFacilitator();
    const lines = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l))
      .filter((l) => l.type === "facilitator_sync_failed");
    warn.mockRestore();
    expect(lines[0].cause).toBe("Facilitator supported request timed out after 90000ms");
  });

  it("a hanging verify ends at the request deadline, unpaid and unsettled", async () => {
    const { app, settle } = setup([], 50, { verify: hang, requestDeadlineMs: 300 });
    const headers = await signedWorkday(app);
    const { value: res, ms } = await timed(workday(app, headers));
    expect(ms).toBeLessThan(300 + 150);
    expect(res.status).not.toBe(200);
    expect(settle).not.toHaveBeenCalled();
  });

  it("a hanging settle ends at the request deadline without content, logged as settle_fail", async () => {
    const { app, events } = setup([], 50, {
      verify: async () => ({ isValid: true, payer: "0x41836Aaa4799D787a0f02D22Ff584C3d72aC979a" }),
      settle: hang,
      requestDeadlineMs: 300,
    });
    const headers = await signedWorkday(app);
    const { value: res, ms } = await timed(workday(app, headers));
    expect(ms).toBeLessThan(300 + 150);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("is_workday");
    expect(events().find((e) => e.stage === "settle_fail")?.reason).toMatch(/settle request timed out/);
  });

  it("invalid input is still a free 400 without waiting for the facilitator", async () => {
    const { app, getSupported } = setup([hang, hang, hang], 5_000);
    const res = await app.request("/cn/workday?date=2026-13-01");
    expect(res.status).toBe(400);
    expect(getSupported).not.toHaveBeenCalled();
  });
});
