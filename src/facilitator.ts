// Facilitator selection: FACILITATOR=x402org | payai | cdp.
//
// cdp uses the authenticated CDP facilitator (needed to be listed in the CDP Bazaar). Its API key
// is read at runtime from AWS Secrets Manager; only the secret NAME is configuration.
import type { FacilitatorConfig } from "@x402/core/http";

export type FacilitatorKind = "x402org" | "payai" | "cdp";

export const FACILITATOR_URLS: Record<Exclude<FacilitatorKind, "cdp">, string> = {
  x402org: "https://x402.org/facilitator", // testnet only
  payai: "https://facilitator.payai.network",
};
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
export const DEFAULT_CDP_SECRET_NAME = "x402-content-site/cdp-api-key";

export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
}

/** Fetches a secret's SecretString by name. Injected in tests. */
export type SecretFetcher = (secretName: string) => Promise<string>;

export const fetchSecretFromAws: SecretFetcher = async (secretName) => {
  // The AWS SDK v3 ships with the Lambda Node 22 runtime and is left out of the bundle.
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!out.SecretString) throw new Error(`secret ${secretName} has no SecretString`);
  return out.SecretString;
};

/**
 * Secret format (JSON): {"CDP_API_KEY_ID": "...", "CDP_API_KEY_SECRET": "..."}.
 * For local runs, CDP_API_KEY_ID / CDP_API_KEY_SECRET in the environment skip Secrets Manager.
 */
export function cdpCredentialLoader(
  env: Record<string, string | undefined>,
  fetchSecret: SecretFetcher = fetchSecretFromAws,
): () => Promise<CdpCredentials> {
  let cached: Promise<CdpCredentials> | undefined;
  const load = async (): Promise<CdpCredentials> => {
    if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
      return { apiKeyId: env.CDP_API_KEY_ID, apiKeySecret: env.CDP_API_KEY_SECRET };
    }
    const name = env.CDP_SECRET_NAME?.trim() || DEFAULT_CDP_SECRET_NAME;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await fetchSecret(name));
    } catch (e) {
      throw new Error(`cannot read CDP API key from secret ${name}: ${(e as Error).message}`);
    }
    const apiKeyId = parsed.CDP_API_KEY_ID;
    const apiKeySecret = parsed.CDP_API_KEY_SECRET;
    if (typeof apiKeyId !== "string" || !apiKeyId || typeof apiKeySecret !== "string" || !apiKeySecret) {
      throw new Error(`secret ${name} must be JSON with CDP_API_KEY_ID and CDP_API_KEY_SECRET`);
    }
    return { apiKeyId, apiKeySecret };
  };
  return () => {
    // Cache per Lambda container, but retry after a failure (e.g. the secret was created later).
    cached ??= load().catch((e) => {
      cached = undefined;
      throw e;
    });
    return cached;
  };
}

/** FacilitatorConfig for the CDP facilitator with JWT auth headers built from the loaded key. */
export function cdpFacilitatorConfig(loadCredentials: () => Promise<CdpCredentials>): FacilitatorConfig {
  return {
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: async () => {
      const { apiKeyId, apiKeySecret } = await loadCredentials();
      const { createCdpAuthHeaders } = await import("@coinbase/x402");
      return createCdpAuthHeaders(apiKeyId, apiKeySecret)!();
    },
  };
}
