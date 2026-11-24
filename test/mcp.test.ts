import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ConditionalCheckFailedException, type UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { createApp } from "../src/app.js";
import { OsvClient } from "../src/advisories.js";
import { FunnelLogger } from "../src/funnel.js";
import { createHash } from "node:crypto";
import { MCP_REGISTRY_NAME, MCP_VERSION, PRIVACY_NOTE, QUOTA_TIMEOUT_MS } from "../src/mcp.js";
import { DynamoQuota, globalKey, hmacKeyLoader, ipHash, ipKey, type FreeQuota } from "../src/quota.js";
import { fakeOsvFetch } from "./helpers/osv.js";

const NETWORK = "eip155:8453";
const PAY_TO = "0x96B16408be584E863Ab3f05703059e302c474f0A";
const BASE = "https://api.example.test";

/** In-memory DynamoDB that applies our UpdateItem (ADD n :one if n < :limit) the way DynamoDB does. */
class FakeDynamo {
  items = new Map<string, { n: number; expires_at: number }>();
  calls: UpdateItemCommand["input"][] = [];
  fail?: Error;
  async send(cmd: UpdateItemCommand) {
    const i = cmd.input;
    this.calls.push(i);
    if (this.fail) throw this.fail;
    const key = i.Key!.pk.S!;
    const v = i.ExpressionAttributeValues!;
    const cur = this.items.get(key);
    if (cur && !(cur.n < Number(v[":limit"].N))) {
      throw new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
    }
    const n = (cur?.n ?? 0) + Number(v[":one"].N);
    this.items.set(key, { n, expires_at: Number(v[":exp"].N) });
    return i.ReturnValues === "UPDATED_NEW" ? { Attributes: { n: { N: String(n) } } } : {};
  }
}

class CountingFacilitator implements FacilitatorClient {
  calls = 0;
  /** verify and settle only: the payment link's in-process 402 quote may sync /supported, but never verifies. */
  paymentCalls = 0;
  async getSupported() {
    this.calls++;
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} } as never;
  }
  async verify(): Promise<never> {
    this.calls++;
    this.paymentCalls++;
    throw new Error("verify must not be called on the free path");
  }
  async settle(): Promise<never> {
    this.calls++;
    this.paymentCalls++;
    throw new Error("settle must not be called on the free path");
  }
}

const NOW = Date.UTC(2026, 10, 24, 12);
const KEY = "k".repeat(64);
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {}); // mcp request log lines
  return () => vi.restoreAllMocks();
});

function setup(
  opts: {
    quota?: FreeQuota | null;
    db?: FakeDynamo;
    perIp?: number;
    global?: number;
    key?: () => Promise<string>;
    origins?: string[];
    path?: string;
    facilitator?: FacilitatorClient;
  } = {},
) {
  const db = opts.db ?? new FakeDynamo();
  const quota =
    opts.quota === null
      ? undefined
      : (opts.quota ?? new DynamoQuota(db, "quota", opts.key ?? (async () => KEY), opts.perIp ?? 20, opts.global ?? 2000, () => NOW));
  const facilitator = new CountingFacilitator();
  const funnel: string[] = [];
  const path = opts.path ?? "/mcp";
  const app = createApp({
    network: NETWORK,
    payTo: PAY_TO,
    facilitatorKind: "payai",
    facilitatorUrl: "http://unused",
    facilitator: opts.facilitator ?? facilitator,
    facilitatorInitTimeoutMs: 200,
    publicBaseUrl: BASE,
    funnel: new FunnelLogger((l) => funnel.push(l)),
    osv: new OsvClient(fakeOsvFetch().fn),
    quota,
    mcpAllowedOrigins: opts.origins,
  });
  let n = 0;
  const rpc = async (method: string, params?: unknown, ip = "203.0.113.9", headers: Record<string, string> = {}, notify = false) => {
    const res = await app.request(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id: ++n }), method, ...(params ? { params } : {}) }),
      },
      { event: { requestContext: { requestId: `apigw-${n}`, http: { sourceIp: ip } } } },
    );
    return { status: res.status, body: res.status === 202 ? null : await res.json() };
  };
  const call = async (name: string, args: unknown, ip?: string) => (await rpc("tools/call", { name, arguments: args }, ip)).body;
  return { app, db, facilitator, funnel, rpc, call };
}

describe("MCP protocol", () => {
  it("initialize negotiates the protocol version and advertises tools", async () => {
    const { rpc } = setup();
    const { status, body } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cn-calendar", version: MCP_VERSION } },
    });
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-11-25");
    // 2025-03-26 (requires batches) and 2024-11-05 (HTTP+SSE) are not offered
    for (const v of ["2025-03-26", "2024-11-05"]) {
      expect((await rpc("initialize", { protocolVersion: v })).body.result.protocolVersion).toBe("2025-11-25");
      expect((await rpc("ping", undefined, undefined, { "mcp-protocol-version": v })).status).toBe(400);
    }
  });

  it("accepts the initialized notification with 202 and no body", async () => {
    const { app } = setup();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("202 only for notifications and responses; other messages are 400", async () => {
    const { app, db } = setup();
    const post = (m: unknown) => app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) });
    expect((await post({ jsonrpc: "2.0", id: 7, result: {} })).status).toBe(202);
    expect((await post({ jsonrpc: "2.0", id: 7, error: { code: -1, message: "x" } })).status).toBe(202);
    for (const bad of [{}, { jsonrpc: "2.0", id: 1 }, { id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "1.0", method: "x" }]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error.code).toBe(-32600);
    }
    expect(db.calls).toHaveLength(0);
  });

  it("refuses any Origin not on the allow list (default empty) with 403, and never sends ACAO *", async () => {
    const { app } = setup();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cn_workday_check", arguments: { date: "2026-10-08" } } });
    const env = { event: { requestContext: { http: { sourceIp: "203.0.113.9" } } } };
    const evil = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body }, env);
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe(-32600);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await app.request("/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(403);
    const plain = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body }, env);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    // other routes keep their public CORS
    expect((await app.request("/llms.txt", { headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBe("*");

    const allowed = setup({ origins: ["https://app.example"] }).app;
    const ok = await allowed.request("/mcp", { method: "POST", headers: { "content-type": "application/json", origin: "https://app.example" }, body }, env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  it("tools/list returns the three tools with input schemas", async () => {
    const { rpc } = setup();
    const tools = (await rpc("tools/list")).body.result.tools as { name: string; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name)).toEqual(["cn_workday_check", "package_advisories", "sec_insider_trades"]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  // Directory probers (nohumans.directory) build an unpaid call from the schema's examples; it must pass validation.
  it.each(["/mcp", "/paid/mcp"])("%s: required parameters have examples, and calls built from any examples pass validation", async (path) => {
    type Schema = { properties: Record<string, { examples?: unknown[] }>; required?: string[]; examples?: Record<string, unknown>[] };
    const { rpc, call } = setup({ path });
    const tools = (await rpc("tools/list")).body.result.tools as { name: string; inputSchema: Schema }[];
    expect(tools.map((t) => t.name)).toEqual(["cn_workday_check", "package_advisories", "sec_insider_trades"]);
    for (const { name, inputSchema: s } of tools) {
      for (const p of s.required ?? []) expect(s.properties[p].examples?.length, `${name}.${p}`).toBeGreaterThan(0);
      const withExamples = Object.entries(s.properties).filter(([, prop]) => prop.examples?.length);
      const fromRequired = Object.fromEntries((s.required ?? []).map((p) => [p, s.properties[p].examples![0]]));
      const argSets = [
        // every property's first example merged, as a prober might build it
        Object.fromEntries(withExamples.map(([p, prop]) => [p, prop.examples![0]])),
        // each single example of every property (optional ones too), on top of the required ones
        ...withExamples.flatMap(([p, prop]) => prop.examples!.map((ex) => ({ ...fromRequired, [p]: ex }))),
        ...(s.examples ?? []),
      ].filter((a) => Object.keys(a).length > 0);
      expect(argSets.length, name).toBeGreaterThan(0);
      for (const args of argSets) {
        const r = (await call(name, args)).result;
        const what = `${name} ${JSON.stringify(args)}`;
        expect(r.content[0].text, what).not.toMatch(/^invalid_/);
        // sec_insider_trades has no free calls: a valid call is the payment link on /mcp too
        if (path === "/mcp" && name !== "sec_insider_trades") expect(r.isError, what).toBeUndefined();
        else expect(r.structuredContent, what).toMatchObject({ status: 402 });
      }
    }
  });

  describe("cn_workday_check with no arguments checks today in Asia/Shanghai", () => {
    // 2026-09-30 16:30 UTC is 2026-10-01 00:30 in China: the UTC day is a workday, the China day is 国庆节.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.UTC(2026, 8, 30, 16, 30));
      return () => vi.useRealTimers();
    });

    it("/mcp answers {} with today's result", async () => {
      const { call } = setup();
      const r = (await call("cn_workday_check", {})).result;
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent).toMatchObject({ date: "2026-10-01", is_workday: false });
      // arguments omitted altogether is the same call
      expect((await call("cn_workday_check", undefined)).result.structuredContent).toMatchObject({ date: "2026-10-01" });
    });

    it("/paid/mcp answers {} with a payment link for today's date", async () => {
      const { call } = setup({ path: "/paid/mcp" });
      const r = (await call("cn_workday_check", {})).result;
      expect(r.structuredContent).toMatchObject({ status: 402, url: `${BASE}/cn/workday?date=2026-10-01&src=mcp` });
    });

    it.each(["/mcp", "/paid/mcp"])("%s still refuses date with from, and from without to", async (path) => {
      const { call } = setup({ path });
      expect((await call("cn_workday_check", { date: "2026-10-08", from: "2026-10-01" })).result.content[0].text).toMatch(/^invalid_arguments/);
      expect((await call("cn_workday_check", { from: "2026-10-01" })).result.content[0].text).toMatch(/^invalid_/);
    });
  });

  it("rejects bad JSON, batches, unknown methods and unsupported protocol versions", async () => {
    const { app, rpc } = setup();
    const post = (body: string) => app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await (await post("{")).json()).error.code).toBe(-32700);
    expect((await (await post("[]")).json()).error.code).toBe(-32600);
    expect((await rpc("resources/list")).body.error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "nope", arguments: {} })).body.error.code).toBe(-32602);
    expect((await rpc("ping", undefined, undefined, { "mcp-protocol-version": "2000-01-01" })).status).toBe(400);
    expect((await rpc("ping", undefined, undefined, { "mcp-protocol-version": "2025-06-18" })).body.result).toEqual({});
    expect((await app.request("/mcp")).status).toBe(405);
  });
});

describe("MCP tools on the free quota", () => {
  it("cn_workday_check answers a date and a range with the paid routes' data", async () => {
    const { call } = setup();
    const day = await call("cn_workday_check", { date: "2026-02-14" });
    expect(day.result.isError).toBeUndefined();
    expect(day.result.structuredContent).toMatchObject({ date: "2026-02-14", is_makeup_workday: true, is_workday: true });
    expect(JSON.parse(day.result.content[0].text)).toEqual(day.result.structuredContent);
    const range = await call("cn_workday_check", { from: "2026-09-28", to: "2026-10-11" });
    expect(range.result.structuredContent).toMatchObject({ calendar_days: 14 });
  });

  it("package_advisories uses the OSV client", async () => {
    const { call } = setup();
    const r = await call("package_advisories", { ecosystem: "npm", name: "lodash", version: "4.17.20" });
    expect(r.result.structuredContent).toMatchObject({ ecosystem: "npm", name: "lodash", vulnerable: true });
  });

  it("invalid arguments are a tool error and are not counted", async () => {
    const { call, db } = setup();
    const r = await call("cn_workday_check", { date: "2026-02-30" });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("invalid_date");
    expect((await call("cn_workday_check", { date: "2026-02-14", from: "2026-02-01" })).result.isError).toBe(true);
    expect((await call("package_advisories", { ecosystem: "cobol", name: "x", version: "1" })).result.isError).toBe(true);
    expect(db.calls).toHaveLength(0);
  });

  it("the 21st call from one IP gets the paid x402 route, price and agentcash command", async () => {
    const { call, db } = setup();
    for (let i = 0; i < 20; i++) expect((await call("cn_workday_check", { date: "2026-10-08" })).result.isError).toBeUndefined();
    const r = await call("cn_workday_check", { date: "2026-10-08" });
    expect(r.result.isError).toBe(true);
    const text = r.result.content[0].text as string;
    expect(text).toContain("20 free calls per day for your IP address");
    const lines = text.split("\n");
    // wallet first, then add, then the paid URL (tagged src=mcp) and its price
    expect(lines[0]).toContain("npx agentcash onboard");
    expect(lines[1]).toContain(`npx agentcash add ${BASE}`);
    const urlLine = lines.findIndex((l) => l === `GET ${BASE}/cn/workday?date=2026-10-08&src=mcp`);
    expect(urlLine).toBeGreaterThan(1);
    expect(lines[urlLine + 1]).toBe("Price: $0.003 USDC per call.");
    expect(text).toContain(NETWORK);
    expect(r.result.structuredContent).toMatchObject({ url: `${BASE}/cn/workday?date=2026-10-08&src=mcp`, status: 402 });
    // range and package calls name their own paid routes
    const range = (await call("cn_workday_check", { from: "2026-01-05", to: "2026-01-16" })).result.content[0].text;
    expect(range.split("\n")[0]).toContain("npx agentcash onboard");
    expect(range).toContain(`GET ${BASE}/cn/business-days?from=2026-01-05&to=2026-01-16&src=mcp`);
    expect(range).toContain("$0.005");
    const pkg = (await call("package_advisories", { ecosystem: "npm", name: "lodash", version: "4.17.20" })).result.content[0].text;
    expect(pkg).toContain(`GET ${BASE}/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20&src=mcp`);
    // another IP still has its free calls
    expect((await call("cn_workday_check", { date: "2026-10-08" }, "198.51.100.4")).result.isError).toBeUndefined();
    expect(db.items.get(globalKey("2026-11-24"))!.n).toBe(21);
  });

  it("sends DynamoDB the conditional ADD with :limit 20 per IP and 2000 overall", async () => {
    const { call, db } = setup();
    await call("cn_workday_check", { date: "2026-10-08" });
    expect(db.calls).toHaveLength(2);
    const [perIp, global] = db.calls;
    for (const c of db.calls) {
      expect(c.TableName).toBe("quota");
      expect(c.ConditionExpression).toBe("attribute_not_exists(n) OR n < :limit");
      expect(c.UpdateExpression).toBe("SET expires_at = :exp ADD n :one");
      expect(c.ExpressionAttributeValues![":one"]).toEqual({ N: "1" });
    }
    expect(perIp.Key!.pk.S).toMatch(/^ip#2026-11-24#/);
    expect(perIp.ExpressionAttributeValues![":limit"]).toEqual({ N: "20" });
    expect(global.Key!.pk.S).toBe("global#2026-11-24");
    expect(global.ExpressionAttributeValues![":limit"]).toEqual({ N: "2000" });
  });

  it("the global daily cap turns every IP to the paid hint", async () => {
    const { call } = setup({ global: 3 });
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      expect((await call("cn_workday_check", { date: "2026-10-08" }, ip)).result.isError).toBeUndefined();
    }
    const r = await call("cn_workday_check", { date: "2026-10-08" }, "192.0.2.4");
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("daily cap of 3 calls for all users");
  });

  it("stores only an HMAC of the day and IP under the secret key, with a TTL", async () => {
    const { call, db } = setup();
    await call("cn_workday_check", { date: "2026-10-08" }, "203.0.113.77");
    const keys = [...db.items.keys()];
    expect(keys).toEqual([ipKey("203.0.113.77", "2026-11-24", KEY), globalKey("2026-11-24")]);
    const unkeyed = createHash("sha256").update("2026-11-24|203.0.113.77").digest("hex").slice(0, 32);
    expect(keys[0]).not.toContain(unkeyed);
    expect(ipKey("203.0.113.77", "2026-11-24", "x".repeat(64))).not.toBe(keys[0]);
    expect(JSON.stringify([...db.items])).not.toContain("203.0.113.77");
    expect(keys[0]).toMatch(/^ip#2026-11-24#[0-9a-f]{32}$/);
    for (const v of db.items.values()) expect(v.expires_at).toBe(Date.UTC(2026, 10, 26) / 1000);
  });

  it("a DynamoDB error gives the paid hint: no 500 and no free call", async () => {
    const db = new FakeDynamo();
    db.fail = Object.assign(new Error("ProvisionedThroughputExceededException"), { name: "ProvisionedThroughputExceededException" });
    const { rpc } = setup({ db });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await rpc("tools/call", { name: "package_advisories", arguments: { ecosystem: "npm", name: "lodash", version: "4.17.20" } });
    err.mockRestore();
    expect(status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("free tier is unavailable");
    expect(body.result.content[0].text).toContain(`${BASE}/deps/advisories?`);
    expect(body.result.structuredContent).toMatchObject({ url: `${BASE}/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20&src=mcp`, status: 402 });
  });

  it("a quota that does not answer within QUOTA_TIMEOUT_MS gives the paid hint", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hang: FreeQuota = { perIpDaily: 20, globalDaily: 2000, consume: () => new Promise(() => {}) };
      const { call } = setup({ quota: hang });
      const pending = call("cn_workday_check", { date: "2026-10-08" });
      await vi.advanceTimersByTimeAsync(QUOTA_TIMEOUT_MS);
      const r = await pending;
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain("free tier is unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unreadable HMAC key fails closed, and the read is retried on the next call", async () => {
    let fail = true;
    const fetchSecret = vi.fn(async () => {
      if (fail) throw new Error("AccessDeniedException");
      return KEY;
    });
    const loader = hmacKeyLoader("arn:aws:secretsmanager:ap-northeast-1:1:secret:k", fetchSecret);
    const quota = new DynamoQuota(new FakeDynamo(), "quota", loader, 20, 2000, () => NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await quota.init(); // cold start: logs, does not throw
    expect(warn).toHaveBeenCalled();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = setup({ quota });
    expect((await call("cn_workday_check", { date: "2026-10-08" })).result.content[0].text).toContain("free tier is unavailable");
    fail = false;
    expect((await call("cn_workday_check", { date: "2026-10-08" })).result.isError).toBeUndefined();
    expect((await call("cn_workday_check", { date: "2026-10-08" })).result.isError).toBeUndefined();
    expect(fetchSecret).toHaveBeenCalledTimes(3); // init, failed call, then cached
    expect(err).toHaveBeenCalled();
    await expect(hmacKeyLoader(undefined)()).rejects.toThrow(/QUOTA_HMAC_SECRET_ARN/);
    await expect(hmacKeyLoader("x", async () => "short")()).rejects.toThrow(/32 characters/);
  });

  it("no quota store configured, or no source IP: paid hint, never free", async () => {
    const { call } = setup({ quota: null });
    expect((await call("cn_workday_check", { date: "2026-10-08" })).result.isError).toBe(true);
    const { app } = setup();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cn_workday_check", arguments: { date: "2026-10-08" } } }),
    });
    expect((await res.json()).result.isError).toBe(true);
  });

  it("the free path never verifies or settles and writes no payment funnel events", async () => {
    const { call, facilitator, funnel } = setup({ perIp: 1 });
    await call("cn_workday_check", { date: "2026-10-08" });
    expect(facilitator.calls).toBe(0); // a free call does not even sync /supported
    await call("cn_workday_check", { date: "2026-10-08" }); // over quota: payment link, quoted in-process
    await call("package_advisories", { ecosystem: "npm", name: "lodash", version: "4.17.20" });
    expect(facilitator.paymentCalls).toBe(0);
    expect(funnel).toEqual([]); // the in-process quote is not a funnel request
  });
});

describe("MCP request log", () => {
  const IP = "203.0.113.9";
  const logLines = () =>
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
  const mcpLines = () => logLines().filter((l) => l.type === "mcp");

  it("writes one line per request (initialize, tools/list, notification, tools/call) with method, client, ip_hash, apigw id", async () => {
    const { app, rpc, call } = setup({ perIp: 2 });
    await app.initQuota(); // cold start loads the HMAC key
    const ua = "claude-code/2.1 " + "x".repeat(400);
    await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.1.0".padEnd(100, "0") } }, IP, { "user-agent": ua });
    await rpc("notifications/initialized", undefined, IP, {}, true);
    await rpc("tools/list");
    await call("cn_workday_check", { date: "2026-10-08" });
    await call("cn_workday_check", { date: "2026-10-08" });
    await call("cn_workday_check", { date: "2026-10-08" }); // over the per-IP quota of 2
    await call("cn_workday_check", { date: "2026-02-30" }); // invalid, not counted
    const lines = mcpLines();
    expect(lines.map((l) => l.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
    ]);
    const hash = ipHash(IP, "2026-11-24", KEY);
    for (const l of lines) {
      expect(l.ip_hash).toBe(hash);
      expect(l).toHaveProperty("status");
      expect(typeof l.ts).toBe("string");
    }
    expect(lines[0]).toMatchObject({ client_name: "claude-code", user_agent: ua.slice(0, 200), apigw_request_id: "apigw-1", status: 200 });
    expect((lines[0].client_version as string).length).toBe(64);
    expect(lines[1]).toMatchObject({ status: 202 });
    expect(lines[3]).toMatchObject({ tool: "cn_workday_check", outcome: "ok", free_call_n: 1 });
    expect(lines[4]).toMatchObject({ outcome: "ok", free_call_n: 2 });
    expect(lines[5]).toMatchObject({ outcome: "ip_limit" });
    expect(lines[5].free_call_n).toBeUndefined();
    expect(lines[6]).toMatchObject({ outcome: "invalid_input", reason: "invalid_date" });
    for (const l of lines.slice(1)) expect(l.client_name).toBeUndefined();
  });

  it("also logs answers from outside the handler (Origin 403, GET 405) and bad JSON", async () => {
    const { app } = setup();
    const env = { event: { requestContext: { requestId: "r1", http: { sourceIp: IP } } } };
    await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }, env);
    await app.request("/mcp", {}, env);
    await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }, env);
    expect(mcpLines().map((l) => [l.method, l.status, l.apigw_request_id])).toEqual([
      ["-", 403, "r1"],
      ["-", 405, "r1"],
      ["parse_error", 400, "r1"],
    ]);
  });

  it("omits ip_hash, without failing, while the HMAC key is not loaded; reason says why a call was unavailable", async () => {
    const quota = new DynamoQuota(new FakeDynamo(), "quota", async () => Promise.reject(new Error("AccessDeniedException")), 20, 2000, () => NOW);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rpc, call } = setup({ quota });
    expect((await rpc("tools/list")).status).toBe(200);
    expect((await call("cn_workday_check", { date: "2026-10-08" })).result.isError).toBe(true);
    err.mockRestore();
    const lines = mcpLines();
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).not.toHaveProperty("ip_hash");
    expect(lines[1]).toMatchObject({ outcome: "unavailable", reason: "quota_error" });
    const { call: noStore } = setup({ quota: null });
    await noStore("cn_workday_check", { date: "2026-10-08" });
    expect(mcpLines().at(-1)).toMatchObject({ outcome: "unavailable", reason: "no_quota_store" });
  });

  it("never writes the raw IP to any log line (mcp, funnel, errors)", async () => {
    const out: string[] = [];
    for (const k of ["log", "error", "warn", "info"] as const) vi.spyOn(console, k).mockImplementation((...a) => void out.push(a.join(" ")));
    const db = new FakeDynamo();
    const { app, rpc, call, funnel } = setup({ db, perIp: 1 });
    await app.initQuota();
    const ip = "198.51.100.231";
    await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "c", version: "1" } }, ip);
    await rpc("tools/list", undefined, ip);
    await call("cn_workday_check", { date: "2026-10-08" }, ip);
    await call("cn_workday_check", { date: "2026-10-08" }, ip);
    db.fail = new Error("boom");
    await call("cn_workday_check", { date: "2026-10-09" }, ip);
    await app.request("/cn/workday?date=2026-10-08&src=mcp", {}, { event: { requestContext: { http: { sourceIp: ip } } } });
    await app.request("/cn/workday?date=2026-02-30&src=mcp", {}, { event: { requestContext: { http: { sourceIp: ip } } } });
    expect(out.length).toBeGreaterThan(5);
    expect(funnel.length).toBeGreaterThan(0);
    for (const line of [...out, ...funnel]) expect(line).not.toContain(ip);
  });
});

describe("paid funnel: src and ip_hash on the request event", () => {
  const IP = "192.0.2.50";
  const env = { event: { requestContext: { http: { sourceIp: IP } } } };

  it("records src=mcp (only that value) and the same daily ip_hash as the MCP log", async () => {
    const { app, funnel } = setup();
    await app.initQuota();
    await app.request("/cn/workday?date=2026-10-08&src=mcp", {}, env);
    await app.request("/cn/workday?date=2026-10-08&src=evil", {}, env);
    await app.request("/cn/workday?date=2026-10-08", {}, env);
    await app.request("/cn/workday?date=2026-02-30&src=mcp", {}, env); // free 400, still tagged
    const requests = funnel.map((l) => JSON.parse(l)).filter((e) => e.stage === "request");
    expect(requests.map((e) => e.src)).toEqual(["mcp", undefined, undefined, "mcp"]);
    for (const e of requests) expect(e.ip_hash).toBe(ipHash(IP, "2026-11-24", KEY));
    for (const e of funnel.map((l) => JSON.parse(l)).filter((e) => e.stage !== "request")) {
      expect(e.src).toBeUndefined();
      expect(e.ip_hash).toBeUndefined();
    }
  });

  it("omits ip_hash when the HMAC key is not loaded, and the paid route still answers 402", async () => {
    const { app, funnel } = setup({ key: () => Promise.reject(new Error("denied")) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await app.initQuota();
    warn.mockRestore();
    expect((await app.request("/cn/workday?date=2026-10-08&src=mcp", {}, env)).status).toBe(402);
    const req = JSON.parse(funnel[0]);
    expect(req).toMatchObject({ stage: "request", src: "mcp" });
    expect(req).not.toHaveProperty("ip_hash");
  });

  it.each([
    ["/cn/workday?date=2026-10-08", "3000"],
    ["/cn/business-days?from=2026-01-05&to=2026-01-16", "5000"],
    ["/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20", "5000"],
  ])("src=mcp does not change %s's 402, price, payTo or network", async (path, amount) => {
    const { app } = setup();
    const quote = async (p: string) => {
      const res = await app.request(p, {}, env);
      expect(res.status).toBe(402);
      const h = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      const body = (await res.json()) as { price: string; network: string; accepts: unknown };
      return { accepts: h.accepts, body: { price: body.price, network: body.network, accepts: body.accepts } };
    };
    const plain = await quote(path);
    const tagged = await quote(`${path}&src=mcp`);
    expect(tagged).toEqual(plain);
    expect(plain.accepts).toHaveLength(1);
    expect(plain.accepts[0]).toMatchObject({ amount, payTo: PAY_TO, network: NETWORK, scheme: "exact" });
    // invalid input stays a free 400 with src=mcp
    const bad = await app.request(`${path.split("?")[0]}?src=mcp`, {}, env);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("payment-required")).toBeNull();
  });
});

describe("payment link and /paid/mcp", () => {
  const IP = "203.0.113.9";
  const env = { event: { requestContext: { http: { sourceIp: IP } } } };
  /** What the paid HTTP route itself answers at url: its decoded PAYMENT-REQUIRED header. */
  const httpQuote = async (app: ReturnType<typeof setup>["app"], url: string) => {
    const res = await app.request(url, {}, env);
    expect(res.status).toBe(402);
    return decodePaymentRequiredHeader(res.headers.get("payment-required")!);
  };
  const CASES = [
    ["cn_workday_check", { date: "2026-10-08" }, `${BASE}/cn/workday?date=2026-10-08&src=mcp`, "3000"],
    ["cn_workday_check", { from: "2026-01-05", to: "2026-01-16" }, `${BASE}/cn/business-days?from=2026-01-05&to=2026-01-16&src=mcp`, "5000"],
    ["package_advisories", { ecosystem: "npm", name: "lodash", version: "4.17.20" }, `${BASE}/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20&src=mcp`, "5000"],
    ["sec_insider_trades", { ticker: "AAPL" }, `${BASE}/sec/insider-trades?ticker=AAPL&src=mcp`, "3000"],
    ["sec_insider_trades", { cik: "320193" }, `${BASE}/sec/insider-trades?cik=320193&src=mcp`, "3000"],
  ] as const;

  it.each(CASES)("/paid/mcp %s %j: payment link {url, status: 402, challenge} equal field by field to the HTTP 402", async (name, args, url, amount) => {
    const { app, call } = setup({ path: "/paid/mcp" });
    const r = (await call(name, args)).result;
    expect(r.isError).toBe(true);
    expect(Object.keys(r.structuredContent).sort()).toEqual(["challenge", "status", "url"]);
    expect(r.structuredContent.url).toBe(url);
    expect(r.structuredContent.status).toBe(402);
    const ch = r.structuredContent.challenge;
    const http = (await httpQuote(app, url)) as unknown as Record<string, unknown>;
    expect(Object.keys(ch).sort()).toEqual(Object.keys(http).sort());
    for (const k of Object.keys(http)) expect(ch[k], k).toEqual(http[k]);
    // what paidmcp's checker requires of a challenge, and our own price, payTo and network
    expect(ch.x402Version).toBe(2);
    expect(ch.resource.url).toBe(url);
    expect(ch.accepts).toHaveLength(1);
    expect(ch.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, payTo: PAY_TO, amount });
    // the human hint stays first: onboard, add, then the URL
    const lines = (r.content[0].text as string).split("\n");
    expect(lines[0]).toContain("npx agentcash onboard");
    expect(lines[1]).toContain(`npx agentcash add ${BASE}`);
    expect(lines).toContain(`GET ${url}`);
    expect(r.content[0].text).toContain("(/paid/mcp) has no free tier");
  });

  it("/paid/mcp never touches the free quota, and /mcp's quota is still all there afterwards", async () => {
    const db = new FakeDynamo();
    const paid = setup({ path: "/paid/mcp", db, perIp: 2 });
    for (let i = 0; i < 5; i++) expect((await paid.call("cn_workday_check", { date: "2026-10-08" }, IP)).result.structuredContent.status).toBe(402);
    expect(db.calls).toHaveLength(0);
    expect(db.items.size).toBe(0);
    const free = setup({ db, perIp: 2 });
    expect((await free.call("cn_workday_check", { date: "2026-10-08" }, IP)).result.isError).toBeUndefined();
    expect(db.items.get(globalKey("2026-11-24"))!.n).toBe(1);
    expect(paid.facilitator.paymentCalls).toBe(0);
    expect(paid.funnel).toEqual([]);
  });

  it("/paid/mcp still answers invalid arguments with the input error and no link", async () => {
    const { call, db } = setup({ path: "/paid/mcp" });
    const r = (await call("cn_workday_check", { date: "2026-02-30" })).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("invalid_date");
    expect(r.structuredContent).toBeUndefined();
    expect((await call("cn_workday_check", { date: "2026-10-08", from: "2026-10-01" })).result.content[0].text).toContain("invalid_arguments");
    expect((await call("package_advisories", { ecosystem: "cobol", name: "x", version: "1" })).result.structuredContent).toBeUndefined();
    expect(db.calls).toHaveLength(0);
  });

  it("/paid/mcp answers initialize and tools/list like /mcp, saying it has no free calls", async () => {
    const { rpc } = setup({ path: "/paid/mcp" });
    const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).body.result;
    expect(init).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "cn-calendar" } });
    expect(init.instructions).toContain("no free calls");
    expect(init.instructions).toContain(`${BASE}/mcp`);
    const tools = (await rpc("tools/list")).body.result.tools as { name: string; description: string }[];
    expect(tools.map((t) => t.name)).toEqual(["cn_workday_check", "package_advisories", "sec_insider_trades"]);
    for (const t of tools) expect(t.description).not.toContain("Free for");
  });

  it("/paid/mcp refuses a foreign Origin with 403 and no CORS, answers GET with 405, and logs its path", async () => {
    const { app } = setup();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cn_workday_check", arguments: { date: "2026-10-08" } } });
    const evil = await app.request("/paid/mcp", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body }, env);
    expect(evil.status).toBe(403);
    expect((await evil.json()).error.code).toBe(-32600);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await app.request("/paid/mcp", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(403);
    expect((await app.request("/paid/mcp")).status).toBe(405);
    const big = await app.request("/paid/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(17 * 1024) }, env);
    expect(big.status).toBe(413);
    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
      .filter((l) => l.type === "mcp");
    expect(lines.map((l) => [l.path, l.status])).toEqual([
      ["/paid/mcp", 403],
      ["/paid/mcp", 403],
      ["/paid/mcp", 405],
      ["/paid/mcp", 413],
    ]);
  });

  it("logs payment_link and outcome paid_only on /paid/mcp", async () => {
    const { call } = setup({ path: "/paid/mcp" });
    await call("cn_workday_check", { date: "2026-10-08" });
    const line = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
      .filter((l) => l.type === "mcp")
      .at(-1);
    expect(line).toMatchObject({ path: "/paid/mcp", tool: "cn_workday_check", outcome: "paid_only", payment_link: true });
  });

  it("without a 402 quote (facilitator down) the tool error keeps the text hint and carries no link", async () => {
    const down: FacilitatorClient = {
      getSupported: async () => Promise.reject(new Error("facilitator down")),
      verify: async () => Promise.reject(new Error("no")),
      settle: async () => Promise.reject(new Error("no")),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { call } = setup({ path: "/paid/mcp", facilitator: down });
    const r = (await call("cn_workday_check", { date: "2026-10-08" })).result;
    warn.mockRestore();
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0].text).toContain(`GET ${BASE}/cn/workday?date=2026-10-08&src=mcp`);
  });
});

describe("sec_insider_trades: paid only, never calls SEC", () => {
  const IP = "203.0.113.9";
  const secFetch = () => vi.fn(async () => {
    throw new Error("SEC must not be called from MCP");
  });
  const setupSec = (path: string) => {
    const fetchImpl = secFetch();
    vi.stubGlobal("fetch", fetchImpl);
    return { ...setup({ path }), fetchImpl };
  };
  afterEach(() => vi.unstubAllGlobals());

  it.each(["/mcp", "/paid/mcp"])("%s: a valid call is the payment link, the free quota is not touched, SEC and the facilitator are not called", async (path) => {
    const { call, db, facilitator, funnel, fetchImpl } = setupSec(path);
    const r = (await call("sec_insider_trades", { ticker: "msft" }, IP)).result;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: 402, url: `${BASE}/sec/insider-trades?ticker=msft&src=mcp` });
    expect(r.structuredContent.challenge.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, payTo: PAY_TO, amount: "3000" });
    expect(r.content[0].text).toContain(path === "/mcp" ? "sec_insider_trades has no free calls" : "(/paid/mcp) has no free tier");
    expect(db.calls).toHaveLength(0);
    expect(facilitator.paymentCalls).toBe(0);
    expect(funnel).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["/mcp", "/paid/mcp"])("%s: no arguments means ticker AAPL", async (path) => {
    const { call } = setupSec(path);
    for (const args of [{}, undefined]) {
      expect((await call("sec_insider_trades", args)).result.structuredContent).toMatchObject({ status: 402, url: `${BASE}/sec/insider-trades?ticker=AAPL&src=mcp` });
    }
  });

  it("invalid arguments get the input error and no link", async () => {
    const { call } = setupSec("/mcp");
    for (const [args, code] of [
      [{ ticker: "AAPL", cik: "320193" }, "invalid_arguments"],
      [{ ticker: "not a ticker!" }, "invalid_ticker"],
      [{ cik: "0" }, "invalid_cik"],
    ] as const) {
      const r = (await call("sec_insider_trades", args)).result;
      expect(r.content[0].text).toMatch(new RegExp(`^${code}`));
      expect(r.structuredContent).toBeUndefined();
    }
  });

  it("logs outcome paid_tool on /mcp", async () => {
    const { call } = setupSec("/mcp");
    await call("sec_insider_trades", { ticker: "AAPL" });
    const line = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
      .filter((l) => l.type === "mcp")
      .at(-1);
    expect(line).toMatchObject({ path: "/mcp", tool: "sec_insider_trades", outcome: "paid_tool", payment_link: true });
    expect(line!.free_call_n).toBeUndefined();
  });

  it("the schema has a default and examples, and the manifest lists its price", async () => {
    const { rpc, app } = setupSec("/mcp");
    const tools = (await rpc("tools/list")).body.result.tools as { name: string; inputSchema: Record<string, any> }[];
    const s = tools.find((t) => t.name === "sec_insider_trades")!.inputSchema;
    expect(s.properties.ticker).toMatchObject({ default: "AAPL", examples: ["AAPL"] });
    expect(s.examples).toEqual([{ ticker: "AAPL" }, { cik: "320193" }]);
    const m = await (await app.request("/.well-known/mcp.json")).json();
    expect(m.payment.prices.sec_insider_trades).toBe("$0.003");
    expect(m.tools.map((t: { name: string }) => t.name)).toContain("sec_insider_trades");
  });
});

describe("MCP discovery", () => {
  it("serves /.well-known/mcp.json pointing at /mcp", async () => {
    const { app } = setup();
    const m = await (await app.request("/.well-known/mcp.json")).json();
    expect(m).toMatchObject({
      name: MCP_REGISTRY_NAME,
      remotes: [{ type: "streamable-http", url: `${BASE}/mcp` }],
      install: { claude_code: `claude mcp add --transport http cn-calendar ${BASE}/mcp` },
      free_tier: { calls_per_ip_per_day: 20, global_calls_per_day: 2000, privacy: PRIVACY_NOTE },
      payment: { network: NETWORK, prices: { cn_workday_check_date: "$0.003", package_advisories: "$0.005" } },
    });
    expect(m.paid_mcp).toMatchObject({ type: "streamable-http", url: `${BASE}/paid/mcp` });
    expect(m.paid_mcp.purpose).toContain("payment link");
  });

  it.each(["/", "/llms.txt", "/SKILL.md"])("%s names /paid/mcp and what it is for", async (path) => {
    const { app } = setup();
    const text = await (await app.request(path)).text();
    expect(text).toContain(`${BASE}/paid/mcp`);
    expect(text).toContain("{url, status: 402, challenge}");
  });

  it.each(["/", "/llms.txt", "/SKILL.md", "/.well-known/mcp.json"])("%s shows the claude mcp add command and the privacy note", async (path) => {
    const { app } = setup();
    const text = await (await app.request(path)).text();
    expect(text).toContain(`claude mcp add --transport http cn-calendar ${BASE}/mcp`);
    expect(PRIVACY_NOTE).toBe(
      "Quota counters store no raw IP address, only a keyed hash (HMAC-SHA256 of the day and IP), deleted by TTL after 2 days; " +
        "request logs keep only the same hash, which changes every UTC day; API Gateway access logs keep the source IP for 30 days.",
    );
    expect(text).toContain(PRIVACY_NOTE);
    expect(text.toLowerCase()).not.toContain("no personal data");
  });

  it("README states the same privacy note and the shared cost breaker", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(PRIVACY_NOTE);
    expect(readme.toLowerCase()).not.toContain("no personal data");
    expect(readme).toContain("`/mcp` shares the API function");
  });

  it("openapi lists /mcp as a free POST and leaves paid routes' payment info unchanged", async () => {
    const { app } = setup();
    const doc = await (await app.request("/openapi.json")).json();
    expect(doc.paths["/mcp"].post.security).toEqual([]);
    expect(doc.paths["/mcp"].post["x-payment-info"]).toBeUndefined();
    expect(doc.paths["/cn/workday"].get["x-payment-info"].price.amount).toBe("0.003");
  });

  it("server.json names io.github.walkley/cn-calendar with the live /mcp remote", () => {
    const s = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    expect(s.name).toBe(MCP_REGISTRY_NAME);
    expect(s.version).toBe(MCP_VERSION);
    expect(s.description.length).toBeLessThanOrEqual(100);
    expect(s.title.length).toBeLessThanOrEqual(100);
    expect(s.remotes).toEqual([{ type: "streamable-http", url: "https://mvqz0m8d6g.execute-api.ap-northeast-1.amazonaws.com/mcp" }]);
  });
});
