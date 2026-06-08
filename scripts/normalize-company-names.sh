#!/bin/bash
# normalize-company-names.sh
#
# Sweep companies.name for formatting cruft introduced by upstream
# CSV imports — wrapped quotes, leading social-handle hash, runs of
# internal whitespace — and clean them up.
#
# Wraps POST /api/admin/normalize-company-names.
#
# Examples:
#   '""FREE""'      → 'FREE'        (CSV double-escaped quotes)
#   '#GunTherapy'   → 'GunTherapy'  (social-handle copy)
#   'Acme  Boutique'→ 'Acme Boutique' (collapsed double space)
#
# Usage:
#   ./scripts/normalize-company-names.sh              # dry-run (default)
#   ./scripts/normalize-company-names.sh --apply      # actually update
#
# Defaults to dry-run for safety. Always review the sample output
# before running with --apply.
set -euo pipefail

BASE_URL="${BASE_URL:-https://theframe.getjaxy.com}"
URL="$BASE_URL/api/admin/normalize-company-names"
ADMIN_KEY="${ADMIN_KEY:-jaxy2026}"

APPLY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)   APPLY=true; shift ;;
    --dry-run) APPLY=false; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Python booleans are PascalCase — see disqualify-by-keyword.sh for
# the same pattern.
DRY=$([ "$APPLY" = "true" ] && echo "False" || echo "True")
BODY=$(D="$DRY" python3 -c "
import os, json
print(json.dumps({ 'dry_run': os.environ['D'] == 'True' }))
")

echo "📡 POST $URL"
echo "   dry_run: $DRY"
echo

curl -s -X POST "$URL" \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" | python3 -m json.tool

if [ "$APPLY" = "false" ]; then
  echo
  echo "ℹ️  Dry-run only. Review the 'sample' above, then re-run with --apply."
fi
