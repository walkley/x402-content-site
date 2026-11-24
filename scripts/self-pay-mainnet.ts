// One-time Base mainnet self-payment: pays GET /cn/workday once from the buyer wallet in
// AWS Secrets Manager (x402/buyer-wallet), so the endpoint gets a real settled payment.
//
//   X402_BASE_URL=https://<api-id>.execute-api.ap-northeast-1.amazonaws.com npm run self-pay:mainnet -- [YYYY-MM-DD]
//
// X402_BASE_URL is the stack output ApiUrl (no trailing slash needed).
// Needs secretsmanager:GetSecretValue on x402/buyer-wallet (ap-northeast-1). The private key is
// read into memory only and never printed. If the wallet holds less than 0.003 USDC the script
// prints the address and balance and exits 2 without sending any request for payment.
// The buyer address is listed in known-addresses.json (role self_pay), so this is not external revenue.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const NETWORK = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base mainnet USDC, 6 decimals
const PAY_TO = "0xAa9BC6380C65fe6d99D0805837AE460D73A91CB2"; // our receiving wallet
const MIN_BALANCE = 3000n; // 0.003 USDC, the /cn/workday price
const MAX_AMOUNT = 10000n; // hard cap per payment: 0.01 USDC
const BASE_URL = process.env.X402_BASE_URL?.trim().replace(/\/$/, "");
if (!BASE_URL || !/^https:\/\//.test(BASE_URL)) throw new Error("set X402_BASE_URL to the stack output ApiUrl (https://...)");

const date = process.argv[2] ?? "2026-10-01";
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD, got ${date}`);

const sm = new SecretsManagerClient({ region: "ap-northeast-1" });
const secretString = (await sm.send(new GetSecretValueCommand({ SecretId: "x402/buyer-wallet" }))).SecretString ?? "{}";
let secret: { privateKey?: unknown; address?: unknown };
try {
  secret = JSON.parse(secretString) ?? {};
} catch {
  // Fixed message: JSON.parse's own error quotes the start of the input, which could be part of a key.
  throw new Error("secret x402/buyer-wallet is not valid JSON");
}
// Shape check only; the key itself is never printed.
if (!/^0x[0-9a-fA-F]{64}$/.test(String(secret.privateKey)) || !/^0x[0-9a-fA-F]{40}$/.test(String(secret.address))) {
  throw new Error('secret x402/buyer-wallet must be JSON {"privateKey":"0x<64 hex>","address":"0x<40 hex>"}');
}
const account = privateKeyToAccount(secret.privateKey as `0x${string}`);
if (account.address !== secret.address) throw new Error("secret privateKey does not derive the stored address");

const publicClient = createPublicClient({ chain: base, transport: http() });
const balance = () =>
  publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

const before = await balance();
console.log(`buyer ${account.address}`);
console.log(`USDC balance on Base: ${formatUnits(before, 6)}`);
if (before < MIN_BALANCE) {
  console.log(`balance below ${formatUnits(MIN_BALANCE, 6)} USDC; fund this address with Base USDC and rerun. No payment sent.`);
  process.exit(2);
}

// Only the exact quote we expect is payable: mainnet USDC, our payTo, at most 0.01 USDC.
// An empty list makes the client throw before it signs anything.
const client = new x402Client()
  .register(NETWORK, new ExactEvmScheme(toClientEvmSigner(account, publicClient)))
  .setSpendControls({ maxAmountPerPayment: "$0.01" })
  .registerPolicy((_version, reqs) => {
    const ok = reqs.filter(
      (r) =>
        r.network === NETWORK &&
        getAddress(r.asset) === USDC &&
        getAddress(r.payTo) === PAY_TO &&
        BigInt(r.amount) <= MAX_AMOUNT &&
        BigInt(r.amount) <= before,
    );
    for (const r of reqs) if (!ok.includes(r)) console.log(`refusing quote: ${JSON.stringify(r)}`);
    return ok;
  });
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay(`${BASE_URL}/cn/workday?date=${date}`, { headers: { "user-agent": "x402-self-pay-mainnet/1.0" } });
const header = res.headers.get("payment-response");
const settle = header ? decodePaymentResponseHeader(header) : undefined;
console.log(`status: ${res.status}`);
console.log(`body: ${(await res.text()).slice(0, 300)}`);
if (settle?.transaction) {
  console.log(`tx: ${settle.transaction}`);
  console.log(`basescan: https://basescan.org/tx/${settle.transaction}`);
}
console.log(`settle success: ${settle?.success ?? false}`);
console.log(`USDC balance after: ${formatUnits(await balance(), 6)}`);
process.exit(res.status === 200 && settle?.success ? 0 : 1);
