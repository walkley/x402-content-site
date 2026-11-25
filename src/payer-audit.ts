// Seller payer audit: who actually pays an x402 payTo address. The data is built offline by scripts/payer-audit/build.ts
// (one JSON per payTo, uploaded to S3) and only read here.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { InputError } from "./calendar.js";
import { UpstreamError } from "./advisories.js";

export const AUDIT_SCHEMA_VERSION = 1;

export const LABEL_DISCLAIMER =
  "Labels are rule-based classifications of public on-chain USDC transfers. They describe funding and payment patterns, not intent, " +
  "and are not an allegation of wash trading or any wrongdoing by a seller or payer. They can be wrong (for example refunds or " +
  "promotional credits sent by a seller make its customers look self-funded). Corrections: https://github.com/walkley/x402-content-site/issues";
export const PAYER_LABELS = ["probe", "self", "fleet", "real", "once"] as const;
export type PayerLabel = (typeof PAYER_LABELS)[number];

export interface LabelTotals {
  payers: number;
  tx: number;
  usd: number;
}

export interface AuditPayer {
  address: string;
  label: PayerLabel;
  /** Why the label was given, e.g. "funded by payTo", "same funder 0x.. sent $0.04 to 4 payers". */
  reason: string;
  tx: number;
  usd: number;
  days: number;
  first_day: string;
  last_day: string;
  /** Largest USDC funders of this payer inside the window (at most 3). */
  funders: { address: string; usd: number; kind?: string }[];
  /** Facilitator that sent a sampled settlement tx ("unknown:0x.." when not in the table, "direct" when the payer sent it). */
  facilitator?: string;
}

export interface AuditRecord {
  schema: number;
  pay_to: string;
  generated_at: string;
  window: { from_block: number; to_block: number; from: string; to: string };
  /** Directory snapshot the listing status comes from. */
  listing: { snapshot: string; cdp: boolean; payai: boolean; hosts: string[]; resources: number };
  totals: LabelTotals;
  by_label: Record<PayerLabel, LabelTotals>;
  /** Transfers above $2, counted apart (not x402-style payments). */
  large_transfers: { tx: number; usd: number };
  /** Sampled settlement tx per facilitator (one per payer). */
  facilitators: Record<string, number>;
  probe_list: { wallets: number; source: string };
  payers: AuditPayer[];
}

/** Reads one payTo's record. undefined when the address is not in the data set. */
export interface AuditStore {
  get(payTo: string): Promise<AuditRecord | undefined>;
}

const PAY_TO_RE = /^0x[0-9a-fA-F]{40}$/;

export function parsePayTo(value: unknown): string {
  if (typeof value !== "string" || !PAY_TO_RE.test(value)) {
    throw new InputError("invalid_pay_to", "payTo must be a 0x-prefixed 40-hex-digit Base address");
  }
  return value.toLowerCase();
}

const keyOf = (prefix: string, payTo: string) => `${prefix.replace(/\/?$/, "/")}${payTo.toLowerCase()}.json`;

/** Records cached per container; a refresh in S3 is seen after at most this long. */
export const AUDIT_CACHE_MS = 10 * 60_000;
export const AUDIT_S3_TIMEOUT_MS = 3_000;

/**
 * Read-only S3 store: s3://bucket/prefix/<payTo lowercase>.json. A missing object is "not in the data set"; any other
 * S3 failure is an UpstreamError (free 502, nothing charged).
 */
export class S3AuditStore implements AuditStore {
  private cache = new Map<string, { at: number; record: AuditRecord | undefined }>();
  constructor(
    private bucket: string,
    private prefix: string,
    private s3: Pick<S3Client, "send"> = new S3Client({}),
    private now: () => number = Date.now,
  ) {}
  async get(payTo: string): Promise<AuditRecord | undefined> {
    const key = payTo.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < AUDIT_CACHE_MS) return hit.record;
    let record: AuditRecord | undefined;
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: keyOf(this.prefix, key) }), {
        abortSignal: AbortSignal.timeout(AUDIT_S3_TIMEOUT_MS),
      });
      record = JSON.parse(await res.Body!.transformToString()) as AuditRecord;
    } catch (e) {
      if (!(e instanceof NoSuchKey) && (e as { name?: string }).name !== "NoSuchKey") {
        throw new UpstreamError(`audit data unavailable (${(e as Error).name ?? "error"})`);
      }
    }
    // shortcut: unbounded map of at most one entry per looked-up payTo per container; fine at the route's 2 rps throttle.
    this.cache.set(key, { at: this.now(), record });
    return record;
  }
}

/** Local directory store (development and tests): <dir>/<payTo lowercase>.json, as written by the build script. */
export class DirAuditStore implements AuditStore {
  constructor(private dir: string) {}
  async get(payTo: string): Promise<AuditRecord | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${payTo.toLowerCase()}.json`), "utf8")) as AuditRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new UpstreamError("audit data unreadable");
    }
  }
}

/** No data configured: every payTo is "not in the data set" (free 404). */
export const EMPTY_AUDIT_STORE: AuditStore = { get: async () => undefined };

export function auditStoreFromEnv(env: Record<string, string | undefined>): AuditStore {
  const bucket = env.PAYER_AUDIT_BUCKET?.trim();
  if (bucket) return new S3AuditStore(bucket, env.PAYER_AUDIT_PREFIX?.trim() || "payer-audit/");
  const dir = env.PAYER_AUDIT_DIR?.trim();
  return dir ? new DirAuditStore(dir) : EMPTY_AUDIT_STORE;
}

export const notIndexed = (payTo: string) =>
  new InputError(
    "not_indexed",
    `${payTo} is not in the audit data set (payTo addresses listed in the CDP Bazaar or PayAI directories with Base USDC payments in the last 30 days)`,
    404,
  );

const round = (n: number, d = 2) => Number(n.toFixed(d));
/** $1.94, $0.17, $0.0009: two decimals unless that would show a non-zero amount as $0.00. */
const money = (n: number) => `$${n === 0 || n >= 0.01 ? n.toFixed(2) : n.toPrecision(1)}`;
const share = (part: number, whole: number) => (whole > 0 ? round(part / whole, 3) : 0);

/** Free preview: counts per label and the probe share, no addresses. */
export function auditPreview(r: AuditRecord) {
  const p = r.by_label.probe;
  return {
    pay_to: r.pay_to,
    generated_at: r.generated_at,
    window: r.window,
    payer_count: r.totals.payers,
    by_label: Object.fromEntries(PAYER_LABELS.map((l) => [l, r.by_label[l].payers])),
    probe_share: { payers: share(p.payers, r.totals.payers), usd: share(p.usd, r.totals.usd) },
    full_report: "GET /x402/payer-audit?payTo=... (x402) lists every payer with label, tx, USD, funders, facilitator and suggestions",
    disclaimer: LABEL_DISCLAIMER,
  };
}

/** Rule-based suggestions from the record; each names the number it is based on. */
export function auditSuggestions(r: AuditRecord): string[] {
  const out: string[] = [];
  const t = r.totals;
  const l = r.by_label;
  const externalUsd = l.real.usd + l.once.usd;
  if (t.payers === 0) {
    out.push("No Base USDC payments in the window. Check that the route returns a valid 402 (agentcash check <url>) and that payTo matches the address in your accepts.");
    return out;
  }
  if (l.probe.payers > 0 && share(l.probe.payers, t.payers) >= 0.5) {
    out.push(
      `${l.probe.payers} of ${t.payers} payers are directory probes and test-buy wallets (${money(l.probe.usd)}). ` +
        "Do not count them as users; they pay once per new route to check delivery.",
    );
  }
  if (l.self.payers > 0) {
    out.push(
      `${l.self.payers} payers (${money(l.self.usd)}) are labelled self: they received USDC from this payTo or from a wallet it funded. ` +
        "If those transfers were not refunds or credits to customers, leave these payers out of revenue and listing metrics.",
    );
  }
  if (l.fleet.payers > 0) {
    out.push(`${l.fleet.payers} payers (${money(l.fleet.usd)}) are labelled fleet: one funder sent the same amount to several of them, so they may be one operator rather than ${l.fleet.payers} customers.`);
  }
  if (l.real.payers === 0) {
    out.push("No payer paid on 2 or more days with 3 or more payments. Repeat use is the signal to watch; directory listing alone has not produced it.");
  } else {
    out.push(`${l.real.payers} repeat payers (3+ payments on 2+ days) paid ${money(l.real.usd)}; that is the external revenue to track.`);
  }
  if (!r.listing.cdp) {
    out.push(
      "Not in the CDP Bazaar snapshot. CDP lists a route after the CDP facilitator settles a payment for it; most sampled agent payments on Base are settled by CDP.",
    );
  }
  if (!r.listing.payai) out.push("Not in the PayAI directory snapshot. PayAI lists a route after it settles one payment for it (a self-payment works).");
  if (externalUsd === 0 && t.usd > 0) out.push("All revenue in the window came from payers labelled probe, self or fleet.");
  return out;
}

export function auditDetail(r: AuditRecord) {
  return { ...auditPreview(r), full_report: undefined, totals: r.totals, by_label_detail: r.by_label, large_transfers: r.large_transfers, listing: r.listing, facilitators: r.facilitators, probe_list: r.probe_list, suggestions: auditSuggestions(r), payers: r.payers };
}

export const PAYER_AUDIT_DESCRIPTION =
  "Who really pays your x402 endpoint. For a Base payTo address: every USDC payer in the last 30 days labelled " +
  "probe (directory probe or test-buy wallet, 164-wallet list), self (funded by the payTo or a wallet it funded), " +
  "fleet (one funder sent the same amount to 3+ payers), real (3+ payments on 2+ days) or once; " +
  "with tx count, USD, funders, settling facilitator, CDP/PayAI listing status and suggestions. " +
  "A payTo not in the data set is a free 404. Data rebuilt offline from Base RPC. Labels are rule-based classifications of " +
  "public transfers, not allegations; they can be wrong (refunds, promotional credits).";
export const PAYER_AUDIT_PREVIEW_DESCRIPTION =
  "Free: payer counts per label (probe, self, fleet, real, once) and the probe share for a Base payTo, no addresses.";

const ADDR = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
export const PAYER_AUDIT_INPUT_SCHEMA = {
  type: "object",
  properties: { payTo: { ...ADDR, description: "The payTo address in your x402 accepts (Base)", examples: ["0xaa9bc6380c65fe6d99d0805837ae460d73a91cb2"] } },
  required: ["payTo"],
  additionalProperties: false,
};
const TOTALS = { type: "object", properties: { payers: { type: "integer" }, tx: { type: "integer" }, usd: { type: "number" } } };
export const PAYER_AUDIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    pay_to: { type: "string" },
    generated_at: { type: "string" },
    window: { type: "object" },
    payer_count: { type: "integer" },
    by_label: { type: "object", description: "payer count per label" },
    probe_share: { type: "object", properties: { payers: { type: "number" }, usd: { type: "number" } } },
    totals: TOTALS,
    by_label_detail: { type: "object", additionalProperties: TOTALS },
    listing: { type: "object", properties: { cdp: { type: "boolean" }, payai: { type: "boolean" }, hosts: { type: "array", items: { type: "string" } } } },
    facilitators: { type: "object", additionalProperties: { type: "integer" } },
    suggestions: { type: "array", items: { type: "string" } },
    payers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          address: { type: "string" },
          label: { type: "string", enum: [...PAYER_LABELS] },
          reason: { type: "string" },
          tx: { type: "integer" },
          usd: { type: "number" },
          days: { type: "integer" },
          funders: { type: "array", items: { type: "object" } },
          facilitator: { type: "string" },
        },
      },
    },
  },
  required: ["pay_to", "payers", "by_label", "suggestions"],
};
export const PAYER_AUDIT_EXAMPLE_INPUT = { payTo: "0xaa9bc6380c65fe6d99d0805837ae460d73a91cb2" };
