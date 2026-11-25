// R24: the payer audit's browser paywall, the preview page for browsers, the entry links, and the format parameter on
// /reports/x402-real-payers/full. fixtures/audit-402-baseline.json was captured from main 23bcf2e with this config:
// the three new paid routes must quote exactly what they quoted there, and the JSON preview must be byte-identical.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { PAYWALL_CONNECTOR, createApp } from "../src/app.js";
import { FunnelLogger } from "../src/funnel.js";
import { DirAuditStore } from "../src/payer-audit.js";
import { reportFullHtml } from "../src/report.js";
import baseline from "./fixtures/audit-402-baseline.json";

const FIXTURES = new URL("./fixtures/payer-audit/", import.meta.url).pathname;
const PACTA = "0x4348df1befaffcba248b5118b1b782b1b2bded14";
const PAY_TO = "0xAa9BC6380C65fe6d99D0805837AE460D73A91CB2";
const PAYER = "0x41836Aaa4799D787a0f02D22Ff584C3d72aC979a";
const NETWORK = "eip155:8453";
const AGENT = { "user-agent": "agent/1.0" };
const BROWSER = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)", accept: "text/html,application/xhtml+xml" };
const GZ = { ...BROWSER, "accept-encoding": "gzip, deflate, br" };
/** What the paywall page's own fetch sends after the wallet signed (plus the payment header). */
const PAYWALL_FETCH = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)", accept: "*/*", "sec-fetch-mode": "cors", "access-control-expose-headers": "PAYMENT-RESPONSE" };
const SELLER_TOOLS = "Tools for x402 sellers (402 lint, listing checks, trust scores) had few non-probe payers: 1 to 5 each.";

class Facilitator implements FacilitatorClient {
  settleCalls = 0;
  verifyCalls = 0;
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: ["bazaar"], signers: {} } as never;
  }
  async verify() {
    this.verifyCalls++;
    return { isValid: true, payer: PAYER };
  }
  async settle(_p: PaymentPayload, r: PaymentRequirements) {
    this.settleCalls++;
    return { success: true, transaction: "0x" + "12".repeat(32), network: r.network, payer: PAYER };
  }
}

function setup(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const facilitator = new Facilitator();
  const app = createApp({
    network: NETWORK,
    payTo: PAY_TO,
    facilitatorKind: "payai",
    facilitatorUrl: "http://unused",
    publicBaseUrl: "https://api.example.test",
    facilitator,
    funnel: new FunnelLogger(() => {}),
    auditStore: new DirAuditStore(FIXTURES),
    ...over,
  });
  return { app, facilitator };
}

async function paid(app: ReturnType<typeof createApp>, path: string, quotePath: string, headers: Record<string, string>) {
  const required = decodePaymentRequiredHeader((await app.request(quotePath, { headers: AGENT })).headers.get("payment-required")!);
  const accepted = required.accepts[0];
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: "0x" + "00".repeat(31) + "03" },
    },
    extensions: required.extensions,
  } as PaymentPayload;
  return app.request(path, { headers: { ...headers, "payment-signature": encodePaymentSignatureHeader(payload) } });
}

const gunzip = (res: Response) => new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();

describe("new paid routes: 402 unchanged from main", () => {
  const quotes = Object.entries(baseline).filter(([k]) => !k.includes("/preview"));
  it.each(quotes)("%s (agent)", async (key, want) => {
    const { app } = setup();
    const w = want as { status: number; paymentRequired: unknown; body: unknown };
    for (const headers of [AGENT, { ...AGENT, "accept-encoding": "gzip" }]) {
      const res = await app.request(key.slice(4), { headers });
      expect(res.status).toBe(w.status);
      expect(res.headers.get("content-encoding")).toBe(key.includes("/full") && "accept-encoding" in headers ? "gzip" : null);
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!)).toEqual(w.paymentRequired);
      expect(JSON.parse(res.headers.get("content-encoding") ? await gunzip(res) : await res.text())).toEqual(w.body);
    }
  });

  it("amounts, payTo and network of the three routes", () => {
    const accepts = Object.fromEntries(quotes.map(([k, v]) => [k, (v as { paymentRequired: { accepts: unknown[] } }).paymentRequired.accepts]));
    const one = (amount: string) => [expect.objectContaining({ scheme: "exact", amount, payTo: PAY_TO, network: NETWORK })];
    expect(accepts["GET /x402/payer-audit"]).toEqual(one("50000"));
    expect(accepts[`GET /x402/payer-audit?payTo=${PACTA}`]).toEqual(one("50000"));
    expect(accepts["GET /reports/x402-real-payers.json"]).toEqual(one("500000"));
    expect(accepts["GET /reports/x402-real-payers/full"]).toEqual(one("2000000"));
  });

  it("the report's browser paywall page is byte-identical", async () => {
    const { app } = setup();
    const want = baseline["GET /reports/x402-real-payers/full"].browser;
    const res = await app.request("/reports/x402-real-payers/full", { headers: { "user-agent": "Mozilla/5.0", accept: "text/html", "accept-encoding": "gzip" } });
    expect(res.status).toBe(want.status);
    expect(res.headers.get("content-type")).toBe(want.contentType);
    expect(createHash("sha256").update(await gunzip(res)).digest("hex")).toBe(want.sha256);
  });

  it("?format=html quotes the same; another format is a free 400", async () => {
    const { app, facilitator } = setup();
    const want = baseline["GET /reports/x402-real-payers/full"];
    const res = await app.request("/reports/x402-real-payers/full?format=html", { headers: AGENT });
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(required.accepts).toEqual(want.paymentRequired.accepts);
    const bad = await paid(app, "/reports/x402-real-payers/full?format=csv", "/reports/x402-real-payers/full", AGENT);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_format");
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
    expect((await paid(app, "/reports/x402-real-payers/full?format=html", "/reports/x402-real-payers/full", AGENT)).status).toBe(200);
  });

  it("openapi declares the optional format parameter on the HTML report", async () => {
    const { app } = setup();
    const spec = await (await app.request("/openapi.json")).json();
    expect(spec.paths["/reports/x402-real-payers/full"].get.parameters).toEqual([
      expect.objectContaining({ name: "format", in: "query", required: false, schema: expect.objectContaining({ type: "string", enum: ["html"] }) }),
    ]);
  });
});

describe("payer audit in a browser", () => {
  it("gets the official paywall: gzip, telemetry off, $0.05 mainnet; agents' bytes are not compressed", async () => {
    const { app } = setup();
    const res = await app.request(`/x402/payer-audit?payTo=${PACTA}`, { headers: GZ });
    expect(res.status).toBe(402);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const page = await gunzip(res);
    expect(page).toContain("window.x402");
    expect(page).toContain(`${PAYWALL_CONNECTOR.slice(0, -2)},preference:{options:"all",telemetry:!1}})`);
    expect(page).not.toContain(PAYWALL_CONNECTOR);
    expect(page).toContain("testnet: false");
    expect(page).toContain('"amount":"50000"');
    expect(page).not.toMatch(/cdpClientKey|CDP_CLIENT_KEY/i);
  });

  it("without gzip: a small page pointing to the free preview", async () => {
    const { app } = setup();
    const res = await app.request(`/x402/payer-audit?payTo=${PACTA}`, { headers: BROWSER });
    expect(res.status).toBe(406);
    const html = await res.text();
    expect(html.length).toBeLessThan(3000);
    expect(html).toContain(`/x402/payer-audit/preview?payTo=${PACTA}`);
  });

  it("shares the daily paywall cap with the report and fails closed", async () => {
    let left = 1;
    const { app } = setup({ paywallCap: { limit: 1, take: async () => left-- > 0 } });
    expect((await app.request("/reports/x402-real-payers/full", { headers: GZ })).status).toBe(402);
    expect((await app.request(`/x402/payer-audit?payTo=${PACTA}`, { headers: GZ })).status).toBe(429);
    expect((await app.request(`/x402/payer-audit?payTo=${PACTA}`, { headers: AGENT })).status).toBe(402);
    const broken = setup({ paywallCap: { limit: 1, take: async () => { throw new Error("ddb down"); } } }).app;
    expect((await broken.request(`/x402/payer-audit?payTo=${PACTA}`, { headers: GZ })).status).toBe(429);
  });

  it("after a browser payment the paywall's fetch gets the audit as HTML; settled once", async () => {
    const { app, facilitator } = setup({ paywallCap: { limit: 0, take: async () => false } });
    const res = await paid(app, `/x402/payer-audit?payTo=${PACTA}`, "/x402/payer-audit", PAYWALL_FETCH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("payment-response")).toBeTruthy();
    const html = await res.text();
    expect(html).toContain("0xca4e2ff22b69a7284210c47bdee21aac1269da09");
    expect(html).toContain("labelled self");
    expect(html).toContain("Payers (18)");
    expect(facilitator.settleCalls).toBe(1);
  });

  it("a paid agent, even a browser-based one without the paywall's header, still gets JSON", async () => {
    const { app } = setup();
    for (const headers of [AGENT, { ...BROWSER, "sec-fetch-mode": "cors" }]) {
      const res = await paid(app, `/x402/payer-audit?payTo=${PACTA}`, "/x402/payer-audit", headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect((await res.json()).payers).toHaveLength(18);
    }
  });
});

describe("payer audit preview", () => {
  const key = `GET /x402/payer-audit/preview?payTo=${PACTA}` as const;

  it("agent and JSON responses are byte-identical to main", async () => {
    const { app } = setup();
    const want = baseline[key] as { status: number; contentType: string; text: string };
    for (const headers of [AGENT, { ...AGENT, accept: "application/json" }, { "user-agent": "Mozilla/5.0", accept: "application/json" }]) {
      const res = await app.request(key.slice(4), { headers });
      expect(res.status).toBe(want.status);
      expect(res.headers.get("content-type")).toBe(want.contentType);
      expect(await res.text()).toBe(want.text);
    }
  });

  it("a browser gets a page with counts per label, one suggestion and the paid link", async () => {
    const { app, facilitator } = setup();
    const res = await app.request(key.slice(4), { headers: BROWSER });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toMatch(/<td>self<\/td><td>10<\/td>/);
    expect(html).toMatch(/<td>once<\/td><td>7<\/td>/);
    expect(html).toContain("<b>18</b> payers");
    expect(html).toContain("Example suggestion");
    expect(html).toContain(`<a class="buy" href="https://api.example.test/x402/payer-audit?payTo=${PACTA}">See every payer, $0.05</a>`);
    expect(html).not.toContain("0xca4e2ff2"); // no payer addresses in the free page
    expect(html.length).toBeLessThan(8000);
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
  });

  it("input errors stay JSON for a browser too", async () => {
    const { app } = setup();
    const res = await app.request("/x402/payer-audit/preview?payTo=0x123", { headers: BROWSER });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_pay_to");
  });
});

describe("entry links", () => {
  it("summary page links the preview and both paid entries, without the seller-tools finding", async () => {
    const { app } = setup();
    const html = await (await app.request("/reports/x402-real-payers", { headers: BROWSER })).text();
    expect(html).not.toContain("Tools for x402 sellers");
    expect(html).toContain('href="https://api.example.test/reports/x402-real-payers/full"');
    expect(html).toContain('action="https://api.example.test/x402/payer-audit/preview"');
    expect(html).toContain('formaction="https://api.example.test/x402/payer-audit"');
    expect(html).toContain('href="https://api.example.test/x402/payer-audit/preview?payTo=0xaa9bc6380c65fe6d99d0805837ae460d73a91cb2"');
    expect(html).toContain('href="https://api.example.test/x402/payer-audit?payTo=0xaa9bc6380c65fe6d99d0805837ae460d73a91cb2"');
  });

  it("the paid report still has the seller-tools finding", () => {
    expect(reportFullHtml()).toContain(SELLER_TOOLS);
  });

  it("home page links the preview, the audit and the report", async () => {
    const { app } = setup();
    const html = await (await app.request("/", { headers: BROWSER })).text();
    for (const href of ["/x402/payer-audit/preview?payTo=", "/x402/payer-audit?payTo=", "/reports/x402-real-payers\"", "/reports/x402-real-payers/full\""]) {
      expect(html).toContain(`href="${href}`);
    }
  });
});
