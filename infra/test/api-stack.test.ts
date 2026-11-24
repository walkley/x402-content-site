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

  it("lets only API Gateway invoke the function, scoped to this HTTP API", () => {
    const [apiId] = Object.keys(template.findResources("AWS::ApiGatewayV2::Api"));
    const perms = Object.values(template.findResources("AWS::Lambda::Permission"));
    expect(perms.length).toBeGreaterThan(0);
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
});
