import { describe, expect, it } from "vitest";
import { NoSuchKey } from "@aws-sdk/client-s3";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { configFromEnv, createApp } from "../src/app.js";
import { FunnelLogger } from "../src/funnel.js";
import { UpstreamError } from "../src/advisories.js";
import { DirAuditStore, S3AuditStore, auditSuggestions, type AuditRecord, type AuditStore } from "../src/payer-audit.js";
import { REPORT } from "../src/report.js";

const FIXTURES = new URL("./fixtures/payer-audit/", import.meta.url).pathname;
const PACTA = "0x4348df1befaffcba248b5118b1b782b1b2bded14";
const UNKNOWN = "0x000000000000000000000000000000000000dead";
const PAY_TO = "0xAa9BC6380C65fe6d99D0805837AE460D73A91CB2";
const PAYER = "0x41836Aaa4799D787a0f02D22Ff584C3d72aC979a";
const NETWORK = "eip155:8453";
const UA = { "user-agent": "vitest-agent/1.0" };
const BROWSER = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)", accept: "text/html,application/xhtml+xml" };

class Facilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
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

function setup(store: AuditStore = new DirAuditStore(FIXTURES)) {
  const facilitator = new Facilitator();
  const app = createApp({
    network: NETWORK,
    payTo: PAY_TO,
    facilitatorKind: "payai",
    facilitatorUrl: "http://unused",
    facilitator,
    funnel: new FunnelLogger(() => {}),
    auditStore: store,
  });
  return { app, facilitator };
}

/** Pays the quote of `quotePath` and sends the payment to `path` (default: the same path). */
async function paid(app: ReturnType<typeof createApp>, path: string, quotePath = path, headers: Record<string, string> = UA) {
  const first = await app.request(quotePath, { headers: UA });
  const required = decodePaymentRequiredHeader(first.headers.get("payment-required")!);
  const accepted = required.accepts[0];
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: "0x" + "00".repeat(31) + "02" },
    },
    extensions: required.extensions,
  } as PaymentPayload;
  return app.request(path, { headers: { ...headers, "payment-signature": encodePaymentSignatureHeader(payload) } });
}

describe("GET /x402/payer-audit/preview (free)", () => {
  it("returns counts per label and the probe share, no addresses, no facilitator call", async () => {
    const { app, facilitator } = setup();
    const res = await app.request(`/x402/payer-audit/preview?payTo=${PACTA.toUpperCase().replace("0X", "0x")}`, { headers: UA });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ pay_to: PACTA, payer_count: 18, by_label: { probe: 0, self: 10, fleet: 0, real: 1, once: 7 }, probe_share: { payers: 0, usd: 0 } });
    expect(JSON.stringify(body)).not.toContain("0xca4e2ff2");
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
  });

  it.each([
    ["", 400, "invalid_pay_to"],
    ["?payTo=0x123", 400, "invalid_pay_to"],
    [`?payTo=${PACTA}&src=mcp`, 400, "unknown_param"],
    [`?payto=${PACTA}`, 400, "unknown_param"],
    [`?payTo=${UNKNOWN}`, 404, "not_indexed"],
  ])("%s -> %i %s", async (q, status, code) => {
    const { app } = setup();
    const res = await app.request(`/x402/payer-audit/preview${q}`, { headers: UA });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(code);
  });
});

describe("GET /x402/payer-audit ($0.05)", () => {
  it("quotes $0.05 to our payTo on Base with a bazaar extension", async () => {
    const { app } = setup();
    const res = await app.request("/x402/payer-audit", { headers: UA });
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, payTo: PAY_TO, amount: "50000" });
    const bazaar = required.extensions?.bazaar as { info: { input: { queryParams: unknown } } };
    expect(JSON.stringify(bazaar.info)).toContain(PACTA);
    expect(await res.json()).toMatchObject({ error: "Payment required", price: "$0.05" });
  });

  it.each([
    ["?payTo=nope", 400, "invalid_pay_to"],
    [`?payTo=${PACTA}&limit=5`, 400, "unknown_param"],
    [`?payTo=${UNKNOWN}`, 404, "not_indexed"],
  ])("%s is rejected before payment, even with a payment attached", async (q, status, code) => {
    const { app, facilitator } = setup();
    const unpaid = await app.request(`/x402/payer-audit${q}`, { headers: UA });
    expect(unpaid.status).toBe(status);
    const body = await unpaid.json();
    expect(body.error).toBe(code);
    expect(body.example.url).toContain(`payTo=${PACTA}`);
    const withPayment = await paid(app, `/x402/payer-audit${q}`, "/x402/payer-audit");
    expect(withPayment.status).toBe(status);
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
  });

  it("data store failure is a free 502 before payment", async () => {
    const { app, facilitator } = setup({ get: async () => { throw new UpstreamError("audit data unavailable (TimeoutError)"); } });
    const res = await paid(app, `/x402/payer-audit?payTo=${PACTA}`, "/x402/payer-audit");
    expect(res.status).toBe(502);
    expect((await res.json()).message).toContain("not charged");
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
  });

  it("paid: every payer with label, funders and suggestions; settled once", async () => {
    const { app, facilitator } = setup();
    const res = await paid(app, `/x402/payer-audit?payTo=${PACTA}`, "/x402/payer-audit");
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-response")).toBeTruthy();
    const body = await res.json();
    expect(body.payers).toHaveLength(18);
    expect(body.payers[0]).toMatchObject({ address: "0xca4e2ff22b69a7284210c47bdee21aac1269da09", label: "self", reason: expect.stringContaining("by the payTo") });
    expect(body.by_label_detail.self).toMatchObject({ payers: 10 });
    expect(body.suggestions.join(" ")).toContain("funded by this payTo");
    expect(body.listing).toMatchObject({ cdp: false, payai: true });
    expect(facilitator.settleCalls).toBe(1);
  });
});

describe("payer audit data", () => {
  const record = (over: Partial<AuditRecord["by_label"]>, listing = { cdp: true, payai: true }) => {
    const z = { payers: 0, tx: 0, usd: 0 };
    const by_label = { probe: z, self: z, fleet: z, real: z, once: z, ...over };
    const payers = Object.values(by_label).reduce((s, v) => s + v.payers, 0);
    return { totals: { payers, tx: payers, usd: Object.values(by_label).reduce((s, v) => s + v.usd, 0) }, by_label, listing } as unknown as AuditRecord;
  };

  it("suggestions name probes, fleets and missing listings", () => {
    const s = auditSuggestions(record({ probe: { payers: 9, tx: 9, usd: 0.09 }, fleet: { payers: 3, tx: 30, usd: 0.3 } }, { cdp: false, payai: true })).join("\n");
    expect(s).toContain("9 of 12 payers are directory probes");
    expect(s).toContain("3 payers ($0.30) share one funder");
    expect(s).toContain("Not in the CDP Bazaar snapshot");
    expect(s).toContain("No payer paid on 2 or more days");
    expect(s).toContain("All revenue in the window came from probes");
    expect(auditSuggestions(record({}))[0]).toContain("No Base USDC payments");
  });

  it("S3 store: missing key is undefined (cached), other errors are UpstreamError", async () => {
    let calls = 0;
    const missing = new S3AuditStore("b", "payer-audit/", {
      send: async () => {
        calls++;
        throw new NoSuchKey({ message: "no", $metadata: {} });
      },
    } as never);
    expect(await missing.get(UNKNOWN)).toBeUndefined();
    expect(await missing.get(UNKNOWN)).toBeUndefined();
    expect(calls).toBe(1);
    const broken = new S3AuditStore("b", "p", { send: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); } } as never);
    await expect(broken.get(UNKNOWN)).rejects.toBeInstanceOf(UpstreamError);
    let key = "";
    const ok = new S3AuditStore("b", "payer-audit", {
      send: async (cmd: { input: { Key: string } }) => {
        key = cmd.input.Key;
        return { Body: { transformToString: async () => '{"pay_to":"x"}' } };
      },
    } as never);
    expect(await ok.get(PACTA.toUpperCase().replace("0X", "0x"))).toEqual({ pay_to: "x" });
    expect(key).toBe(`payer-audit/${PACTA}.json`);
  });

  it("configFromEnv: S3 when PAYER_AUDIT_BUCKET is set; mainnet still defaults to PayAI", () => {
    const cfg = configFromEnv({ X402_PAY_TO: PAY_TO, X402_NETWORK: NETWORK, PAYER_AUDIT_BUCKET: "bucket" });
    expect(cfg.auditStore).toBeInstanceOf(S3AuditStore);
    expect(cfg).toMatchObject({ payTo: PAY_TO, facilitatorKind: "payai", facilitatorUrl: "https://facilitator.payai.network" });
  });
});

describe("x402 real payers report", () => {
  it("summary page is free HTML with links to both paid versions", async () => {
    const { app, facilitator } = setup();
    const res = await app.request("/reports/x402-real-payers", { headers: BROWSER });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("22,916");
    expect(html).toContain("/reports/x402-real-payers/full");
    expect(html).toContain("/reports/x402-real-payers.json");
    expect(html).not.toContain("0x9d3d9410"); // top payer table is in the paid part only
    expect(facilitator.verifyCalls).toBe(0);
  });

  it("JSON version: $0.5, unknown parameter is a free 400, paid returns the report", async () => {
    const { app, facilitator } = setup();
    const q = await app.request("/reports/x402-real-payers.json", { headers: UA });
    expect(q.status).toBe(402);
    expect(decodePaymentRequiredHeader(q.headers.get("payment-required")!).accepts[0]).toMatchObject({ amount: "500000", payTo: PAY_TO });
    const bad = await paid(app, "/reports/x402-real-payers.json?format=csv", "/reports/x402-real-payers.json");
    expect(bad.status).toBe(400);
    expect(facilitator.verifyCalls).toBe(0);
    const res = await paid(app, "/reports/x402-real-payers.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.probe_wallets).toHaveLength(164);
    expect(body.headline[1]).toEqual({ metric: "distinct paying addresses", value: 22_916 });
    expect(facilitator.settleCalls).toBe(1);
  });

  it("HTML version: $2; a browser gets the official mainnet paywall, an agent the JSON quote", async () => {
    const { app } = setup();
    const agent = await app.request("/reports/x402-real-payers/full", { headers: UA });
    expect(agent.status).toBe(402);
    expect(decodePaymentRequiredHeader(agent.headers.get("payment-required")!).accepts[0]).toMatchObject({ amount: "2000000", payTo: PAY_TO, network: NETWORK });
    const browser = await app.request("/reports/x402-real-payers/full", { headers: { ...BROWSER, "accept-encoding": "gzip" } });
    expect(browser.status).toBe(402);
    expect(browser.headers.get("content-encoding")).toBe("gzip");
    const unzipped = await new Response(browser.body!.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(unzipped).toContain("window.x402");
    const plain = await app.request("/reports/x402-real-payers/full", { headers: BROWSER });
    const page = await plain.text();
    expect(page).toContain("window.x402");
    expect(page).toContain("testnet: false");
    expect(page).toContain('"amount":"2000000"');
    expect(page).not.toMatch(/cdpClientKey|CDP_CLIENT_KEY/i);
  });

  it("HTML version paid: the report with the probe wallet table", async () => {
    const { app, facilitator } = setup();
    const res = await paid(app, "/reports/x402-real-payers/full");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Top 20 repeat payers");
    expect(html).toContain(REPORT.probe_wallets[0].address);
    expect(facilitator.settleCalls).toBe(1);
  });

  it("testnet deployment shows the testnet paywall", async () => {
    const app = createApp({ network: "eip155:84532", payTo: PAY_TO, facilitatorKind: "x402org", facilitatorUrl: "http://unused", facilitator: new (class extends Facilitator {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} } as never;
      }
    })(), funnel: new FunnelLogger(() => {}) });
    const page = await (await app.request("/reports/x402-real-payers/full", { headers: BROWSER })).text();
    expect(page).toContain("testnet: true");
  });
});
