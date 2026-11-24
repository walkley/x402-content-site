import { fileURLToPath } from "node:url";
import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import { CfnIntegration, CfnRoute, CfnStage, HttpApi, HttpStage, LogGroupLogDestination } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
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
   * Cost breaker: when the API function's invocations in the last 24 hours exceed this, its reserved concurrency is set
   * to 0, which stops Lambda, log and most request cost until a person restores it. Default in infra/bin/app.ts.
   */
  breakerDailyInvocations: number;
  /** Free MCP tool calls per source IP per UTC day (0 turns the free tier off). Default in infra/bin/app.ts. */
  freePerIpDaily: number;
  /** Free MCP tool calls per UTC day for everyone together; past it every call gets the paid hint. */
  freeGlobalDaily: number;
}

export const MAINNET_NETWORK = "eip155:8453";

/** Stage default route throttle: every route without its own settings, which includes all paid routes. */
export const DEFAULT_THROTTLE = { rateLimit: 10, burstLimit: 20 };
/** The free MCP endpoint's own route and throttle, so /mcp traffic does not use the paid routes' 10 rps. */
export const MCP_ROUTE_KEY = "POST /mcp";
/** The paid MCP endpoint (payment links only, no free quota): its own route with the same throttle as /mcp. */
export const PAID_MCP_ROUTE_KEY = "POST /paid/mcp";
export const MCP_THROTTLE = { rateLimit: 2, burstLimit: 5 };
/**
 * SEC routes. sec.gov's fair-access limit is 10 requests per second. Each paid endpoint has its own GET route with its
 * own 1 rps / burst 1 throttle, so a directory that probes both in the same second (x402scan does) gets a 402 from each
 * instead of a 429 for one of them. Everything else under /sec (HEAD and other methods, other paths, a trailing
 * slash) lands on the ANY /sec/{proxy+} fallback, also 1 rps / burst 1, and never on $default's 10 rps.
 *
 * Worst case SEC calls per second for the whole API, whatever the number of containers (each container also paces its
 * own calls at 4/s, which alone would allow 10 x 4 = 40):
 *   GET /sec/insider-trades  1 req/s x 6 (src/sec.ts MAX_SEC_CALLS_PER_REQUEST: tickers + submissions + 4 Form 4) = 6
 *   GET /sec/latest-filings  1 req/s x 2 (src/sec.ts LATEST_FILINGS_MAX_SEC_CALLS: tickers + submissions)        = 2
 *   ANY /sec/{proxy+}        0: the app refuses it before payment and before any SEC call                         = 0
 *   total 8 <= 10. Both per-request caps are enforced by SecClient's call budget, not only counted.
 *
 * Why the fallback carries no SEC call: API Gateway matches routes on the decoded path, so /sec/insider%2Dtrades
 * matches GET /sec/insider-trades and counts against that route's own throttle; HEAD does not match a GET route.
 * The app then serves only GET whose raw path is one of the two literal paths AND whose API Gateway routeKey is that
 * path's own GET route (src/app.ts); anything else, including any request that arrived on the fallback, gets a free
 * 404/405 before payment is verified. So no spelling or method reaches SEC through a throttle above 1 rps per route.
 */
export const SEC_INSIDER_ROUTE_KEY = "GET /sec/insider-trades";
export const SEC_FILINGS_ROUTE_KEY = "GET /sec/latest-filings";
export const SEC_ROUTE_KEY = "ANY /sec/{proxy+}";
export const SEC_THROTTLE = { rateLimit: 1, burstLimit: 1 };

/** HTTP API access log line ($context variables; the query string is not logged). */
export const ACCESS_LOG_FIELDS = {
  requestId: "$context.requestId",
  requestTime: "$context.requestTime",
  ip: "$context.identity.sourceIp",
  method: "$context.httpMethod",
  path: "$context.path",
  routeKey: "$context.routeKey",
  status: "$context.status",
  responseLength: "$context.responseLength",
  responseLatency: "$context.responseLatency",
  integrationStatus: "$context.integrationStatus",
  integrationLatency: "$context.integrationLatency",
  integrationErrorMessage: "$context.integrationErrorMessage",
  integrationError: "$context.integration.error",
};

/**
 * Breaker handler (inline, CommonJS, AWS SDK v3 from the Node 22 runtime). It only ever sets the API function's
 * reserved concurrency to 0; restoring it is a manual step (README "Cost breaker").
 */
export const BREAKER_CODE = `const { LambdaClient, PutFunctionConcurrencyCommand } = require("@aws-sdk/client-lambda");
const lambda = new LambdaClient({});
exports.handler = async (event) => {
  const alarms = (event.Records || []).map((r) => { try { return JSON.parse(r.Sns.Message); } catch { return {}; } });
  // Only our own alarm's transition into ALARM trips the breaker.
  if (!alarms.some((a) => a.AlarmName === process.env.ALARM_NAME && a.NewStateValue === "ALARM")) return { skipped: true };
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
    for (const k of ["freePerIpDaily", "freeGlobalDaily"] as const) {
      if (!Number.isInteger(props[k]) || props[k] < 0) throw new Error(`${k} must be a non-negative integer, got ${props[k]}`);
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

    // Free MCP quota counters: one item per (IP hash, UTC day) and one per day overall, deleted by TTL. Holds counts
    // only, so the table is destroyed with the stack. The API function may only UpdateItem on this table.
    const quotaTable = new Table(this, "FreeQuotaTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires_at",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    quotaTable.grant(fn, "dynamodb:UpdateItem");
    fn.addEnvironment("QUOTA_TABLE", quotaTable.tableName);
    // HMAC key for the per-IP counter keys, generated by Secrets Manager (never in the template or code). Only the API
    // function may read it; it reads it once at cold start. Destroyed with the stack: it only protects 2-day counters.
    const quotaKey = new Secret(this, "QuotaHmacKey", {
      description: "HMAC-SHA256 key for the free MCP quota counter keys (x402-content-site)",
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    quotaKey.grantRead(fn);
    fn.addEnvironment("QUOTA_HMAC_SECRET_ARN", quotaKey.secretArn);
    fn.addEnvironment("FREE_PER_IP_DAILY", String(props.freePerIpDaily));
    fn.addEnvironment("FREE_GLOBAL_DAILY", String(props.freeGlobalDaily));

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
    // POST /mcp, POST /paid/mcp and the SEC routes each get their own route, pointed at the same integration, so that each can have its
    // own throttle. L1 routes: binding the L2 integration to another route would add another invoke permission, and the
    // existing one already covers every route of this API (SourceArn api-id/*/*). OPTIONS/GET/DELETE stay on $default.
    const integration = api.node.findAll().find((c): c is CfnIntegration => c instanceof CfnIntegration);
    if (!integration) throw new Error("HttpApi default integration not found");
    const target = `integrations/${integration.ref}`;
    const mcpRoute = new CfnRoute(this, "McpRoute", { apiId: api.apiId, routeKey: MCP_ROUTE_KEY, target });
    const paidMcpRoute = new CfnRoute(this, "PaidMcpRoute", { apiId: api.apiId, routeKey: PAID_MCP_ROUTE_KEY, target });
    const secRoute = new CfnRoute(this, "SecRoute", { apiId: api.apiId, routeKey: SEC_ROUTE_KEY, target });
    const secInsiderRoute = new CfnRoute(this, "SecInsiderRoute", { apiId: api.apiId, routeKey: SEC_INSIDER_ROUTE_KEY, target });
    const secFilingsRoute = new CfnRoute(this, "SecFilingsRoute", { apiId: api.apiId, routeKey: SEC_FILINGS_ROUTE_KEY, target });
    const stage = new HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: DEFAULT_THROTTLE,
      // One JSON line per request, so 4xx/5xx can be listed by status without matching Lambda logs (R10).
      // HTTP APIs write access logs through their service-linked role; no API Gateway account role is needed.
      accessLogSettings: {
        destination: new LogGroupLogDestination(new LogGroup(this, "AccessLogs", { retention: RetentionDays.ONE_MONTH })),
        format: AccessLogFormat.custom(JSON.stringify(ACCESS_LOG_FIELDS)),
      },
    });
    // Route-level settings replace the default throttle for that route only (HttpStage has no L2 prop for them).
    const mcpThrottle = { ThrottlingRateLimit: MCP_THROTTLE.rateLimit, ThrottlingBurstLimit: MCP_THROTTLE.burstLimit };
    const secThrottle = { ThrottlingRateLimit: SEC_THROTTLE.rateLimit, ThrottlingBurstLimit: SEC_THROTTLE.burstLimit };
    (stage.node.defaultChild as CfnStage).routeSettings = {
      [MCP_ROUTE_KEY]: mcpThrottle,
      [PAID_MCP_ROUTE_KEY]: mcpThrottle,
      [SEC_ROUTE_KEY]: secThrottle,
      [SEC_INSIDER_ROUTE_KEY]: secThrottle,
      [SEC_FILINGS_ROUTE_KEY]: secThrottle,
    };
    stage.node.addDependency(mcpRoute, paidMcpRoute, secRoute, secInsiderRoute, secFilingsRoute); // the stage's route settings name the routes, so they must exist first

    // The app uses its public base URL in /openapi.json, /llms.txt, the 402 body and iconUrl.
    if (!props.publicBaseUrl) fn.addEnvironment("PUBLIC_BASE_URL", api.apiEndpoint);
    new CfnOutput(this, "ApiUrl", { value: `${api.apiEndpoint}/` });

    // Cost breaker, no email needed: CloudWatch alarm on the invocations in the last 24 hours -> SNS -> breaker Lambda
    // -> PutFunctionConcurrency(0) on the API function. Requests then get 5xx from API Gateway without running Lambda.
    // The topic policy lets only this alarm publish, and the topic has one subscription.
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
      environment: { TARGET_FUNCTION: fn.functionName }, // ALARM_NAME is added below, once the alarm exists
    });
    const topic = new Topic(this, "BreakerTopic");
    topic.addSubscription(new LambdaSubscription(breaker));
    const alarm = new Alarm(this, "DailyInvocationsAlarm", {
      // No EvaluationWindow: a sliding 24-hour sum, evaluated every minute (not aligned to UTC days).
      alarmDescription: `API function invocations in the last 24 hours > ${props.breakerDailyInvocations}: reserved concurrency set to 0 (README "Cost breaker").`,
      metric: fn.metricInvocations({ period: Duration.days(1), statistic: "Sum" }),
      threshold: props.breakerDailyInvocations,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new SnsAction(topic));
    // The alarm still counts /mcp (README "Cost breaker"): what keeps a /mcp flood alone from tripping it is that the
    // /mcp route's throttle cannot reach the threshold in 24 hours.
    if (MCP_THROTTLE.rateLimit * 86_400 >= props.breakerDailyInvocations) {
      Annotations.of(this).addWarning(
        `breakerDailyInvocations ${props.breakerDailyInvocations} is reachable by /mcp alone (${MCP_THROTTLE.rateLimit} rps x 24 h): a /mcp flood can trip the breaker and stop the paid routes`,
      );
    }
    // Replaces SNS's default topic policy (AWS:* limited to this account): only CloudWatch, only for this alarm.
    topic.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal("cloudwatch.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
        conditions: { ArnEquals: { "aws:SourceArn": alarm.alarmArn } },
      }),
    );
    breaker.addEnvironment("ALARM_NAME", alarm.alarmName);
    new CfnOutput(this, "BreakerAlarmName", { value: alarm.alarmName });
    new CfnOutput(this, "ApiFunctionName", { value: fn.functionName });
  }
}
