#!/usr/bin/env python3
"""
Re-key catalog_images rows whose current checksum points at a file
that doesn't exist on prod, by replacing the bytes + checksum + path
with a matching Desktop source file.

Reads scripts/sync-report.json produced by sync-images-to-prod.py and
processes its `checksum_mismatch` entries. For each entry:
  - Pick the most appropriate Desktop candidate (prefer *-FRONT*).
  - POST to /api/admin/rekey-image with the file bytes and row id.

Writes scripts/rekey-report.json with results.

Usage:
  python3 scripts/rekey-mismatched-images.py           # live
  python3 scripts/rekey-mismatched-images.py --dry     # plan only
  python3 scripts/rekey-mismatched-images.py --source square  # filter
"""
import argparse
import base64
import json
import os
import sys
import urllib.request
import urllib.error

API_BASE = "https://theframe.getjaxy.com"
ADMIN_KEY = "jaxy2026"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SYNC_REPORT = os.path.join(SCRIPT_DIR, "sync-report.json")
REKEY_REPORT = os.path.join(SCRIPT_DIR, "rekey-report.json")

def api_post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=data,
        headers={
            "x-admin-key": ADMIN_KEY,
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": str(e)}

def pick_best_candidate(candidates, prefer_suffixes=("FRONT",)):
    """From a list of {path, sha} dicts, pick the best candidate.

    Prefer files whose filename contains one of `prefer_suffixes`
    (e.g. "FRONT"), falling back to the first valid candidate.
    """
    valid = [c for c in candidates if c.get("path") and c.get("sha")]
    if not valid:
        return None
    for c in valid:
        name = os.path.basename(c["path"]).upper()
        if any(s in name for s in prefer_suffixes):
            return c
    return valid[0]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--source", default=None, help="only process entries with this source")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    if not os.path.isfile(SYNC_REPORT):
        print(f"ERROR: sync report not found at {SYNC_REPORT}", file=sys.stderr)
        print("Run sync-images-to-prod.py first.", file=sys.stderr)
        sys.exit(2)

    with open(SYNC_REPORT) as f:
        sync = json.load(f)

    mismatches = sync.get("checksum_mismatch") or []
    if args.source:
        mismatches = [m for m in mismatches if m.get("source") == args.source]
    if args.limit is not None:
        mismatches = mismatches[:args.limit]

    print(f"Processing {len(mismatches)} checksum_mismatch entries")

    report = {
        "total_attempted": len(mismatches),
        "rekeyed": [],
        "no_candidate": [],
        "errors": [],
    }

    for idx, m in enumerate(mismatches, 1):
        row_id = m.get("id")
        source = m.get("source")
        key = m.get("key")
        expected = m.get("expected")
        candidates = m.get("candidates") or []

        pick = pick_best_candidate(candidates)
        if not pick:
            report["no_candidate"].append({"id": row_id, "source": source, "key": key})
            continue

        src_path = pick["path"]
        if args.dry:
            print(f"[{idx}/{len(mismatches)}] DRY rekey row={row_id} ({source} {key}) using {os.path.basename(src_path)} sha={pick['sha']}  (was {expected})")
            report["rekeyed"].append({"id": row_id, "source": source, "key": key, "src": src_path, "dry": True})
            continue

        with open(src_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()

        status, resp = api_post("/api/admin/rekey-image", {"rowId": row_id, "data": b64})

        if status == 200 and resp.get("status") == "ok":
            print(f"[{idx}/{len(mismatches)}] OK  {key} {source}: {resp['oldChecksum']} → {resp['newChecksum']}  ({resp['size']}B)")
            report["rekeyed"].append({
                "id": row_id, "source": source, "key": key,
                "src": src_path,
                "old_checksum": resp.get("oldChecksum"),
                "new_checksum": resp.get("newChecksum"),
                "new_file_path": resp.get("newFilePath"),
                "size": resp.get("size"),
            })
        else:
            print(f"[{idx}/{len(mismatches)}] ERR {status} {resp}")
            report["errors"].append({"id": row_id, "status": status, "resp": resp})

    with open(REKEY_REPORT, "w") as f:
        json.dump(report, f, indent=2)

    print("\n=== Summary ===")
    for k in ("rekeyed", "no_candidate", "errors"):
        print(f"  {k}: {len(report[k])}")
    print(f"Report saved: {REKEY_REPORT}")

if __name__ == "__main__":
    main()
