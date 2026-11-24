import { fileURLToPath } from "node:url";
import { Aws, CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { EndpointType, LambdaRestApi } from "aws-cdk-lib/aws-apigateway";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { Architecture, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export interface ApiStackProps extends StackProps {
  payTo: string;
  network: string;
  facilitator: "x402org" | "payai" | "cdp";
  /** Override the preset facilitator URL (x402org/payai only). */
  facilitatorUrl?: string;
  /** cdp only: name of the Secrets Manager secret holding {"CDP_API_KEY_ID","CDP_API_KEY_SECRET"}. Created by a person, not by this stack. */
  cdpSecretName: string;
  publicBaseUrl?: string;
  /** Caps concurrent invocations so a flood of free 402/400 responses cannot take the account's pool. */
  reservedConcurrency: number;
  /** Creates a monthly AWS Budgets cost alert to this address. No budget when unset. */
  budgetEmail?: string;
  budgetUsd: number;
}

/** One Lambda (Node 22, arm64) behind an API Gateway REST API (Lambda proxy integration, stage `prod`). */
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const logGroup = new LogGroup(this, "ApiLogs", { retention: RetentionDays.THREE_MONTHS });

    const fn = new NodejsFunction(this, "ApiFunction", {
      entry: fileURLToPath(new URL("../../src/lambda.ts", import.meta.url)),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      reservedConcurrentExecutions: props.reservedConcurrency,
      // Settlement waits for the facilitator to land the tx. Kept under API Gateway's 29 s integration timeout, so a
      // request that settles is never answered 504 by the gateway after the buyer was charged.
      timeout: Duration.seconds(25),
      logGroup,
      // JSON format keeps the funnel lines queryable in CloudWatch Logs Insights.
      loggingFormat: LoggingFormat.JSON,
      environment: {
        X402_PAY_TO: props.payTo,
        X402_NETWORK: props.network,
        FACILITATOR: props.facilitator,
        ...(props.facilitatorUrl ? { X402_FACILITATOR_URL: props.facilitatorUrl } : {}),
        ...(props.facilitator === "cdp" ? { CDP_SECRET_NAME: props.cdpSecretName } : {}),
        ...(props.publicBaseUrl ? { PUBLIC_BASE_URL: props.publicBaseUrl } : {}),
      },
      bundling: { format: OutputFormat.ESM, target: "node22", minify: true, sourceMap: true },
    });

    if (props.facilitator === "cdp") {
      // Read access to this one secret only (the ARN wildcard covers Secrets Manager's random suffix).
      Secret.fromSecretNameV2(this, "CdpApiKey", props.cdpSecretName).grantRead(fn);
    }

    if (props.budgetEmail) {
      // Account-wide monthly cost budget: mail at 80% and 100% of actual spend, and when the forecast passes 100%.
      const subscribers = [{ subscriptionType: "EMAIL", address: props.budgetEmail }];
      const notify = (notificationType: "ACTUAL" | "FORECASTED", threshold: number) => ({
        notification: { notificationType, comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
        subscribers,
      });
      new CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: `${this.stackName}-monthly`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: props.budgetUsd, unit: "USD" },
        },
        notificationsWithSubscribers: [notify("ACTUAL", 80), notify("ACTUAL", 100), notify("FORECASTED", 100)],
      });
    }

    // No Lambda Function URL: the only public entry is this REST API, whose stage throttling caps the request rate.
    // The integration grants lambda:InvokeFunction to apigateway.amazonaws.com with a SourceArn on this API's
    // `prod` stage only (allowTestInvoke: false drops the console test-invoke grant).
    const stageName = "prod";
    const api = new LambdaRestApi(this, "Api", {
      handler: fn,
      proxy: true, // ANY on / and /{proxy+}: GET, HEAD and query strings reach the app unchanged
      integrationOptions: { allowTestInvoke: false },
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      cloudWatchRole: false, // no account-wide API Gateway logging role
      deployOptions: { stageName, throttlingRateLimit: 10, throttlingBurstLimit: 20 },
    });

    // The app needs its public base URL (with the stage) for /openapi.json and /llms.txt. Built from the RestApi
    // id rather than api.url, because api.url references the stage, which depends on the function (a cycle).
    const apiUrl = `https://${api.restApiId}.execute-api.${this.region}.${Aws.URL_SUFFIX}/${stageName}`;
    if (!props.publicBaseUrl) fn.addEnvironment("PUBLIC_BASE_URL", apiUrl);
    new CfnOutput(this, "ApiUrl", { value: `${apiUrl}/` });
  }
}
