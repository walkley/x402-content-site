// Package vulnerability advisories from OSV.dev (https://osv.dev, API: https://google.github.io/osv.dev/api/).
// Licensing: OSV.dev itself is Apache-2.0; each record keeps the license of its source database,
// mapped by ID prefix below and returned per advisory so the attribution travels with the data.
import { InputError } from "./calendar.js";

export const ECOSYSTEMS = ["npm", "PyPI", "Go", "crates.io", "Maven"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export const OSV_API = "https://api.osv.dev/v1";
export const OSV_TIMEOUT_MS = 5_000;
export const CACHE_TTL_MS = 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 5_000;
export const MAX_BATCH = 50;
/** Wall-clock budget for all OSV.dev calls of one paid request; leaves time to settle before the HTTP API's 30 s integration timeout. */
export const UPSTREAM_DEADLINE_MS = 15_000;
const MAX_PAGES = 5; // OSV paginates very large results; cap the pages per package.
/** Upper bound on OSV.dev page requests one paid batch can trigger (first pages included). */
export const MAX_BATCH_PAGES = 60;
const BATCH_CONCURRENCY = 10;
export const OSV_SOURCE_NOTE =
  "OSV.dev (https://osv.dev). Excerpted and modified: details text omitted, affected ranges restructured and filtered to the queried package. Per-advisory license in `license`.";
const USER_AGENT = "x402-content-site/1.0 (+https://github.com/walkley/x402-content-site)";

const LICENSES: [prefix: string, license: string, source: string][] = [
  ["GHSA-", "CC-BY-4.0", "GitHub Advisory Database"],
  ["PYSEC-", "CC-BY-4.0", "PyPI Advisory Database"],
  ["GO-", "CC-BY-4.0", "Go Vulnerability Database"],
  ["RUSTSEC-", "CC0-1.0", "Rust Advisory Database"],
  ["MAL-", "Apache-2.0", "OpenSSF Malicious Packages"],
  ["PSF-", "CC-BY-4.0", "Python Software Foundation Database"],
];

export interface PackageQuery {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

export interface Advisory {
  id: string;
  aliases: string[];
  summary: string | null;
  severity: { level: string | null; cvss: { type: string; vector: string }[] };
  affected: { package: string; ranges: { type: string; introduced?: string; fixed?: string; last_affected?: string }[] }[];
  fixed_versions: string[];
  published: string | null;
  modified: string | null;
  references: string[];
  url: string;
  source_database: string;
  license: string;
}

export interface AdvisoryResult extends PackageQuery {
  vulnerable: boolean;
  advisory_count: number;
  advisories: Advisory[];
  truncated: boolean;
  data_fetched_at: string;
  queried_at: string;
  source: string;
}

export class UpstreamError extends Error {}

/** Shared by every OSV.dev call made for one paid request. */
interface Budget {
  deadline: number; // epoch ms
  extraPages: number; // follow-up pages (after each package's first page) still allowed
}

// ---- input validation -------------------------------------------------------------------

const ECOSYSTEM_BY_LOWER = new Map(ECOSYSTEMS.map((e) => [e.toLowerCase(), e]));
const NAME_RE = /^[\x21-\x7e]{1,214}$/; // printable ASCII, no spaces
const VERSION_RE = /^[\x21-\x7e]{1,128}$/;

export function parsePackageQuery(input: { ecosystem?: unknown; name?: unknown; version?: unknown }, where = ""): PackageQuery {
  const at = where ? ` (${where})` : "";
  const eco = typeof input.ecosystem === "string" ? ECOSYSTEM_BY_LOWER.get(input.ecosystem.trim().toLowerCase()) : undefined;
  if (!eco) throw new InputError("invalid_ecosystem", `ecosystem must be one of ${ECOSYSTEMS.join(", ")}${at}`);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!NAME_RE.test(name)) throw new InputError("invalid_name", `name must be 1-214 printable characters without spaces${at}`);
  if (eco === "Maven" && !/^[^:]+:[^:]+$/.test(name)) {
    throw new InputError("invalid_name", `Maven name must be groupId:artifactId, e.g. org.apache.logging.log4j:log4j-core${at}`);
  }
  const version = typeof input.version === "string" ? input.version.trim() : "";
  if (!VERSION_RE.test(version)) throw new InputError("invalid_version", `version must be 1-128 printable characters without spaces${at}`);
  return { ecosystem: eco, name, version };
}

export function parseBatch(body: unknown): PackageQuery[] {
  const packages = (body as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new InputError("invalid_body", 'body must be JSON {"packages":[{"ecosystem","name","version"}, ...]}');
  }
  if (packages.length > MAX_BATCH) throw new InputError("batch_too_large", `at most ${MAX_BATCH} packages per batch, got ${packages.length}`);
  return packages.map((p, i) => parsePackageQuery((p ?? {}) as Record<string, unknown>, `packages[${i}]`));
}

// ---- OSV record mapping -----------------------------------------------------------------

interface OsvEvent { introduced?: string; fixed?: string; last_affected?: string; limit?: string }
interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  modified?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  references?: { type?: string; url: string }[];
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { type: string; events: OsvEvent[] }[] }[];
}

function licenseOf(id: string): { license: string; source_database: string } {
  const hit = LICENSES.find(([p]) => id.startsWith(p));
  return hit ? { license: hit[1], source_database: hit[2] } : { license: "see source record", source_database: "OSV.dev" };
}

export function toAdvisory(v: OsvVuln, q: PackageQuery): Advisory {
  const norm = (s: string) => (q.ecosystem === "PyPI" ? s.toLowerCase().replace(/[-_.]+/g, "-") : s.toLowerCase());
  const same = (a: NonNullable<OsvVuln["affected"]>[number]) =>
    a.package?.ecosystem === q.ecosystem && norm(a.package?.name ?? "") === norm(q.name);
  const affectedEntries = (v.affected ?? []).filter(same);
  const affected = affectedEntries.map((a) => ({
    package: a.package!.name!,
    ranges: (a.ranges ?? []).flatMap((r) => {
      // Events come as a flat list: introduced, then fixed or last_affected, possibly repeated.
      const out: { type: string; introduced?: string; fixed?: string; last_affected?: string }[] = [];
      for (const e of r.events) {
        if (e.introduced !== undefined) out.push({ type: r.type, introduced: e.introduced });
        else if (out.length && (e.fixed !== undefined || e.last_affected !== undefined)) {
          if (e.fixed !== undefined) out[out.length - 1].fixed = e.fixed;
          if (e.last_affected !== undefined) out[out.length - 1].last_affected = e.last_affected;
        }
      }
      return out;
    }),
  }));
  const fixed = [...new Set(affected.flatMap((a) => a.ranges.map((r) => r.fixed).filter((f): f is string => !!f)))];
  const lic = licenseOf(v.id);
  return {
    id: v.id,
    aliases: v.aliases ?? [],
    // Records from a source without a known permissive license keep facts only (ids, versions, links).
    summary: lic.license === "see source record" ? null : (v.summary ?? null),
    severity: {
      level: v.database_specific?.severity ?? null,
      cvss: (v.severity ?? []).filter((s) => s.type.startsWith("CVSS")).map((s) => ({ type: s.type, vector: s.score })),
    },
    affected,
    fixed_versions: fixed,
    published: v.published ?? null,
    modified: v.modified ?? null,
    references: (v.references ?? []).map((r) => r.url),
    url: `https://osv.dev/vulnerability/${encodeURIComponent(v.id)}`,
    ...lic,
  };
}

// ---- client with cache ------------------------------------------------------------------

type Fetch = typeof fetch;
interface CacheEntry { expires: number; fetchedAt: string; advisories: Advisory[]; truncated: boolean }

export class OsvClient {
  private readonly cache = new Map<string, CacheEntry>();
  /** Concurrent misses for the same key share one upstream call. */
  private readonly pending = new Map<string, Promise<CacheEntry>>();
  upstreamCalls = 0;

  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private key(q: PackageQuery) {
    return `${q.ecosystem}\u0000${q.name}\u0000${q.version}`;
  }

  private budget(extraPages: number): Budget {
    return { deadline: this.now() + UPSTREAM_DEADLINE_MS, extraPages };
  }

  private async post(body: unknown, budget: Budget): Promise<{ vulns?: OsvVuln[]; next_page_token?: string }> {
    const remaining = budget.deadline - this.now();
    if (remaining <= 0) throw new UpstreamError(`OSV.dev deadline of ${UPSTREAM_DEADLINE_MS / 1000}s exceeded`);
    this.upstreamCalls++;
    const timeout = Math.min(OSV_TIMEOUT_MS, remaining);
    let res: Response;
    try {
      res = await this.fetchImpl(`${OSV_API}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      throw new UpstreamError(`OSV.dev unreachable: ${timedOut ? `timeout after ${Math.round(timeout / 100) / 10}s` : (e as Error).message}`);
    }
    if (!res.ok) throw new UpstreamError(`OSV.dev returned HTTP ${res.status}`);
    try {
      return (await res.json()) as { vulns?: OsvVuln[]; next_page_token?: string };
    } catch {
      throw new UpstreamError("OSV.dev returned invalid JSON");
    }
  }

  private async fetchEntry(q: PackageQuery, now: number, budget: Budget): Promise<CacheEntry> {
    const key = this.key(q);
    const vulns: OsvVuln[] = [];
    let token: string | undefined;
    let pages = 0;
    let cutByBudget = false;
    for (;;) {
      const page = await this.post(
        { package: { ecosystem: q.ecosystem, name: q.name }, version: q.version, ...(token ? { page_token: token } : {}) },
        budget,
      );
      vulns.push(...(page.vulns ?? []));
      token = page.next_page_token;
      if (!token || ++pages >= MAX_PAGES) break;
      if (budget.extraPages <= 0) {
        cutByBudget = true;
        break;
      }
      budget.extraPages--;
    }
    const entry: CacheEntry = {
      expires: now + CACHE_TTL_MS,
      fetchedAt: new Date(now).toISOString(),
      advisories: vulns.map((v) => toAdvisory(v, q)),
      truncated: !!token,
    };
    // A result cut short by this batch's page budget is not cached, so a later single query gets the full list.
    if (!cutByBudget) {
      // shortcut: oldest-first eviction at a fixed entry cap bounds memory per Lambda container.
      if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }

  async query(q: PackageQuery, budget: Budget = this.budget(MAX_PAGES - 1)): Promise<AdvisoryResult> {
    const key = this.key(q);
    const now = this.now();
    let entry = this.cache.get(key);
    if (!entry || entry.expires <= now) {
      let p = this.pending.get(key);
      if (!p) {
        p = this.fetchEntry(q, now, budget).finally(() => this.pending.delete(key));
        this.pending.set(key, p);
      }
      entry = await p;
    }
    return {
      ...q,
      vulnerable: entry.advisories.length > 0,
      advisory_count: entry.advisories.length,
      advisories: entry.advisories,
      truncated: entry.truncated,
      data_fetched_at: entry.fetchedAt,
      queried_at: new Date(now).toISOString(),
      source: OSV_SOURCE_NOTE,
    };
  }

  /**
   * Runs queries with bounded concurrency under one deadline and a total page budget of MAX_BATCH_PAGES.
   * Any upstream failure or the deadline fails the whole batch (and so it is not charged).
   */
  async queryMany(qs: PackageQuery[]): Promise<AdvisoryResult[]> {
    const budget = this.budget(Math.max(0, MAX_BATCH_PAGES - qs.length));
    const out: AdvisoryResult[] = new Array(qs.length);
    let next = 0;
    const worker = async () => {
      while (next < qs.length) {
        const i = next++;
        out[i] = await this.query(qs[i], budget);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, qs.length) }, worker));
    return out;
  }
}
