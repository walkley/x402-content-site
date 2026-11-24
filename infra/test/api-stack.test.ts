import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { ApiStack, BREAKER_CODE, type ApiStackProps } from "../lib/api-stack.js";

const BASE: Omit<ApiStackProps, "env"> = {
  payTo: "0x0000000000000000000000000000000000000001",
  network: "eip155:8453",
  facilitator: "payai",
  cdpSecretName: "unused",
  reservedConcurrency: 10,
  budgetUsd: 10,
  noBudget: true,
  breakerDailyInvocations: 300_000,
  freePerIpDaily: 20,
  freeGlobalDaily: 2000,
};
const stack = (overrides: Partial<ApiStackProps> = {}, id = "TestStack") =>
  new ApiStack(new App(), id, { env: { region: "ap-northeast-1" }, ...BASE, ...overrides });

const template = Template.fromStack(stack());
const logicalId = (type: string, prefix: string) => {
  const ids = Object.keys(template.findResources(type)).filter((k) => k.startsWith(prefix));
  expect(ids).toHaveLength(1);
  return ids[0];
};
const apiFnId = logicalId("AWS::Lambda::Function", "ApiFunction");
const breakerFnId = logicalId("AWS::Lambda::Function", "BreakerFunction");

describe("ApiStack", () => {
  it("has no Lambda Function URL", () => {
    template.resourceCountIs("AWS::Lambda::Url", 0);
  });

  it("fronts the function with a throttled HTTP API $default stage and no REST API", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP" });
    template.resourceCountIs("AWS::ApiGateway::RestApi", 0);
    template.resourceCountIs("AWS::ApiGatewayV2::Stage", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$default" });
    template.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 10, Timeout: 25 });
    template.resourceCountIs("AWS::ApiGateway::Account", 0);
  });

  it("writes a JSON access log line per request to a 30-day log group", () => {
    const stages = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"));
    const settings = stages[0].Properties.AccessLogSettings;
    const fields = JSON.parse(settings.Format);
    for (const k of ["requestId", "status", "routeKey", "integrationErrorMessage"]) expect(fields[k]).toMatch(/^\$context\./);
    const groupId = logicalId("AWS::Logs::LogGroup", "AccessLogs");
    expect(settings.DestinationArn).toEqual({ "Fn::GetAtt": [groupId, "Arn"] });
    template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
  });

  it("lets only API Gateway invoke the API function, scoped to this HTTP API", () => {
    const [apiId] = Object.keys(template.findResources("AWS::ApiGatewayV2::Api"));
    const perms = Object.values(template.findResources("AWS::Lambda::Permission")).filter(
      (p) => JSON.stringify(p.Properties.FunctionName).includes(apiFnId),
    );
    expect(perms).toHaveLength(1); // one invoke permission, for this HTTP API only
    for (const p of perms) {
      expect(p.Properties.Principal).toBe("apigateway.amazonaws.com");
      expect(p.Properties.Action).toBe("lambda:InvokeFunction");
      expect(JSON.stringify(p.Properties.SourceArn)).toContain(`{"Ref":"${apiId}"}`);
    }
  });

  it("points PUBLIC_BASE_URL at the HTTP API endpoint, with no stage path", () => {
    const [apiId] = Object.keys(template.findResources("AWS::ApiGatewayV2::Api"));
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ PUBLIC_BASE_URL: { "Fn::GetAtt": [apiId, "ApiEndpoint"] } }) },
    });
  });

  it("has no wildcard principal anywhere in the template", () => {
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toMatch(/"Principal":"\*"/);
    expect(json).not.toMatch(/"AWS":"\*"/);
    expect(json).not.toContain("InvokeFunctionUrl");
  });
});

describe("free MCP quota table", () => {
  const tableId = logicalId("AWS::DynamoDB::Table", "FreeQuotaTable");

  it("is on-demand, keyed by pk, with TTL on expires_at", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "expires_at", Enabled: true },
    });
  });

  it("only the API function's role may touch it, and only with UpdateItem on this table", () => {
    const roleId = (template.findResources("AWS::Lambda::Function")[apiFnId].Properties.Role["Fn::GetAtt"] as string[])[0];
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const dynamo = policies.flatMap((p) =>
      (p.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[])
        .filter((st) => [st.Action].flat().some((a) => a.startsWith("dynamodb:")))
        .map((st) => ({ roles: p.Properties.Roles, st })),
    );
    expect(dynamo).toHaveLength(1);
    expect(dynamo[0].roles).toEqual([{ Ref: roleId }]);
    expect([dynamo[0].st.Action].flat()).toEqual(["dynamodb:UpdateItem"]);
    expect(dynamo[0].st.Resource).toEqual([{ "Fn::GetAtt": [tableId, "Arn"] }]);
    expect(JSON.stringify(template.findResources("AWS::DynamoDB::Table"))).not.toContain("ResourcePolicy");
  });

  it("passes the table name and the limits to the API function", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ QUOTA_TABLE: { Ref: tableId }, FREE_PER_IP_DAILY: "20", FREE_GLOBAL_DAILY: "2000" }) },
    });
    expect(() => stack({ freeGlobalDaily: -1 }, "BadQuota")).toThrow(/freeGlobalDaily/);
  });

  it("generates the HMAC key secret, readable only by the API function, and passes its ARN", () => {
    const secretId = logicalId("AWS::SecretsManager::Secret", "QuotaHmacKey");
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true },
    });
    expect(template.findResources("AWS::SecretsManager::Secret")[secretId].Properties.SecretString).toBeUndefined(); // no value in the template
    const roleId = (template.findResources("AWS::Lambda::Function")[apiFnId].Properties.Role["Fn::GetAtt"] as string[])[0];
    const sm = Object.values(template.findResources("AWS::IAM::Policy")).flatMap((p) =>
      (p.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[])
        .filter((st) => [st.Action].flat().some((a) => a.startsWith("secretsmanager:")))
        .map((st) => ({ roles: p.Properties.Roles, st })),
    );
    expect(sm).toHaveLength(1);
    expect(sm[0].roles).toEqual([{ Ref: roleId }]);
    expect([sm[0].st.Action].flat().sort()).toEqual(["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]);
    expect(sm[0].st.Resource).toEqual({ Ref: secretId });
    template.resourceCountIs("AWS::SecretsManager::ResourcePolicy", 0);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ QUOTA_HMAC_SECRET_ARN: { Ref: secretId } }) },
    });
  });
});

describe("cost breaker", () => {
  it("alarms on the API function's invocations in the last 24 hours and publishes to the breaker topic", () => {
    const topicId = logicalId("AWS::SNS::Topic", "BreakerTopic");
    template.resourceCountIs("AWS::CloudWatch::Alarm", 1);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/Lambda",
      MetricName: "Invocations",
      Statistic: "Sum",
      Period: 86400,
      EvaluationPeriods: 1,
      Threshold: 300_000,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      Dimensions: [{ Name: "FunctionName", Value: { Ref: apiFnId } }],
      AlarmActions: [{ Ref: topicId }],
    });
    const alarm = Object.values(template.findResources("AWS::CloudWatch::Alarm"))[0];
    expect(alarm.Properties.EvaluationWindow).toBeUndefined(); // sliding window, evaluated every minute
    expect(alarm.Properties.AlarmDescription).toContain("in the last 24 hours");
    const alarmId = logicalId("AWS::CloudWatch::Alarm", "DailyInvocationsAlarm");
    template.hasOutput("BreakerAlarmName", { Value: { Ref: alarmId } });
  });

  it("topic policy lets only CloudWatch publish, and only for this alarm", () => {
    const topicId = logicalId("AWS::SNS::Topic", "BreakerTopic");
    const alarmId = logicalId("AWS::CloudWatch::Alarm", "DailyInvocationsAlarm");
    const policies = Object.values(template.findResources("AWS::SNS::TopicPolicy"));
    expect(policies).toHaveLength(1);
    expect(policies[0].Properties.Topics).toEqual([{ Ref: topicId }]);
    expect(policies[0].Properties.PolicyDocument.Statement).toEqual([
      // only extra key allowed is CDK's generated Sid
      {
        Sid: expect.any(String),
        Effect: "Allow",
        Principal: { Service: "cloudwatch.amazonaws.com" },
        Action: "sns:Publish",
        Resource: { Ref: topicId },
        Condition: { ArnEquals: { "aws:SourceArn": { "Fn::GetAtt": [alarmId, "Arn"] } } },
      },
    ]);
  });

  it("subscribes only the breaker Lambda to the topic, and only SNS from that topic may invoke it", () => {
    const topicId = logicalId("AWS::SNS::Topic", "BreakerTopic");
    template.resourceCountIs("AWS::SNS::Subscription", 1);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "lambda",
      TopicArn: { Ref: topicId },
      Endpoint: { "Fn::GetAtt": [breakerFnId, "Arn"] },
    });
    const perms = Object.values(template.findResources("AWS::Lambda::Permission")).filter(
      (p) => JSON.stringify(p.Properties.FunctionName).includes(breakerFnId),
    );
    expect(perms).toHaveLength(1);
    expect(perms[0].Properties).toMatchObject({ Principal: "sns.amazonaws.com", Action: "lambda:InvokeFunction", SourceArn: { Ref: topicId } });
  });

  it("breaker role may only PutFunctionConcurrency on the API function and write its own log group", () => {
    const roleId = logicalId("AWS::IAM::Role", "BreakerRole");
    const logsId = logicalId("AWS::Logs::LogGroup", "BreakerLogs");
    const role = template.findResources("AWS::IAM::Role")[roleId];
    expect(role.Properties.ManagedPolicyArns).toBeUndefined(); // no AWSLambdaBasicExecutionRole (logs on *)
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes(roleId),
    );
    expect(policies).toHaveLength(1);
    const statements = policies[0].Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown; Effect: string }[];
    const byAction = new Map(statements.flatMap((s) => [s.Action].flat().map((a) => [a, s] as const)));
    expect([...byAction.keys()].sort()).toEqual(["lambda:PutFunctionConcurrency", "logs:CreateLogStream", "logs:PutLogEvents"]);
    expect(byAction.get("lambda:PutFunctionConcurrency")!.Resource).toEqual({ "Fn::GetAtt": [apiFnId, "Arn"] });
    for (const a of ["logs:CreateLogStream", "logs:PutLogEvents"]) {
      expect(JSON.stringify(byAction.get(a)!.Resource)).toContain(logsId);
    }
    expect(JSON.stringify(statements)).not.toContain('"*"');
    template.hasResourceProperties("AWS::Lambda::Function", {
      Role: { "Fn::GetAtt": [roleId, "Arn"] },
      Environment: {
        Variables: { TARGET_FUNCTION: { Ref: apiFnId }, ALARM_NAME: { Ref: logicalId("AWS::CloudWatch::Alarm", "DailyInvocationsAlarm") } },
      },
      LoggingConfig: Match.objectLike({ LogGroup: { Ref: logsId } }),
    });
  });

  it("breaker handler sets the target's reserved concurrency to 0 only on its own alarm's ALARM notification", async () => {
    const sent: unknown[] = [];
    class PutFunctionConcurrencyCommand { constructor(readonly input: unknown) {} }
    class LambdaClient { async send(cmd: { input: unknown }) { sent.push(cmd.input); } }
    const mod = { exports: {} as { handler: (e: unknown) => Promise<unknown> } };
    runInNewContext(BREAKER_CODE, {
      require: (id: string) => (id === "@aws-sdk/client-lambda" ? { LambdaClient, PutFunctionConcurrencyCommand } : undefined),
      exports: mod.exports,
      process: { env: { TARGET_FUNCTION: "api-fn", ALARM_NAME: "a" } },
      console: { log: () => {} },
      JSON,
    });
    const sns = (msg: string) => ({ Records: [{ Sns: { Message: msg } }] });
    expect(await mod.exports.handler(sns(JSON.stringify({ AlarmName: "a", NewStateValue: "OK" })))).toEqual({ skipped: true });
    expect(await mod.exports.handler(sns("not json"))).toEqual({ skipped: true });
    expect(await mod.exports.handler(sns(JSON.stringify({ AlarmName: "other", NewStateValue: "ALARM" })))).toEqual({ skipped: true });
    expect(sent).toHaveLength(0);
    expect(await mod.exports.handler(sns(JSON.stringify({ AlarmName: "a", NewStateValue: "ALARM" })))).toEqual({ tripped: true });
    expect(sent).toEqual([{ FunctionName: "api-fn", ReservedConcurrentExecutions: 0 }]);
  });

  it("takes the daily threshold from props and rejects a non-positive one", () => {
    const t = Template.fromStack(stack({ breakerDailyInvocations: 1234 }, "ThresholdStack"));
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { Threshold: 1234 });
    expect(() => stack({ breakerDailyInvocations: 0 }, "BadThreshold")).toThrow(/breakerDailyInvocations/);
  });
});

describe("cost alert on mainnet", () => {
  it("refuses Base mainnet without budgetEmail unless noBudget is set", () => {
    expect(() => stack({ noBudget: false }, "NoBudget")).toThrow(/budgetEmail/);
    expect(() => stack({ noBudget: false, network: "eip155:84532", facilitator: "x402org" }, "Testnet")).not.toThrow();
  });

  it("creates the monthly budget when budgetEmail is given", () => {
    const t = Template.fromStack(stack({ noBudget: false, budgetEmail: "ops@example.com" }, "WithBudget"));
    t.resourceCountIs("AWS::Budgets::Budget", 1);
  });
});
