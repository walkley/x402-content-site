import { handle } from "hono/aws-lambda";
import { configFromEnv, createApp } from "./app.js";

/**
 * API Gateway HTTP API entry point (`$default` stage, Lambda proxy payload format 2.0).
 *
 * The `$default` stage has no path prefix, so `rawPath` is the public path and `c.req.url`, which x402 copies into
 * `resource`, is a URL a client can call. Funnel logs go to stdout -> CloudWatch Logs.
 *
 * The facilitator sync runs here, in the Lambda init phase, so it is never frozen half-way the way a background
 * request is after a fast free first request. A failed sync does not fail init: the next paid request retries it.
 */
const app = createApp(configFromEnv(process.env));
await app.initFacilitator();
export const handler = handle(app);
