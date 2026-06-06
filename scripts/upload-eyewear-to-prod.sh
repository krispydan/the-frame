#!/bin/bash
# upload-eyewear-to-prod.sh
#
# Push the three local eyewear-crawl CSVs to prod in a single
# multipart/form-data request, run the import, refresh smart lists.
#
# Usage:
#   ./scripts/upload-eyewear-to-prod.sh           # full run
#   ./scripts/upload-eyewear-to-prod.sh --no-classifier
#   ./scripts/upload-eyewear-to-prod.sh --dry-run
#   ./scripts/upload-eyewear-to-prod.sh --limit 100
#
# Input files (must exist in ~/Downloads/):
#   sunglasses-products.csv  ~24 MB
#   sunglasses-state.jsonl   ~20 MB
#   apparel-filtered.csv     ~17 MB
# Total ~60 MB → multipart request fits under Cloudflare's 100 MB cap.
#
# This calls the user-facing REST endpoint at
#   POST /api/v1/sales/import-eyewear-crawl
# which is the same path the `sales.import_eyewear_crawl` MCP tool
# uses internally. Dedup is by normalized domain — re-running this
# is safe (existing rows get COALESCE-merged with the fresh data).
set -euo pipefail

BASE_URL="${BASE_URL:-https://theframe.getjaxy.com}"
IMPORT_URL="$BASE_URL/api/v1/sales/import-eyewear-crawl"
SEED_URL="$BASE_URL/api/admin/eyewear-seed-smart-lists"
ADMIN_KEY="${ADMIN_KEY:-jaxy2026}"

DOWNLOADS="${HOME}/Downloads"
PRODUCTS="$DOWNLOADS/sunglasses-products.csv"
STATE="$DOWNLOADS/sunglasses-state.jsonl"
COHORT="$DOWNLOADS/apparel-filtered.csv"

for P in "$PRODUCTS" "$STATE" "$COHORT"; do
  if [ ! -f "$P" ]; then
    echo "❌ Missing input: $P"
    exit 1
  fi
done

# Auth: user-facing /api/v1/sales/* endpoints require a session-token
# cookie. Read it from the SESSION_TOKEN env var. Easiest to grab from
# the browser DevTools → Application → Cookies tab on theframe.getjaxy.com.
if [ -z "${SESSION_TOKEN:-}" ]; then
  echo "❌ SESSION_TOKEN env var required."
  echo "   Grab from browser DevTools → Application → Cookies → session-token"
  exit 1
fi

# Forward CLI flags to the import endpoint as form fields.
EXTRA_ARGS=""
for ARG in "$@"; do
  case "$ARG" in
    --no-classifier) EXTRA_ARGS="$EXTRA_ARGS -F noClassifier=true" ;;
    --dry-run)       EXTRA_ARGS="$EXTRA_ARGS -F dryRun=true" ;;
    --limit)         shift; EXTRA_ARGS="$EXTRA_ARGS -F limit=${1:-0}" ;;
  esac
done

echo "📤 Uploading 3 CSVs ($(du -ch "$PRODUCTS" "$STATE" "$COHORT" | tail -1 | cut -f1)) to $IMPORT_URL"
echo "   This is a single multipart request — be patient on the upload."

curl -s --max-time 600 -X POST "$IMPORT_URL" \
  -H "cookie: session-token=$SESSION_TOKEN" \
  -F "products=@$PRODUCTS" \
  -F "state=@$STATE" \
  -F "cohort=@$COHORT" \
  $EXTRA_ARGS | python3 -m json.tool

echo
echo "📋 Refreshing Smart Lists on prod..."
curl -s -X POST "$SEED_URL" \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool

echo
echo "✅ Done."
