// SEC EDGAR insider trades (Form 4) and latest filings, from SEC's public JSON API and the filings' own XML.
// https://www.sec.gov/search-filings/edgar-application-programming-interfaces and
// https://www.sec.gov/os/accessing-edgar-data (fair access: declare a User-Agent, at most 10 requests per second).
// EDGAR data is public; responses name SEC EDGAR as the source and do not imply any SEC endorsement.
import { InputError } from "./calendar.js";
import { UpstreamError } from "./advisories.js";

export const SEC_DATA = "https://data.sec.gov";
export const SEC_WWW = "https://www.sec.gov";
export const SEC_TIMEOUT_MS = 5_000;
/**
 * Wall-clock budget for all SEC calls of one paid request. The app also passes the request's own deadline minus the
 * time it keeps for settlement, and the earlier of the two applies.
 */
export const SEC_DEADLINE_MS = 12_000;
/** Most recent Form 4 / 4/A filings parsed per insider-trades request. */
export const INSIDER_FILINGS = 4;
/**
 * Upper bound on SEC requests one paid request can make: ticker map + submissions + INSIDER_FILINGS Form 4 XMLs, all
 * on a cold cache. A warm container usually needs only the submissions call, or none.
 */
export const MAX_SEC_CALLS_PER_REQUEST = 2 + INSIDER_FILINGS;
/** Upper bound for a latest-filings request: ticker map + submissions. Enforced like the one above (infra SEC routes). */
export const LATEST_FILINGS_MAX_SEC_CALLS = 2;
/** Per-container pacing of SEC requests. The global bound comes from the API Gateway route throttle on /sec/* (infra). */
export const SEC_RATE_PER_SEC = 4;
export const TICKERS_TTL_MS = 24 * 60 * 60 * 1000;
export const SUBMISSIONS_TTL_MS = 10 * 60 * 1000;
// Memory bounds per Lambda container (256 MB). A raw submissions JSON is about 1 MB on the heap (AAPL, 1,005
// filings, measured in review); only SUBMISSIONS_MAX_FILINGS compact rows of it are kept, so 50 companies stay
// in a few MB. 1,000 parsed Form 4 documents of 9 transactions each are about 22 MB (measured 2026-11-24).
export const SUBMISSIONS_MAX_ENTRIES = 50;
/** Filings kept per company, newest first: enough for the 4 latest Form 4s and limit=50 of a common form. */
export const SUBMISSIONS_MAX_FILINGS = 200;
/** Filed Form 4 documents never change (an amendment is a new accession), so they are kept until evicted. */
const FORM4_MAX_ENTRIES = 1_000;
export const MAX_FILINGS_LIMIT = 50;
export const DEFAULT_FILINGS_LIMIT = 20;

export const SEC_SOURCE_NOTE =
  "SEC EDGAR (https://www.sec.gov/edgar), public filings data retrieved from data.sec.gov and sec.gov archives. Not affiliated with or endorsed by the U.S. Securities and Exchange Commission.";

/** SEC rejects a User-Agent containing "github" (403 "Undeclared Automated Tool", tested 2026-11-24), so the contact is the site URL. */
export const secUserAgent = (siteUrl: string) => `x402-content-site ${siteUrl}`;

/** Form 4 transaction codes (SEC Form 4 General Instructions, item 8). */
export const TRANSACTION_CODES: Record<string, string> = {
  P: "Open market or private purchase",
  S: "Open market or private sale",
  V: "Transaction voluntarily reported earlier than required",
  A: "Grant, award or other acquisition from the issuer",
  D: "Disposition to the issuer",
  F: "Payment of exercise price or tax liability by delivering or withholding securities",
  I: "Discretionary transaction",
  M: "Exercise or conversion of derivative security",
  C: "Conversion of derivative security",
  E: "Expiration of short derivative position",
  H: "Expiration (or cancellation) of long derivative position",
  O: "Exercise of out-of-the-money derivative security",
  X: "Exercise of in-the-money or at-the-money derivative security",
  G: "Bona fide gift",
  L: "Small acquisition",
  W: "Acquisition or disposition by will or the laws of descent and distribution",
  Z: "Deposit into or withdrawal from voting trust",
  J: "Other acquisition or disposition",
  K: "Equity swap or similar instrument",
  U: "Disposition pursuant to a tender of shares in a change of control transaction",
};

/** Form 8-K item numbers (Form 8-K General Instructions B), so an agent can spot earnings releases (2.02) etc. */
export const FORM_8K_ITEMS: Record<string, string> = {
  "1.01": "Entry into a Material Definitive Agreement",
  "1.02": "Termination of a Material Definitive Agreement",
  "1.03": "Bankruptcy or Receivership",
  "1.04": "Mine Safety",
  "1.05": "Material Cybersecurity Incidents",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03": "Creation of a Direct Financial Obligation",
  "2.04": "Triggering Events That Accelerate or Increase a Direct Financial Obligation",
  "2.05": "Costs Associated with Exit or Disposal Activities",
  "2.06": "Material Impairments",
  "3.01": "Notice of Delisting or Failure to Satisfy a Continued Listing Rule",
  "3.02": "Unregistered Sales of Equity Securities",
  "3.03": "Material Modification to Rights of Security Holders",
  "4.01": "Changes in Registrant's Certifying Accountant",
  "4.02": "Non-Reliance on Previously Issued Financial Statements",
  "5.01": "Changes in Control of Registrant",
  "5.02": "Departure or Appointment of Directors or Officers; Compensatory Arrangements",
  "5.03": "Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year",
  "5.04": "Temporary Suspension of Trading Under Employee Benefit Plans",
  "5.05": "Amendments to the Code of Ethics",
  "5.06": "Change in Shell Company Status",
  "5.07": "Submission of Matters to a Vote of Security Holders",
  "5.08": "Shareholder Director Nominations",
  "6.01": "ABS Informational and Computational Material",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

// ---- input validation -------------------------------------------------------------------

export interface CompanyQuery {
  ticker?: string;
  cik?: string; // 10 digits, zero-padded
}
export interface FilingsQuery extends CompanyQuery {
  form?: string;
  limit: number;
}

const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;
const CIK_RE = /^\d{1,10}$/;
const FORM_RE = /^[A-Z0-9][A-Z0-9 \-\/]{0,19}$/;

export function parseCompanyQuery(input: { ticker?: unknown; cik?: unknown }): CompanyQuery {
  const ticker = typeof input.ticker === "string" ? input.ticker.trim().toUpperCase() : undefined;
  const cik = typeof input.cik === "string" ? input.cik.trim() : undefined;
  if (ticker && cik) throw new InputError("invalid_arguments", "pass either ticker or cik, not both");
  if (ticker) {
    if (!TICKER_RE.test(ticker)) throw new InputError("invalid_ticker", "ticker must be 1-10 letters, digits, '.' or '-', e.g. AAPL or BRK-B");
    return { ticker };
  }
  if (cik) {
    if (!CIK_RE.test(cik) || Number(cik) === 0) throw new InputError("invalid_cik", "cik must be the SEC Central Index Key, 1-10 digits, e.g. 320193");
    return { cik: cik.padStart(10, "0") };
  }
  throw new InputError("invalid_arguments", "pass ticker (e.g. AAPL) or cik (e.g. 320193)");
}

export function parseFilingsQuery(input: { ticker?: unknown; cik?: unknown; form?: unknown; limit?: unknown }): FilingsQuery {
  const company = parseCompanyQuery(input);
  let form: string | undefined;
  if (input.form !== undefined) {
    form = typeof input.form === "string" ? input.form.trim().toUpperCase() : "";
    if (!FORM_RE.test(form)) throw new InputError("invalid_form", "form must be an EDGAR form type such as 8-K, 10-Q, 10-K or 4");
  }
  let limit = DEFAULT_FILINGS_LIMIT;
  if (input.limit !== undefined) {
    limit = typeof input.limit === "string" && /^\d{1,3}$/.test(input.limit.trim()) ? Number(input.limit) : NaN;
    if (!(limit >= 1 && limit <= MAX_FILINGS_LIMIT)) throw new InputError("invalid_limit", `limit must be an integer 1-${MAX_FILINGS_LIMIT}`);
  }
  return { ...company, ...(form ? { form } : {}), limit };
}

// ---- Form 4 XML -------------------------------------------------------------------------

export interface ReportingOwner {
  name: string;
  cik: string;
  is_director: boolean;
  is_officer: boolean;
  officer_title: string | null;
  is_ten_percent_owner: boolean;
  is_other: boolean;
}

export interface Form4Transaction {
  table: "non_derivative" | "derivative";
  security: string | null;
  transaction_date: string | null;
  code: string | null;
  code_description: string | null;
  acquired_disposed: "A" | "D" | null;
  shares: number | null;
  price_per_share: number | null;
  shares_owned_after: number | null;
  ownership: "D" | "I" | null;
  underlying_security: string | null;
}

export interface Form4 {
  reporting_owners: ReportingOwner[];
  rule_10b5_1: boolean | null;
  transactions: Form4Transaction[];
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (XML_ENTITIES[e] ?? m),
  );

// shortcut: tag-based extraction, not a general XML parser. EDGAR ownership documents are generated against SEC's
// fixed schema (no attributes or CDATA on these elements), which this relies on; switch to a real parser if a field
// with nesting or attributes is ever needed.
const blocks = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const text = (xml: string, tag: string): string | null => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  const inner = m[1].includes("<value>") ? (m[1].match(/<value>([\s\S]*?)<\/value>/)?.[1] ?? "") : m[1];
  const v = unescape(inner.trim());
  return v === "" || v.includes("<") ? null : v;
};
const bool = (xml: string, tag: string) => {
  const v = text(xml, tag);
  return v === "1" || v?.toLowerCase() === "true";
};
const num = (xml: string, tag: string) => {
  const v = text(xml, tag);
  const n = v === null ? NaN : Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);

export function parseForm4(xml: string): Form4 {
  const owners = blocks(xml, "reportingOwner").map((o) => ({
    name: text(o, "rptOwnerName") ?? "",
    cik: text(o, "rptOwnerCik") ?? "",
    is_director: bool(o, "isDirector"),
    is_officer: bool(o, "isOfficer"),
    officer_title: text(o, "officerTitle"),
    is_ten_percent_owner: bool(o, "isTenPercentOwner"),
    is_other: bool(o, "isOther"),
  }));
  const tx = (table: Form4Transaction["table"]) => (t: string): Form4Transaction => {
    const code = text(t, "transactionCode");
    return {
      table,
      security: text(t, "securityTitle"),
      transaction_date: text(t, "transactionDate"),
      code,
      code_description: code ? (TRANSACTION_CODES[code] ?? null) : null,
      acquired_disposed: oneOf(text(t, "transactionAcquiredDisposedCode"), ["A", "D"] as const),
      shares: num(t, "transactionShares"),
      price_per_share: num(t, "transactionPricePerShare"),
      shares_owned_after: num(t, "sharesOwnedFollowingTransaction"),
      ownership: oneOf(text(t, "directOrIndirectOwnership"), ["D", "I"] as const),
      underlying_security: table === "derivative" ? text(t, "underlyingSecurityTitle") : null,
    };
  };
  const aff = text(xml, "aff10b5One");
  return {
    reporting_owners: owners,
    rule_10b5_1: aff === null ? null : aff === "1" || aff.toLowerCase() === "true",
    transactions: [
      ...blocks(xml, "nonDerivativeTransaction").map(tx("non_derivative")),
      ...blocks(xml, "derivativeTransaction").map(tx("derivative")),
    ],
  };
}

// ---- results ----------------------------------------------------------------------------

export interface Issuer {
  cik: string;
  name: string;
  tickers: string[];
}

export interface Filing {
  accession_number: string;
  form: string;
  filing_date: string;
  report_date: string | null;
  accepted_at: string | null;
  /** 8-K item numbers with their titles; empty for other forms. */
  items: { item: string; title: string | null }[];
  description: string | null;
  document_url: string;
  index_url: string;
}

export interface InsiderTrade extends Form4Transaction {
  accession_number: string;
  form: string;
  filing_date: string;
  filing_url: string;
  reporting_owners: ReportingOwner[];
  rule_10b5_1: boolean | null;
}

export interface InsiderTradesResult {
  issuer: Issuer;
  filings_checked: number;
  transaction_count: number;
  transactions: InsiderTrade[];
  data_fetched_at: string;
  queried_at: string;
  source: string;
}

export interface FilingsResult {
  issuer: Issuer;
  form: string | null;
  count: number;
  filings: Filing[];
  data_fetched_at: string;
  queried_at: string;
  source: string;
}

/** One filing as cached: accession, form, filing date, report date, acceptance time, 8-K items, primary document, description. */
type Row = [string, string, string, string | null, string | null, string, string, string | null];

interface Submissions {
  expires: number;
  fetchedAt: string;
  issuer: Issuer;
  rows: Row[];
}

function toFiling(cik: string, [acc, form, filed, reported, accepted, items, doc, description]: Row): Filing {
  return {
    accession_number: acc,
    form,
    filing_date: filed,
    report_date: reported,
    accepted_at: accepted,
    items: items
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((item) => ({ item, title: FORM_8K_ITEMS[item] ?? null })),
    description,
    document_url: `${archive(cik, acc)}/${doc}`,
    index_url: `${archive(cik, acc)}/${acc}-index.htm`,
  };
}

interface SubmissionsJson {
  cik?: string;
  name?: string;
  tickers?: string[];
  filings?: { recent?: Record<string, unknown[]> };
}

/** Shared by every SEC call made for one paid request. */
interface Budget {
  deadline: number; // epoch ms
  calls: number; // SEC requests still allowed
}

type Fetch = typeof fetch;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const archive = (cik: string, accession: string) => `${SEC_WWW}/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;

// ---- client with cache and pacing -------------------------------------------------------

export class SecClient {
  private tickers?: { expires: number; map: Map<string, string> };
  private readonly submissions = new Map<string, Submissions>();
  private readonly form4 = new Map<string, Form4>();
  /** Concurrent misses for the same key share one upstream call. */
  private readonly pending = new Map<string, Promise<unknown>>();
  private nextSlot = 0;
  upstreamCalls = 0;

  /** Cache sizes, for tests: submissions entries and, per entry, kept filings and serialized bytes. */
  cacheStats() {
    const entries = [...this.submissions.values()];
    return {
      submissions: entries.length,
      maxFilings: Math.max(0, ...entries.map((e) => e.rows.length)),
      maxEntryBytes: Math.max(0, ...entries.map((e) => JSON.stringify(e).length)),
      form4: this.form4.size,
    };
  }

  constructor(
    private readonly userAgent: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private budget(deadline = Infinity, calls = MAX_SEC_CALLS_PER_REQUEST): Budget {
    return { deadline: Math.min(this.now() + SEC_DEADLINE_MS, deadline), calls };
  }

  /** Waits for this container's next SEC slot (SEC_RATE_PER_SEC), then fetches. 404 returns null. */
  private async get(url: string, budget: Budget, as: "json" | "text"): Promise<unknown> {
    if (budget.calls <= 0) throw new UpstreamError("SEC request limit per call reached");
    budget.calls--;
    const start = Math.max(this.now(), this.nextSlot);
    this.nextSlot = start + 1000 / SEC_RATE_PER_SEC;
    if (start >= budget.deadline) throw new UpstreamError("SEC EDGAR deadline exceeded");
    if (start > this.now()) await this.wait(start - this.now());
    const remaining = budget.deadline - this.now();
    if (remaining <= 0) throw new UpstreamError("SEC EDGAR deadline exceeded");
    const timeout = Math.min(SEC_TIMEOUT_MS, remaining);
    this.upstreamCalls++;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { "user-agent": this.userAgent, accept: as === "json" ? "application/json" : "application/xml" }, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      throw new UpstreamError(`SEC EDGAR unreachable: ${timedOut ? `timeout after ${Math.round(timeout / 100) / 10}s` : (e as Error).message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new UpstreamError(`SEC EDGAR returned HTTP ${res.status}`);
    try {
      return as === "json" ? await res.json() : await res.text();
    } catch {
      throw new UpstreamError("SEC EDGAR returned an unreadable body");
    }
  }

  private shared<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.pending.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  private async cikOf(q: CompanyQuery, budget: Budget): Promise<string> {
    if (q.cik) return q.cik.padStart(10, "0");
    if (!this.tickers || this.tickers.expires <= this.now()) {
      this.tickers = await this.shared("tickers", async () => {
        const body = (await this.get(`${SEC_WWW}/files/company_tickers.json`, budget, "json")) as Record<string, { cik_str?: number; ticker?: string }> | null;
        if (!body || typeof body !== "object") throw new UpstreamError("SEC EDGAR ticker list unavailable");
        const map = new Map<string, string>();
        for (const e of Object.values(body)) {
          if (e?.ticker && e.cik_str) map.set(e.ticker.toUpperCase(), String(e.cik_str).padStart(10, "0"));
        }
        return { expires: this.now() + TICKERS_TTL_MS, map };
      });
    }
    // EDGAR writes class shares with '-' (BRK-B); agents often write BRK.B.
    const cik = this.tickers.map.get(q.ticker!) ?? this.tickers.map.get(q.ticker!.replace(/\./g, "-"));
    if (!cik) throw new InputError("unknown_ticker", `ticker ${q.ticker} is not in SEC's company ticker list; try cik=`, 404);
    return cik;
  }

  private async submissionsOf(cik: string, budget: Budget): Promise<Submissions> {
    const hit = this.submissions.get(cik);
    if (hit && hit.expires > this.now()) return hit;
    if (hit) this.submissions.delete(cik); // expired: free it now, not only when evicted
    return this.shared(`sub:${cik}`, async () => {
      const body = (await this.get(`${SEC_DATA}/submissions/CIK${cik}.json`, budget, "json")) as SubmissionsJson | null;
      if (body === null) throw new InputError("unknown_cik", `no SEC EDGAR filer with CIK ${cik}`, 404);
      const r = body.filings?.recent;
      if (!r || !Array.isArray(r.accessionNumber)) throw new UpstreamError("SEC EDGAR returned an unexpected submissions format");
      const col = (k: string, i: number) => {
        const v = (r[k] as unknown[] | undefined)?.[i];
        return typeof v === "string" && v !== "" ? v : null;
      };
      // Only the compact rows are kept; the parsed body (about 1 MB for a large filer) is dropped after this.
      const rows: Row[] = r.accessionNumber.slice(0, SUBMISSIONS_MAX_FILINGS).map((acc, i) => [
        String(acc),
        col("form", i) ?? "",
        col("filingDate", i) ?? "",
        col("reportDate", i),
        col("acceptanceDateTime", i),
        col("items", i) ?? "",
        col("primaryDocument", i) ?? "",
        col("primaryDocDescription", i),
      ]);
      const now = this.now();
      const entry: Submissions = {
        expires: now + SUBMISSIONS_TTL_MS,
        fetchedAt: new Date(now).toISOString(),
        issuer: { cik, name: body.name ?? "", tickers: Array.isArray(body.tickers) ? body.tickers.map(String) : [] },
        rows,
      };
      // shortcut: oldest-first eviction at a fixed entry cap bounds memory per Lambda container.
      if (this.submissions.size >= SUBMISSIONS_MAX_ENTRIES) this.submissions.delete(this.submissions.keys().next().value!);
      this.submissions.delete(cik);
      this.submissions.set(cik, entry);
      return entry;
    });
  }

  private async form4Of(cik: string, [acc, , , , , , doc]: Row, budget: Budget): Promise<Form4> {
    const hit = this.form4.get(acc);
    if (hit) return hit;
    return this.shared(`f4:${acc}`, async () => {
      // primaryDocument points at the XSL-rendered view (xslF345X06/form4.xml); the raw XML sits beside it.
      const raw = doc.replace(/^xsl[^/]*\//, "");
      const xml = await this.get(`${archive(cik, acc)}/${raw}`, budget, "text");
      if (typeof xml !== "string" || !xml.includes("<ownershipDocument")) throw new UpstreamError("SEC EDGAR Form 4 document unavailable");
      const parsed = parseForm4(xml);
      if (this.form4.size >= FORM4_MAX_ENTRIES) this.form4.delete(this.form4.keys().next().value!);
      this.form4.set(acc, parsed);
      return parsed;
    });
  }

  /** deadline: epoch ms by which all SEC calls must be done (the app's settlement cut-off). */
  async insiderTrades(q: CompanyQuery, deadline?: number): Promise<InsiderTradesResult> {
    const budget = this.budget(deadline);
    const cik = await this.cikOf(q, budget);
    const sub = await this.submissionsOf(cik, budget);
    const recent = sub.rows.filter(([, form, , , , , doc]) => (form === "4" || form === "4/A") && doc.endsWith(".xml")).slice(0, INSIDER_FILINGS);
    // Fetched together; get() spaces the requests out at SEC_RATE_PER_SEC.
    const docs = await Promise.all(recent.map((row) => this.form4Of(cik, row, budget)));
    const transactions = recent.map((row) => toFiling(cik, row)).flatMap((f, i) =>
      docs[i].transactions.map((t) => ({
        accession_number: f.accession_number,
        form: f.form,
        filing_date: f.filing_date,
        filing_url: f.index_url,
        reporting_owners: docs[i].reporting_owners,
        rule_10b5_1: docs[i].rule_10b5_1,
        ...t,
      })),
    );
    return {
      issuer: sub.issuer,
      filings_checked: recent.length,
      transaction_count: transactions.length,
      transactions,
      data_fetched_at: sub.fetchedAt,
      queried_at: new Date(this.now()).toISOString(),
      source: SEC_SOURCE_NOTE,
    };
  }

  async latestFilings(q: FilingsQuery, deadline?: number): Promise<FilingsResult> {
    const budget = this.budget(deadline, LATEST_FILINGS_MAX_SEC_CALLS);
    const cik = await this.cikOf(q, budget);
    const sub = await this.submissionsOf(cik, budget);
    const filings = sub.rows
      .filter(([, form]) => !q.form || form === q.form)
      .slice(0, q.limit)
      .map((row) => toFiling(cik, row));
    return {
      issuer: sub.issuer,
      form: q.form ?? null,
      count: filings.length,
      filings,
      data_fetched_at: sub.fetchedAt,
      queried_at: new Date(this.now()).toISOString(),
      source: SEC_SOURCE_NOTE,
    };
  }
}

// ---- deployment probe -------------------------------------------------------------------

/**
 * A direct `aws lambda invoke` payload {"x402_probe":"sec"} (scripts/sec-lambda-probe.sh). API Gateway events always
 * carry requestContext, so this cannot be reached over HTTP; only an IAM principal allowed to invoke the function can.
 */
export const isSecProbe = (event: unknown): boolean =>
  typeof event === "object" && event !== null && (event as { x402_probe?: unknown }).x402_probe === "sec" && !("requestContext" in event);

/** Two read-only GETs with the production User-Agent: does SEC answer from this Lambda's egress IP? Never throws. */
export async function probeSec(userAgent: string, fetchImpl: Fetch = fetch) {
  const urls = [`${SEC_DATA}/submissions/CIK0000320193.json`, `${SEC_WWW}/files/company_tickers.json`];
  const results = [];
  for (const url of urls) {
    const start = Date.now();
    try {
      const res = await fetchImpl(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(SEC_TIMEOUT_MS) });
      const body = await res.text();
      results.push({ url, status: res.status, ms: Date.now() - start, bytes: body.length, blocked: body.includes("Undeclared Automated Tool") });
    } catch (e) {
      results.push({ url, status: null, ms: Date.now() - start, error: (e as Error).message });
    }
    await sleep(1000 / SEC_RATE_PER_SEC);
  }
  return { ok: results.every((r) => r.status === 200), user_agent: userAgent, results };
}
