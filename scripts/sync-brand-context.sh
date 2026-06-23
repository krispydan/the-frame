#!/usr/bin/env bash
#
# Sync the brand-context snapshot from Google Drive into the repo.
#
# The marketing-email assistant reads brand docs from
# src/modules/marketing/brand-context/ for zero-latency, version-
# controlled loading. The masters live in Google Drive. Run this on
# demand to refresh the snapshot, then review the diff and commit.
#
# Usage:
#   scripts/sync-brand-context.sh [SOURCE_DIR]
#
#   SOURCE_DIR defaults to $BRAND_DRIVE_DIR, else the documented path.
#   Override per-run:  scripts/sync-brand-context.sh "/path/to/brand"
#
# It matches source files case-insensitively and copies them to the
# canonical snapshot names. Missing sources are warned, not fatal.

set -euo pipefail

DEFAULT_DIR="${HOME}/Library/CloudStorage/GoogleDrive-/My Drive/brand"
SRC="${1:-${BRAND_DRIVE_DIR:-$DEFAULT_DIR}}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${REPO_ROOT}/src/modules/marketing/brand-context"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: source dir not found: $SRC" >&2
  echo "Set BRAND_DRIVE_DIR or pass the path as an argument." >&2
  exit 1
fi

mkdir -p "$DEST"

# Map of: snapshot-name => space-separated candidate source basenames
# (matched case-insensitively).
sync_one() {
  local dest_name="$1"; shift
  local found=""
  for cand in "$@"; do
    # case-insensitive find, first match wins
    found="$(find "$SRC" -maxdepth 2 -iname "$cand" -type f 2>/dev/null | head -n1 || true)"
    [[ -n "$found" ]] && break
  done
  if [[ -n "$found" ]]; then
    cp "$found" "$DEST/$dest_name"
    echo "  ✓ $dest_name  ←  $(basename "$found")"
  else
    echo "  ⚠ $dest_name  — no source found (candidates: $*)" >&2
  fi
}

echo "Syncing brand context from: $SRC"
sync_one "brand-bible.md"          "BRAND-BIBLE.md" "brand-bible.md" "brand bible.md"
sync_one "wholesale-voice.md"      "WHOLESALE-VOICE.md" "wholesale-voice.md" "wholesale voice.md"
sync_one "visual-guidelines.md"    "VISUAL-GUIDELINES.md" "visual-guidelines.md" "BRAND-GUIDELINES.md" "visual guidelines.md"
sync_one "photography-aesthetic.md" "PHOTOGRAPHY-AESTHETIC.md" "photography-aesthetic.md" "photo-aesthetic.md"

echo "Done. Review changes:  git diff -- $DEST"
