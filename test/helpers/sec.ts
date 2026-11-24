import { readFileSync } from "node:fs";

// Recorded from data.sec.gov and www.sec.gov on 2026-11-24 (submissions trimmed to the 30 most recent filings);
// CI never calls the network.
const fixture = (f: string) => readFileSync(new URL(`../fixtures/sec/${f}`, import.meta.url), "utf8");

export function fakeSecFetch(opts: { fail?: "timeout" | "500" | "403" | "network" | "badjson" } = {}) {
  const calls: { url: string; userAgent: string | null }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, userAgent: new Headers(init.headers).get("user-agent") });
    if (opts.fail === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (opts.fail === "network") throw new TypeError("fetch failed");
    if (opts.fail === "500") return new Response("oops", { status: 500 });
    if (opts.fail === "403") return new Response("Undeclared Automated Tool", { status: 403 });
    if (opts.fail === "badjson") return new Response("<html>", { status: 200 });
    if (url === "https://www.sec.gov/files/company_tickers.json") return new Response(fixture("company_tickers.json"));
    if (url === "https://data.sec.gov/submissions/CIK0000320193.json") return new Response(fixture("submissions-CIK0000320193.json"));
    const m = url.match(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/(\d{10})(\d{2})(\d{6})\/form4\.xml$/);
    if (m) {
      try {
        return new Response(fixture(`${m[1]}-${m[2]}-${m[3]}.xml`));
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
