// Payer audit data: Base USDC payments into x402 payTo addresses over the last 30 days, each payer labelled
// probe / self / fleet / real / once, with funders, settling facilitator and directory listing. One JSON per payTo,
// read by GET /x402/payer-audit and /x402/payer-audit/preview. Merges research r12 real30.mjs (transfers into payTos),
// realpayers.mjs (per-payer aggregation, probe list) and r21 funding.mjs (who funded each payer).
//
//   npx tsx scripts/payer-audit/build.ts --rows <directory-snapshot.rows.json.gz> [--payto 0x..,0x..] \
//     [--state .payer-audit/state] [--out .payer-audit/out] [--to-block N] [--days 30] [--upload s3://bucket/prefix/]
//
// Incremental: transfers and funding already fetched are kept in --state with a block cursor; a rerun only reads new
// blocks and drops transfers older than the window. Read-only against a public RPC (BASE_RPC, default publicnode).
// --rows is a CDP Bazaar + PayAI directory snapshot: an array (optionally gzipped) of {src, host, payTo, ...}; the
// payTo list defaults to every Base payTo in it. Without --upload nothing leaves this machine.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { AUDIT_SCHEMA_VERSION, PAYER_LABELS, type AuditPayer, type AuditRecord, type LabelTotals, type PayerLabel } from "../../src/payer-audit.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RPC = process.env.BASE_RPC ?? "https://base-rpc.publicnode.com";
const CHUNK = 50_000; // blocks per eth_getLogs (split further on "too many results")
const ADDRS_PER_QUERY = 50;
const ANCHOR_STEP = 100_000; // block timestamps fetched every this many blocks and interpolated between
const BIG_USD = 2; // above this a transfer is not an x402-style payment (r12 rule)
/** Funding is looked up for at most this many payers per payTo (most payments first). shortcut: raise for big sellers. */
const MAX_FUNDED_PAYERS = 200;
/** A funder with more outgoing txs than this is an exchange or service hot wallet, never a fleet owner. */
const HOT_WALLET_NONCE = 10_000;
const FLEET_MIN = 3;

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const rowsPath = arg("rows");
if (!rowsPath) throw new Error("--rows <directory snapshot rows.json[.gz]> is required");
const stateDir = arg("state") ?? ".payer-audit/state";
const outDir = arg("out") ?? ".payer-audit/out";
const days = Number(arg("days") ?? 30);
const probeFiles = (arg("probes") ?? join(HERE, "../../data/payer-audit/probe-wallets.json")).split(",");
const facFile = arg("facilitators") ?? join(HERE, "../../data/payer-audit/facilitators.json");
const upload = arg("upload");
for (const d of [stateDir, join(stateDir, "transfers"), outDir]) mkdirSync(d, { recursive: true });

// ---------- rpc ----------
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpcBatch(calls: { method: string; params: unknown[] }[]): Promise<Json[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, ...c }))),
        signal: AbortSignal.timeout(90_000),
      });
      const j = (await res.json()) as Json[];
      if (!Array.isArray(j)) throw new Error(`rpc ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const byId = new Map(j.map((x) => [x.id, x]));
      return calls.map((_, id) => {
        const x = byId.get(id);
        if (!x || x.error) throw new Error(JSON.stringify(x?.error ?? "missing").slice(0, 200));
        return x.result;
      });
    } catch (e) {
      if (/max results|too many|limit exceeded|range/i.test((e as Error).message) || attempt >= 5) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}
const rpc = async (method: string, params: unknown[]) => (await rpcBatch([{ method, params }]))[0];
const hex = (n: number) => "0x" + n.toString(16);
const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const unpad = (t: string) => "0x" + t.slice(26);

/** USDC Transfer logs with `to` in tos, blocks f..t inclusive. */
async function transfersTo(f: number, t: number, tos: string[]): Promise<[string, string, number, number, string][]> {
  try {
    const logs: Json[] = await rpc("eth_getLogs", [{ fromBlock: hex(f), toBlock: hex(t), address: USDC, topics: [TRANSFER, null, tos.map(pad)] }]);
    return logs.map((l) => [unpad(l.topics[1]), unpad(l.topics[2]), parseInt(l.data, 16), parseInt(l.blockNumber, 16), l.transactionHash]);
  } catch (e) {
    if (t > f) {
      const m = (f + t) >> 1;
      return [...(await transfersTo(f, m, tos)), ...(await transfersTo(m + 1, t, tos))];
    }
    throw e;
  }
}

// ---------- block time ----------
const anchorsFile = join(stateDir, "anchors.json");
const anchors: Record<number, number> = existsSync(anchorsFile) ? JSON.parse(readFileSync(anchorsFile, "utf8")) : {};
async function ensureAnchors(blocks: number[]) {
  const missing = [...new Set(blocks)].filter((b) => anchors[b] === undefined);
  for (let i = 0; i < missing.length; i += 20) {
    const part = missing.slice(i, i + 20);
    const res = await rpcBatch(part.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), false] })));
    part.forEach((b, k) => (anchors[b] = parseInt(res[k].timestamp, 16)));
  }
  writeFileSync(anchorsFile, JSON.stringify(anchors));
}
function tsOf(b: number): number {
  const ks = Object.keys(anchors).map(Number).sort((x, y) => x - y);
  let lo = ks[0], hi = ks[ks.length - 1];
  for (const k of ks) {
    if (k <= b) lo = k;
    if (k >= b) { hi = k; break; }
  }
  return hi === lo ? anchors[lo] : anchors[lo] + ((anchors[hi] - anchors[lo]) * (b - lo)) / (hi - lo);
}
const dayOf = (b: number) => new Date(tsOf(b) * 1000).toISOString().slice(0, 10);

/** First block with timestamp >= ts (binary search). */
async function blockAt(ts: number, head: number): Promise<number> {
  // Base makes at least one block per 0.2 s, so the answer is within this many blocks; public RPCs refuse older ones.
  let lo = Math.max(0, head - Math.ceil((headTs - ts) / 0.2) - 1_000), hi = head;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const t = parseInt((await rpc("eth_getBlockByNumber", [hex(mid), false])).timestamp, 16);
    anchors[mid] = t;
    if (t < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------- inputs ----------
const rowsBuf = readFileSync(rowsPath);
const rows: Json[] = JSON.parse((rowsPath.endsWith(".gz") ? gunzipSync(rowsBuf) : rowsBuf).toString("utf8"));
const snapshot = arg("snapshot") ?? rowsPath.split("/").pop()!.replace(/\.rows\.json(\.gz)?$/, "");
const listing = new Map<string, { cdp: boolean; payai: boolean; hosts: Set<string>; resources: number }>();
for (const r of rows) {
  const a = String(r.payTo ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
  const o = listing.get(a) ?? { cdp: false, payai: false, hosts: new Set<string>(), resources: 0 };
  if (/cdp|coinbase/i.test(String(r.src))) o.cdp = true;
  if (/payai/i.test(String(r.src))) o.payai = true;
  if (r.host) o.hosts.add(String(r.host));
  o.resources++;
  listing.set(a, o);
}
const payTos = (arg("payto") ? arg("payto")!.split(",") : [...listing.keys()]).map((a) => a.trim().toLowerCase());
for (const a of payTos) if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`bad payTo ${a}`);

const probes = new Map<string, string>();
for (const f of probeFiles) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  for (const w of j.wallets ?? []) if (w.address) probes.set(String(w.address).toLowerCase(), w.group ?? "probe");
}
const facilitatorOf: Record<string, string> = JSON.parse(readFileSync(facFile, "utf8")).signers;

// ---------- window ----------
const head = Number(arg("to-block") ?? parseInt(await rpc("eth_blockNumber", []), 16));
const headTs = parseInt((await rpc("eth_getBlockByNumber", [hex(head), false])).timestamp, 16);
anchors[head] = headTs;
const startFile = join(stateDir, "window.json");
const prev = existsSync(startFile) ? JSON.parse(readFileSync(startFile, "utf8")) : {};
const start = prev.head === head && prev.days === days ? prev.start : await blockAt(headTs - days * 86_400, head);
writeFileSync(startFile, JSON.stringify({ head, days, start }));
const anchorBlocks = [start, head];
for (let b = Math.ceil(start / ANCHOR_STEP) * ANCHOR_STEP; b < head; b += ANCHOR_STEP) anchorBlocks.push(b);
await ensureAnchors(anchorBlocks);
console.error(`window blocks ${start}..${head} (${dayOf(start)}..${dayOf(head)}), ${payTos.length} payTo, ${probes.size} probe wallets`);

// ---------- incremental transfer pull ----------
type Transfer = [from: string, to: string, micro: number, block: number, tx: string];
const cursorFile = join(stateDir, "cursors.json");
const cursors: Record<string, number> = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")) : {};
const readLines = (file: string): Transfer[] =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

/** Brings `cursors[key]` up to head for each address, appending logs to `file(key)`. Groups addresses by start block. */
async function pull(keys: string[], cur: Record<string, number>, file: (k: string) => string, curFile: string, label: string) {
  const groups = new Map<number, string[]>();
  for (const k of keys) {
    const from = Math.max((cur[k] ?? -1) + 1, start);
    if (from > head) continue;
    groups.set(from, [...(groups.get(from) ?? []), k]);
  }
  for (const [from, ks] of groups) {
    for (let i = 0; i < ks.length; i += ADDRS_PER_QUERY) {
      const part = ks.slice(i, i + ADDRS_PER_QUERY);
      const buf = new Map<string, Transfer[]>(part.map((k) => [k, []]));
      let n = 0;
      for (let f = from; f <= head; f += CHUNK) {
        for (const t of await transfersTo(f, Math.min(head, f + CHUNK - 1), part)) buf.get(t[1])?.push(t);
        if (++n % 40 === 0) console.error(`${label} ${part.length} addr, block ${f} (${Math.round((100 * (f - from)) / (head - from + 1))}%)`);
      }
      for (const k of part) {
        const old = readLines(file(k)).filter((t) => t[3] >= start); // drop what left the window
        writeFileSync(file(k), [...old, ...buf.get(k)!].map((t) => JSON.stringify(t)).join("\n") + "\n");
        cur[k] = head;
      }
      writeFileSync(curFile, JSON.stringify(cur));
    }
  }
}
await pull(payTos, cursors, (k) => join(stateDir, "transfers", `${k}.ndjson`), cursorFile, "transfers");

// ---------- funding (inbound USDC to payers) ----------
const fundCursorFile = join(stateDir, "funding-cursors.json");
const fundCursors: Record<string, number> = existsSync(fundCursorFile) ? JSON.parse(readFileSync(fundCursorFile, "utf8")) : {};
mkdirSync(join(stateDir, "funding"), { recursive: true });
const fundFile = (a: string) => join(stateDir, "funding", `${a}.ndjson`);

interface Agg { tx: number; usd: number; days: Set<string>; first: number; last: number; sample: string; bigTx: number; bigUsd: number }
const perPayTo = new Map<string, Map<string, Agg>>();
const needFunding = new Set<string>();
for (const p of payTos) {
  const m = new Map<string, Agg>();
  for (const [from, , micro, b, h] of readLines(join(stateDir, "transfers", `${p}.ndjson`))) {
    const a = m.get(from) ?? { tx: 0, usd: 0, days: new Set(), first: b, last: b, sample: h, bigTx: 0, bigUsd: 0 };
    if (micro / 1e6 > BIG_USD) {
      a.bigTx++;
      a.bigUsd += micro / 1e6;
    } else {
      a.tx++;
      a.usd += micro / 1e6;
      a.days.add(dayOf(b));
      if (b < a.first) { a.first = b; a.sample = h; }
      a.last = Math.max(a.last, b);
    }
    m.set(from, a);
  }
  perPayTo.set(p, m);
  [...m.entries()]
    .filter(([a, g]) => g.tx >= 2 && !probes.has(a) && a !== p)
    .sort((x, y) => y[1].tx - x[1].tx)
    .slice(0, MAX_FUNDED_PAYERS)
    .forEach(([a]) => needFunding.add(a));
}
console.error(`funding lookups for ${needFunding.size} payers`);
await pull([...needFunding], fundCursors, fundFile, fundCursorFile, "funding");

// funder account kinds (nonce, contract)
const funderKind = new Map<string, string>();
async function kinds(addrs: string[]) {
  const todo = [...new Set(addrs)].filter((a) => !funderKind.has(a));
  for (let i = 0; i < todo.length; i += 10) {
    const part = todo.slice(i, i + 10);
    const res = await rpcBatch(part.flatMap((a) => [{ method: "eth_getTransactionCount", params: [a, "latest"] }, { method: "eth_getCode", params: [a, "latest"] }]));
    part.forEach((a, k) => {
      const nonce = parseInt(res[2 * k], 16);
      const code = (res[2 * k + 1] as string).length > 2;
      funderKind.set(a, code ? ((res[2 * k + 1] as string).startsWith("0xef0100") ? "eip7702" : "contract") : nonce > HOT_WALLET_NONCE ? "hot_wallet" : "eoa");
    });
  }
}

// ---------- label and write ----------
const usd = (n: number) => Number(n.toFixed(4));
const index: Record<string, { payers: number; usd: number; real: number }> = {};
for (const p of payTos) {
  const m = perPayTo.get(p)!;
  const payers = [...m.entries()].filter(([, g]) => g.tx > 0);
  const funding = new Map<string, Map<string, { usd: number; amounts: Map<number, number> }>>();
  for (const [a] of payers) {
    if (!needFunding.has(a)) continue;
    const f = new Map<string, { usd: number; amounts: Map<number, number> }>();
    for (const [from, , micro, b] of readLines(fundFile(a))) {
      // Dust (< $0.01) is mostly address-poisoning spam; it never makes a payer self or fleet.
      if (b < start || from === a || micro < 10_000) continue;
      const o = f.get(from) ?? { usd: 0, amounts: new Map() };
      o.usd += micro / 1e6;
      o.amounts.set(micro, (o.amounts.get(micro) ?? 0) + 1);
      f.set(from, o);
    }
    funding.set(a, f);
  }
  const label = new Map<string, { label: PayerLabel; reason: string }>();
  for (const [a] of payers) {
    if (probes.has(a)) label.set(a, { label: "probe", reason: `probe list (${probes.get(a)})` });
    else if (a === p) label.set(a, { label: "self", reason: "payer is the payTo" });
  }
  // self: funded by the payTo, or by a wallet already labelled self (fixpoint, so payTo -> A -> B marks both).
  for (let changed = true; changed; ) {
    changed = false;
    for (const [a] of payers) {
      if (label.has(a)) continue;
      for (const [from, o] of funding.get(a) ?? []) {
        if (o.usd < 0.01) continue;
        if (from === p || label.get(from)?.label === "self") {
          label.set(a, { label: "self", reason: from === p ? `funded $${usd(o.usd)} by the payTo` : `funded $${usd(o.usd)} by self wallet ${from}` });
          changed = true;
          break;
        }
      }
    }
  }
  // fleet: one EOA funder sent the same amount to FLEET_MIN or more payers of this payTo.
  const byFunderAmount = new Map<string, Set<string>>();
  for (const [a] of payers) {
    if (label.has(a)) continue;
    for (const [from, o] of funding.get(a) ?? []) for (const micro of o.amounts.keys()) {
      const k = `${from}|${micro}`;
      byFunderAmount.set(k, (byFunderAmount.get(k) ?? new Set()).add(a));
    }
  }
  const fleetCandidates = [...byFunderAmount.entries()].filter(([, s]) => s.size >= FLEET_MIN);
  await kinds(fleetCandidates.map(([k]) => k.split("|")[0]));
  // Once a funder is a fleet owner, every payer it funded (any amount of $0.01+) belongs to the same fleet.
  const fleetOwners = new Map<string, string>();
  for (const [k, s] of fleetCandidates) {
    const [from, micro] = k.split("|");
    if (funderKind.get(from) !== "eoa" || probes.has(from)) continue;
    fleetOwners.set(from, `funder ${from} sent the same $${usd(Number(micro) / 1e6)} to ${s.size} payers`);
  }
  for (const [a] of payers) {
    if (label.has(a)) continue;
    const owner = [...(funding.get(a)?.keys() ?? [])].find((f) => fleetOwners.has(f));
    if (owner) label.set(a, { label: "fleet", reason: fleetOwners.get(owner)! });
  }
  for (const [a, g] of payers) {
    if (label.has(a)) continue;
    label.set(a, g.tx >= 3 && g.days.size >= 2 ? { label: "real", reason: `${g.tx} payments on ${g.days.size} days` } : { label: "once", reason: `${g.tx} payments on ${g.days.size} day(s)` });
  }
  // facilitator: sender of each payer's first settlement tx
  const fac = new Map<string, string>();
  for (let i = 0; i < payers.length; i += 20) {
    const part = payers.slice(i, i + 20);
    const res = await rpcBatch(part.map(([, g]) => ({ method: "eth_getTransactionByHash", params: [g.sample] })));
    part.forEach(([a], k) => {
      const sender = String(res[k]?.from ?? "").toLowerCase();
      fac.set(a, facilitatorOf[sender] ?? (sender === a ? "direct" : `unknown:${sender}`));
    });
  }
  const topFunders = new Set<string>();
  const rowsOut: AuditPayer[] = payers
    .map(([a, g]) => {
      const funders = [...(funding.get(a) ?? [])].sort((x, y) => y[1].usd - x[1].usd).slice(0, 3);
      funders.forEach(([f]) => topFunders.add(f));
      return {
        address: a,
        ...label.get(a)!,
        tx: g.tx,
        usd: usd(g.usd),
        days: g.days.size,
        first_day: dayOf(g.first),
        last_day: dayOf(g.last),
        funders: funders.map(([f, o]) => ({ address: f, usd: usd(o.usd) })),
        facilitator: fac.get(a),
      };
    })
    .sort((x, y) => y.usd - x.usd || y.tx - x.tx);
  await kinds([...topFunders]);
  for (const r of rowsOut) for (const f of r.funders) (f as { kind?: string }).kind = f.address === p ? "pay_to" : funderKind.get(f.address);
  const totals = (rs: AuditPayer[]): LabelTotals => ({ payers: rs.length, tx: rs.reduce((s, r) => s + r.tx, 0), usd: usd(rs.reduce((s, r) => s + r.usd, 0)) });
  const facCount: Record<string, number> = {};
  for (const r of rowsOut) if (r.facilitator) facCount[r.facilitator.startsWith("unknown:") ? "unknown" : r.facilitator] = (facCount[r.facilitator.startsWith("unknown:") ? "unknown" : r.facilitator] ?? 0) + 1;
  const big = [...m.values()].reduce((s, g) => ({ tx: s.tx + g.bigTx, usd: s.usd + g.bigUsd }), { tx: 0, usd: 0 });
  const l = listing.get(p);
  const record: AuditRecord = {
    schema: AUDIT_SCHEMA_VERSION,
    pay_to: p,
    generated_at: new Date().toISOString(),
    window: { from_block: start, to_block: head, from: new Date(tsOf(start) * 1000).toISOString(), to: new Date(headTs * 1000).toISOString() },
    listing: { snapshot, cdp: !!l?.cdp, payai: !!l?.payai, hosts: [...(l?.hosts ?? [])].sort(), resources: l?.resources ?? 0 },
    totals: totals(rowsOut),
    by_label: Object.fromEntries(PAYER_LABELS.map((k) => [k, totals(rowsOut.filter((r) => r.label === k))])) as Record<PayerLabel, LabelTotals>,
    large_transfers: { tx: big.tx, usd: usd(big.usd) },
    facilitators: facCount,
    probe_list: { wallets: probes.size, source: "x402-content-site data/payer-audit/probe-wallets.json" },
    payers: rowsOut,
  };
  writeFileSync(join(outDir, `${p}.json`), JSON.stringify(record, null, 1) + "\n");
  index[p] = { payers: record.totals.payers, usd: record.totals.usd, real: record.by_label.real.payers };
  console.error(`${p} ${[...(l?.hosts ?? [])][0] ?? "?"}: ${PAYER_LABELS.map((k) => `${k} ${record.by_label[k].payers}`).join(", ")}`);
}
writeFileSync(join(outDir, "index.json"), JSON.stringify({ generated_at: new Date().toISOString(), window: { from_block: start, to_block: head }, pay_to: index }, null, 1) + "\n");

if (upload) {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(upload);
  if (!m) throw new Error("--upload must look like s3://bucket/prefix/");
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({});
  const prefix = m[2] ? m[2].replace(/\/?$/, "/") : "";
  for (const k of [...payTos, "index"]) {
    await s3.send(new PutObjectCommand({ Bucket: m[1], Key: `${prefix}${k}.json`, Body: readFileSync(join(outDir, `${k}.json`)), ContentType: "application/json" }));
  }
  console.error(`uploaded ${payTos.length + 1} objects to s3://${m[1]}/${prefix}`);
}
