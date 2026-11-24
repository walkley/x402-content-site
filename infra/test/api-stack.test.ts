import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack } from "../lib/api-stack.js";

const template = Template.fromStack(
  new ApiStack(new App(), "TestStack", {
    env: { region: "ap-northeast-1" },
    payTo: "0x0000000000000000000000000000000000000001",
    network: "eip155:8453",
    facilitator: "payai",
    cdpSecretName: "unused",
    reservedConcurrency: 10,
    budgetUsd: 10,
  }),
);

describe("ApiStack", () => {
  it("has no Lambda Function URL", () => {
    template.resourceCountIs("AWS::Lambda::Url", 0);
  });

  it("fronts the function with a throttled REST API stage", () => {
    template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      StageName: "prod",
      MethodSettings: [Match.objectLike({ HttpMethod: "*", ResourcePath: "/*", ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 })],
    });
    template.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 10, Timeout: 25 });
    template.resourceCountIs("AWS::ApiGateway::Account", 0);
  });

  it("lets only API Gateway invoke the function, scoped to this API's prod stage", () => {
    const [apiId] = Object.keys(template.findResources("AWS::ApiGateway::RestApi"));
    const [stageId] = Object.keys(template.findResources("AWS::ApiGateway::Stage"));
    const perms = Object.values(template.findResources("AWS::Lambda::Permission"));
    expect(perms.length).toBeGreaterThan(0);
    for (const p of perms) {
      expect(p.Properties.Principal).toBe("apigateway.amazonaws.com");
      expect(p.Properties.Action).toBe("lambda:InvokeFunction");
      const arn = JSON.stringify(p.Properties.SourceArn);
      expect(arn).toContain(`{"Ref":"${apiId}"}`);
      expect(arn).toContain(`{"Ref":"${stageId}"}`);
      expect(arn).not.toContain("test-invoke-stage");
    }
  });
});
