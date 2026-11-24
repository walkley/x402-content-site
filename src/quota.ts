// Free daily MCP quota, counted in DynamoDB. Stores no personal data: the key is a hash of the source IP and the day,
// the item holds only a counter and its TTL.
import { createHash } from "node:crypto";
import { ConditionalCheckFailedException, DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

export const FREE_PER_IP_DAILY = 20;
export const FREE_GLOBAL_DAILY = 2000;
const DAY_MS = 86_400_000;

export type QuotaResult = "ok" | "ip_limit" | "global_limit";

export interface FreeQuota {
  readonly perIpDaily: number;
  readonly globalDaily: number;
  /** Counts one free call for this IP and for everyone, or says which limit is reached. Throws when the store fails. */
  consume(ip: string): Promise<QuotaResult>;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * shortcut: an unsalted hash of an IPv4 address can be reversed by trying all 2^32 addresses; the item is deleted by
 * TTL two days later and holds nothing else. Upgrade to an HMAC with a secret key if the counts must outlive that.
 */
export const ipKey = (ip: string, day: string) => `ip#${day}#${createHash("sha256").update(`${day}|${ip}`).digest("hex").slice(0, 32)}`;
export const globalKey = (day: string) => `global#${day}`;

type Sender = { send(cmd: UpdateItemCommand): Promise<unknown> };

export class DynamoQuota implements FreeQuota {
  constructor(
    private readonly db: Sender,
    private readonly table: string,
    readonly perIpDaily = FREE_PER_IP_DAILY,
    readonly globalDaily = FREE_GLOBAL_DAILY,
    private readonly now: () => number = Date.now,
  ) {}

  /** Adds 1 unless the counter has reached limit. false when it has. */
  private async increment(key: string, limit: number, expiresAt: number): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: { pk: { S: key } },
          UpdateExpression: "SET expires_at = :exp ADD n :one",
          ConditionExpression: "attribute_not_exists(n) OR n < :limit",
          ExpressionAttributeValues: { ":one": { N: "1" }, ":exp": { N: String(expiresAt) }, ":limit": { N: String(limit) } },
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException || (e as Error).name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }

  async consume(ip: string): Promise<QuotaResult> {
    const now = this.now();
    const day = utcDay(now);
    const expiresAt = (Math.floor(now / DAY_MS) + 2) * 86_400; // TTL in epoch seconds: end of the next UTC day
    // Per-IP first, so one address cannot use up the global cap. An IP call that then hits the global cap still
    // counts against that IP; it gets the paid hint either way.
    if (!(await this.increment(ipKey(ip, day), this.perIpDaily, expiresAt))) return "ip_limit";
    if (!(await this.increment(globalKey(day), this.globalDaily, expiresAt))) return "global_limit";
    return "ok";
  }
}

type Env = Record<string, string | undefined>;

function limitFromEnv(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${value}`);
  return n;
}

/** No QUOTA_TABLE: no free tier, every MCP tool call gets the paid hint. */
export function quotaFromEnv(env: Env): FreeQuota | undefined {
  const table = env.QUOTA_TABLE?.trim();
  if (!table) return undefined;
  // Short timeouts: a slow store ends in the paid hint, not in a request that waits for the Lambda timeout.
  const db = new DynamoDBClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 1_500 } });
  return new DynamoQuota(
    db,
    table,
    limitFromEnv(env.FREE_PER_IP_DAILY, FREE_PER_IP_DAILY, "FREE_PER_IP_DAILY"),
    limitFromEnv(env.FREE_GLOBAL_DAILY, FREE_GLOBAL_DAILY, "FREE_GLOBAL_DAILY"),
  );
}
