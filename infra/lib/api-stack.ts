import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { Architecture, FunctionUrlAuthType, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
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
}

/** One Lambda (Node 22, arm64) behind a public Lambda Function URL. */
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
      timeout: Duration.seconds(30), // settlement waits for the facilitator to land the tx
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

    const url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
    new CfnOutput(this, "ApiUrl", { value: url.url });
  }
}
