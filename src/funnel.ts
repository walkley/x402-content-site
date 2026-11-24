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
  | "content_returned";

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

export type FunnelSink = (line: string) => void;

export class FunnelLogger {
  constructor(private readonly sink: FunnelSink = (line) => console.log(line)) {}

  log(event: FunnelEvent): void {
    this.sink(JSON.stringify({ ts: new Date().toISOString(), type: "x402_funnel", ...event }));
  }
}
