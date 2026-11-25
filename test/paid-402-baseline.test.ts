// The six original paid routes must quote exactly what they quoted before the payer audit and report routes were added:
// same PAYMENT-REQUIRED (amount, asset, payTo, network, resource, bazaar extension), same JSON body, same browser page.
// fixtures/paid-402-baseline.json was captured from main 1ef73b4 with this config.
import { describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createApp } from "../src/app.js";
import { FunnelLogger } from "../src/funnel.js";
import baseline from "./fixtures/paid-402-baseline.json";

const NETWORK = "eip155:8453";
const app = createApp({
  network: NETWORK,
  payTo: "0xAa9BC6380C65fe6d99D0805837AE460D73A91CB2",
  facilitatorKind: "payai",
  facilitatorUrl: "http://unused",
  publicBaseUrl: "https://api.example.test",
  facilitator: {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: ["bazaar"], signers: {} }) as never,
    verify: async () => {
      throw new Error("not called");
    },
    settle: async () => {
      throw new Error("not called");
    },
  },
  funnel: new FunnelLogger(() => {}),
});

describe("original paid routes: 402 unchanged", () => {
  it.each(Object.entries(baseline))("%s", async (key, want) => {
    const [method, path] = key.split(" ");
    const agent = await app.request(path, { method, headers: { "user-agent": "agent/1.0" } });
    expect(agent.status).toBe(want.status);
    expect(decodePaymentRequiredHeader(agent.headers.get("payment-required")!)).toEqual(want.paymentRequired);
    expect(await agent.json()).toEqual(want.body);
    const browser = await app.request(path, { method, headers: { "user-agent": "Mozilla/5.0", accept: "text/html" } });
    expect(browser.status).toBe(want.browser.status);
    expect(browser.headers.get("content-type")).toBe(want.browser.contentType);
    expect(await browser.text()).toBe(want.browser.html);
  });

  it("covers all six routes, mainnet, PayAI-era payTo", () => {
    const routes = new Set(Object.keys(baseline).map((k) => k.split("?")[0]));
    expect([...routes].sort()).toEqual([
      "GET /cn/business-days",
      "GET /cn/workday",
      "GET /deps/advisories",
      "GET /sec/insider-trades",
      "GET /sec/latest-filings",
      "POST /deps/advisories/batch",
    ]);
    for (const v of Object.values(baseline)) {
      expect(v.paymentRequired.accepts[0]).toMatchObject({ network: NETWORK, payTo: "0xAa9BC6380C65fe6d99D0805837AE460D73A91CB2" });
    }
  });
});
