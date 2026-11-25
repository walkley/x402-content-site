// "Who really pays for x402": a fixed research report (numbers from research rounds r12, r21 and r23 of this project,
// Base mainnet USDC, 2026-10-26..2026-11-25). Free summary page, $2 HTML body behind the x402 browser paywall, $0.5 JSON.
import probeFile from "../data/payer-audit/probe-wallets.json";
import { LABEL_DISCLAIMER, PAYER_LABELS, type auditDetail, type auditPreview } from "./payer-audit.js";

export const REPORT_PATH = "/reports/x402-real-payers";
export const REPORT_FULL_PATH = `${REPORT_PATH}/full`;
export const REPORT_JSON_PATH = `${REPORT_PATH}.json`;
export const REPORT_TITLE = "Who really pays for x402: 30 days of Base USDC payments";
export const REPORT_DESCRIPTION =
  "Research report on x402 payments on Base, 2026-10-26 to 2026-11-25: of 22,916 paying addresses, how many are directory probes, " +
  "test-buy wallets, seller self-funding and fleets, and the 779 independent operators that are left; what they buy, " +
  "which facilitators settle, case studies of sellers with their own users, and the 164-wallet probe list";

const window = { from: "2026-10-26T01:18:00+08:00", to: "2026-11-25T00:52:00+08:00", from_block: 53_077_945, to_block: 61_743_941, chain: "Base (eip155:8453)", asset: "USDC" };

// In the paid report only: on the free summary page it reads as a reason not to buy the payer audit.
const SELLER_TOOLS_FINDING = "Tools for x402 sellers (402 lint, listing checks, trust scores) had few non-probe payers: 1 to 5 each.";
/** Same paths as PAYER_AUDIT_PATH / PAYER_AUDIT_PREVIEW_PATH in app.ts (which imports this file). */
const AUDIT_PATH = "/x402/payer-audit";
const AUDIT_PREVIEW_PATH = `${AUDIT_PATH}/preview`;

export const REPORT = {
  title: REPORT_TITLE,
  version: "2026-11-25",
  window,
  scope:
    "USDC transfers of $2 or less into the 3,046 Base payTo addresses in the 2026-11-24 CDP Bazaar and PayAI directory snapshots, " +
    "read from a public Base RPC. 3,037 payTo fully read; 9 very high-volume payTo sampled at about 2%.",
  headline: [
    { metric: "transfers of $2 or less", value: 930_693 },
    { metric: "distinct paying addresses", value: 22_916 },
    { metric: "paying addresses with exactly 1 payment", value: 15_045 },
    { metric: "probe / crawler wallets found by rule (the 164-wallet list adds 15 known probe and test-buy wallets)", value: 149, usd: 1_146.19 },
    { metric: "repeat payers (3+ payments, 2+ days, a seller paid on 2+ days)", value: 2_888, usd: 9_721.44 },
    { metric: "independent operators after removing 17 large fleets", value: 779, wallets: 980, tx: 273_000, usd: 6_284 },
    { metric: "payTo with any payment", value: 2_745 },
    { metric: "payTo paid by at least one probe wallet", value: 2_572 },
    { metric: "payTo where probe payers outnumber all other payers", value: 2_353 },
    { metric: "payTo with $1+ from non-probe payers", value: 616 },
  ],
  key_findings: [
    "Most sellers' payment counts are probes: 2,353 of 2,745 paid payTo addresses had more probe payers than other payers.",
    "After removing probes, fleets and single-seller bots, 779 independent operators paid $6,284 in 30 days. Their median operator pays one seller.",
    "46 of 50 sampled settlements of representative payers were sent by Coinbase CDP facilitator relayers, 2 by Ultravioleta, 1 by OpenFacilitator, 0 by PayAI.",
    "Of the PayAI sellers studied, laevitas and wurk were the only ones whose main payers were funded from outside the seller (by the funding rule below).",
    SELLER_TOOLS_FINDING,
  ],
  categories: {
    note: "Independent operators only, by the seller's directory description (first match). A payTo selling several things is counted once.",
    columns: ["category", "operators", "sellers_paid", "usd", "sellers_in_directory"],
    rows: [
      ["crypto / DeFi", 418, 314, 1611, 1196],
      ["other (people/company enrichment, search)", 268, 148, 2385, 950],
      ["LLM inference", 93, 43, 805, 170],
      ["web scrape / search", 54, 32, 235, 134],
      ["stock quotes", 36, 27, 83, 89],
      ["social / news (X search)", 32, 10, 106, 77],
      ["weather", 18, 12, 21, 138],
      ["SEC / company filings", 9, 9, 44, 33],
      ["holidays", 1, 1, 4.5, 18],
    ],
  },
  top_payers: {
    note: "Ranked by repeat payments (2nd and later payment to the same seller). Payers 6, 11, 17, 18 and 20 pay almost only one seller and may be the seller testing.",
    columns: ["rank", "wallet", "sellers", "repeat_tx", "usd", "days", "main_sellers"],
    rows: [
      [1, "0x9d3d9410", 7, 52794, 953, 31, "blockrun, kadec0, strale"],
      [2, "0xd97c63d0", 2, 46859, 484, 31, "stableenrich, twit.sh"],
      [3, "0x30a6cb91", 10, 22017, 355, 31, "blockrun, kognai"],
      [4, "0x0000000040f4", 8, 9157, 65, 29, "exa, openwebninja"],
      [5, "0xb646a104", 17, 7250, 87, 31, "ottoai, getanyapi, blockrun"],
      [6, "0x902dcf34", 2, 6231, 137, 30, "agent402.tools"],
      [7, "0x3897f20c", 2, 5387, 31, 23, "blockscout, chainscout"],
      [8, "0xd343ec7e", 2, 2608, 14, 15, "stableenrich, exa"],
      [9, "0xc3214897", 8, 3821, 27, 7, "twit.sh, paysponge"],
      [10, "0x3a2762c5", 2, 2564, 86, 26, "stableenrich"],
      [11, "0xcc83159a", 2, 3745, 200, 25, "losbeto"],
      [12, "0x55c103ba", 8, 3676, 80, 31, "gedx402, glim, socialfetch"],
      [13, "0x5ec04c6a", 5, 3428, 154, 22, "stableenrich, Locus rentcast"],
      [14, "0x16f17c11", 11, 3425, 16, 3, "halowerk, x402atlas"],
      [15, "0x1ec34cbc", 3, 2929, 43, 30, "glim, nansen"],
      [16, "0x820e22fd", 3, 2373, 8, 19, "blockrun, exa"],
      [17, "0xf2c1e818", 3, 2469, 11, 10, "wafermap"],
      [18, "0x7be38250", 2, 2440, 7, 31, "agent402.tools"],
      [19, "0xa40fd462", 3, 2077, 294, 6, "stableenrich, Locus"],
      [20, "0x5b7acf42", 3, 1334, 6, 10, "teppi"],
    ],
  },
  sellers: {
    note:
      "Six PayAI sellers, 30 days, probe-list wallets excluded. payers_all / usd_all count every USDC transfer from those wallets, " +
      "including transfers above $2 (research r21 method); payers_le2 / usd_le2 count only transfers of $2 or less, the method of the " +
      "headline table and of /x402/payer-audit (n/a: not rebuilt that way). The last column states which funding rule matched, not a finding about the seller.",
    columns: ["seller", "payers_all", "usd_all", "payers_le2", "usd_le2", "repeat_payers", "active_last_7d", "main_price", "funding_rule_result"],
    rows: [
      ["laevitas", 27, 174.3, 26, 86.3, 12, 10, "$0.10 credit pack", "external by rule: top payer funded $7,199.92 by a batch-transfer contract; 290 payments in 31 days"],
      ["wurkapi", 48, 302, "n/a", "n/a", 19, 16, "$1", "external by rule: main payers funded by an exchange-size hot wallet (nonce 17.25M) and a $798 contract deposit"],
      ["pacta", 18, 21.11, 18, 2.11, 7, 18, "$0.02 / $0.05", "labelled self by rule: the payTo sent $98.93 to its top payer, which sent USDC to 9 other payers"],
      ["mars-base", 11, 0.3, 11, 0.3, 8, 8, "$0.005", "labelled fleet by rule: 8 payers funded by one EOA, which sent the same $0.025 to 6 of them"],
      ["nftdata", 5, 0.16, "n/a", "n/a", 4, 2, "$0.002", "external by rule: main payer funded through a 1inch swap"],
      ["agentum", 1, 15.7, "n/a", "n/a", "n/a", "n/a", "custom", "one wallet pays both domains, median gap 3 s: a pattern consistent with the seller's own integration"],
    ],
  },
  seller_tools: {
    note: "Sellers of tools for other x402 sellers: payers not on the probe list, 30 days, counted by rule.",
    rows: [
      ["x402-doctor", "3 non-probe payers, $0.79"],
      ["x402check.xyz", "1, $0.02"],
      ["x402-trust.com", "5, $0.10"],
      ["agentx.sale protocol-lint", "1, $3.58"],
      ["agentmercantile bazaar-visibility-change", "probe-list wallets only"],
      ["asterpay agent-readiness", "27 non-probe payers; 24 of them paid the same $0.7695 on one day, which the grouping rule counts as one operator"],
    ],
  },
  facilitators: {
    note: "Sender of one sampled settlement tx for each of 50 representative payers (signer table from Merit-Systems/x402scan facilitators source).",
    rows: [["Coinbase CDP", 46], ["Ultravioleta", 2], ["OpenFacilitator", 1], ["PayAI", 0]],
  },
  method: {
    labels: {
      probe: "paid 50+ sellers; or 20+ sellers at 3 or fewer payments each; or 8+ sellers at 2 or fewer each (one-pass directory probes, test buys, crawlers)",
      wide: "20-49 sellers with repeats (aggregators); not counted as users",
      single: "1 seller and 300+ payments (seller self-traffic or one integration)",
      real: "3+ payments on 2+ days with at least one seller paid on 2+ different days",
      once: "everything else",
      fleet: "wallets whose top 3 sellers are the same are grouped as one operator; 17 groups of 10+ wallets hold 1,208 wallets (e.g. 399 wallets paying ax1/clashofcoins, 345 minting on botpay)",
    },
    disclaimer: LABEL_DISCLAIMER,
    probe_list:
      "The 164-wallet probe list is the 149 wallets found by the probe rule plus 15 known ones: 5 directory probes, 4 test-buy wallets and 6 agent402 wallets.",
    excluded: "Our own wallets, 5 known probes, 4 test-buy wallets, the Relay hot wallet, and 0x26b610a0 (nonce 960k, about $100M in 7 days: an exchange).",
    limits: [
      "Counts are per payTo address; one seller can have several, so seller counts are lower.",
      "Categories are regex matches on the first directory description and can be wrong.",
      "No human browser x402 payment was found on chain; this report's own paywall is one of the few.",
      "Funding sources only cover USDC inflows inside the window.",
    ],
  },
  probe_wallets: (probeFile.wallets as { address: string; group: string; label: string }[]).map((w) => ({ address: w.address, group: w.group, label: w.label })),
};

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const num = (n: unknown) => (typeof n === "number" ? n.toLocaleString("en-US") : esc(n));
const table = (cols: string[], rows: unknown[][]) =>
  `<table><thead><tr>${cols.map((c) => `<th>${esc(c.replace(/_/g, " "))}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((v) => `<td>${num(v)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;

const page = (title: string, body: string, description = REPORT_DESCRIPTION) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;color:#1b1b1b}table{border-collapse:collapse;width:100%;margin:.6rem 0 1.4rem;font-size:14px}th,td{border:1px solid #ddd;padding:.3rem .45rem;text-align:left;vertical-align:top}th{background:#f4f4f4}code{background:#f4f4f4;padding:0 .2rem}.buy{display:inline-block;background:#0052ff;color:#fff;padding:.6rem 1rem;border-radius:6px;text-decoration:none;margin-right:.6rem}small{color:#666}</style></head><body>${body}</body></html>`;

const headline = () => table(["metric", "value", "USD"], REPORT.headline.map((h) => [h.metric, h.value, "usd" in h ? `$${num(h.usd)}` : ""]));

export function reportSummaryHtml(baseUrl: string, prices: { html: string; json: string; audit: string; auditExamplePayTo: string }) {
  return page(
    REPORT_TITLE,
    `<h1>${esc(REPORT_TITLE)}</h1>
<p><small>Version ${esc(REPORT.version)}. ${esc(REPORT.window.chain)}, blocks ${num(REPORT.window.from_block)}-${num(REPORT.window.to_block)} (2026-10-26 to 2026-11-25).</small></p>
<p>${esc(REPORT.scope)}</p>
<h2>Headline numbers (free)</h2>${headline()}
<h2>Key findings</h2><ul>${REPORT.key_findings.filter((f) => f !== SELLER_TOOLS_FINDING).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
<h2>Full report</h2>
<p>The full report adds: what independent operators buy (by category, against how many sellers offer it), the top 20 repeat payers,
case studies of six PayAI sellers with the funding trail behind their payers, seller-tool demand, facilitator shares, the labelling rules,
and the 164 probe and test-buy wallets as a table.</p>
<p><a class="buy" href="${esc(baseUrl + REPORT_FULL_PATH)}">Read the full report (${esc(prices.html)} USDC on Base)</a>
<a class="buy" href="${esc(baseUrl + REPORT_JSON_PATH)}">JSON for agents (${esc(prices.json)}, x402)</a></p>
${auditForm(baseUrl, prices.audit, prices.auditExamplePayTo)}
<p><small>${esc(LABEL_DISCLAIMER)}</small></p>
<p><small>Payment is an x402 USDC authorization on Base signed in your browser wallet (MetaMask or another EOA wallet; a Coinbase Smart Wallet works once it has been deployed by an earlier transaction, a brand-new one is refused by the facilitator). No account, no sign-up.
The payment page is the official x402 paywall: it loads the Coinbase Wallet / Base Account SDK (choosing Coinbase Wallet opens keys.coinbase.com) and reads your USDC balance from a public Base RPC; we switch the SDK's usage telemetry off.</small></p>`,
  );
}

export function reportFullHtml() {
  const r = REPORT;
  return page(
    REPORT_TITLE,
    `<h1>${esc(r.title)}</h1><p><small>Version ${esc(r.version)}. ${esc(r.scope)}</small></p>
<p><small>${esc(r.method.disclaimer)}</small></p>
<h2>Headline numbers</h2>${headline()}
<h2>Key findings</h2><ul>${r.key_findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
<h2>What independent operators buy</h2><p>${esc(r.categories.note)}</p>${table(r.categories.columns, r.categories.rows)}
<h2>Top 20 repeat payers</h2><p>${esc(r.top_payers.note)}</p>${table(r.top_payers.columns, r.top_payers.rows)}
<h2>Sellers with their own users</h2><p>${esc(r.sellers.note)}</p>${table(r.sellers.columns, r.sellers.rows)}
<h2>Tools for sellers</h2><p>${esc(r.seller_tools.note)}</p>${table(["seller", "payers"], r.seller_tools.rows)}
<h2>Who settles</h2><p>${esc(r.facilitators.note)}</p>${table(["facilitator", "sampled payers"], r.facilitators.rows)}
<h2>Method</h2><p><strong>${esc(r.method.disclaimer)}</strong></p>${table(["label", "rule"], Object.entries(r.method.labels))}<p>${esc(r.method.probe_list)}</p><p>${esc(r.method.excluded)}</p><ul>${r.method.limits.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<h2>Probe and test-buy wallets (${r.probe_wallets.length})</h2>${table(["address", "group", "label"], r.probe_wallets.map((w) => [w.address, w.group, w.label]))}`,
  );
}

/** The per-seller audit entry: a payTo field with a free preview button and a paid button, plus an example. */
export function auditForm(baseUrl: string, price: string, examplePayTo: string) {
  const q = `?payTo=${encodeURIComponent(examplePayTo)}`;
  return `<h2>Audit your own payTo</h2>
<p>Who pays your x402 endpoint: payer counts per label for free, every payer with label, funders and suggestions for ${esc(price)}.</p>
<form method="get" action="${esc(baseUrl + AUDIT_PREVIEW_PATH)}"><input name="payTo" placeholder="0x... (your Base payTo)" pattern="0x[0-9a-fA-F]{40}" required size="44">
<button type="submit">Free preview</button> <button type="submit" formaction="${esc(baseUrl + AUDIT_PATH)}">See every payer, ${esc(price)}</button></form>
<p><small>Example: <a href="${esc(baseUrl + AUDIT_PREVIEW_PATH + q)}">free preview</a> · <a href="${esc(baseUrl + AUDIT_PATH + q)}">full audit (${esc(price)})</a> for ${esc(examplePayTo)}.</small></p>`;
}

const AUDIT_TITLE = "Who really pays your x402 endpoint";

/** Free preview for a browser: counts per label, one suggestion, and the paid link. Agents get the JSON preview. */
export function auditPreviewHtml(baseUrl: string, preview: ReturnType<typeof auditPreview>, suggestion: string | undefined, price: string) {
  const paid = `${baseUrl}${AUDIT_PATH}?payTo=${encodeURIComponent(preview.pay_to)}`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return page(
    `${AUDIT_TITLE}: ${preview.pay_to}`,
    `<h1>${esc(AUDIT_TITLE)}</h1>
<p><code>${esc(preview.pay_to)}</code>, Base USDC, ${esc(preview.window.from.slice(0, 10))} to ${esc(preview.window.to.slice(0, 10))}: <b>${num(preview.payer_count)}</b> payers.</p>
${table(["label", "payers"], PAYER_LABELS.map((l) => [l, preview.by_label[l]]))}
<p>Probe share: ${pct(preview.probe_share.payers)} of payers, ${pct(preview.probe_share.usd)} of USD.</p>
${suggestion ? `<h2>Example suggestion</h2><p>${esc(suggestion)}</p>` : ""}
<p>The full audit lists every payer with label, reason, tx count, USD, funders and settling facilitator, the CDP / PayAI listing status, and all suggestions.</p>
<p><a class="buy" href="${esc(paid)}">See every payer, ${esc(price)}</a></p>
<p><small>${esc(preview.disclaimer)}</small></p>
<p><small>Payment is an x402 USDC authorization on Base signed in your browser wallet (MetaMask or another EOA wallet). No account, no sign-up. The result opens as JSON.
<a href="${esc(baseUrl + REPORT_PATH)}">Market report</a></small></p>`,
    AUDIT_TITLE,
  );
}

/** The paid audit as a page, for the paywall's fetch after a browser payment. Same data as the JSON. */
export function auditDetailHtml(baseUrl: string, d: ReturnType<typeof auditDetail>) {
  const usd = (n: number) => `$${n.toFixed(n !== 0 && n < 0.01 ? 4 : 2)}`;
  return page(
    `${AUDIT_TITLE}: ${d.pay_to}`,
    `<h1>${esc(AUDIT_TITLE)}</h1>
<p><code>${esc(d.pay_to)}</code>, Base USDC, ${esc(d.window.from.slice(0, 10))} to ${esc(d.window.to.slice(0, 10))}. Data built ${esc(d.generated_at)}.</p>
<p>Totals: ${num(d.totals.payers)} payers, ${num(d.totals.tx)} payments, ${usd(d.totals.usd)}. Listed: CDP Bazaar ${d.listing.cdp ? "yes" : "no"}, PayAI ${d.listing.payai ? "yes" : "no"}.</p>
${table(["label", "payers", "payments", "USD"], PAYER_LABELS.map((l) => [l, d.by_label_detail[l].payers, d.by_label_detail[l].tx, usd(d.by_label_detail[l].usd)]))}
<h2>Suggestions</h2><ul>${d.suggestions.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
<h2>Payers (${d.payers.length})</h2>
${table(["address", "label", "reason", "payments", "USD", "days", "funders", "facilitator"], d.payers.map((p) => [p.address, p.label, p.reason, p.tx, usd(p.usd), p.days, p.funders.map((f) => f.address).join(", "), p.facilitator ?? ""]))}
<p><small>${esc(d.disclaimer)}</small></p>
<p><small>Agents get this as JSON from the same URL. <a href="${esc(baseUrl + REPORT_PATH)}">Market report</a></small></p>`,
    AUDIT_TITLE,
  );
}

/** The audit's small page when the paywall page cannot be served (no gzip, daily limit). */
export function auditBusyHtml(baseUrl: string, reason: string, payTo: string | undefined) {
  const q = payTo ? `?payTo=${encodeURIComponent(payTo)}` : "";
  return page(
    AUDIT_TITLE,
    `<h1>Payment page unavailable</h1><p>${esc(reason)}</p>
<p><a href="${esc(baseUrl + AUDIT_PREVIEW_PATH + q)}">Free preview</a> · <a href="${esc(baseUrl + REPORT_PATH)}">Market report</a></p>`,
    AUDIT_TITLE,
  );
}

/** Served instead of the 2.5 MB paywall page when the client cannot take gzip or today's page limit is used up. */
export function reportBusyHtml(baseUrl: string, reason: string) {
  return page(
    REPORT_TITLE,
    `<h1>Payment page unavailable</h1><p>${esc(reason)}</p>
<p><a href="${esc(baseUrl + REPORT_PATH)}">Free summary</a> · <a href="${esc(baseUrl + REPORT_JSON_PATH)}">JSON version for agents (x402)</a></p>`,
  );
}

export const REPORT_JSON_DESCRIPTION =
  "x402 payment market report as JSON (Base USDC, 30 days to 2026-11-25): headline counts of probe, fleet and real payers, " +
  "categories independent operators pay for, top 20 repeat payers, seller case studies with funding trails, facilitator shares, " +
  "labelling rules and the 164-wallet probe list.";
export const REPORT_JSON_OUTPUT_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(Object.keys(REPORT).map((k) => [k, { type: Array.isArray((REPORT as Record<string, unknown>)[k]) ? "array" : typeof (REPORT as Record<string, unknown>)[k] === "string" ? "string" : "object" }])),
  required: ["title", "headline", "probe_wallets"],
};
export const REPORT_JSON_EXAMPLE_OUTPUT = { title: REPORT.title, version: REPORT.version, headline: REPORT.headline.slice(0, 3), key_findings: REPORT.key_findings.slice(0, 1), probe_wallets: REPORT.probe_wallets.slice(0, 1) };
