#!/bin/bash
# upload-eyewear-to-prod.sh
#
# Chunked upload of the three eyewear-crawl CSVs to prod, then trigger
# the import, then refresh the canned Smart Lists.
#
# We chunk at 4 MB because Cloudflare's request body limit is 100 MB
# on the free/pro plans — total payload here is ~160 MB (apparel-
# filtered.csv alone is ~101 MB), so a single multipart request would
# get rejected at the edge before reaching Next.js.
#
# Usage:
#   ./scripts/upload-eyewear-to-prod.sh           # full run with classifier
#   ./scripts/upload-eyewear-to-prod.sh --no-classifier
#   ./scripts/upload-eyewear-to-prod.sh --dry-run
#   ./scripts/upload-eyewear-to-prod.sh --limit 100
#
# Files expected in ~/Downloads/:
#   sunglasses-products.csv   ~31 MB
#   sunglasses-state.jsonl    ~28 MB
#   apparel-filtered.csv      ~101 MB
# Total ~160 MB → ~40 chunks @ 4 MB → ~2-3 minute upload, then import.
set -euo pipefail

# Auth: chunked admin endpoint uses x-admin-key (matches restore-db
# pattern). No session-token needed for this script.
ADMIN_KEY="${ADMIN_KEY:-jaxy2026}"
BASE_URL="${BASE_URL:-https://theframe.getjaxy.com}"
IMPORT_URL="$BASE_URL/api/admin/eyewear-import"
SEED_URL="$BASE_URL/api/admin/eyewear-seed-smart-lists"
CHUNK_SIZE=4194304   # 4 MB

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

post_json() {
  curl -s -X POST "$IMPORT_URL" \
    -H "x-admin-key: $ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d "$1"
}

# 1. Pre-flight check — endpoint must exist
echo "🔍 Checking endpoint deploy status…"
PRE=$(post_json '{"action":"status"}' 2>&1 | head -c 200)
if echo "$PRE" | grep -q "404\|This page could not be found"; then
  echo "❌ Endpoint not deployed yet. Check Railway dashboard for build/deploy status."
  echo "   Current prod commit: $(curl -s $BASE_URL/api/health | python3 -c 'import sys,json; print(json.load(sys.stdin).get(\"version\",\"unknown\"))')"
  exit 1
fi
echo "  $PRE"

# 2. Reset all three staging files on the server
echo
echo "🧹 Resetting staging on prod…"
post_json '{"action":"start"}'
echo

# 3. Upload each file in chunks
for KEY in products state cohort; do
  case "$KEY" in
    products) P="$PRODUCTS" ;;
    state)    P="$STATE" ;;
    cohort)   P="$COHORT" ;;
  esac
  SIZE=$(stat -f%z "$P" 2>/dev/null || stat -c%s "$P")
  CHUNKS=$(( (SIZE + CHUNK_SIZE - 1) / CHUNK_SIZE ))
  HUMAN=$(du -h "$P" | cut -f1)
  echo
  echo "📤 Uploading $KEY ($HUMAN, $CHUNKS chunks)…"

  CHUNK_NUM=0
  while [ $CHUNK_NUM -lt $CHUNKS ]; do
    CHUNK_NUM=$((CHUNK_NUM + 1))
    # Build the JSON body in a tmpfile and stream it to curl via
    # --data-binary @file. Inline -d on a 4MB chunk overflows
    # ARG_MAX on macOS (~256KB). Also strip newlines from base64
    # output — macOS `base64` line-wraps at 76 columns by default,
    # and raw \n inside a JSON string literal is a parse error.
    TMP_BODY="$(mktemp -t eyewear-chunk.XXXXXX)"
    {
      printf '{"action":"chunk","file":"%s","chunk":%d,"data":"' "$KEY" "$CHUNK_NUM"
      dd if="$P" bs=$CHUNK_SIZE skip=$((CHUNK_NUM - 1)) count=1 2>/dev/null | base64 | tr -d '\n'
      printf '"}'
    } > "$TMP_BODY"

    RESP=$(curl -s -X POST "$IMPORT_URL" \
      -H "x-admin-key: $ADMIN_KEY" \
      -H "Content-Type: application/json" \
      --data-binary "@$TMP_BODY")
    rm -f "$TMP_BODY"

    SIZE_AFTER=$(echo "$RESP" | python3 -c "import sys,json
try: d=json.load(sys.stdin); print(d.get('size','?'))
except: print('parse-error')" 2>/dev/null || echo "?")
    printf "\r  chunk %d/%d → %s bytes on disk     " "$CHUNK_NUM" "$CHUNKS" "$SIZE_AFTER"
  done
  echo
done

# 4. Trigger the import (forward CLI flags)
echo
echo "🚀 Triggering import on prod…"
RUN_BODY='{"action":"run"'
NEXT_IS_LIMIT=false
for ARG in "$@"; do
  if [ "$NEXT_IS_LIMIT" = "true" ]; then
    RUN_BODY="$RUN_BODY,\"limit\":$ARG"
    NEXT_IS_LIMIT=false
    continue
  fi
  case "$ARG" in
    --no-classifier) RUN_BODY="$RUN_BODY,\"noClassifier\":true" ;;
    --dry-run)       RUN_BODY="$RUN_BODY,\"dryRun\":true" ;;
    --limit)         NEXT_IS_LIMIT=true ;;
  esac
done
RUN_BODY="$RUN_BODY}"
echo "  body: $RUN_BODY"

# This can take up to 5 min on Railway under load. maxDuration on the
# route is 300s; give curl matching headroom.
curl -s --max-time 360 -X POST "$IMPORT_URL" \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "$RUN_BODY" | python3 -m json.tool

# 5. Cleanup staging
echo
echo "🧹 Cleaning up staging on prod…"
post_json '{"action":"cleanup"}'
echo

# 6. Refresh smart lists
echo
echo "📋 Refreshing Smart Lists on prod…"
curl -s -X POST "$SEED_URL" \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool
echo

echo "✅ Done."
