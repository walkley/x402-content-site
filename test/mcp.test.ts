import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { ConditionalCheckFailedException, type UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { createApp } from "../src/app.js";
import { OsvClient } from "../src/advisories.js";
import { FunnelLogger } from "../src/funnel.js";
import { createHash } from "node:crypto";
import { MCP_REGISTRY_NAME, MCP_VERSION, PRIVACY_NOTE, QUOTA_TIMEOUT_MS } from "../src/mcp.js";
import { DynamoQuota, globalKey, hmacKeyLoader, ipKey, type FreeQuota } from "../src/quota.js";
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
    this.items.set(key, { n: (cur?.n ?? 0) + Number(v[":one"].N), expires_at: Number(v[":exp"].N) });
    return {};
  }
}

class CountingFacilitator implements FacilitatorClient {
  calls = 0;
  async getSupported() {
    this.calls++;
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} } as never;
  }
  async verify(): Promise<never> {
    this.calls++;
    throw new Error("verify must not be called on the free path");
  }
  async settle(): Promise<never> {
    this.calls++;
    throw new Error("settle must not be called on the free path");
  }
}

const NOW = Date.UTC(2026, 10, 24, 12);
const KEY = "k".repeat(64);
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {}); // mcp_call lines
  return () => vi.restoreAllMocks();
});

function setup(
  opts: { quota?: FreeQuota | null; db?: FakeDynamo; perIp?: number; global?: number; key?: () => Promise<string>; origins?: string[] } = {},
) {
  const db = opts.db ?? new FakeDynamo();
  const quota =
    opts.quota === null
      ? undefined
      : (opts.quota ?? new DynamoQuota(db, "quota", opts.key ?? (async () => KEY), opts.perIp ?? 20, opts.global ?? 2000, () => NOW));
  const facilitator = new CountingFacilitator();
  const funnel: string[] = [];
  const app = createApp({
    network: NETWORK,
    payTo: PAY_TO,
    facilitatorKind: "payai",
    facilitatorUrl: "http://unused",
    facilitator,
    publicBaseUrl: BASE,
    funnel: new FunnelLogger((l) => funnel.push(l)),
    osv: new OsvClient(fakeOsvFetch().fn),
    quota,
    mcpAllowedOrigins: opts.origins,
  });
  let n = 0;
  const rpc = async (method: string, params?: unknown, ip = "203.0.113.9", headers: Record<string, string> = {}) => {
    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, ...(params ? { params } : {}) }),
      },
      { event: { requestContext: { http: { sourceIp: ip } } } },
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

  it("tools/list returns both tools with input schemas", async () => {
    const { rpc } = setup();
    const tools = (await rpc("tools/list")).body.result.tools as { name: string; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name)).toEqual(["cn_workday_check", "package_advisories"]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
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
    expect(text).toContain(`GET ${BASE}/cn/workday?date=2026-10-08`);
    expect(text).toContain("$0.003");
    expect(text).toContain(`npx agentcash add ${BASE}`);
    expect(text).toContain(NETWORK);
    expect(r.result.structuredContent).toBeUndefined();
    // range and package calls name their own paid routes
    const range = (await call("cn_workday_check", { from: "2026-01-05", to: "2026-01-16" })).result.content[0].text;
    expect(range).toContain(`GET ${BASE}/cn/business-days?from=2026-01-05&to=2026-01-16`);
    expect(range).toContain("$0.005");
    const pkg = (await call("package_advisories", { ecosystem: "npm", name: "lodash", version: "4.17.20" })).result.content[0].text;
    expect(pkg).toContain(`GET ${BASE}/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20`);
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
    expect(body.result.structuredContent).toBeUndefined();
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

  it("the free path never asks the facilitator and writes no payment funnel events", async () => {
    const { call, facilitator, funnel } = setup({ perIp: 1 });
    await call("cn_workday_check", { date: "2026-10-08" });
    await call("cn_workday_check", { date: "2026-10-08" }); // over quota
    await call("package_advisories", { ecosystem: "npm", name: "lodash", version: "4.17.20" });
    expect(facilitator.calls).toBe(0);
    expect(funnel).toEqual([]);
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
  });

  it.each(["/", "/llms.txt", "/SKILL.md", "/.well-known/mcp.json"])("%s shows the claude mcp add command and the privacy note", async (path) => {
    const { app } = setup();
    const text = await (await app.request(path)).text();
    expect(text).toContain(`claude mcp add --transport http cn-calendar ${BASE}/mcp`);
    expect(PRIVACY_NOTE).toBe(
      "Quota counters store no raw IP address, only a keyed hash (HMAC-SHA256 of the day and IP), deleted by TTL after 2 days; " +
        "API Gateway access logs keep the source IP for 30 days.",
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
