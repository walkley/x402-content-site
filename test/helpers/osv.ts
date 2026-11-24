import { readFileSync } from "node:fs";

// Recorded from api.osv.dev/v1/query on 2026-11-24; CI never calls the network.
const fixture = (f: string) => readFileSync(new URL(`../fixtures/osv/${f}`, import.meta.url), "utf8");
const FIXTURES: Record<string, string> = {
  "npm/lodash/4.17.20": "npm-lodash-4.17.20.json",
  "npm/lodash/4.17.21": "npm-lodash-4.17.21.json",
  "PyPI/jinja2/2.10": "pypi-jinja2-2.10.json",
  "npm/this-package-does-not-exist-x402/1.0.0": "npm-nonexistent.json",
};

export function fakeOsvFetch(opts: { fail?: "timeout" | "500" | "network" | "badjson" } = {}) {
  const calls: unknown[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    if (opts.fail === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (opts.fail === "network") throw new TypeError("fetch failed");
    if (opts.fail === "500") return new Response("oops", { status: 500 });
    if (opts.fail === "badjson") return new Response("<html>", { status: 200 });
    const key = `${body.package.ecosystem}/${body.package.name}/${body.version}`;
    return new Response(FIXTURES[key] ? fixture(FIXTURES[key]) : "{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

