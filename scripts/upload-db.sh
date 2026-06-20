#!/bin/bash
# Upload local DB to Railway via chunked API
set -euo pipefail

DB_PATH="${1:-/tmp/the-frame-live.db}"
API="https://the-frame-production.up.railway.app/api/admin/restore-db"
ADMIN_KEY="jaxy2026"
CHUNK_SIZE=4194304  # 4MB chunks

echo "📤 Uploading $(du -h "$DB_PATH" | cut -f1) to Railway..."

# Start upload
curl -s -X POST "$API" -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"action":"start"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'  Status: {d.get(\"status\",\"error\")}')"

# Split and upload chunks
TOTAL_SIZE=$(stat -f%z "$DB_PATH" 2>/dev/null || stat -c%s "$DB_PATH")
CHUNK_NUM=0
OFFSET=0

while [ $OFFSET -lt $TOTAL_SIZE ]; do
    CHUNK_NUM=$((CHUNK_NUM + 1))
    CHUNK_JSON=$(mktemp)
    # Write chunk payload to a temp JSON file so curl does not hit shell argv limits.
    dd if="$DB_PATH" bs=$CHUNK_SIZE skip=$((CHUNK_NUM - 1)) count=1 2>/dev/null \
      | python3 -c "import base64, json, sys; json.dump({'action': 'chunk', 'data': base64.b64encode(sys.stdin.buffer.read()).decode('ascii'), 'chunk': $CHUNK_NUM}, sys.stdout)" \
      > "$CHUNK_JSON"

    RESP=$(curl -s -X POST "$API" -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
      --data-binary @"$CHUNK_JSON")
    rm -f "$CHUNK_JSON"
    
    UPLOADED=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('size',0))" 2>/dev/null || echo "?")
    echo "  Chunk $CHUNK_NUM: ${UPLOADED} bytes uploaded"
    
    OFFSET=$((OFFSET + CHUNK_SIZE))
done

# Finish
RESP=$(curl -s -X POST "$API" -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"action":"finish"}')
echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'✅ Upload complete: {d.get(\"size\",0)} bytes')" 2>/dev/null || echo "❌ Upload response: $RESP"
