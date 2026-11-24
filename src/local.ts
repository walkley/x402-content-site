import { serve } from "@hono/node-server";
import { configFromEnv, createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const cfg = configFromEnv(process.env);
serve({ fetch: createApp(cfg).fetch, port }, (info) => {
  console.error(`listening on http://localhost:${info.port} network=${cfg.network} facilitator=${cfg.facilitatorUrl}`);
});
