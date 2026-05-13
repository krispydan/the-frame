#!/usr/bin/env bash
# sync-prod-db.sh
#
# Pull a fresh snapshot of the production SQLite DB from Railway.
# Updates a single rolling file at backups/the-frame-prod.db so that any
# TablePlus connection you've saved pointing at that path automatically
# reflects the latest data on the next refresh in the GUI.
#
# Usage:
#   ./scripts/sync-prod-db.sh         # overwrite the rolling snapshot
#   ./scripts/sync-prod-db.sh --keep  # also keep a timestamped archive
#
# Requires:
#   - railway CLI installed + logged in (brew install railway)
#   - Linked to the the-frame service: `railway service the-frame`
#   - python3 (only as a fallback if macOS base64 -d misbehaves)

set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUPS_DIR="$REPO_ROOT/backups"
ROLLING="$BACKUPS_DIR/the-frame-prod.db"
TMP_B64="$BACKUPS_DIR/.snap-in-progress.b64"
TMP_DB="$BACKUPS_DIR/.snap-in-progress.db"

mkdir -p "$BACKUPS_DIR"

echo "[sync-prod-db] Starting snapshot via railway ssh + node..."

# Take a consistent snapshot on the remote (handles WAL checkpoint), base64
# encode to stdout, and capture locally. sqlite3 CLI isn't installed in the
# prod container — we use the better-sqlite3 already on the box.
railway ssh "cd /app && node -e \"
const Database = require('better-sqlite3');
const fs = require('fs');
const src = new Database('/data/the-frame.db');
src.backup('/tmp/snap.db').then(() => {
  process.stdout.write(fs.readFileSync('/tmp/snap.db').toString('base64'));
  fs.unlinkSync('/tmp/snap.db');
}).catch(e => { console.error(e); process.exit(1); });
\"" > "$TMP_B64"

# Decode — fall back to python3 if BSD base64 chokes on no-newline input.
if ! base64 --decode -i "$TMP_B64" -o "$TMP_DB" 2>/dev/null; then
  echo "[sync-prod-db] BSD base64 failed, using python3 fallback..."
  python3 -c "import base64; open('$TMP_DB','wb').write(base64.b64decode(open('$TMP_B64','rb').read()))"
fi
rm -f "$TMP_B64"

# Validate before swapping
echo "[sync-prod-db] Validating snapshot..."
if ! sqlite3 "$TMP_DB" "PRAGMA integrity_check;" | grep -q "^ok$"; then
  echo "[sync-prod-db] ✗ Integrity check failed — keeping previous snapshot, removing bad file."
  rm -f "$TMP_DB"
  exit 1
fi

# Swap atomically
mv "$TMP_DB" "$ROLLING"
SIZE="$(du -h "$ROLLING" | awk '{print $1}')"

# Optional: keep a timestamped copy
if [ "${1:-}" = "--keep" ]; then
  STAMPED="$BACKUPS_DIR/the-frame-prod-$(date +%Y%m%d-%H%M%S).db"
  cp "$ROLLING" "$STAMPED"
  echo "[sync-prod-db] ✓ Snapshot refreshed ($SIZE)"
  echo "[sync-prod-db]   Rolling:  $ROLLING"
  echo "[sync-prod-db]   Archived: $STAMPED"
else
  echo "[sync-prod-db] ✓ Snapshot refreshed ($SIZE) at $ROLLING"
fi

# Quick stats so you know what landed
sqlite3 "$ROLLING" "
  SELECT printf('  %-22s %8d rows', name, (SELECT COUNT(*) FROM " '"' "' || name || '" '"' ")) AS line
  FROM sqlite_master
  WHERE type = 'table' AND name IN ('companies', 'orders', 'catalog_products', 'catalog_skus', 'shopify_shops')
  ORDER BY name;
" 2>/dev/null || true
