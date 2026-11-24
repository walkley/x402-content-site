import { handle } from "hono/aws-lambda";
import { configFromEnv, createApp } from "./app.js";

/**
 * API Gateway HTTP API entry point (`$default` stage, Lambda proxy payload format 2.0).
 *
 * The `$default` stage has no path prefix, so `rawPath` is the public path and `c.req.url`, which x402 copies into
 * `resource`, is a URL a client can call. Funnel logs go to stdout -> CloudWatch Logs.
 */
export const handler = handle(createApp(configFromEnv(process.env)));
