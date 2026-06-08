#!/bin/bash
# disqualify-by-keyword.sh
#
# Bulk-disqualify (status='rejected') companies whose name /
# description / meta_description / top_brand / industry / tags
# contain any of the supplied keywords. Idempotent — already-
# rejected rows aren't re-touched.
#
# Wraps POST /api/admin/disqualify-by-keyword.
#
# Usage:
#   ./scripts/disqualify-by-keyword.sh --dry-run "jewelry" "fine jewelry"
#   ./scripts/disqualify-by-keyword.sh --reason "Jewelry — not Jaxy ICP" "jewelry"
#
# Defaults to dry-run unless --apply is passed, so you get a
# safety preview first.
set -euo pipefail

BASE_URL="${BASE_URL:-https://theframe.getjaxy.com}"
URL="$BASE_URL/api/admin/disqualify-by-keyword"
ADMIN_KEY="${ADMIN_KEY:-jaxy2026}"

APPLY=false
REASON=""
KEYWORDS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)   APPLY=true; shift ;;
    --dry-run) APPLY=false; shift ;;
    --reason)  REASON="${2:-}"; shift 2 ;;
    *)         KEYWORDS+=("$1"); shift ;;
  esac
done

if [ ${#KEYWORDS[@]} -eq 0 ]; then
  echo "Usage: $0 [--apply] [--reason 'text'] <keyword1> [keyword2] ..."
  echo "Default is dry-run. Pass --apply to actually update rows."
  exit 1
fi

# Build JSON array of keywords
KW_JSON=$(printf '%s\n' "${KEYWORDS[@]}" | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
# Python booleans are PascalCase — substituting shell-style lowercase
# `true`/`false` blew up with NameError. Use Python literals here.
DRY=$([ "$APPLY" = "true" ] && echo "False" || echo "True")
REASON_JSON=${REASON:-"${KEYWORDS[*]} — disqualified by keyword sweep"}

# Pass values via env to the python3 inline script — avoids the
# pain of escaping em-dashes and quotes inside a heredoc-style
# string substitution.
BODY=$(KW="$KW_JSON" R="$REASON_JSON" D="$DRY" python3 -c "
import os, json
print(json.dumps({
  'keywords': json.loads(os.environ['KW']),
  'reason':   os.environ['R'],
  'dry_run':  os.environ['D'] == 'True',
}))
")

echo "📡 POST $URL"
echo "   keywords: ${KEYWORDS[*]}"
echo "   reason:   $REASON_JSON"
echo "   dry_run:  $DRY"
echo

curl -s -X POST "$URL" \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" | python3 -m json.tool

if [ "$APPLY" = "false" ]; then
  echo
  echo "ℹ️  Dry-run only. Add --apply to actually disqualify."
fi
