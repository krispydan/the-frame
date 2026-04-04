#!/bin/bash
# Quick status check on the running qualification job
PROGRESS="/tmp/gemma4-qualify-progress.json"
PID_FILE="/tmp/gemma4-qualify.pid"
LOG="/tmp/gemma4-qualify-run.log"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "✅ Process running (PID $PID)"
    else
        echo "❌ Process NOT running (PID $PID)"
    fi
fi

if [ -f "$PROGRESS" ]; then
    python3 -c "
import json
d = json.load(open('$PROGRESS'))
print(f\"📊 {d['processed']}/{d['total_prospects']} ({d['status']})\")
print(f\"   ✅ Qualified: {d['qualified']}\")
print(f\"   ❌ Not Qualified: {d['not_qualified']}\")
print(f\"   🔍 Needs Review: {d['needs_review']}\")
print(f\"   📧 Emails: {d['emails_found']}\")
print(f\"   ⏱️  {d['rate_per_min']}/min | Elapsed: {d['elapsed_seconds']//60}min\")
remaining = d['total_prospects'] - d['processed']
if d['rate_per_min'] > 0:
    eta = remaining / d['rate_per_min']
    print(f\"   ETA: {eta:.0f} min ({eta/60:.1f} hrs)\")
"
else
    echo "No progress file yet"
fi

if [ -f "$LOG" ]; then
    echo ""
    echo "Last 5 log lines:"
    tail -5 "$LOG"
fi
