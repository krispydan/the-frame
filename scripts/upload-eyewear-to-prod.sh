#!/bin/bash
# upload-eyewear-to-prod.sh
#
# Push the three local eyewear-crawl CSVs to prod via the admin
# chunked-upload endpoint, then trigger the import. Modeled after
# upload-db.sh — same auth, same 4 MB chunk size, same chunked
# base64 protocol.
#
# Usage:
#   ./scripts/upload-eyewear-to-prod.sh           # full run (with classifier)
#   ./scripts/upload-eyewear-to-prod.sh --no-classifier
#   ./scripts/upload-eyewear-to-prod.sh --limit 100   # cap NEW inserts per cohort
#
# Files expected in ~/Downloads/:
#   sunglasses-products.csv     ~24 MB
#   sunglasses-state.jsonl      ~20 MB
#   apparel-filtered.csv        ~17 MB
# Total ~60 MB → ~16 chunks at 4 MB each → ~30-60s upload, then run.
set -euo pipefail

API="https://the-frame-production.up.railway.app/api/admin/eyewear-import"
ADMIN_KEY="${ADMIN_KEY:-jaxy2026}"
CHUNK_SIZE=4194304  # 4 MB

DOWNLOADS="${HOME}/Downloads"
declare -A FILES=(
  [products]="${DOWNLOADS}/sunglasses-products.csv"
  [state]="${DOWNLOADS}/sunglasses-state.jsonl"
  [cohort]="${DOWNLOADS}/apparel-filtered.csv"
)

# Sanity check inputs
for KEY in "${!FILES[@]}"; do
  P="${FILES[$KEY]}"
  if [ ! -f "$P" ]; then
    echo "❌ Missing input: $P"
    exit 1
  fi
done

post_json() {
  local body="$1"
  curl -s -X POST "$API" \
    -H "x-admin-key: $ADMIN_KEY" \
    -H "Content-Type: application/json" \
    -d "$body"
}

# 1. Reset staging on the server
echo "🧹 Resetting staging on prod…"
RESP=$(post_json '{"action":"start"}')
echo "  $RESP"

# 2. Upload each file in chunks
for KEY in products state cohort; do
  P="${FILES[$KEY]}"
  SIZE=$(stat -f%z "$P" 2>/dev/null || stat -c%s "$P")
  CHUNKS=$(( (SIZE + CHUNK_SIZE - 1) / CHUNK_SIZE ))
  HUMAN=$(du -h "$P" | cut -f1)
  echo
  echo "📤 Uploading $KEY ($HUMAN, $CHUNKS chunks)…"

  # Start (clears just this file's staging)
  post_json "{\"action\":\"start\",\"file\":\"$KEY\"}" > /dev/null

  CHUNK_NUM=0
  while [ $CHUNK_NUM -lt $CHUNKS ]; do
    CHUNK_NUM=$((CHUNK_NUM + 1))
    # Extract chunk N (1-indexed) as base64
    DATA=$(dd if="$P" bs=$CHUNK_SIZE skip=$((CHUNK_NUM - 1)) count=1 2>/dev/null | base64)
    # POST it. Use printf to safely embed the base64 string in the JSON.
    BODY=$(printf '{"action":"chunk","file":"%s","chunk":%d,"data":"%s"}' "$KEY" "$CHUNK_NUM" "$DATA")
    SIZE_AFTER=$(post_json "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('size','?'))" 2>/dev/null || echo "?")
    echo "  chunk $CHUNK_NUM/$CHUNKS  → $SIZE_AFTER bytes on disk"
  done
done

# 3. Trigger the import
echo
echo "🚀 Triggering import on prod…"
RUN_BODY='{"action":"run"'
for ARG in "$@"; do
  case "$ARG" in
    --no-classifier) RUN_BODY="$RUN_BODY,\"noClassifier\":true" ;;
    --dry-run)       RUN_BODY="$RUN_BODY,\"dryRun\":true" ;;
    --limit)         shift; RUN_BODY="$RUN_BODY,\"limit\":${1:-0}" ;;
  esac
done
RUN_BODY="$RUN_BODY}"
echo "  $RUN_BODY"

# Important: this can take 60-300s on Railway. Use long curl timeout.
curl -s --max-time 360 -X POST "$API" \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "$RUN_BODY" | python3 -m json.tool

# 4. Cleanup staging
echo
echo "🧹 Cleaning up staging on prod…"
post_json '{"action":"cleanup"}'
echo

echo "✅ Done."
