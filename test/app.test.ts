import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { BATCH_PRICE, configFromEnv, createApp } from "../src/app.js";
import { ADVISORIES_DESCRIPTION, BATCH_DESCRIPTION } from "../src/content-deps.js";
import { SKILL_DESCRIPTION, perPackagePrice } from "../src/content.js";
import { FunnelLogger } from "../src/funnel.js";
import { OsvClient } from "../src/advisories.js";
import { fakeOsvFetch } from "./helpers/osv.js";
import { SecClient } from "../src/sec.js";
import { fakeSecFetch } from "./helpers/sec.js";

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

function setup(mode: { verify: boolean; settle: boolean | "throw" }, osv?: OsvClient, sec?: SecClient) {
  const lines: string[] = [];
  const facilitator = new FakeFacilitator(mode);
  const app = createApp({
    network: NETWORK,
    payTo: PAY_TO,
    facilitatorKind: "x402org",
    facilitatorUrl: "http://unused",
    facilitator,
    funnel: new FunnelLogger((l) => lines.push(l)),
    osv,
    sec,
  });
  const events = () => lines.map((l) => JSON.parse(l));
  return { app, facilitator, lines, events };
}

const UA = { "user-agent": "vitest-agent/1.0" };

async function paidRequest(app: ReturnType<typeof createApp>, path: string, init: { method?: string; body?: string } = {}) {
  const json: Record<string, string> = init.body ? { "content-type": "application/json" } : {};
  const first = await app.request(path, { ...init, headers: { ...UA, ...json } });
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
  return app.request(path, { ...init, headers: { ...UA, ...json, "payment-signature": encodePaymentSignatureHeader(payload) } });
}

describe("402 without payment", () => {
  it.each([
    ["/cn/workday?date=2026-10-08", "3000"],
    ["/cn/business-days?from=2026-01-05&to=2026-01-16", "5000"],
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
    const body = await res.json();
    expect(body).toMatchObject({ error: "Payment required", currency: "USDC", network: NETWORK });
    // no paid content: the body only carries the fixed documentation example, never this request's answer
    expect(JSON.stringify(body)).not.toContain(path.includes("workday") ? '"date":"2026-10-08"' : '"from":"2026-01-05"');
    expect(events().map((e) => e.stage)).toEqual(["request", "402_returned"]);
    expect(events()[0]).toMatchObject({ route: path.split("?")[0], user_agent: "vitest-agent/1.0", type: "x402_funnel" });
    expect(events()[0].ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe("invalid input is rejected before payment (not charged)", () => {
  it.each([
    ["/cn/workday?date=", 400, "invalid_date"],
    ["/cn/workday?day=2026-02-14", 400, "invalid_date"],
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
    for (const e of events()) expect(Object.keys(e)).not.toContain("settled");
    // The signature (and the encoded header containing it) must never be logged.
    expect(lines.join("\n")).not.toContain("abababab");
  });

  it("src=mcp (the MCP over-quota hint's URL) pays and answers exactly like the plain URL", async () => {
    const plain = setup({ verify: true, settle: true });
    const tagged = setup({ verify: true, settle: true });
    const a = await paidRequest(plain.app, "/cn/workday?date=2026-02-14");
    const b = await paidRequest(tagged.app, "/cn/workday?date=2026-02-14&src=mcp");
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    expect(tagged.facilitator.settleCalls).toBe(1);
    expect(tagged.events().map((e) => e.stage)).toEqual(plain.events().map((e) => e.stage));
    expect(tagged.events().filter((e) => e.stage === "request").map((e) => e.src)).toEqual(["mcp", "mcp"]);
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
    for (const path of ["/cn/workday", "/cn/business-days"]) {
      const r = oa.paths[path].get.responses;
      expect(Object.keys(r["402"].headers)).toEqual(["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"]);
      expect(r["200"].headers["PAYMENT-RESPONSE"]).toBeTruthy();
      expect(r["502"]).toBeTruthy();
    }
    expect(await (await app.request("/health")).json()).toMatchObject({ ok: true, network: NETWORK });
    expect(events()).toHaveLength(0);
  });
});

describe("bare probes (no input at all) get a 402 quote, not a 400", () => {
  it.each([
    ["/cn/workday", "GET", "3000", "$0.003", "/cn/workday?date=2026-02-14"],
    ["/cn/business-days", "GET", "5000", "$0.005", "/cn/business-days?from=2026-09-28&to=2026-10-11"],
    ["/deps/advisories", "GET", "5000", "$0.005", "/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20"],
    ["/deps/advisories/batch", "POST", "20000", "$0.02", "/deps/advisories/batch"],
  ])("%s %s -> 402 with bazaar example and a self-describing body", async (path, method, amount, price, examplePath) => {
    const osv = new OsvClient(fakeOsvFetch().fn);
    const { app, facilitator, events } = setup({ verify: true, settle: true }, osv);
    const res = await app.request(path, { method, headers: UA });
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(required.accepts[0].amount).toBe(amount);
    const bazaar = required.extensions?.bazaar as { info: { input: unknown; output: { example: unknown } } };
    expect(bazaar.info.input).toBeTruthy();
    expect(bazaar.info.output.example).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({
      error: "Payment required",
      price,
      currency: "USDC",
      network: NETWORK,
      docs: "http://localhost/openapi.json",
      llms_txt: "http://localhost/llms.txt",
      example: { request: { method, url: `http://localhost${examplePath}` } },
    });
    expect(body.how_to_pay).toContain("PAYMENT-SIGNATURE");
    expect(body.example.response).toBeTruthy();
    if (method === "POST") expect(body.example.request.body).toEqual({ packages: [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }] });
    expect(events().map((e) => e.stage)).toEqual(["request", "402_returned"]);
    expect(facilitator.verifyCalls + facilitator.settleCalls + osv.upstreamCalls).toBe(0);
  });

  it.each(["  \n", "{}", " { } "])("a bare POST body %j is also quoted", async (body) => {
    const { app, facilitator } = setup({ verify: true, settle: true });
    const res = await app.request("/deps/advisories/batch", { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(402);
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
  });

  it("an empty-object batch body that carries a payment is validated (400), never verified or settled", async () => {
    const { app, facilitator } = setup({ verify: true, settle: true });
    const res = await app.request("/deps/advisories/batch", {
      method: "POST",
      body: "{}",
      headers: { ...UA, "content-type": "application/json", "payment-signature": "e30=" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
  });

  it("a bare request that carries a payment is validated and rejected free, never verified or settled", async () => {
    for (const [path, method] of [["/cn/workday", "GET"], ["/deps/advisories/batch", "POST"]] as const) {
      const { app, facilitator } = setup({ verify: true, settle: true });
      const res = await app.request(path, { method, headers: { ...UA, "payment-signature": "e30=" } });
      expect(res.status).toBe(400);
      expect(res.headers.get("payment-required")).toBeNull();
      expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
    }
  });
});

describe("discovery metadata (x402scan / AgentCash)", () => {
  it("openapi declares structured x-payment-info on every paid operation, x-discovery.llmsTxtUrl, guidance and public free routes", async () => {
    const { app } = setup({ verify: true, settle: true });
    const oa = await (await app.request("/openapi.json")).json();
    const paid = {
      "/cn/workday": ["get", "0.003"],
      "/cn/business-days": ["get", "0.005"],
      "/deps/advisories": ["get", "0.005"],
      "/deps/advisories/batch": ["post", "0.02"],
      "/sec/insider-trades": ["get", "0.003"],
      "/sec/latest-filings": ["get", "0.003"],
    } as const;
    for (const [path, [method, amount]] of Object.entries(paid)) {
      const op = oa.paths[path][method];
      expect(op["x-payment-info"]).toEqual({ price: { mode: "fixed", currency: "USD", amount }, protocols: [{ x402: {} }] });
      expect(op.responses["402"]).toBeTruthy();
    }
    expect(oa.paths["/health"].get["x-payment-info"]).toBeUndefined();
    expect(oa["x-discovery"]).toEqual({ llmsTxtUrl: "http://localhost/llms.txt" });
    expect(oa.paths["/health"].get.security).toEqual([]);
    expect(oa.info["x-guidance"]).toContain("402");
    expect(oa.info.contact.url).toContain("github.com");
    expect(oa.info.description.length).toBeLessThan(300);
    expect(oa.info.description).not.toContain("CC-BY");
    expect(JSON.stringify(oa.tags)).toContain("CC-BY 4.0"); // attribution moved out of info.description
    expect(await (await app.request("/.well-known/openapi.json")).json()).toEqual(oa);
  });

  it("serves an image favicon and sets iconUrl when the public base URL is known", async () => {
    const { app } = setup({ verify: true, settle: true });
    const ico = await app.request("/favicon.ico");
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
    expect(new Uint8Array(await ico.arrayBuffer()).slice(0, 4)).toEqual(Uint8Array.from([0, 0, 1, 0]));
    const withBase = createApp({
      network: NETWORK,
      payTo: PAY_TO,
      facilitatorKind: "x402org",
      facilitatorUrl: "http://unused",
      facilitator: new FakeFacilitator({ verify: true, settle: true }),
      publicBaseUrl: "https://api.example",
      funnel: new FunnelLogger(() => {}),
    });
    const res = await withBase.request("/cn/workday");
    expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).resource.iconUrl).toBe("https://api.example/favicon.ico");
    expect((await res.json()).docs).toBe("https://api.example/openapi.json");
  });

  it("advisory descriptions lead with the install-safety intent and the batch per-package price matches BATCH_PRICE / MAX_BATCH", () => {
    expect(ADVISORIES_DESCRIPTION.startsWith("Is this package version safe to install?")).toBe(true);
    expect(BATCH_DESCRIPTION).toContain(`${BATCH_PRICE} per call`);
    expect(BATCH_DESCRIPTION).toContain(`${perPackagePrice(BATCH_PRICE)} per package`);
    expect(perPackagePrice(BATCH_PRICE)).toBe("$0.0004");
  });

  it("llms.txt has one section per service and states the payment terms once", async () => {
    const { app } = setup({ verify: true, settle: true });
    const llms = await (await app.request("/llms.txt")).text();
    const h2 = llms.split("\n").filter((l) => l.startsWith("## "));
    expect(h2).toEqual([
      "## Use from Claude Code / Cursor / Codex",
      "## MCP server (free daily quota)",
      "## China Workday Calendar",
      "## Package Vulnerability Advisories",
      "## SEC EDGAR Insider Trades and Filings",
      "## Free",
    ]);
    expect(llms.match(/scheme "exact"/g)).toHaveLength(1);
    expect(llms).toContain("$0.0004 per package");
  });
});

describe("402 body repeats the PAYMENT-REQUIRED quote (body-only clients such as market402)", () => {
  const BATCH = JSON.stringify({ packages: [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }] });
  it.each([
    ["/cn/workday?date=2026-10-08", "GET", undefined, "3000"],
    ["/cn/business-days?from=2026-01-05&to=2026-01-16", "GET", undefined, "5000"],
    ["/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20", "GET", undefined, "5000"],
    ["/deps/advisories/batch", "POST", BATCH, "20000"],
    ["/cn/workday", "GET", undefined, "3000"],
    ["/deps/advisories/batch", "POST", undefined, "20000"],
  ])("%s %s: body x402Version/accepts/resource equal the decoded header", async (path, method, body, amount) => {
    const { app } = setup({ verify: true, settle: true }, new OsvClient(fakeOsvFetch().fn));
    const res = await app.request(path, { method, body, headers: { ...UA, ...(body ? { "content-type": "application/json" } : {}) } });
    expect(res.status).toBe(402);
    expect(res.headers.get("content-length")).not.toBe("0");
    const header = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    const json = await res.json();
    expect(json.x402Version).toBe(header.x402Version);
    expect(json.accepts).toEqual(header.accepts);
    expect(json.resource).toEqual(header.resource);
    // market402's checks: x402_version, accepts_present, pay_to, amount, network_present
    expect(json.x402Version).toBe(2);
    expect(json.accepts.length).toBeGreaterThan(0);
    expect(json.accepts[0]).toMatchObject({ payTo: PAY_TO, amount, network: NETWORK });
    // the explanatory fields are kept
    expect(json).toMatchObject({ error: "Payment required", currency: "USDC" });
    expect(json.how_to_pay).toBeTruthy();
    expect(json.example).toBeTruthy();
  });

  it("a rejected payment's 402 also carries the quote, and nothing is settled", async () => {
    const { app, facilitator } = setup({ verify: false, settle: true });
    const res = await paidRequest(app, "/cn/workday?date=2026-10-08");
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.accepts).toEqual(decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts);
    expect(facilitator.settleCalls).toBe(0);
  });

  it("invalid input with a payment header is still a free 400 without a quote", async () => {
    const { app, facilitator } = setup({ verify: true, settle: true });
    const res = await app.request("/cn/workday?date=2026-13-01", { headers: { ...UA, "payment-signature": "e30=" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(await res.json()).not.toHaveProperty("accepts");
    expect(facilitator.verifyCalls + facilitator.settleCalls).toBe(0);
  });
});

describe("AgentCash one-line install and /SKILL.md", () => {
  const ORIGIN = "https://api.example";
  const withBase = () =>
    createApp({
      network: NETWORK,
      payTo: PAY_TO,
      facilitatorKind: "x402org",
      facilitatorUrl: "http://unused",
      facilitator: new FakeFacilitator({ verify: true, settle: true }),
      publicBaseUrl: ORIGIN,
      funnel: new FunnelLogger(() => {}),
    });
  const commands = [`npx agentcash add ${ORIGIN}`, `npx agentcash try ${ORIGIN}`, "npx agentcash onboard"];

  it("the preview page shows the install block before the price table, and llms.txt lists the same commands right after the summary", async () => {
    const app = withBase();
    const html = await (await app.request("/")).text();
    expect(html).toContain("Use from Claude Code / Cursor / Codex");
    expect(html).toContain(commands.join("\n"));
    expect(html.indexOf("npx agentcash add")).toBeLessThan(html.indexOf("<table>"));
    expect(html).toContain("<code>try</code> and <code>onboard</code> create an AgentCash wallet");
    const llms = await (await app.request("/llms.txt")).text();
    expect(llms).toContain(commands.join("\n"));
    expect(llms.indexOf("npx agentcash onboard")).toBeLessThan(llms.indexOf("## China Workday Calendar"));
    expect(llms).toContain("create an AgentCash wallet on first run");
  });

  it("every paid route's 402 body carries the install command, resource.description does not; payTo and amount are unchanged", async () => {
    const app = withBase();
    for (const [path, method, amount] of [
      ["/cn/workday", "GET", "3000"],
      ["/cn/business-days", "GET", "5000"],
      ["/deps/advisories", "GET", "5000"],
      ["/deps/advisories/batch", "POST", "20000"],
    ] as const) {
      const res = await app.request(path, { method, headers: UA });
      expect(res.status).toBe(402);
      const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(required.resource.description).not.toContain("agentcash");
      expect(required.accepts[0]).toMatchObject({ payTo: PAY_TO, amount, network: NETWORK });
      expect((await res.json()).install).toBe(`npx agentcash add ${ORIGIN}`);
    }
    expect((await app.request("/cn/workday?date=2026-02-30", { headers: UA })).status).toBe(400);
  });

  it("serves /SKILL.md with AgentSkills frontmatter, every endpoint and price, gov.cn sources, and lists it in openapi", async () => {
    const { app, events } = setup({ verify: true, settle: true });
    const res = await app.request("/SKILL.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("payment-required")).toBeNull();
    const md = await res.text();
    const fm = md.match(/^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/);
    expect(fm).not.toBeNull();
    expect(fm![1].length).toBeLessThanOrEqual(64);
    expect(JSON.parse(fm![2])).toBe(SKILL_DESCRIPTION);
    expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(1024);
    for (const word of ["法定节假日", "调休", "补班", "工作日", "国务院", "npm", "PyPI"]) expect(SKILL_DESCRIPTION).toContain(word);
    for (const line of [
      "GET /cn/workday?date=YYYY-MM-DD ($0.003)",
      "GET /cn/business-days?from=YYYY-MM-DD&to=YYYY-MM-DD ($0.005)",
      "GET /deps/advisories?ecosystem=&name=&version= ($0.005)",
      "POST /deps/advisories/batch ($0.02)",
      "npx agentcash add http://localhost",
      "Any x402 v2 client pays USDC on Base (network eip155:84532, scheme \"exact\"): agentcash, @x402/fetch (2.x), or Binance",
      "www.gov.cn",
    ]) expect(md).toContain(line);
    expect(md).not.toContain("x402-fetch"); // the v1-only client cannot pay a v2 quote
    const oa = await (await app.request("/openapi.json")).json();
    expect(oa.paths["/SKILL.md"].get.security).toEqual([]);
    expect(oa.paths["/SKILL.md"].get["x-payment-info"]).toBeUndefined();
    expect(events()).toHaveLength(0);
  });

  it("the skill `npx agentcash add` builds from openapi info is valid AgentSkills frontmatter", async () => {
    const { info } = await (await withBase().request("/openapi.json")).json();
    // Same template as agentcash@0.17.1 dist/esm/add-skill-*.js (originSkillTitle / originSkillContent): values are unquoted.
    const frontmatter = `---\nname: ${info.title.toLowerCase().replace(/[ .]/g, "-")}\ndescription: ${info.description}\n---`;
    const [, name, description] = frontmatter.match(/^---\nname: (.*)\ndescription: (.*)\n---$/)!;
    expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(description.length).toBeGreaterThan(0);
    expect(description).not.toContain(": ");
    expect(description).not.toContain(" #");
  });
});

describe("titles name the services", () => {
  it("openapi info.title and the llms.txt heading carry both service names; contact points at the repo", async () => {
    const { app } = setup({ verify: true, settle: true });
    const oa = await (await app.request("/openapi.json")).json();
    for (const title of [oa.info.title, (await (await app.request("/llms.txt")).text()).split("\n")[0]]) {
      expect(title).toContain("China Workday Calendar");
      expect(title).toContain("Package Vulnerability Advisories");
    }
    expect(oa.info.contact).toEqual({ name: "Source and issues", url: "https://github.com/walkley/x402-content-site" });
    expect(oa.info.contact.email).toBeUndefined();
  });
});

describe("configFromEnv", () => {
  it("defaults to Base Sepolia and the x402.org facilitator", () => {
    expect(configFromEnv({ X402_PAY_TO: PAY_TO })).toMatchObject({
      network: "eip155:84532",
      facilitatorKind: "x402org",
      facilitatorUrl: "https://x402.org/facilitator",
    });
  });
  it("selects payai and cdp, and lets X402_FACILITATOR_URL override non-cdp URLs", () => {
    expect(configFromEnv({ X402_PAY_TO: PAY_TO, X402_NETWORK: "eip155:8453", FACILITATOR: "payai" }))
      .toMatchObject({ network: "eip155:8453", facilitatorKind: "payai", facilitatorUrl: "https://facilitator.payai.network" });
    expect(configFromEnv({ X402_PAY_TO: PAY_TO, FACILITATOR: "cdp" }))
      .toMatchObject({ facilitatorKind: "cdp", facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402" });
    expect(configFromEnv({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: "https://f.example" }).facilitatorUrl).toBe("https://f.example");
  });
  it("rejects bad values and x402.org on mainnet", () => {
    expect(() => configFromEnv({})).toThrow(/X402_PAY_TO/);
    expect(() => configFromEnv({ X402_PAY_TO: "0x123" })).toThrow(/X402_PAY_TO/);
    expect(() => configFromEnv({ X402_PAY_TO: PAY_TO, X402_NETWORK: "base" })).toThrow(/CAIP-2/);
    expect(() => configFromEnv({ X402_PAY_TO: PAY_TO, FACILITATOR: "coinbase" })).toThrow(/FACILITATOR/);
    expect(() => configFromEnv({ X402_PAY_TO: PAY_TO, X402_NETWORK: "eip155:8453", FACILITATOR: "x402org" })).toThrow(/testnet only/);
  });
  it("defaults to PayAI on Base mainnet", () => {
    expect(configFromEnv({ X402_PAY_TO: PAY_TO, X402_NETWORK: "eip155:8453" }))
      .toMatchObject({ facilitatorKind: "payai", facilitatorUrl: "https://facilitator.payai.network" });
  });
});

describe("cdp mode without a secret", () => {
  const missing = async (name: string): Promise<string> => {
    throw new Error(`ResourceNotFoundException: ${name}`);
  };

  it("starts and serves free routes; a paid request fails closed without content", async () => {
    let reads = 0;
    const fetchSecret = async (name: string) => {
      reads++;
      return missing(name);
    };
    const cfg = configFromEnv({ X402_PAY_TO: PAY_TO, X402_NETWORK: "eip155:8453", FACILITATOR: "cdp" }, fetchSecret);
    const lines: string[] = [];
    const app = createApp({ ...cfg, funnel: new FunnelLogger((l) => lines.push(l)) });
    for (const path of ["/", "/health", "/llms.txt", "/openapi.json"]) {
      expect((await app.request(path)).status).toBe(200);
    }
    expect((await app.request("/cn/workday?date=bad")).status).toBe(400);
    // The library syncs with the facilitator in the background at startup; a missing secret there
    // is logged and retried on the next paid request, never fatal.
    const paid = await app.request("/cn/workday?date=2026-02-14");
    expect(paid.status).toBeGreaterThanOrEqual(500);
    expect(await paid.text()).not.toContain("is_makeup_workday");
    expect(reads).toBeGreaterThan(0);
  });

  it("other facilitator modes never read the secret", () => {
    let reads = 0;
    const fetchSecret = async () => {
      reads++;
      return "{}";
    };
    for (const FACILITATOR of ["x402org", "payai"]) {
      createApp(configFromEnv({ X402_PAY_TO: PAY_TO, FACILITATOR }, fetchSecret));
    }
    expect(reads).toBe(0);
  });
});

describe("prices shown to agents and humans", () => {
  it("openapi, llms.txt and the preview page carry $0.003 / $0.005", async () => {
    const { app } = setup({ verify: true, settle: true });
    const oa = await (await app.request("/openapi.json")).json();
    expect(oa.paths["/cn/workday"].get["x-x402-price"]).toBe("$0.003");
    expect(oa.paths["/cn/business-days"].get["x-x402-price"]).toBe("$0.005");
    for (const path of ["/llms.txt", "/"]) {
      const text = await (await app.request(path)).text();
      expect(text).toContain("$0.003");
      expect(text).toContain("$0.005");
    }
  });
});

describe("package advisories endpoints", () => {
  const LODASH = "/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20";
  const batchBody = (n: number) =>
    JSON.stringify({ packages: Array.from({ length: n }, (_, i) => ({ ecosystem: "npm", name: "lodash", version: i % 2 ? "4.17.21" : "4.17.20" })) });

  it.each([
    [LODASH, "GET", undefined, "5000"],
    ["/deps/advisories/batch", "POST", batchBody(2), "20000"],
  ])("%s %s without payment returns 402 with accepts and a Bazaar declaration", async (path, method, body, amount) => {
    const osv = new OsvClient(fakeOsvFetch().fn);
    const { app } = setup({ verify: true, settle: true }, osv);
    const res = await app.request(path, { method, body, headers: { ...UA, ...(body ? { "content-type": "application/json" } : {}) } });
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, payTo: PAY_TO, amount, asset: USDC_BASE_SEPOLIA });
    expect(required.resource).toMatchObject({ serviceName: "Package Vulnerability Advisories" });
    expect(required.resource.tags).toEqual(["security", "dependencies", "cve", "npm", "pypi"]);
    const bazaar = required.extensions?.bazaar as { info: { input: { method: string }; output: { example: unknown } } };
    expect(bazaar.info.input.method).toBe(method);
    expect(bazaar.info.output.example).toBeTruthy();
    expect(osv.upstreamCalls).toBe(0); // OSV is only called after a verified payment
  });

  it.each([
    ["/deps/advisories?ecosystem=rubygems&name=rails&version=7.0.0", "GET", undefined, "invalid_ecosystem"],
    ["/deps/advisories?ecosystem=npm&version=1.0.0", "GET", undefined, "invalid_name"],
    ["/deps/advisories?ecosystem=npm&name=lodash", "GET", undefined, "invalid_version"],
    ["/deps/advisories/batch", "POST", "not json", "invalid_body"],
    ["/deps/advisories/batch", "POST", '{"packages":[]}', "invalid_body"],
    ["/deps/advisories/batch", "POST", "[]", "invalid_body"],
    ["/deps/advisories/batch", "POST", batchBody(51), "batch_too_large"],
  ])("%s %s %s -> free 400 %s", async (path, method, body, code) => {
    const { app } = setup({ verify: true, settle: true }, new OsvClient(fakeOsvFetch().fn));
    const res = await app.request(path, { method, body, headers: { ...UA, "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(await res.json()).toMatchObject({ error: code });
  });

  it("rejects an oversized batch body with 413 before parsing", async () => {
    const { app } = setup({ verify: true, settle: true });
    const res = await app.request("/deps/advisories/batch", {
      method: "POST",
      body: JSON.stringify({ packages: [], pad: "x".repeat(70_000) }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(413);
  });

  it("GET on the batch route and POST on the single route are not paid routes", async () => {
    const { app } = setup({ verify: true, settle: true });
    expect((await app.request("/deps/advisories/batch")).status).toBe(404);
    expect((await app.request(LODASH, { method: "POST" })).status).toBe(404);
  });

  it("paid single query returns advisories and settles; a repeat hits the cache", async () => {
    const osv = new OsvClient(fakeOsvFetch().fn);
    const { app, events, facilitator } = setup({ verify: true, settle: true }, osv);
    const res = await paidRequest(app, LODASH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ecosystem: "npm", name: "lodash", version: "4.17.20", vulnerable: true, advisory_count: 4 });
    expect(body.advisories.flatMap((a: { aliases: string[] }) => a.aliases)).toContain("CVE-2021-23337");
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
    expect(events().map((e) => e.stage)).toContain("content_returned");
    const again = await paidRequest(app, LODASH);
    expect(again.status).toBe(200);
    expect(osv.upstreamCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(2);
  });

  it.each(["timeout", "500", "network", "badjson"] as const)("OSV %s: 502, nothing settled, no content", async (fail) => {
    const { app, events, facilitator } = setup({ verify: true, settle: true }, new OsvClient(fakeOsvFetch({ fail }).fn));
    const res = await paidRequest(app, LODASH);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("upstream_unavailable");
    expect(body.advisories).toBeUndefined();
    expect(res.headers.get("payment-response")).toBeNull();
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(0);
    const stages = events().map((e) => e.stage);
    expect(stages).toContain("handler_error");
    expect(stages).not.toContain("settle_ok");
    expect(stages).not.toContain("content_returned");
  });

  it("paid batch returns results in request order and settles once", async () => {
    const osv = new OsvClient(fakeOsvFetch().fn);
    const { app, facilitator } = setup({ verify: true, settle: true }, osv);
    const res = await paidRequest(app, "/deps/advisories/batch", { method: "POST", body: batchBody(4) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(4);
    expect(body.results.map((r: { version: string }) => r.version)).toEqual(["4.17.20", "4.17.21", "4.17.20", "4.17.21"]);
    expect(body.vulnerable_count).toBe(4);
    expect(osv.upstreamCalls).toBe(2); // duplicates in one batch share the cache
    expect(facilitator.settleCalls).toBe(1);
  });

  it("paid batch with one upstream failure is not charged", async () => {
    const { app, facilitator } = setup({ verify: true, settle: true }, new OsvClient(fakeOsvFetch({ fail: "500" }).fn));
    const res = await paidRequest(app, "/deps/advisories/batch", { method: "POST", body: batchBody(3) });
    expect(res.status).toBe(502);
    expect(facilitator.settleCalls).toBe(0);
  });

  it("openapi, llms.txt and the preview page describe the new endpoints with prices and attribution", async () => {
    const { app } = setup({ verify: true, settle: true });
    const oa = await (await app.request("/openapi.json")).json();
    expect(oa.paths["/deps/advisories"].get["x-x402-price"]).toBe("$0.005");
    expect(oa.paths["/deps/advisories/batch"].post["x-x402-price"]).toBe("$0.02");
    expect(oa.paths["/deps/advisories"].get.responses["502"]).toBeTruthy();
    for (const path of ["/llms.txt", "/"]) {
      const text = await (await app.request(path)).text();
      expect(text).toContain("/deps/advisories");
      expect(text).toContain("$0.02");
      expect(text).toContain("OSV.dev");
      expect(text).toContain("CC-BY 4.0");
    }
  });

  it("batch hitting the upstream deadline returns 502 and is not settled", async () => {
    let now = Date.now();
    const slow = (async () => {
      now += 6_000;
      return new Response(JSON.stringify({ vulns: [], next_page_token: undefined }));
    }) as unknown as typeof fetch;
    const { app, facilitator } = setup({ verify: true, settle: true }, new OsvClient(slow, () => now));
    const res = await paidRequest(app, "/deps/advisories/batch", { method: "POST", body: batchBody(50).replace(/4\.17\.2[01]/g, () => `1.0.${Math.random()}`) });
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/deadline/);
    expect(facilitator.settleCalls).toBe(0);
  });
});

describe("CORS", () => {
  it("exposes the x402 headers on a 402 and answers preflight without payment", async () => {
    const { app, events } = setup({ verify: true, settle: true });
    const res = await app.request("/cn/workday?date=2026-02-14", { headers: { Origin: "https://agent.example" } });
    expect(res.status).toBe(402);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const exposed = res.headers.get("access-control-expose-headers")!.toLowerCase();
    expect(exposed).toContain("payment-required");
    expect(exposed).toContain("payment-response");
    const pre = await app.request("/deps/advisories/batch", {
      method: "OPTIONS",
      headers: { Origin: "https://agent.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,payment-signature" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")!.toLowerCase()).toContain("payment-signature");
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    expect(events().filter((e) => e.route === "/deps/advisories/batch")).toHaveLength(0);
  });

  it("keeps CORS headers on a paid 200", async () => {
    const { app } = setup({ verify: true, settle: true });
    const res = await paidRequest(app, "/cn/workday?date=2026-02-14");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-expose-headers")!.toLowerCase()).toContain("payment-response");
  });
});

describe("SEC EDGAR endpoints", () => {
  const AAPL = "/sec/insider-trades?ticker=AAPL";
  const secClient = (opts: Parameters<typeof fakeSecFetch>[0] = {}) => new SecClient("x402-content-site https://api.example", fakeSecFetch(opts).fn, Date.now, async () => {});

  it.each([
    [AAPL, "3000"],
    ["/sec/latest-filings?ticker=AAPL&form=8-K&limit=2", "3000"],
    ["/sec/insider-trades", "3000"], // bare probe
  ])("%s without payment returns 402 with accepts, Bazaar declaration and no SEC call", async (path, amount) => {
    const sec = secClient();
    const { app } = setup({ verify: true, settle: true }, undefined, sec);
    const res = await app.request(path, { headers: UA });
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, payTo: PAY_TO, amount, asset: USDC_BASE_SEPOLIA });
    expect(required.resource).toMatchObject({ serviceName: "SEC EDGAR Insider Trades and Filings" });
    expect(required.resource.description).toMatch(/insider trading|SEC filings/i);
    const bazaar = required.extensions?.bazaar as { info: { input: { method: string }; output: { example: unknown } } };
    expect(bazaar.info.input.method).toBe("GET");
    expect(bazaar.info.output.example).toBeTruthy();
    const body = await res.json();
    expect(body.accepts).toEqual(required.accepts); // 402 body repeats the header quote
    expect(body.price).toBe("$0.003");
    expect(sec.upstreamCalls).toBe(0);
  });

  it.each([
    ["/sec/insider-trades?ticker=AAPL&cik=320193", "invalid_arguments"],
    ["/sec/insider-trades?ticker=A%20B", "invalid_ticker"],
    ["/sec/insider-trades?cik=x", "invalid_cik"],
    ["/sec/insider-trades?src=mcp", "invalid_arguments"],
    ["/sec/latest-filings?ticker=AAPL&limit=99", "invalid_limit"],
  ])("%s -> free 400 %s", async (path, code) => {
    const { app } = setup({ verify: true, settle: true }, undefined, secClient());
    const res = await app.request(path, { headers: UA });
    expect(res.status).toBe(400);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(await res.json()).toMatchObject({ error: code });
  });

  it("paid insider trades return Form 4 transactions and settle once; src=mcp is logged", async () => {
    const sec = secClient();
    const { app, events, facilitator } = setup({ verify: true, settle: true }, undefined, sec);
    const res = await paidRequest(app, `${AAPL}&src=mcp`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer.name).toBe("Apple Inc.");
    expect(body.filings_checked).toBe(4);
    expect(body.transactions[0]).toMatchObject({ code: "S", shares: 2398, price_per_share: 352.77, reporting_owners: [{ name: "Newstead Jennifer" }] });
    expect(body.source).toContain("SEC EDGAR");
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
    expect(facilitator.settleCalls).toBe(1);
    const stages = events().map((e) => e.stage);
    expect(stages).toContain("content_returned");
    expect(events().find((e) => e.stage === "request")).toMatchObject({ route: "/sec/insider-trades", src: "mcp" });
  });

  it("paid latest filings return the 8-K list", async () => {
    const { app } = setup({ verify: true, settle: true }, undefined, secClient());
    const res = await paidRequest(app, "/sec/latest-filings?ticker=AAPL&form=8-K&limit=2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.filings[1].items[0]).toEqual({ item: "2.02", title: "Results of Operations and Financial Condition" });
  });

  it("unknown ticker after payment: 404, nothing settled, handler_error logged", async () => {
    const { app, events, facilitator } = setup({ verify: true, settle: true }, undefined, secClient());
    const res = await paidRequest(app, "/sec/insider-trades?ticker=ZZZZ");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_ticker");
    expect(res.headers.get("payment-response")).toBeNull();
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(0);
    expect(events().find((e) => e.stage === "handler_error")).toMatchObject({ status: 404, reason: "not_found: unknown_ticker" });
  });

  it.each(["timeout", "500", "403", "network", "badjson"] as const)("SEC %s: 502, nothing settled, no content", async (fail) => {
    const { app, events, facilitator } = setup({ verify: true, settle: true }, undefined, secClient({ fail }));
    const res = await paidRequest(app, AAPL);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("upstream_unavailable");
    expect(body.transactions).toBeUndefined();
    expect(res.headers.get("payment-response")).toBeNull();
    expect(facilitator.settleCalls).toBe(0);
    const stages = events().map((e) => e.stage);
    expect(stages).toContain("handler_error");
    expect(stages).not.toContain("settle_ok");
  });

  it("openapi, llms.txt, SKILL.md and the preview page describe the SEC endpoints with prices and the no-endorsement note", async () => {
    const { app } = setup({ verify: true, settle: true });
    const oa = await (await app.request("/openapi.json")).json();
    expect(oa.paths["/sec/insider-trades"].get["x-x402-price"]).toBe("$0.003");
    expect(oa.paths["/sec/latest-filings"].get["x-x402-price"]).toBe("$0.003");
    expect(oa.paths["/sec/insider-trades"].get.responses["404"]).toBeTruthy();
    expect(oa.paths["/sec/insider-trades"].get.parameters.map((p: { name: string }) => p.name)).toEqual(["ticker", "cik"]);
    expect(oa.info.description).toContain("insider trading (Form 4)");
    for (const path of ["/llms.txt", "/", "/SKILL.md"]) {
      const text = await (await app.request(path)).text();
      expect(text).toContain("/sec/insider-trades");
      expect(text).toContain("/sec/latest-filings");
      expect(text).toContain("Form 4");
      expect(text).toContain("not affiliated with or endorsed by the U.S. Securities and Exchange Commission");
    }
  });
});
