// Structured funnel logging for paid routes. One JSON object per line on stdout,
// which Lambda forwards to CloudWatch Logs.
//
// Never log the payment header or signature: only stage, route, user agent, payer
// address, reasons and transaction hashes.

export type FunnelStage =
  | "request"
  | "402_returned"
  | "payment_header_received"
  | "verify_ok"
  | "verify_fail"
  | "settle_ok"
  | "settle_fail"
  | "content_returned"
  | "handler_error";

export interface FunnelEvent {
  stage: FunnelStage;
  route: string;
  request_id: string;
  user_agent: string;
  status?: number;
  reason?: string;
  payer?: string;
  tx?: string;
  network?: string;
}

const FIELDS = ["stage", "route", "request_id", "user_agent", "status", "reason", "payer", "tx", "network"] as const satisfies readonly (keyof FunnelEvent)[];

export type FunnelSink = (line: string) => void;

export class FunnelLogger {
  constructor(private readonly sink: FunnelSink = (line) => console.log(line)) {}

  log(event: FunnelEvent): void {
    // Whitelist the fields so request state or payment data spread into `event` never reaches the log.
    const out: Record<string, unknown> = { ts: new Date().toISOString(), type: "x402_funnel" };
    for (const k of FIELDS) if (event[k] !== undefined) out[k] = event[k];
    this.sink(JSON.stringify(out));
  }
}
