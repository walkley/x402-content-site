import { handle } from "hono/aws-lambda";
import { configFromEnv, createApp } from "./app.js";
import { isSecProbe, probeSec, secUserAgent } from "./sec.js";

/**
 * API Gateway HTTP API entry point (`$default` stage, Lambda proxy payload format 2.0).
 *
 * The `$default` stage has no path prefix, so `rawPath` is the public path and `c.req.url`, which x402 copies into
 * `resource`, is a URL a client can call. Funnel logs go to stdout -> CloudWatch Logs.
 *
 * The facilitator sync runs here, in the Lambda init phase, so it is never frozen half-way the way a background
 * request is after a fast free first request. A failed sync does not fail init: the next paid request retries it.
 * The free MCP quota's HMAC key is read here too, once; if that fails, MCP calls get the paid hint and retry the read.
 *
 * A direct invoke with {"x402_probe":"sec"} (not reachable through API Gateway) checks SEC EDGAR access from this
 * function's egress IP; see scripts/sec-lambda-probe.sh.
 */
const cfg = configFromEnv(process.env);
const app = createApp(cfg);
await app.initFacilitator();
await app.initQuota();
const http = handle(app);
export const handler = (event: Parameters<typeof http>[0], context: Parameters<typeof http>[1]) =>
  isSecProbe(event) ? probeSec(secUserAgent(cfg.publicBaseUrl ?? "http://localhost")) : http(event, context);
