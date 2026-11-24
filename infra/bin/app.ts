import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";

const app = new App();
const ctx = (key: string) => app.node.tryGetContext(key) as string | undefined;

// Defaults are the testnet values. Mainnet values go on the command line, see README.
const payTo = ctx("payTo") ?? process.env.X402_PAY_TO;
if (!payTo) throw new Error("set the receiving address: cdk deploy -c payTo=0x...");

const network = ctx("network") ?? "eip155:84532";
const facilitator = (ctx("facilitator") ?? "x402org") as "x402org" | "payai" | "cdp";
if (!["x402org", "payai", "cdp"].includes(facilitator)) throw new Error("facilitator must be cdp, payai or x402org");
if (facilitator === "x402org" && network === "eip155:8453") throw new Error("x402org is testnet only; use -c facilitator=cdp or payai");

new ApiStack(app, ctx("stackName") ?? "X402CnWorkdayApi", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: ctx("region") ?? process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1" },
  payTo,
  network,
  facilitator,
  facilitatorUrl: ctx("facilitatorUrl"),
  cdpSecretName: ctx("cdpSecretName") ?? "x402-content-site/cdp-api-key",
  publicBaseUrl: ctx("publicBaseUrl"),
});
