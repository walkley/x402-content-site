import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cdpCredentialLoader, cdpFacilitatorConfig, DEFAULT_CDP_SECRET_NAME } from "../src/facilitator.js";

// A throwaway Ed25519 key in CDP's format: base64(32-byte seed || 32-byte public key).
function fakeCdpSecret(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Buffer.concat([seed, pub]).toString("base64");
}

const SECRET_JSON = JSON.stringify({ CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: fakeCdpSecret() });

describe("cdpCredentialLoader", () => {
  it("reads the default secret name once and caches it", async () => {
    const fetchSecret = vi.fn(async () => SECRET_JSON);
    const load = cdpCredentialLoader({}, fetchSecret);
    expect((await load()).apiKeyId).toBe("test-key-id");
    await load();
    expect(fetchSecret).toHaveBeenCalledTimes(1);
    expect(fetchSecret).toHaveBeenCalledWith(DEFAULT_CDP_SECRET_NAME);
  });

  it("uses CDP_SECRET_NAME, and env credentials skip Secrets Manager", async () => {
    const fetchSecret = vi.fn(async () => SECRET_JSON);
    await cdpCredentialLoader({ CDP_SECRET_NAME: "other/name" }, fetchSecret)();
    expect(fetchSecret).toHaveBeenCalledWith("other/name");
    const noFetch = vi.fn(async () => SECRET_JSON);
    const creds = await cdpCredentialLoader({ CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "s" }, noFetch)();
    expect(creds).toEqual({ apiKeyId: "id", apiKeySecret: "s" });
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("fails clearly on a missing or malformed secret, and retries next time", async () => {
    const fetchSecret = vi
      .fn<(name: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("ResourceNotFoundException"))
      .mockResolvedValueOnce(JSON.stringify({ CDP_API_KEY_ID: "only-id" }))
      .mockResolvedValueOnce(SECRET_JSON);
    const load = cdpCredentialLoader({}, fetchSecret);
    await expect(load()).rejects.toThrow(/ResourceNotFoundException/);
    await expect(load()).rejects.toThrow(/CDP_API_KEY_SECRET/);
    expect((await load()).apiKeyId).toBe("test-key-id");
  });
});

describe("cdpFacilitatorConfig", () => {
  it("builds Bearer JWT headers for verify, settle and supported", async () => {
    const cfg = cdpFacilitatorConfig(cdpCredentialLoader({}, async () => SECRET_JSON));
    expect(cfg.url).toBe("https://api.cdp.coinbase.com/platform/v2/x402");
    const headers = (await cfg.createAuthHeaders!()) as Record<string, Record<string, string>>;
    for (const op of ["verify", "settle", "supported"]) {
      expect(headers[op].Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    }
    // The JWT names the key id, never the secret.
    const payload = JSON.parse(Buffer.from(headers.verify.Authorization.split(".")[1], "base64url").toString());
    expect(payload.sub).toBe("test-key-id");
    expect(JSON.stringify(headers)).not.toContain(JSON.parse(SECRET_JSON).CDP_API_KEY_SECRET);
  });
});
