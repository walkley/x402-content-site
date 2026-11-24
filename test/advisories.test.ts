import { describe, expect, it } from "vitest";
import { InputError } from "../src/calendar.js";
import { CACHE_TTL_MS, MAX_BATCH, OsvClient, UpstreamError, parseBatch, parsePackageQuery } from "../src/advisories.js";

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
});
