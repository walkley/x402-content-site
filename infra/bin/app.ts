import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";

const app = new App();
const ctx = (key: string) => app.node.tryGetContext(key) as string | undefined;

// Defaults are the testnet values. Mainnet values go on the command line, see README.
const payTo = ctx("payTo") ?? process.env.X402_PAY_TO;
if (!payTo) throw new Error("set the receiving address: cdk deploy -c payTo=0x...");

new ApiStack(app, ctx("stackName") ?? "X402CnWorkdayApi", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: ctx("region") ?? process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1" },
  payTo,
  network: ctx("network") ?? "eip155:84532",
  facilitatorUrl: ctx("facilitatorUrl") ?? "https://x402.org/facilitator",
  publicBaseUrl: ctx("publicBaseUrl"),
});
