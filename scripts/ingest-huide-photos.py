#!/usr/bin/env python3
"""
Ingest new Huide factory photos (JX2xxx) into The Frame.

Input folder: ~/Desktop/jaxy-product-images/Photos from huide1/
  front/  side1/  side2/  top/     — 24 SKUs × 4 angles = 96 files

For each source file {SKU}-{ANGLE}.jpg this script produces 5 pipeline
artifacts and uploads each via POST /api/v1/catalog/images/upload-raw:

  raw       — original bytes, untouched
  no_bg     — flood-fill white (threshold=245) → transparent PNG
  white_bg  — same as raw (already on clean white)
  cropped   — no_bg alpha-bbox-cropped
  square    — cropped placed on 2048×2048 #F8F9FA canvas

After a successful run:
  1. Call POST /api/admin/cleanup-images to demote older duplicate rows
  2. Call POST /api/v1/catalog/images/regen-collections to rebuild the
     8 JX2xxx product composites from the new cropped fronts.

Usage:
  python3 scripts/ingest-huide-photos.py              # live, all SKUs
  python3 scripts/ingest-huide-photos.py --dry        # plan only
  python3 scripts/ingest-huide-photos.py --sku JX2001  # one product
  python3 scripts/ingest-huide-photos.py --save-local-only  # no upload

Intermediate artifacts are saved under:
  ~/Desktop/jaxy-product-images/Photos from huide1/_processed/
so you can spot-check before bulk uploading.
"""
import argparse
import io
import json
import os
import sys
import urllib.request
import urllib.error
from collections import deque
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError as e:
    print(f"ERROR: missing dep: {e}. Run `pip install numpy Pillow`", file=sys.stderr)
    sys.exit(2)

API_BASE = "https://theframe.getjaxy.com"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

HUIDE_ROOT = Path.home() / "Desktop" / "jaxy-product-images" / "Photos from huide1"
PROCESSED_ROOT = HUIDE_ROOT / "_processed"

# Folder name → (DB image_type slug, filename suffix)
ANGLE_MAP = {
    "front": ("front", "FRONT"),
    "side1": ("side", "SIDE1"),
    "side2": ("other-side", "SIDE2"),
    "top":   ("top", "TOP"),
}

# Tune high — Huide photos have pure white bg, so a conservative
# threshold is safe and avoids eating any product highlights.
WHITE_THRESHOLD = 245
SQUARE_SIZE = (2048, 2048)
SQUARE_BG = (248, 249, 250)
SQUARE_PAD = 0.05
JPEG_QUALITY = 95


def upload_raw(file_bytes: bytes, filename: str, sku_id: str, variant: str,
               image_type: str, position: int, mime: str) -> tuple[int, dict]:
    """POST multipart/form-data to /api/v1/catalog/images/upload-raw."""
    boundary = "----huide" + os.urandom(8).hex()
    lines: list[bytes] = []

    def part(name: str, value: str):
        lines.append(f"--{boundary}".encode())
        lines.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        lines.append(b"")
        lines.append(value.encode())

    part("skuId", sku_id)
    part("imageType", image_type)
    part("variant", variant)
    part("position", str(position))
    part("source", variant)

    lines.append(f"--{boundary}".encode())
    lines.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode())
    lines.append(f"Content-Type: {mime}".encode())
    lines.append(b"")
    lines.append(file_bytes)

    lines.append(f"--{boundary}--".encode())
    lines.append(b"")

    body = b"\r\n".join(lines)

    req = urllib.request.Request(
        f"{API_BASE}/api/v1/catalog/images/upload-raw",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": UA,
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": str(e)}


def remove_white_background(img: Image.Image) -> Image.Image:
    """Flood-fill white pixels connected to any edge → alpha=0."""
    img = img.convert("RGBA")
    arr = np.array(img)
    h, w = arr.shape[:2]
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    white = (r >= WHITE_THRESHOLD) & (g >= WHITE_THRESHOLD) & (b >= WHITE_THRESHOLD)

    bg = np.zeros_like(white, dtype=bool)
    q = deque()
    for x in range(w):
        if white[0, x]:
            q.append((0, x)); bg[0, x] = True
        if white[h - 1, x]:
            q.append((h - 1, x)); bg[h - 1, x] = True
    for y in range(h):
        if white[y, 0]:
            q.append((y, 0)); bg[y, 0] = True
        if white[y, w - 1]:
            q.append((y, w - 1)); bg[y, w - 1] = True

    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not bg[ny, nx] and white[ny, nx]:
                bg[ny, nx] = True
                q.append((ny, nx))

    arr[bg, 3] = 0
    return Image.fromarray(arr)


def tight_crop_alpha(rgba: Image.Image) -> Image.Image:
    bbox = rgba.split()[3].getbbox()
    return rgba.crop(bbox) if bbox else rgba


def make_square(rgba: Image.Image) -> Image.Image:
    canvas = Image.new("RGB", SQUARE_SIZE, SQUARE_BG)
    avail = int(SQUARE_SIZE[0] * (1 - 2 * SQUARE_PAD))
    w, h = rgba.size
    scale = min(avail / w, avail / h)
    nw, nh = int(w * scale), int(h * scale)
    resized = rgba.resize((nw, nh), Image.LANCZOS)
    x = (SQUARE_SIZE[0] - nw) // 2
    y = (SQUARE_SIZE[1] - nh) // 2
    canvas.paste(resized, (x, y), mask=resized.split()[3])
    return canvas


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO(); img.save(buf, format="PNG"); return buf.getvalue()


def jpeg_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO(); img.save(buf, format="JPEG", quality=JPEG_QUALITY); return buf.getvalue()


def enumerate_sources(sku_filter: str | None) -> list[tuple[str, str, Path]]:
    """Return (sku, angle_slug, src_path) for every source file."""
    out: list[tuple[str, str, Path]] = []
    for folder_name, (slug, suffix) in ANGLE_MAP.items():
        folder = HUIDE_ROOT / folder_name
        if not folder.is_dir():
            print(f"WARN: folder not found: {folder}")
            continue
        for p in sorted(folder.iterdir()):
            if not p.name.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            stem = p.stem  # e.g. JX2001-BLK-FRONT
            if not stem.endswith(f"-{suffix}"):
                continue
            sku = stem[: -len(f"-{suffix}")]  # strip angle suffix
            if sku_filter and sku != sku_filter:
                continue
            out.append((sku, slug, p))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--sku", help="only process this SKU (e.g. JX2001-BLK)")
    ap.add_argument("--save-local-only", action="store_true",
                    help="write processed files to Desktop but don't upload")
    args = ap.parse_args()

    if not HUIDE_ROOT.is_dir():
        print(f"ERROR: {HUIDE_ROOT} not found"); sys.exit(2)
    PROCESSED_ROOT.mkdir(exist_ok=True)

    sources = enumerate_sources(args.sku)
    print(f"Found {len(sources)} source files to process")
    if not sources:
        sys.exit(1)

    report = {"uploaded": [], "errors": [], "skipped_upload": []}

    for idx, (sku, slug, src) in enumerate(sources, 1):
        tag = f"[{idx}/{len(sources)}] {sku} {slug}"
        try:
            raw_bytes = src.read_bytes()
            raw_img = Image.open(src)
            no_bg = remove_white_background(raw_img)
            cropped = tight_crop_alpha(no_bg)
            square = make_square(cropped)

            # Save local copies for spot-check
            sku_dir = PROCESSED_ROOT / sku
            sku_dir.mkdir(exist_ok=True)
            stem = f"{sku}-{slug.upper()}"
            no_bg.save(sku_dir / f"{stem}_NO_BG.png")
            cropped.save(sku_dir / f"{stem}_CROPPED.png")
            square.save(sku_dir / f"{stem}_SQUARE.jpg", format="JPEG", quality=JPEG_QUALITY)

            if args.dry or args.save_local_only:
                print(f"{tag} LOCAL only ({raw_img.size} → square {square.size})")
                if not args.dry:
                    report["skipped_upload"].append({"sku": sku, "angle": slug})
                continue

            # Upload each pipeline stage
            variants = [
                ("raw",      raw_bytes,             src.name,                 "image/jpeg"),
                ("no_bg",    png_bytes(no_bg),      f"{stem}_NO_BG.png",      "image/png"),
                ("white_bg", raw_bytes,             f"{stem}_WHITE_BG.jpg",   "image/jpeg"),
                ("cropped",  png_bytes(cropped),    f"{stem}_CROPPED.png",    "image/png"),
                ("square",   jpeg_bytes(square),    f"{stem}_SQUARE.jpg",     "image/jpeg"),
            ]
            ok_count = 0
            for variant, data, fname, mime in variants:
                status, resp = upload_raw(
                    data, fname, sku_id=sku, variant=variant,
                    image_type=slug, position=0, mime=mime,
                )
                if status == 200 and resp.get("url"):
                    ok_count += 1
                    report["uploaded"].append({
                        "sku": sku, "angle": slug, "variant": variant,
                        "file_path": resp.get("filePath"), "size": resp.get("fileSize"),
                    })
                else:
                    report["errors"].append({
                        "sku": sku, "angle": slug, "variant": variant,
                        "status": status, "resp": resp,
                    })
            print(f"{tag} OK {ok_count}/5 variants")
        except Exception as e:
            report["errors"].append({"sku": sku, "angle": slug, "exception": str(e)})
            print(f"{tag} EXCEPTION {e}")

    out = PROCESSED_ROOT / "ingest-report.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"\n=== Summary ===")
    print(f"  uploaded: {len(report['uploaded'])}")
    print(f"  errors:   {len(report['errors'])}")
    print(f"  local-only: {len(report['skipped_upload'])}")
    print(f"Report: {out}")

    if not args.dry and not args.save_local_only and not report["errors"]:
        print("\n=== Auto-cleanup: demoting older duplicate rows (status='superseded') ===")
        try:
            req = urllib.request.Request(
                f"{API_BASE}/api/admin/cleanup-images",
                data=json.dumps({"dryRun": False}).encode(),
                headers={
                    "x-admin-key": "jaxy2026",
                    "Content-Type": "application/json",
                    "User-Agent": UA,
                    "Accept": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                r = json.loads(resp.read())
            print(f"  demoted: {r.get('total_demoted', 0)}")
            for src, n in (r.get("affected_by_source") or {}).items():
                print(f"    {src}: {n}")
        except Exception as e:
            print(f"  cleanup FAILED: {e} — run manually:")
            print("    curl -s -X POST https://theframe.getjaxy.com/api/admin/cleanup-images \\")
            print("      -H 'x-admin-key: jaxy2026' -H 'Content-Type: application/json' \\")
            print('      -d \'{"dryRun": false}\' | jq')

        print("\n=== Auto-regen: rebuilding collection composites ===")
        try:
            req = urllib.request.Request(
                f"{API_BASE}/api/v1/catalog/images/regen-collections",
                data=b"",
                headers={"User-Agent": UA, "Accept": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=600) as resp:
                r = json.loads(resp.read())
            print(f"  regenerated: {r.get('regenerated', 0)}  failed: {r.get('failed', 0)}  skipped: {r.get('skipped', 0)}")
        except Exception as e:
            print(f"  regen FAILED: {e} — run manually:")
            print("    curl -s -X POST https://theframe.getjaxy.com/api/v1/catalog/images/regen-collections | jq")

        print("\nDone. Next:")
        print("  • Purge Cloudflare /api/images/* cache (dashboard → Caching → Purge)")
        print("  • Re-export Faire/Shopify CSVs")


if __name__ == "__main__":
    main()
