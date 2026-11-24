#!/usr/bin/env bash
# Read-only check, run after deploying: can the deployed API function reach SEC EDGAR with its User-Agent?
# Invokes the function directly (IAM, not over HTTP) with {"x402_probe":"sec"}; the function makes two GETs to
# data.sec.gov and www.sec.gov and returns their status codes. It changes nothing and sends no payment.
#
#   scripts/sec-lambda-probe.sh [stack-name]     # default X402CnWorkdayApi, region ap-northeast-1
#
# Needs cloudformation:DescribeStacks and lambda:InvokeFunction on the API function. Exit 0 when both answer 200.
set -euo pipefail
STACK="${1:-X402CnWorkdayApi}"
REGION="${AWS_REGION:-ap-northeast-1}"
FN=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiFunctionName'].OutputValue" --output text)
[ -n "$FN" ] && [ "$FN" != "None" ] || { echo "no ApiFunctionName output on stack $STACK" >&2; exit 2; }
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
aws lambda invoke --region "$REGION" --function-name "$FN" --cli-binary-format raw-in-base64-out \
  --payload '{"x402_probe":"sec"}' "$OUT" >/dev/null
cat "$OUT"; echo
grep -q '"ok":true' "$OUT"
