import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";

const app = new App();
const ctx = (key: string) => app.node.tryGetContext(key) as string | undefined;

// Defaults are the testnet values. Mainnet values go on the command line, see README.
const payTo = ctx("payTo") ?? process.env.X402_PAY_TO;
if (!payTo) throw new Error("set the receiving address: cdk deploy -c payTo=0x...");

const network = ctx("network") ?? "eip155:84532";
// Default facilitator: x402.org on testnet, PayAI (no account or key) on Base mainnet.
const facilitator = (ctx("facilitator") ?? (network === "eip155:8453" ? "payai" : "x402org")) as "x402org" | "payai" | "cdp";
if (!["x402org", "payai", "cdp"].includes(facilitator)) throw new Error("facilitator must be cdp, payai or x402org");
if (facilitator === "x402org" && network === "eip155:8453") throw new Error("x402org is testnet only; use -c facilitator=cdp or payai");

new ApiStack(app, ctx("stackName") ?? "X402CnWorkdayApi", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: ctx("region") ?? process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1" },
  payTo,
  network,
  facilitator,
  facilitatorUrl: ctx("facilitatorUrl"),
  cdpSecretName: ctx("cdpSecretName") ?? "x402-content-site/cdp-api-key",
  reservedConcurrency: Number(ctx("reservedConcurrency") ?? 10),
  budgetEmail: ctx("budgetEmail"),
  budgetUsd: Number(ctx("budgetUsd") ?? 10),
  publicBaseUrl: ctx("publicBaseUrl"),
  noBudget: ctx("noBudget") === "true",
  // ~300k invocations/day is about $1-2 of API Gateway, Lambda, log and egress cost; see README "Cost breaker".
  breakerDailyInvocations: Number(ctx("breakerDailyInvocations") ?? 300_000),
});
