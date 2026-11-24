import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InputError } from "../src/calendar.js";
import { UpstreamError } from "../src/advisories.js";
import {
  INSIDER_FILINGS,
  MAX_SEC_CALLS_PER_REQUEST,
  SEC_DEADLINE_MS,
  SEC_RATE_PER_SEC,
  SEC_SOURCE_NOTE,
  SUBMISSIONS_TTL_MS,
  SecClient,
  isSecProbe,
  parseCompanyQuery,
  probeSec,
  parseFilingsQuery,
  parseForm4,
  secUserAgent,
} from "../src/sec.js";
import { fakeSecFetch } from "./helpers/sec.js";

const xml = (acc: string) => readFileSync(new URL(`./fixtures/sec/${acc}.xml`, import.meta.url), "utf8");
const noWait = async () => {};
const client = (fn = fakeSecFetch().fn, now: () => number = Date.now) => new SecClient(secUserAgent("https://api.example"), fn, now, noWait);

function inputError(fn: () => unknown): InputError {
  try {
    fn();
  } catch (e) {
    if (e instanceof InputError) return e;
    throw e;
  }
  throw new Error("expected InputError");
}

describe("parseCompanyQuery / parseFilingsQuery", () => {
  it("normalises ticker and pads cik", () => {
    expect(parseCompanyQuery({ ticker: " aapl " })).toEqual({ ticker: "AAPL" });
    expect(parseCompanyQuery({ ticker: "brk.b" })).toEqual({ ticker: "BRK.B" });
    expect(parseCompanyQuery({ cik: "320193" })).toEqual({ cik: "0000320193" });
    expect(parseFilingsQuery({ ticker: "AAPL" })).toEqual({ ticker: "AAPL", limit: 20 });
    expect(parseFilingsQuery({ ticker: "AAPL", form: "8-k", limit: "5" })).toEqual({ ticker: "AAPL", form: "8-K", limit: 5 });
  });

  it.each([
    [{}, "invalid_arguments"],
    [{ ticker: "AAPL", cik: "320193" }, "invalid_arguments"],
    [{ ticker: "AAPL MSFT" }, "invalid_ticker"],
    [{ ticker: "TOOLONGTICKER" }, "invalid_ticker"],
    [{ ticker: "../x" }, "invalid_ticker"],
    [{ cik: "12345678901" }, "invalid_cik"],
    [{ cik: "0" }, "invalid_cik"],
    [{ cik: "abc" }, "invalid_cik"],
    [{ ticker: "AAPL", limit: "0" }, "invalid_limit"],
    [{ ticker: "AAPL", limit: "51" }, "invalid_limit"],
    [{ ticker: "AAPL", limit: "2.5" }, "invalid_limit"],
    [{ ticker: "AAPL", form: "8-K;drop" }, "invalid_form"],
    [{ ticker: "AAPL", form: "" }, "invalid_form"],
  ])("rejects %j (%s)", (input, code) => {
    expect(inputError(() => parseFilingsQuery(input as never))).toMatchObject({ code, status: 400 });
  });
});

describe("parseForm4", () => {
  it("reads owner, role, 10b5-1 flag and a sale", () => {
    const f = parseForm4(xml("0001140361-26-044952"));
    expect(f.reporting_owners).toEqual([
      { name: "Newstead Jennifer", cik: "0001780525", is_director: false, is_officer: true, officer_title: "SVP, GC and Government Affairs", is_ten_percent_owner: false, is_other: false },
    ]);
    expect(f.rule_10b5_1).toBe(true);
    expect(f.transactions).toEqual([
      {
        table: "non_derivative",
        security: "Common Stock",
        transaction_date: "2026-11-17",
        code: "S",
        code_description: "Open market or private sale",
        acquired_disposed: "D",
        shares: 2398,
        price_per_share: 352.77,
        shares_owned_after: 25200,
        ownership: "D",
        underlying_security: null,
      },
    ]);
  });

  it("reads derivative rows, footnote-only prices as null and decodes entities", () => {
    const f = parseForm4(xml("0001140361-26-038674"));
    expect(f.reporting_owners[0]).toMatchObject({ is_director: true, is_officer: true, officer_title: "Executive Chair" });
    const codes = f.transactions.map((t) => `${t.table}:${t.code}`);
    expect(codes[0]).toBe("non_derivative:M");
    expect(codes).toContain("non_derivative:F");
    expect(codes.at(-1)).toBe("derivative:M");
    const rsu = f.transactions.at(-1)!;
    expect(rsu).toMatchObject({ security: "Restricted Stock Unit", price_per_share: null, shares: 374541, underlying_security: "Common Stock", shares_owned_after: 0 });
    expect(f.transactions[0].price_per_share).toBeNull(); // RSU settlement: price only in a footnote
    expect(parseForm4("<ownershipDocument><reportingOwner><rptOwnerName>A &amp; B</rptOwnerName></reportingOwner></ownershipDocument>").reporting_owners[0].name).toBe("A & B");
  });
});

describe("SecClient with recorded fixtures", () => {
  it("insider trades by ticker: latest 4 Form 4 filings, cold cache within the per-request call limit, then cached", async () => {
    const fake = fakeSecFetch();
    const c = client(fake.fn);
    const r = await c.insiderTrades({ ticker: "AAPL" });
    expect(r.issuer).toEqual({ cik: "0000320193", name: "Apple Inc.", tickers: ["AAPL"] });
    expect(r.filings_checked).toBe(INSIDER_FILINGS);
    expect([...new Set(r.transactions.map((t) => t.accession_number))]).toEqual([
      "0001140361-26-044952",
      "0001140361-26-044773",
      "0001140361-26-043484",
      "0001140361-26-042149",
    ]);
    expect(r.transaction_count).toBe(r.transactions.length);
    expect(r.transactions[0]).toMatchObject({ form: "4", filing_date: "2026-11-19", code: "S", price_per_share: 352.77 });
    expect(r.transactions[0].filing_url).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000114036126044952/0001140361-26-044952-index.htm",
    );
    expect(r.source).toBe(SEC_SOURCE_NOTE);
    expect(r.source).toContain("Not affiliated with or endorsed");
    expect(c.upstreamCalls).toBe(MAX_SEC_CALLS_PER_REQUEST); // tickers + submissions + 4 XMLs
    expect(fake.calls.map((x) => x.url).filter((u) => u.endsWith("form4.xml"))[0]).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000114036126044952/form4.xml", // raw XML, not the xslF345X06 view
    );
    expect(new Set(fake.calls.map((x) => x.userAgent))).toEqual(new Set(["x402-content-site https://api.example"]));
    await c.insiderTrades({ cik: "320193" });
    await c.latestFilings({ ticker: "AAPL", limit: 5 });
    expect(c.upstreamCalls).toBe(MAX_SEC_CALLS_PER_REQUEST); // all from cache
  });

  it("submissions expire after the TTL; Form 4 documents and the ticker map stay cached", async () => {
    let now = Date.parse("2026-11-24T00:00:00Z");
    const c = client(fakeSecFetch().fn, () => now);
    await c.insiderTrades({ ticker: "AAPL" });
    now += SUBMISSIONS_TTL_MS + 1;
    await c.insiderTrades({ ticker: "AAPL" });
    expect(c.upstreamCalls).toBe(MAX_SEC_CALLS_PER_REQUEST + 1);
  });

  it("latest filings: form filter, limit, 8-K items with titles, document links", async () => {
    const c = client();
    const r = await c.latestFilings({ ticker: "AAPL", form: "8-K", limit: 2 });
    expect(r.count).toBe(2);
    expect(r.filings.map((f) => f.accession_number)).toEqual(["0001140361-26-042798", "0000320193-26-000024"]);
    expect(r.filings[1].items).toEqual([
      { item: "2.02", title: "Results of Operations and Financial Condition" },
      { item: "9.01", title: "Financial Statements and Exhibits" },
    ]);
    expect(r.filings[1].document_url).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/aapl-20261102.htm");
    expect(r.filings[1]).not.toHaveProperty("primary_document");
    expect(c.upstreamCalls).toBe(2);
    const all = await c.latestFilings({ cik: "0000320193", limit: 50 });
    expect(all.count).toBe(30); // the fixture keeps 30 filings
    expect(all.form).toBeNull();
  });

  it("unknown ticker and unknown CIK are 404 InputErrors", async () => {
    const c = client();
    await expect(c.insiderTrades({ ticker: "ZZZZ" })).rejects.toMatchObject({ code: "unknown_ticker", status: 404 });
    await expect(c.latestFilings({ cik: "0000000001", limit: 1 })).rejects.toMatchObject({ code: "unknown_cik", status: 404 });
  });

  it("BRK.B finds EDGAR's BRK-B", async () => {
    const fake = fakeSecFetch();
    await expect(client(fake.fn).latestFilings({ ticker: "BRK.B", limit: 1 })).rejects.toMatchObject({ code: "unknown_cik" }); // no fixture for its submissions
    expect(fake.calls.at(-1)!.url).toBe("https://data.sec.gov/submissions/CIK0001067983.json");
  });

  it.each(["timeout", "500", "403", "network", "badjson"] as const)("SEC %s is an UpstreamError", async (fail) => {
    await expect(client(fakeSecFetch({ fail }).fn).insiderTrades({ cik: "320193" })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("paces requests at SEC_RATE_PER_SEC within a container", async () => {
    let now = 1_000_000;
    const waits: number[] = [];
    const c = new SecClient("ua", fakeSecFetch().fn, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await c.insiderTrades({ ticker: "AAPL" });
    expect(waits.length).toBe(MAX_SEC_CALLS_PER_REQUEST - 1);
    expect(waits.every((w) => w <= 1000 / SEC_RATE_PER_SEC * MAX_SEC_CALLS_PER_REQUEST)).toBe(true);
    expect(now - 1_000_000).toBe((MAX_SEC_CALLS_PER_REQUEST - 1) * (1000 / SEC_RATE_PER_SEC));
  });

  it("fails with the deadline instead of waiting past it", async () => {
    let now = 0;
    const slow = (async (url: string, init: RequestInit) => {
      now += 4_000;
      return fakeSecFetch().fn(url, init);
    }) as unknown as typeof fetch;
    const c = new SecClient("ua", slow, () => now, noWait);
    await expect(c.insiderTrades({ ticker: "AAPL" })).rejects.toThrow(/deadline/);
    expect(c.upstreamCalls).toBeLessThanOrEqual(Math.ceil(SEC_DEADLINE_MS / 4_000));
  });

  it("concurrent requests for the same company share the upstream calls", async () => {
    const c = client();
    await Promise.all([c.insiderTrades({ ticker: "AAPL" }), c.insiderTrades({ ticker: "AAPL" })]);
    expect(c.upstreamCalls).toBe(MAX_SEC_CALLS_PER_REQUEST);
  });

  it("the User-Agent names the site and no e-mail or the word github (SEC answers 403 to those)", () => {
    const ua = secUserAgent("https://abc.execute-api.ap-northeast-1.amazonaws.com");
    expect(ua).toBe("x402-content-site https://abc.execute-api.ap-northeast-1.amazonaws.com");
    expect(ua).not.toMatch(/@|github/i);
  });
});

describe("Lambda SEC probe", () => {
  it("only a direct-invoke payload is a probe, never an API Gateway event", () => {
    expect(isSecProbe({ x402_probe: "sec" })).toBe(true);
    expect(isSecProbe({ x402_probe: "sec", requestContext: {} })).toBe(false);
    expect(isSecProbe({ version: "2.0", rawPath: "/health" })).toBe(false);
    expect(isSecProbe(null)).toBe(false);
  });

  it("reports both SEC hosts with the production User-Agent; a 403 is not ok", async () => {
    const fake = fakeSecFetch();
    const ok = await probeSec("x402-content-site https://api.example", fake.fn);
    expect(ok.ok).toBe(true);
    expect(ok.results.map((r) => r.status)).toEqual([200, 200]);
    expect(fake.calls.map((c) => c.userAgent)).toEqual(["x402-content-site https://api.example", "x402-content-site https://api.example"]);
    const blocked = await probeSec("ua", fakeSecFetch({ fail: "403" }).fn);
    expect(blocked.ok).toBe(false);
    expect(blocked.results[0]).toMatchObject({ status: 403, blocked: true });
  });
});
