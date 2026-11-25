#!/usr/bin/env bash
# End-to-end smoke test for a running VeriDoc server.
#
#   BASE=http://localhost:3000 KEY=your-key ./scripts/smoke-test.sh
#   BASE=https://my-app.vercel.app KEY=... DOC_URL=https://.../file.pdf DOC_NAME=file.pdf ./scripts/smoke-test.sh
#
# Checks /health, auth, validation errors, then ingests one document end to end
# and deletes it again. Needs only bash + curl. The server's SOURCE_URL_HOSTS
# must allow DOC_URL's host (use SOURCE_URL_HOSTS=* locally).
set -uo pipefail

BASE="${BASE:-http://localhost:3000}"
KEY="${KEY:-${VERIDOC_API_KEY:-}}"
DOC_URL="${DOC_URL:-https://raw.githubusercontent.com/honojs/hono/main/README.md}"
DOC_NAME="${DOC_NAME:-hono-readme.md}"
MAX_POLLS="${MAX_POLLS:-120}"

if [[ -t 1 ]]; then G=$'\e[32m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else G=; R=; D=; N=; fi
pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "${G}✓${N} $1"; }
bad() { fail=$((fail + 1)); echo "${R}✗${N} $1"; echo "    ${D}$2${N}"; }

# req METHOD PATH [BODY] [AUTH=yes|no|wrong] -> sets $STATUS and $BODY
req() {
  local method=$1 path=$2 data=${3:-} auth=${4:-yes} out
  local args=(-s -o /tmp/veridoc-smoke.$$ -w '%{http_code}' -X "$method" "$BASE$path")
  case $auth in
    yes)   [[ -n $KEY ]] && args+=(-H "Authorization: Bearer $KEY") ;;
    wrong) args+=(-H "Authorization: Bearer definitely-not-the-key") ;;
  esac
  [[ -n $data ]] && args+=(-H 'Content-Type: application/json' --data "$data")
  STATUS=$(curl "${args[@]}") || STATUS=000
  BODY=$(cat /tmp/veridoc-smoke.$$ 2>/dev/null); rm -f /tmp/veridoc-smoke.$$
}

# expect NAME STATUS [GREP_PATTERN]
expect() {
  local name=$1 want=$2 pattern=${3:-}
  if [[ $STATUS != "$want" ]]; then bad "$name" "expected HTTP $want, got $STATUS: $BODY"; return 1; fi
  if [[ -n $pattern ]] && ! grep -qE "$pattern" <<<"$BODY"; then bad "$name" "body didn't match /$pattern/: $BODY"; return 1; fi
  ok "$name"
}

json_field() { sed -nE "s/.*\"$1\":\"?([^\",}]*)\"?.*/\1/p" <<<"$BODY" | head -1; }

echo "VeriDoc smoke test → $BASE"
[[ -z $KEY ]] && echo "${D}(no KEY set — auth checks are skipped; fine for local dev without VERIDOC_API_KEY)${N}"
echo

# --- health & routing ---
req GET /health '' no
expect 'GET /health is 200 and db ok' 200 '"db":"ok"' || { echo "Server/database not healthy — stopping."; exit 1; }
req GET /nope '' no
expect 'unknown route → 404 not_found (JSON)' 404 '"code":"not_found"'

# --- auth ---
if [[ -n $KEY ]]; then
  req GET /documents '' no;    expect 'no API key → 401' 401 '"code":"unauthorized"'
  req GET /documents '' wrong; expect 'wrong API key → 401' 401 '"code":"unauthorized"'
fi

# --- validation ---
req POST /documents '{"url":"http://example.com/a.md","fileName":"a.md"}'
expect 'http:// url → 400 invalid_request' 400 '"code":"invalid_request"'
req POST /documents '{"url":"https://example.com/a.md"}'
expect 'missing fileName → 400 invalid_request' 400 '"code":"invalid_request"'
req POST /documents "{\"url\":\"$DOC_URL\",\"fileName\":\"photo.png\"}"
expect 'unsupported extension → 415' 415 '"code":"unsupported_type"'
req POST /documents '{not json'
expect 'malformed JSON → 400' 400 '"error"'
req GET '/documents?limit=500'
expect 'limit=500 → 400 invalid_request' 400 '"code":"invalid_request"'
req GET /documents/000000000000000000000000
expect 'unknown document id → 404' 404 '"code":"not_found"'
req GET /documents/not-an-id
expect 'malformed document id → 404' 404 '"code":"not_found"'

# --- full ingestion ---
req POST /documents "{\"url\":\"$DOC_URL\",\"fileName\":\"$DOC_NAME\"}"
if ! expect 'POST /documents → 202 pending' 202 '"status":"pending"'; then
  [[ $BODY == *invalid_input* ]] && echo "    ${D}hint: allow the host in SOURCE_URL_HOSTS (e.g. SOURCE_URL_HOSTS=* locally)${N}"
  echo; echo "$pass passed, $fail failed"; exit 1
fi
ID=$(json_field id)
echo "    ${D}id=$ID${N}"

status=pending
for ((i = 1; i <= MAX_POLLS; i++)); do
  req POST "/documents/$ID/process"
  if [[ $STATUS == 502 ]]; then echo "    ${D}502 (retryable) — retrying: $BODY${N}"; sleep 2; continue; fi
  if [[ $STATUS != 200 ]]; then bad 'POST /documents/:id/process' "HTTP $STATUS: $BODY"; break; fi
  status=$(json_field status)
  echo "    ${D}process #$i → $status $(json_field processed)/$(json_field total)${N}"
  [[ $status == ready || $status == failed ]] && break
  sleep 1
done
if [[ $status == ready ]]; then ok 'document processed to ready'; else bad 'document processed to ready' "final status: $status $BODY"; fi

req POST "/documents/$ID/process"
expect 'calling /process again is a no-op' 200 "\"status\":\"$status\""

req GET "/documents/$ID"
expect 'GET /documents/:id' 200 "\"id\":\"$ID\""

req GET '/documents?limit=1'
expect 'GET /documents?limit=1 (list + nextCursor)' 200 '"nextCursor"'

req DELETE "/documents/$ID"
expect 'DELETE /documents/:id' 200 '"deleted":true'
req GET "/documents/$ID"
expect 'deleted document → 404' 404 '"code":"not_found"'

echo
if ((fail == 0)); then echo "${G}All $pass checks passed.${N}"; else echo "${R}$fail failed${N}, $pass passed."; fi
exit $((fail > 0))
