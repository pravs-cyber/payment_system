#!/usr/bin/env bash
# End-to-end PayFlow flow check.
#   ./scripts/smoke-test.sh                      # local Docker (via nginx on :8080)
#   ./scripts/smoke-test.sh https://your-app.vercel.app
# Requires: bash, curl, node (used only to read JSON).
set -euo pipefail
BASE="${1:-http://localhost:8080}"
BASE="${BASE%/}"
RUN="$(date +%s)$RANDOM"
PASS=0; FAIL=0

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))})' "$1"; }
call() { # method path [body] [extra curl args...]  -> sets CODE and BODY
  local m="$1" p="$2" b="${3:-}"; shift 3 || shift $#
  local args=(-s -o /tmp/pf_body -w '%{http_code}' -X "$m" "$BASE$p" -H 'Content-Type: application/json')
  [[ -n "${KEY:-}" ]] && args+=(-H "Authorization: Bearer $KEY")
  [[ -n "$b" ]] && args+=(-d "$b")
  CODE=$(curl "${args[@]}" "$@"); BODY=$(cat /tmp/pf_body)
}
check() { # description expected actual
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1";
  else FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s (expected %s, got %s)\n       %s\n' "$1" "$2" "$3" "${BODY:0:300}"; fi
}

echo "PayFlow smoke test against $BASE"
KEY=""
call GET /health;                                   check "GET /health" 200 "$CODE"
check "health reports database connected" connected "$(echo "$BODY" | json database)"
PROVIDER=$(echo "$BODY" | json provider); echo "  provider: $PROVIDER"

call POST /v1/merchants "{\"businessName\":\"Smoke Store $RUN\",\"ownerName\":\"Tester\",\"email\":\"smoke+$RUN@example.com\",\"website\":\"https://example.com\"}"
check "POST /v1/merchants" 201 "$CODE"
KEY=$(echo "$BODY" | json credentials.apiKey); MID=$(echo "$BODY" | json credentials.merchantId)
check "merchant id issued" mer "${MID%%_*}"
check "test API key issued" pk_test "$(echo "$KEY" | cut -d_ -f1-2)"

SAVED="$KEY"; KEY="pk_test_invalid"
call GET /v1/wallet;                                check "invalid API key rejected" 401 "$CODE"
KEY="$SAVED"
call GET /v1/merchant;                              check "GET /v1/merchant (API-key auth)" 200 "$CODE"
call GET /v1/wallet;                                check "GET /v1/wallet (wallet auto-created)" 0 "$(echo "$BODY" | json wallet.available_paise)"

KEY=""
call POST /v1/webhooks/simulator/payments '{"type":"PAYMENT_SUCCESS_WEBHOOK"}' -H 'x-webhook-timestamp: 1' -H 'x-webhook-signature: forged'
check "forged webhook signature rejected" 401 "$CODE"
KEY="$SAVED"

CUST='"customer":{"phone":"9876543210","email":"buyer@example.com","name":"Smoke Buyer"}'
call POST /v1/payments '{"amount":100000,"orderId":"order-'"$RUN"'",'"$CUST"'}' -H "Idempotency-Key: pay-$RUN"
check "POST /v1/payments -> PENDING at provider" PENDING "$(echo "$BODY" | json status)"
PAY=$(echo "$BODY" | json paymentId); CHECKOUT=$(echo "$BODY" | json checkout.url)
call POST /v1/payments '{"amount":100000,"orderId":"order-'"$RUN"'",'"$CUST"'}' -H "Idempotency-Key: pay-$RUN"
check "idempotent replay returns same payment" "$PAY" "$(echo "$BODY" | json paymentId)"
call GET "/v1/checkout/$PAY";                       check "public checkout endpoint" 200 "$CODE"

if [[ "$PROVIDER" == "internal_simulator" ]]; then
  call POST "/v1/checkout/$PAY/simulate" '{"outcome":"success"}'
  check "customer pays on hosted checkout -> signed webhook -> SUCCESS" SUCCESS "$(echo "$BODY" | json status)"
  call GET "/v1/payments/$PAY";                     check "GET /v1/payments/:id" SUCCESS "$(echo "$BODY" | json payment.status)"
  call GET /v1/wallet;                              check "wallet credited net of 1% fee" 99000 "$(echo "$BODY" | json wallet.available_paise)"

  call POST /v1/payments '{"amount":5000,"orderId":"order-fail-'"$RUN"'","simulation":"failed"}' -H "Idempotency-Key: payf-$RUN"
  check "failed payment recorded" FAILED "$(echo "$BODY" | json status)"

  call POST /v1/merchant/payout-account '{"name":"Smoke Owner","accountNumber":"123456789012","ifsc":"HDFC0000001"}'
  check "POST /v1/merchant/payout-account (beneficiary)" 201 "$CODE"
  call POST /v1/payouts '{"amount":40000,"mode":"IMPS"}' -H "Idempotency-Key: po-$RUN"
  check "POST /v1/payouts" 201 "$CODE"
  PO=$(echo "$BODY" | json payoutId)
  call GET "/v1/payouts/$PO";                       check "payout SUCCESS via provider webhook" SUCCESS "$(echo "$BODY" | json payout.status)"
  call GET /v1/wallet;                              check "wallet debited by payout" 59000 "$(echo "$BODY" | json wallet.available_paise)"
  check "pending balance settled" 0 "$(echo "$BODY" | json wallet.pending_paise)"
  call POST /v1/payouts '{"amount":999999999}' -H "Idempotency-Key: po-big-$RUN"
  check "payout above balance rejected" 409 "$CODE"
  call GET /v1/payouts;                             check "GET /v1/payouts lists the payout" "$PO" "$(echo "$BODY" | json payouts.0.payoutId)"
  call GET "/v1/payments?status=SUCCESS";           check "GET /v1/payments?status=SUCCESS" "$PAY" "$(echo "$BODY" | json payments.0.paymentId)"

  call POST "/v1/simulator/payouts/$PO/reverse" '{}'
  check "bank reversal -> REVERSED, funds returned" REVERSED "$(echo "$BODY" | json payout.status)"
  call GET /v1/wallet;                              check "wallet credited back after reversal" 99000 "$(echo "$BODY" | json wallet.available_paise)"

  call GET "/v1/reconciliation/payouts/$PO";        check "payout reconciliation matched" true "$(echo "$BODY" | json matched)"
  call GET /v1/reconciliation;                      check "wallet == double-entry ledger" true "$(echo "$BODY" | json matched)"
  call GET /v1/reconciliation/provider;             check "PayFlow vs provider: all matched" 0 "$(echo "$BODY" | json summary.mismatched)"
  call POST "/v1/payments/$PAY/refund" '{}';        check "POST /v1/payments/:id/refund" 200 "$CODE"
  call GET /v1/reconciliation;                      check "reconciliation still matched after refund" true "$(echo "$BODY" | json matched)"
else
  check "Cashfree checkout session issued" cashfree "$(echo "$BODY" | json checkout.type)"
  call POST /v1/merchant/payout-account '{"name":"Smoke Owner","accountNumber":"026291800001191","ifsc":"YESB0000262"}'
  check "payout account registered as Cashfree beneficiary" 201 "$CODE"
  call GET /v1/reconciliation;                      check "wallet == double-entry ledger" true "$(echo "$BODY" | json matched)"
  call GET /v1/reconciliation/provider;             check "provider reconciliation reachable" 200 "$CODE"
  echo "  Complete the payment in a browser with Cashfree sandbox test credentials:"
  echo "    $CHECKOUT"
  echo "  then: curl -H 'Authorization: Bearer $KEY' $BASE/v1/payments/$PAY"
fi
call GET /v1/dashboard;                             check "GET /v1/dashboard" 200 "$CODE"
call GET /v1/does-not-exist;                        check "unknown route returns JSON 404" 404 "$CODE"

echo; echo "Passed: $PASS  Failed: $FAIL"
[[ $FAIL -eq 0 ]]
