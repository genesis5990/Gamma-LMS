#!/usr/bin/env bash
# scripts/smoke.sh — Post-deploy smoke test for mygenesis-training
#
# Verifies that the deployed site is healthy and core static assets resolve.
# Exits non-zero on any failure. Designed to be safe to run repeatedly.
#
# Usage:
#   ./scripts/smoke.sh                          # tests https://mygenesis-training.fly.dev
#   ./scripts/smoke.sh https://www.mygenesis-training.com
#   BASE=http://localhost:8080 ./scripts/smoke.sh

set -u
BASE="${1:-${BASE:-https://mygenesis-training.fly.dev}}"
BASE="${BASE%/}"   # strip trailing slash

# ANSI colors (off if not a TTY)
if [ -t 1 ]; then
  G=$(printf '\033[32m'); R=$(printf '\033[31m'); Y=$(printf '\033[33m'); D=$(printf '\033[0m')
else
  G=''; R=''; Y=''; D=''
fi

PASS=0; FAIL=0
echo "Smoke-testing $BASE"
echo "------------------------------------------------------------"

# check <name> <expected_status> <path> [grep_pattern]
check() {
  local name="$1" want="$2" path="$3" grep_pat="${4:-}"
  local url="$BASE$path"
  local body
  local code
  body=$(curl -s -o /tmp/.smoke_body -w '%{http_code}' --max-time 15 "$url")
  code="$body"
  if [ "$code" != "$want" ]; then
    printf "  ${R}FAIL${D}  %-32s  expected %s, got %s  (%s)\n" "$name" "$want" "$code" "$url"
    FAIL=$((FAIL+1)); return
  fi
  if [ -n "$grep_pat" ]; then
    if ! grep -q -- "$grep_pat" /tmp/.smoke_body; then
      printf "  ${R}FAIL${D}  %-32s  pattern not found: %s\n" "$name" "$grep_pat"
      FAIL=$((FAIL+1)); return
    fi
  fi
  printf "  ${G}OK${D}    %-32s  %s\n" "$name" "$path"
  PASS=$((PASS+1))
}

# ---- Core endpoints --------------------------------------------------------
check "health endpoint"            200 "/health"           '"ok"'
check "root redirect/landing"      200 "/"
check "course shell"               200 "/course.html"      "Crypto 101"
check "admin shell"                 200 "/admin.html"       "Admin Dashboard"
check "supabase config"            200 "/config.js"        "SUPABASE_URL"
check "auth helper"                200 "/auth.js"          "signInWithEmail"
check "course data"                200 "/course_data.json" '"lessons"'
check "tenant routing (deconflict)" 200 "/deconflict"      "Crypto 101"
check "tenant admin routing"        200 "/deconflict/admin" "Admin Dashboard"
check "super-admin route"           200 "/admin"            "Admin Dashboard"
check "verify page"                 200 "/verify"           "Verify certificate"
check "deconflict logo"             200 "/assets/tenants/deconflict/Logo-With-Text-White.svg"

# ---- Fallback behavior -----------------------------------------------------
# Unknown routes serve the neutral GDAA landing with a 404 status.
check "unknown route fallback"     404 "/this-should-not-exist.html" "Genesis Digital Assets Academy"

# ---- Smoke-only checks for production endpoints ----------------------------
# These only run when BASE is https://...
if [[ "$BASE" == https://* ]]; then
  # Check that course.html doesn't accidentally leak the service-role secret
  if curl -s --max-time 15 "$BASE/course.html" | grep -qE 'service_role|SUPABASE_SERVICE_ROLE|sb_secret_'; then
    printf "  ${R}FAIL${D}  %-32s  service-role secret found in course.html\n" "no service-role leak"
    FAIL=$((FAIL+1))
  else
    printf "  ${G}OK${D}    %-32s  /course.html\n" "no service-role leak"
    PASS=$((PASS+1))
  fi
fi

echo "------------------------------------------------------------"
TOTAL=$((PASS+FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "${G}All $TOTAL checks passed.${D}"
  exit 0
else
  echo "${R}$FAIL of $TOTAL checks failed.${D}"
  exit 1
fi
