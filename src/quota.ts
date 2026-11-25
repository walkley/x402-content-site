// Free daily MCP quota, counted in DynamoDB. No raw IP is stored: the key is an HMAC-SHA256 of the day and the source
// IP under a secret key from Secrets Manager, and the item holds only a counter and its TTL (two days).
import { createHmac } from "node:crypto";
import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { fetchSecretFromAws, type SecretFetcher } from "./facilitator.js";

export const FREE_PER_IP_DAILY = 20;
export const FREE_GLOBAL_DAILY = 2000;
const DAY_MS = 86_400_000;

export type QuotaResult = "ok" | "ip_limit" | "global_limit";

export interface QuotaUse {
  result: QuotaResult;
  /** This IP's counter after this call: the how-many-th free call of the day. Unset on ip_limit (nothing counted). */
  ipCalls?: number;
}

export interface FreeQuota {
  readonly perIpDaily: number;
  readonly globalDaily: number;
  /** Loads what consume needs (the HMAC key) during Lambda init. Never throws; consume retries a failed load. */
  init?(): Promise<void>;
  /** Counts one free call for this IP and for everyone, or says which limit is reached. Throws when the store fails. */
  consume(ip: string): Promise<QuotaUse>;
  /**
   * The same keyed hash the per-IP counter uses (today's UTC day and the IP), for log lines that link one caller's
   * requests. Undefined while the HMAC key is not loaded; never throws and never reads the key itself.
   */
  ipHash?(ip: string): string | undefined;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Without the key, the 2^32 IPv4 addresses cannot be tried against a stored hash. */
export const ipHash = (ip: string, day: string, hmacKey: string) =>
  createHmac("sha256", hmacKey).update(`${day}|${ip}`).digest("hex").slice(0, 32);
export const ipKey = (ip: string, day: string, hmacKey: string) => `ip#${day}#${ipHash(ip, day, hmacKey)}`;
export const globalKey = (day: string) => `global#${day}`;

type Sender = { send(cmd: UpdateItemCommand): Promise<unknown> };

/** Adds 1 to counter `key` unless it has reached limit: the new count, or false when it has. */
async function incrementCounter(db: Sender, table: string, key: string, limit: number, expiresAt: number): Promise<number | false> {
  try {
    const out = await db.send(
      new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: key } },
        UpdateExpression: "SET expires_at = :exp ADD n :one",
        ConditionExpression: "attribute_not_exists(n) OR n < :limit",
        ExpressionAttributeValues: { ":one": { N: "1" }, ":exp": { N: String(expiresAt) }, ":limit": { N: String(limit) } },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number((out as { Attributes?: { n?: { N?: string } } } | undefined)?.Attributes?.n?.N ?? Number.NaN);
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException || (e as Error).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** Browser paywall pages (about 0.68 MB gzipped each) rendered per UTC day for everyone together. */
export const PAYWALL_DAILY = 2000;

/** One global counter per UTC day in the quota table (key `<name>#<day>`). take() is false once the day's limit is reached. */
export interface DailyCap {
  readonly limit: number;
  take(): Promise<boolean>;
}

export class DynamoDailyCap implements DailyCap {
  constructor(
    private readonly db: Sender,
    private readonly table: string,
    private readonly name: string,
    readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}
  async take(): Promise<boolean> {
    const now = this.now();
    const expiresAt = (Math.floor(now / DAY_MS) + 2) * 86_400;
    return (await incrementCounter(this.db, this.table, `${this.name}#${utcDay(now)}`, this.limit, expiresAt)) !== false;
  }
}

/** The paywall page cap; undefined without QUOTA_TABLE (local runs: no cap). */
export function paywallCapFromEnv(env: Record<string, string | undefined>): DailyCap | undefined {
  const table = env.QUOTA_TABLE?.trim();
  if (!table) return undefined;
  const db = new DynamoDBClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 1_500 } });
  return new DynamoDailyCap(db, table, "paywall", limitFromEnv(env.PAYWALL_DAILY, PAYWALL_DAILY, "PAYWALL_DAILY"));
}

export class DynamoQuota implements FreeQuota {
  /** Set once the key has been read, so ipHash can run without waiting or retrying the read. */
  private loadedKey?: string;

  constructor(
    private readonly db: Sender,
    private readonly table: string,
    /** Returns the HMAC key; rejects when it cannot be read (the call then fails closed). */
    private readonly hmacKey: () => Promise<string>,
    readonly perIpDaily = FREE_PER_IP_DAILY,
    readonly globalDaily = FREE_GLOBAL_DAILY,
    private readonly now: () => number = Date.now,
  ) {}

  private increment(key: string, limit: number, expiresAt: number): Promise<number | false> {
    return incrementCounter(this.db, this.table, key, limit, expiresAt);
  }

  private async key(): Promise<string> {
    return (this.loadedKey = await this.hmacKey());
  }

  ipHash(ip: string): string | undefined {
    return this.loadedKey === undefined ? undefined : ipHash(ip, utcDay(this.now()), this.loadedKey);
  }

  async init(): Promise<void> {
    try {
      await this.key();
    } catch (e) {
      console.warn(JSON.stringify({ ts: new Date().toISOString(), type: "quota_key_load_failed", message: (e as Error).message }));
    }
  }

  async consume(ip: string): Promise<QuotaUse> {
    const key = await this.key();
    const now = this.now();
    const day = utcDay(now);
    const expiresAt = (Math.floor(now / DAY_MS) + 2) * 86_400; // TTL in epoch seconds: end of the next UTC day
    // Per-IP first, so one address cannot use up the global cap. An IP call that then hits the global cap still
    // counts against that IP; it gets the paid hint either way.
    const ipCalls = await this.increment(ipKey(ip, day, key), this.perIpDaily, expiresAt);
    if (ipCalls === false) return { result: "ip_limit" };
    const counted = Number.isFinite(ipCalls) ? { ipCalls } : {};
    if ((await this.increment(globalKey(day), this.globalDaily, expiresAt)) === false) return { result: "global_limit", ...counted };
    return { result: "ok", ...counted };
  }
}

type Env = Record<string, string | undefined>;

function limitFromEnv(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${value}`);
  return n;
}

/**
 * Reads the HMAC key (the whole SecretString, at least 32 characters) once per container. A failed read is not cached,
 * so the next call retries it; until then calls fail closed.
 */
export function hmacKeyLoader(secretId: string | undefined, fetchSecret: SecretFetcher = fetchSecretFromAws): () => Promise<string> {
  let cached: Promise<string> | undefined;
  const load = async () => {
    if (!secretId) throw new Error("QUOTA_HMAC_SECRET_ARN is not set");
    const key = await fetchSecret(secretId);
    if (key.length < 32) throw new Error("quota HMAC key is shorter than 32 characters");
    return key;
  };
  return () =>
    (cached ??= load().catch((e) => {
      cached = undefined;
      throw e;
    }));
}

/** No QUOTA_TABLE: no free tier, every MCP tool call gets the paid hint. */
export function quotaFromEnv(env: Env, fetchSecret?: SecretFetcher): FreeQuota | undefined {
  const table = env.QUOTA_TABLE?.trim();
  if (!table) return undefined;
  // Short timeouts: a slow store ends in the paid hint, not in a request that waits for the Lambda timeout.
  const db = new DynamoDBClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 1_500 } });
  return new DynamoQuota(
    db,
    table,
    hmacKeyLoader(env.QUOTA_HMAC_SECRET_ARN?.trim(), fetchSecret),
    limitFromEnv(env.FREE_PER_IP_DAILY, FREE_PER_IP_DAILY, "FREE_PER_IP_DAILY"),
    limitFromEnv(env.FREE_GLOBAL_DAILY, FREE_GLOBAL_DAILY, "FREE_GLOBAL_DAILY"),
  );
}
