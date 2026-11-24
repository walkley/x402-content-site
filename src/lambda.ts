import { handle } from "hono/aws-lambda";
import { configFromEnv, createApp } from "./app.js";

// Lambda Function URL entry point. Funnel logs go to stdout -> CloudWatch Logs.
export const handler = handle(createApp(configFromEnv(process.env)));
