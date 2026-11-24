import { Hono } from "hono";
import { handle, type LambdaContext, type LambdaEvent } from "hono/aws-lambda";
import { configFromEnv, createApp } from "./app.js";

type StageEnv = { requestContext?: { stage?: string } };

/**
 * API Gateway REST API entry point (Lambda proxy integration, payload v1).
 *
 * The public URL carries the stage (`/prod/cn/workday`) but `event.path` omits it (`/cn/workday`). The request is
 * built from `requestContext.path`, so `c.req.url`, which x402 copies into `resource`, is a URL a client can call.
 * Routing strips the stage again, so routes and the paid-route table still see `/cn/workday`.
 */
export function restApiHandler(app: Hono) {
  const routed = new Hono({
    getPath: (req, opts) => {
      const raw = new URL(req.url).pathname;
      let path = raw;
      try {
        path = decodeURI(raw);
      } catch {
        // keep the raw path, as Hono's default getPath does on a malformed escape
      }
      const stage = (opts?.env as StageEnv | undefined)?.requestContext?.stage;
      if (!stage) return path;
      const prefix = `/${stage}`;
      if (path === prefix) return "/";
      return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
    },
  }).route("/", app);
  const inner = handle(routed);
  return (event: LambdaEvent, context?: LambdaContext) => {
    const restPath = (event.requestContext as { path?: unknown } | undefined)?.path;
    return inner("httpMethod" in event && typeof restPath === "string" ? { ...event, path: restPath } : event, context);
  };
}

// Funnel logs go to stdout -> CloudWatch Logs.
export const handler = restApiHandler(createApp(configFromEnv(process.env)));
