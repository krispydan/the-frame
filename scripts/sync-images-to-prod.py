#!/usr/bin/env python3
"""
Sync truly-missing catalog images from local Desktop folder to prod.

Flow:
  1. GET /api/admin/audit-images → list truly-missing rows
  2. For each row, resolve sku_id → sku code via prod MCP system.query
  3. Locate candidate file on Desktop by source stage + sku code
  4. sha256 first 16 hex chars must match DB checksum
  5. POST /api/admin/upload-image for matches
  6. Write sync-report.json with uploaded / already_present / no_source /
     checksum_mismatch lists.

Usage:
  python3 scripts/sync-images-to-prod.py
  python3 scripts/sync-images-to-prod.py --limit 10  # only attempt first 10
  python3 scripts/sync-images-to-prod.py --dry       # compute plan, no upload

Never mutates Desktop files.
"""
import argparse
import base64
import glob
import hashlib
import json
import os
import sys
import time
import urllib.request
import urllib.error

API_BASE = "https://theframe.getjaxy.com"
ADMIN_KEY = "jaxy2026"
MCP_KEY = "d7b54adb537de1f8a7fe41cffc3b595f39b37490a47edadfe8661e04a55cebc6"
DESKTOP_ROOT = os.path.expanduser("~/Desktop/jaxy-product-images")
REPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sync-report.json")

SOURCE_TO_STAGE = {
    "raw": ("01_originals", ("jpg", "jpeg", "png")),
    "no_bg": ("02_no_background", ("png",)),
    "white_bg": ("03_white_bg", ("jpg", "jpeg")),
    "cropped": ("04_cropped", ("jpg", "jpeg", "png")),
    "square": ("05_square_f8f9fa", ("jpg", "jpeg")),
    "collection": ("06_collection", ("jpg", "jpeg")),
}

# Cloudflare blocks Python-urllib by default; use a browser-like UA.
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

def api_get(path):
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        headers={"x-admin-key": ADMIN_KEY, "User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())

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

def mcp_query(sql):
    data = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": "system.query", "arguments": {"sql": sql}},
    }).encode()
    req = urllib.request.Request(
        f"{API_BASE}/api/mcp",
        data=data,
        headers={
            "x-api-key": MCP_KEY,
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read())
    return json.loads(body["result"]["content"][0]["text"])

def sha256_prefix(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:16]

def resolve_sku_codes(sku_ids):
    """Return {sku_id: sku_code} using prod MCP."""
    if not sku_ids:
        return {}
    # Batch in chunks of 50 to keep SQL small
    out = {}
    ids = list(sku_ids)
    for i in range(0, len(ids), 50):
        batch = ids[i:i+50]
        quoted = ",".join("'" + b.replace("'", "''") + "'" for b in batch)
        rows = mcp_query(f"SELECT id, sku FROM catalog_skus WHERE id IN ({quoted})")
        for r in rows:
            out[r["id"]] = r["sku"]
    return out

def resolve_product_prefix(sku_ids):
    """For collection images (attached to a sku_id), return sku_prefix via product."""
    if not sku_ids:
        return {}
    out = {}
    ids = list(sku_ids)
    for i in range(0, len(ids), 50):
        batch = ids[i:i+50]
        quoted = ",".join("'" + b.replace("'", "''") + "'" for b in batch)
        rows = mcp_query(f"""
            SELECT s.id as sku_id, p.sku_prefix
            FROM catalog_skus s
            JOIN catalog_products p ON s.product_id = p.id
            WHERE s.id IN ({quoted})
        """)
        for r in rows:
            out[r["sku_id"]] = r["sku_prefix"]
    return out

def find_candidate(stage_dir, patterns, key):
    """Glob for files starting with key under stage_dir with given extensions."""
    matches = []
    for ext in patterns:
        matches.extend(glob.glob(os.path.join(DESKTOP_ROOT, stage_dir, f"{key}*.{ext}")))
        matches.extend(glob.glob(os.path.join(DESKTOP_ROOT, stage_dir, f"{key}*.{ext.upper()}")))
    return sorted(set(matches))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(DESKTOP_ROOT):
        print(f"ERROR: Desktop folder not found: {DESKTOP_ROOT}", file=sys.stderr)
        sys.exit(2)

    print("Fetching audit report...")
    audit = api_get("/api/admin/audit-images")
    missing = audit.get("truly_missing", [])
    print(f"  truly_missing: {len(missing)} rows")
    print(f"  total_approved: {audit.get('total_approved')}")
    print(f"  missing_total: {audit.get('missing_total')}")
    print(f"  by_source: {json.dumps(audit.get('by_source', {}), indent=2)}")

    if args.limit is not None:
        missing = missing[:args.limit]

    # Partition by source so we can resolve SKU codes / product prefixes in bulk
    sku_ids = {m["sku_id"] for m in missing if m.get("source") != "collection"}
    collection_sku_ids = {m["sku_id"] for m in missing if m.get("source") == "collection"}

    print(f"Resolving {len(sku_ids)} SKU codes + {len(collection_sku_ids)} product prefixes via MCP...")
    sku_code_map = resolve_sku_codes(sku_ids | collection_sku_ids)
    prefix_map = resolve_product_prefix(collection_sku_ids) if collection_sku_ids else {}

    report = {
        "total_attempted": len(missing),
        "uploaded": [],
        "already_present": [],
        "no_source_available": [],
        "checksum_mismatch": [],
        "errors": [],
    }

    for idx, m in enumerate(missing, 1):
        file_path = m["file_path"]
        source = m.get("source")
        checksum = m.get("checksum") or ""
        sku_id = m["sku_id"]

        if source not in SOURCE_TO_STAGE:
            report["no_source_available"].append({**m, "reason": f"unknown source '{source}'"})
            continue
        stage_dir, exts = SOURCE_TO_STAGE[source]

        if source == "collection":
            key = prefix_map.get(sku_id)  # e.g. "JX1002"
            if not key:
                report["no_source_available"].append({**m, "reason": "could not resolve product prefix"})
                continue
        else:
            key = sku_code_map.get(sku_id)  # e.g. "JX1002-BLK"
            if not key:
                report["no_source_available"].append({**m, "reason": "could not resolve SKU code"})
                continue

        candidates = find_candidate(stage_dir, exts, key)
        if not candidates:
            report["no_source_available"].append({**m, "key": key, "stage_dir": stage_dir, "reason": "no files match"})
            continue

        # Find the candidate whose sha256 prefix matches the DB checksum
        matched_path = None
        candidate_prefixes = []
        for c in candidates:
            try:
                p = sha256_prefix(c)
                candidate_prefixes.append({"path": c, "sha": p})
                if p == checksum:
                    matched_path = c
                    break
            except Exception as e:
                candidate_prefixes.append({"path": c, "error": str(e)})

        if not matched_path:
            report["checksum_mismatch"].append({
                **m,
                "key": key,
                "expected": checksum,
                "candidates": candidate_prefixes,
            })
            continue

        # Upload (or dry-run)
        if args.dry:
            print(f"[{idx}/{len(missing)}] DRY would upload {matched_path} → {file_path}")
            report["uploaded"].append({"file_path": file_path, "source_path": matched_path, "dry": True})
            continue

        with open(matched_path, "rb") as f:
            data_b64 = base64.b64encode(f.read()).decode()

        status, resp = api_post("/api/admin/upload-image", {
            "filePath": file_path,
            "data": data_b64,
            "expectedChecksum": checksum,
        })
        if status == 200 and resp.get("status") == "ok":
            print(f"[{idx}/{len(missing)}] OK {file_path} ({resp.get('size')} bytes)")
            report["uploaded"].append({"file_path": file_path, "source_path": matched_path, "size": resp.get("size")})
        elif status == 409:
            report["already_present"].append({"file_path": file_path})
        else:
            print(f"[{idx}/{len(missing)}] ERR {status} {resp}")
            report["errors"].append({"file_path": file_path, "status": status, "resp": resp})

        # Small pause to be polite to prod
        if idx % 25 == 0:
            time.sleep(0.5)

    with open(REPORT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    print("\n=== Summary ===")
    for k in ("uploaded", "already_present", "no_source_available", "checksum_mismatch", "errors"):
        print(f"  {k}: {len(report[k])}")
    print(f"Report saved: {REPORT_PATH}")

if __name__ == "__main__":
    main()
