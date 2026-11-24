// Base Sepolia end-to-end check: pays the local (or BASE_URL) server with a test buyer wallet.
//
//   BUYER_KEY_FILE=/tmp/x402-buyer.key BASE_URL=http://localhost:8787 npm run e2e:sepolia
//
// Arguments are GET paths, or "POST <path> <json body>" for a POST route.
// The private key is read from a file outside the repo and is never printed.
import { readFileSync } from "node:fs";
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const keyFile = process.env.BUYER_KEY_FILE ?? "/tmp/x402-buyer.key";
const baseUrl = process.env.BASE_URL ?? "http://localhost:8787";
const paths = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "/cn/workday?date=2026-02-14",
      "/cn/business-days?from=2026-09-28&to=2026-10-11",
      "/deps/advisories?ecosystem=npm&name=lodash&version=4.17.20",
      'POST /deps/advisories/batch {"packages":[{"ecosystem":"npm","name":"lodash","version":"4.17.20"},{"ecosystem":"PyPI","name":"jinja2","version":"2.10"}]}',
    ];

const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as `0x${string}`);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const balance = () => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

console.log(`buyer ${account.address} USDC before: ${formatUnits(await balance(), 6)}`);
const client = new x402Client().register("eip155:84532", new ExactEvmScheme(toClientEvmSigner(account, publicClient)));
const pay = wrapFetchWithPayment(fetch, client);

let failed = false;
for (const arg of paths) {
  const [, method = "GET", path, body] = /^(?:(POST) )?(\S+)(?: (.+))?$/.exec(arg) ?? [];
  const headers: Record<string, string> = { "user-agent": "x402-e2e-sepolia/1.0", ...(body ? { "content-type": "application/json" } : {}) };
  const res = await pay(`${baseUrl}${path}`, { method, headers, body });
  const header = res.headers.get("payment-response");
  const settle = header ? decodePaymentResponseHeader(header) : undefined;
  const text = await res.text();
  console.log(JSON.stringify({ method, path, status: res.status, payment_response: settle, body: text.slice(0, 300) }));
  if (res.status !== 200 || !settle?.success) failed = true;
}
console.log(`buyer USDC after: ${formatUnits(await balance(), 6)}`);
process.exit(failed ? 1 : 0);
