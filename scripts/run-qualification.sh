#!/bin/bash
# Run Gemma 4 qualification with DB sync and crash recovery
# Usage: ./run-qualification.sh [--limit N]

set -euo pipefail

DB_LOCAL="/tmp/the-frame-live.db"
PROGRESS="/tmp/gemma4-qualify-progress.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LIMIT="${1:-999999}"
UPLOAD_EVERY=100  # Upload to Railway every N prospects

echo "========================================="
echo "  Jaxy Prospect Qualification Pipeline"
echo "========================================="
echo ""

# 1. Check Ollama
if ! curl -s http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
    echo "❌ Ollama not running. Starting..."
    brew services start ollama
    sleep 5
fi

# Verify gemma4 model
if ! curl -s http://127.0.0.1:11434/api/tags | grep -q "gemma4"; then
    echo "❌ gemma4 model not found in Ollama"
    exit 1
fi
echo "✅ Ollama + Gemma 4 ready"

# 2. Download fresh DB from Railway
echo "📥 Downloading DB from Railway..."
cd "$REPO_DIR"
railway ssh -- base64 /data/the-frame.db 2>/dev/null | base64 -d > "$DB_LOCAL.tmp"

# Verify it's a valid SQLite file
if ! file "$DB_LOCAL.tmp" | grep -q "SQLite"; then
    echo "❌ Downloaded file is not valid SQLite!"
    rm -f "$DB_LOCAL.tmp"
    exit 1
fi

# Only overwrite if we got a valid file
mv "$DB_LOCAL.tmp" "$DB_LOCAL"
echo "✅ DB downloaded ($(du -h "$DB_LOCAL" | cut -f1))"

# 3. Ensure columns exist
sqlite3 "$DB_LOCAL" "ALTER TABLE companies ADD COLUMN ai_reviewed_by TEXT;" 2>/dev/null || true
sqlite3 "$DB_LOCAL" "ALTER TABLE companies ADD COLUMN ai_confidence INTEGER;" 2>/dev/null || true

# 4. Show pre-run stats
echo ""
echo "📊 Pre-run stats:"
sqlite3 "$DB_LOCAL" "
SELECT '  Total: ' || COUNT(*) FROM companies;
SELECT '  New (unreviewed): ' || COUNT(*) FROM companies WHERE status='new' AND website IS NOT NULL AND website != '' AND (ai_reviewed_by IS NULL);
SELECT '  Already qualified: ' || COUNT(*) FROM companies WHERE status='qualified';
SELECT '  Already DQ: ' || COUNT(*) FROM companies WHERE status='not_qualified';
"

# 5. Run the qualifier
echo ""
echo "🚀 Starting qualification..."
python3 "$SCRIPT_DIR/gemma4-qualify-v2.py" --db "$DB_LOCAL" --limit "$LIMIT" --batch-size 5

# 6. Show post-run stats
echo ""
echo "📊 Post-run stats:"
sqlite3 "$DB_LOCAL" "
SELECT '  Total: ' || COUNT(*) FROM companies;
SELECT '  AI reviewed (v2): ' || COUNT(*) FROM companies WHERE ai_reviewed_by = 'gemma4-v2';
SELECT '  Qualified: ' || COUNT(*) FROM companies WHERE status='qualified';
SELECT '  Not qualified: ' || COUNT(*) FROM companies WHERE status='not_qualified';
SELECT '  Needs review: ' || COUNT(*) FROM companies WHERE status='new';
"

# 7. Upload back to Railway
echo ""
echo "📤 Uploading results to Railway..."
cd "$REPO_DIR"

# Use the admin upload endpoint (safer than SSH pipe for large files)
DOMAIN="the-frame-production.up.railway.app"
curl -s -X POST "https://$DOMAIN/api/admin/upload" \
  -H "x-upload-secret: jaxy2026" \
  -F "file=@$DB_LOCAL;filename=the-frame.db" \
  -F "path=the-frame.db" && echo "✅ Upload complete" || echo "❌ Upload failed — trying base64 method..."

echo ""
echo "🎉 Done!"
