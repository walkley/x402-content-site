import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Code, Function as LambdaFunction, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Topic } from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
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
  /** Base mainnet without budgetEmail is refused unless this is true (an explicit "no email alert" choice). */
  noBudget?: boolean;
  /**
   * Cost breaker: when the API function's invocations in one UTC day exceed this, its reserved concurrency is set
   * to 0, which stops Lambda, log and most request cost until a person restores it. Default in infra/bin/app.ts.
   */
  breakerDailyInvocations: number;
}

export const MAINNET_NETWORK = "eip155:8453";

/**
 * Breaker handler (inline, CommonJS, AWS SDK v3 from the Node 22 runtime). It only ever sets the API function's
 * reserved concurrency to 0; restoring it is a manual step (README "Cost breaker").
 */
export const BREAKER_CODE = `const { LambdaClient, PutFunctionConcurrencyCommand } = require("@aws-sdk/client-lambda");
const lambda = new LambdaClient({});
exports.handler = async (event) => {
  const alarms = (event.Records || []).map((r) => { try { return JSON.parse(r.Sns.Message); } catch { return {}; } });
  if (!alarms.some((a) => a.NewStateValue === "ALARM")) return { skipped: true };
  await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: process.env.TARGET_FUNCTION, ReservedConcurrentExecutions: 0 }));
  console.log(JSON.stringify({ type: "cost_breaker", action: "reserved_concurrency_0", target: process.env.TARGET_FUNCTION, alarms: alarms.map((a) => a.AlarmName) }));
  return { tripped: true };
};
`;

/** One Lambda (Node 22, arm64) behind an API Gateway HTTP API (Lambda proxy integration, `$default` stage). */
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    if (props.network === MAINNET_NETWORK && !props.budgetEmail && !props.noBudget) {
      throw new Error("Base mainnet needs a cost alert: pass -c budgetEmail=you@example.com, or -c noBudget=true to deploy without one");
    }
    if (!Number.isInteger(props.breakerDailyInvocations) || props.breakerDailyInvocations < 1) {
      throw new Error(`breakerDailyInvocations must be a positive integer, got ${props.breakerDailyInvocations}`);
    }

    const logGroup = new LogGroup(this, "ApiLogs", { retention: RetentionDays.THREE_MONTHS });

    const fn = new NodejsFunction(this, "ApiFunction", {
      entry: fileURLToPath(new URL("../../src/lambda.ts", import.meta.url)),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      reservedConcurrentExecutions: props.reservedConcurrency,
      // Settlement waits for the facilitator to land the tx. Kept under the HTTP API's 30 s integration timeout, so a
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

    // No Lambda Function URL: the only public entry is this HTTP API. Its `$default` stage has no path prefix, so
    // /openapi.json, /.well-known/openapi.json and /llms.txt sit at the origin root where discovery tools look.
    // The `$default` route sends every method and path (including /) to the function, payload format 2.0.
    // HttpLambdaIntegration grants lambda:InvokeFunction to apigateway.amazonaws.com with a SourceArn on this API only.
    // Its integration timeout (30 s, the HTTP API default and maximum) stays above the function's 25 s.
    const api = new HttpApi(this, "HttpApi", {
      defaultIntegration: new HttpLambdaIntegration("Lambda", fn),
      createDefaultStage: false, // created below with throttling, which HttpApi's own default stage cannot set
    });
    new HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
    });

    // The app uses its public base URL in /openapi.json, /llms.txt, the 402 body and iconUrl.
    if (!props.publicBaseUrl) fn.addEnvironment("PUBLIC_BASE_URL", api.apiEndpoint);
    new CfnOutput(this, "ApiUrl", { value: `${api.apiEndpoint}/` });

    // Cost breaker, no email needed: CloudWatch alarm on the day's invocations -> SNS -> breaker Lambda ->
    // PutFunctionConcurrency(0) on the API function. Requests then get 5xx from API Gateway without running Lambda.
    // The topic has no extra policy (same-account CloudWatch publishes under the default one) and one subscription.
    const breakerLogs = new LogGroup(this, "BreakerLogs", { retention: RetentionDays.THREE_MONTHS });
    // Own role instead of the default AWSLambdaBasicExecutionRole: logs only to its own group, one action on one function.
    const breakerRole = new Role(this, "BreakerRole", { assumedBy: new ServicePrincipal("lambda.amazonaws.com") });
    breakerLogs.grantWrite(breakerRole);
    breakerRole.addToPolicy(new PolicyStatement({ actions: ["lambda:PutFunctionConcurrency"], resources: [fn.functionArn] }));
    const breaker = new LambdaFunction(this, "BreakerFunction", {
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      code: Code.fromInline(BREAKER_CODE),
      role: breakerRole,
      logGroup: breakerLogs,
      memorySize: 128,
      timeout: Duration.seconds(30),
      environment: { TARGET_FUNCTION: fn.functionName },
    });
    const topic = new Topic(this, "BreakerTopic");
    topic.addSubscription(new LambdaSubscription(breaker));
    const alarm = new Alarm(this, "DailyInvocationsAlarm", {
      alarmDescription: `API function invocations in one UTC day > ${props.breakerDailyInvocations}: reserved concurrency set to 0 (README "Cost breaker").`,
      metric: fn.metricInvocations({ period: Duration.days(1), statistic: "Sum" }),
      threshold: props.breakerDailyInvocations,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new SnsAction(topic));
    new CfnOutput(this, "ApiFunctionName", { value: fn.functionName });
  }
}
