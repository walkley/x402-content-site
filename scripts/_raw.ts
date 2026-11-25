import { createServer } from "node:http";
const r = await fetch("http://localhost:8795/reports/x402-real-payers/full", { headers: { "user-agent": "Mozilla/5.0", accept: "text/html" } });
const html = (await r.text()).replace(',preference:{options:"all",telemetry:!1}', "");
createServer((_q, s) => { s.writeHead(402, { "content-type": "text/html" }); s.end(html); }).listen(8796);
