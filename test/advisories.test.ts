import { describe, expect, it } from "vitest";
import { InputError } from "../src/calendar.js";
import {
  CACHE_TTL_MS,
  MAX_BATCH,
  MAX_BATCH_PAGES,
  OSV_SOURCE_NOTE,
  OsvClient,
  UPSTREAM_DEADLINE_MS,
  UpstreamError,
  parseBatch,
  parsePackageQuery,
} from "../src/advisories.js";

import { fakeOsvFetch } from "./helpers/osv.js";

function inputError(fn: () => unknown): InputError {
  try {
    fn();
  } catch (e) {
    if (e instanceof InputError) return e;
    throw e;
  }
  throw new Error("expected InputError");
}

describe("parsePackageQuery", () => {
  it("accepts the five ecosystems case-insensitively and trims", () => {
    expect(parsePackageQuery({ ecosystem: "pypi", name: " Jinja2 ", version: "2.10" })).toEqual({ ecosystem: "PyPI", name: "Jinja2", version: "2.10" });
    expect(parsePackageQuery({ ecosystem: "CRATES.IO", name: "serde", version: "1.0.0" }).ecosystem).toBe("crates.io");
    expect(parsePackageQuery({ ecosystem: "Go", name: "golang.org/x/net", version: "v0.17.0" }).name).toBe("golang.org/x/net");
    expect(parsePackageQuery({ ecosystem: "maven", name: "org.apache.logging.log4j:log4j-core", version: "2.14.1" }).ecosystem).toBe("Maven");
    expect(parsePackageQuery({ ecosystem: "npm", name: "@babel/core", version: "7.0.0" }).name).toBe("@babel/core");
  });

  it.each([
    [{ ecosystem: "rubygems", name: "rails", version: "7.0.0" }, "invalid_ecosystem"],
    [{ ecosystem: undefined, name: "x", version: "1" }, "invalid_ecosystem"],
    [{ ecosystem: "npm", name: "", version: "1" }, "invalid_name"],
    [{ ecosystem: "npm", name: "a b", version: "1" }, "invalid_name"],
    [{ ecosystem: "npm", name: "x".repeat(215), version: "1" }, "invalid_name"],
    [{ ecosystem: "npm", name: "lodash\u0000", version: "1" }, "invalid_name"],
    [{ ecosystem: "npm", name: "lodash", version: undefined }, "invalid_version"],
    [{ ecosystem: "npm", name: "lodash", version: "" }, "invalid_version"],
    [{ ecosystem: "npm", name: "lodash", version: "4.17.20 OR 1=1" }, "invalid_version"],
    [{ ecosystem: "npm", name: "lodash", version: "1".repeat(129) }, "invalid_version"],
    [{ ecosystem: "Maven", name: "log4j-core", version: "2.14.1" }, "invalid_name"],
    [{ ecosystem: "Maven", name: "a:b:c", version: "1" }, "invalid_name"],
  ])("rejects %j (%s)", (input, code) => {
    expect(inputError(() => parsePackageQuery(input as never))).toMatchObject({ code, status: 400 });
  });
});

describe("parseBatch", () => {
  const pkg = { ecosystem: "npm", name: "lodash", version: "4.17.20" };
  it("accepts 1..50 packages and points at the bad entry", () => {
    expect(parseBatch({ packages: [pkg] })).toHaveLength(1);
    expect(parseBatch({ packages: Array(MAX_BATCH).fill(pkg) })).toHaveLength(MAX_BATCH);
    expect(inputError(() => parseBatch({ packages: Array(MAX_BATCH + 1).fill(pkg) })).code).toBe("batch_too_large");
    expect(inputError(() => parseBatch({ packages: [] })).code).toBe("invalid_body");
    expect(inputError(() => parseBatch({})).code).toBe("invalid_body");
    expect(inputError(() => parseBatch(null)).code).toBe("invalid_body");
    expect(inputError(() => parseBatch({ packages: [pkg, { ecosystem: "npm", name: "x" }] })).message).toContain("packages[1]");
    expect(inputError(() => parseBatch({ packages: [pkg, null] })).code).toBe("invalid_ecosystem");
  });
});

describe("OsvClient with recorded fixtures", () => {
  it("npm lodash 4.17.20 is vulnerable with known CVEs and fixed versions", async () => {
    const { fn } = fakeOsvFetch();
    const r = await new OsvClient(fn).query({ ecosystem: "npm", name: "lodash", version: "4.17.20" });
    expect(r.vulnerable).toBe(true);
    expect(r.advisory_count).toBe(4);
    const cves = r.advisories.flatMap((a) => a.aliases);
    expect(cves).toEqual(expect.arrayContaining(["CVE-2020-28500", "CVE-2021-23337"]));
    const cmd = r.advisories.find((a) => a.aliases.includes("CVE-2021-23337"))!;
    expect(cmd).toMatchObject({
      id: "GHSA-35jh-r3h4-6jhm",
      summary: "Command Injection in lodash",
      severity: { level: "HIGH", cvss: [{ type: "CVSS_V3", vector: "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H" }] },
      fixed_versions: ["4.17.21"],
      license: "CC-BY-4.0",
      source_database: "GitHub Advisory Database",
      url: "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",
    });
    // Only the queried package's affected entries are returned (the record also lists lodash-es etc.).
    expect(cmd.affected.map((a) => a.package)).toEqual(["lodash"]);
    expect(cmd.affected[0].ranges).toEqual([{ type: "SEMVER", introduced: "0", fixed: "4.17.21" }]);
    expect(cmd.references.length).toBeGreaterThan(0);
    expect(r.queried_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("PyPI name matching is normalised and a missing package is not vulnerable", async () => {
    const { fn } = fakeOsvFetch();
    const c = new OsvClient(fn);
    const j = await c.query({ ecosystem: "PyPI", name: "jinja2", version: "2.10" });
    expect(j.advisory_count).toBe(12);
    expect(j.advisories.every((a) => a.affected.length > 0)).toBe(true);
    const none = await c.query({ ecosystem: "npm", name: "this-package-does-not-exist-x402", version: "1.0.0" });
    expect(none).toMatchObject({ vulnerable: false, advisory_count: 0, advisories: [] });
  });

  it("caches per package version for one hour", async () => {
    const { fn, calls } = fakeOsvFetch();
    let now = Date.parse("2026-11-24T08:00:00Z");
    const c = new OsvClient(fn, () => now);
    const q = { ecosystem: "npm" as const, name: "lodash", version: "4.17.20" };
    const first = await c.query(q);
    now += CACHE_TTL_MS - 1;
    const second = await c.query(q);
    expect(calls).toHaveLength(1);
    expect(second.data_fetched_at).toBe(first.data_fetched_at);
    expect(second.queried_at).not.toBe(first.queried_at);
    await c.query({ ...q, version: "4.17.21" });
    expect(calls).toHaveLength(2);
    now += 2;
    await c.query(q);
    expect(calls).toHaveLength(3);
  });

  it.each(["timeout", "500", "network", "badjson"] as const)("upstream %s raises UpstreamError and is not cached", async (fail) => {
    const { fn, calls } = fakeOsvFetch({ fail });
    const c = new OsvClient(fn);
    const q = { ecosystem: "npm" as const, name: "lodash", version: "4.17.20" };
    await expect(c.query(q)).rejects.toBeInstanceOf(UpstreamError);
    await expect(c.query(q)).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(2);
  });

  it("sends a 5 s timeout signal and an identifying User-Agent", async () => {
    let init: RequestInit | undefined;
    const fn = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await new OsvClient(fn).query({ ecosystem: "npm", name: "x", version: "1" });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect((init!.headers as Record<string, string>)["user-agent"]).toContain("x402-content-site");
  });

  it("follows next_page_token", async () => {
    const pages = [
      { vulns: [{ id: "GHSA-aaaa", affected: [] }], next_page_token: "t1" },
      { vulns: [{ id: "GHSA-bbbb", affected: [] }] },
    ];
    const bodies: { page_token?: string }[] = [];
    const fn = (async (_u: string, i: RequestInit) => {
      bodies.push(JSON.parse(String(i.body)));
      return new Response(JSON.stringify(pages[bodies.length - 1]));
    }) as unknown as typeof fetch;
    const r = await new OsvClient(fn).query({ ecosystem: "npm", name: "x", version: "1" });
    expect(r.advisories.map((a) => a.id)).toEqual(["GHSA-aaaa", "GHSA-bbbb"]);
    expect(bodies[1].page_token).toBe("t1");
    expect(r.truncated).toBe(false);
  });

  it("omits summaries of records whose source license is unknown", async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ vulns: [{ id: "UBUNTU-CVE-2024-1", summary: "text", affected: [] }] }))) as unknown as typeof fetch;
    const r = await new OsvClient(fn).query({ ecosystem: "npm", name: "x", version: "1" });
    expect(r.advisories[0]).toMatchObject({ summary: null, license: "see source record" });
  });

  it("marks the data as excerpted and modified (CC-BY 4.0)", async () => {
    const r = await new OsvClient(fakeOsvFetch().fn).query({ ecosystem: "npm", name: "lodash", version: "4.17.20" });
    expect(r.source).toBe(OSV_SOURCE_NOTE);
    expect(r.source).toMatch(/Excerpted and modified/);
  });
});

describe("upstream deadline and page budget", () => {
  // Every OSV response carries another page so pagination never ends on its own.
  const endless = (onCall?: () => void) => {
    let n = 0;
    return (async (_u: string, init: RequestInit) => {
      onCall?.();
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ vulns: [{ id: `GHSA-${body.package.name}-${n++}`, affected: [] }], next_page_token: "more" }));
    }) as unknown as typeof fetch;
  };
  const pkgs = (n: number) => Array.from({ length: n }, (_, i) => ({ ecosystem: "npm" as const, name: `p${i}`, version: "1" }));

  it("a single query stops after 5 pages and reports truncated", async () => {
    const c = new OsvClient(endless());
    const r = await c.query({ ecosystem: "npm", name: "x", version: "1" });
    expect(c.upstreamCalls).toBe(5);
    expect(r).toMatchObject({ truncated: true, advisory_count: 5 });
  });

  it(`a batch makes at most ${MAX_BATCH_PAGES} OSV calls in total`, async () => {
    const c = new OsvClient(endless());
    const results = await c.queryMany(pkgs(MAX_BATCH));
    expect(c.upstreamCalls).toBe(MAX_BATCH_PAGES);
    expect(results.every((r) => r.truncated)).toBe(true);
    const small = new OsvClient(endless());
    await small.queryMany(pkgs(3));
    expect(small.upstreamCalls).toBe(15); // 3 x 5 pages, well under the budget
  });

  it("results cut by the batch budget are not cached", async () => {
    const c = new OsvClient(endless());
    await c.queryMany(pkgs(MAX_BATCH));
    const before = c.upstreamCalls;
    const single = await c.query(pkgs(MAX_BATCH)[MAX_BATCH - 1]);
    expect(c.upstreamCalls).toBeGreaterThan(before);
    expect(single.advisory_count).toBe(5);
  });

  it(`gives up after ${UPSTREAM_DEADLINE_MS / 1000}s of upstream time with UpstreamError`, async () => {
    let now = 0;
    const c = new OsvClient(endless(() => (now += 4_000)), () => now); // each call "takes" 4 s
    await expect(c.query({ ecosystem: "npm", name: "x", version: "1" })).rejects.toThrow(/deadline of 15s exceeded/);
    expect(c.upstreamCalls).toBe(4); // calls start at t=0,4,8,12; the 5th would start at 16 s
    now = 0;
    const b = new OsvClient(endless(() => (now += 4_000)), () => now);
    await expect(b.queryMany(pkgs(20))).rejects.toBeInstanceOf(UpstreamError);
  });

  it("caps each call's timeout at the time left before the deadline", async () => {
    let now = 0;
    const timeouts: number[] = [];
    const orig = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => (timeouts.push(ms), orig.call(AbortSignal, ms));
    try {
      const c = new OsvClient(endless(() => (now += 6_000)), () => now);
      await expect(c.query({ ecosystem: "npm", name: "x", version: "1" })).rejects.toBeInstanceOf(UpstreamError);
    } finally {
      AbortSignal.timeout = orig;
    }
    expect(timeouts).toEqual([5_000, 5_000, 3_000]);
  });
});
