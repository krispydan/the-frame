#!/usr/bin/env python3
"""
Fix the 3 SKUs whose 2026-04-17 Gemini magenta-chroma-key reprocessing
corrupted the lens color (tinted everything purple/magenta).

Affected:
  - JX3003-BLK (Dahlia black)
  - JX3004-TOR (Diplomat tortoise)
  - JX3005-BRW (Phoenix brown)

The old pipeline asked Gemini to put the product on a magenta
background and then chroma-keyed out the magenta. That failed because
transparent lenses blended the magenta through to the lens pixels —
the final chroma-keyed image had magenta/purple lens tints.

This script uses Gemini with a WHITE background prompt instead, then
flood-fills the white background from the corners to make it
transparent. White is safe because:
  - Lens tints (gray, green, brown) are nowhere near pure white
  - Flood-fill stops at the first non-white pixel, so internal
    product pixels are preserved regardless of brightness
Gemini still handles shadow/reflection removal, which is what we need.

For each SKU, this script:
  1. Reads 01_originals/{SKU}-FRONT.jpg
  2. Sends to Gemini → clean white background, no shadows
  3. Flood-fills near-white pixels from edges → transparent PNG
  4. Tight-crops by alpha bbox
  5. Writes to Desktop pipeline folders (02/04/05), overwriting
     the broken outputs
  6. POSTs each file to /api/admin/rekey-image with the matching DB
     row id so the production DB points at the new checksum-addressed
     path with correct lens colors

After this, regenerate the collection images for JX3003, JX3004,
JX3005 via POST /api/v1/catalog/images/regen-collections so the
composites reflect the corrected fronts.

Usage:
  python3 scripts/fix-lens-color-skus.py           # live
  python3 scripts/fix-lens-color-skus.py --dry     # plan only
  python3 scripts/fix-lens-color-skus.py --skip-gemini  # use raw original
"""
import argparse
import base64
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
ADMIN_KEY = "jaxy2026"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

GEMINI_KEY = os.environ.get("GOOGLE_GEMINI_API_KEY") or "AIzaSyD-Q2yWOD-c9vxuTn8ydr-3fb6LRNVaQ8Q"
GEMINI_MODEL = "gemini-2.5-flash-image"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"

GEMINI_PROMPT = (
    "Place this sunglasses product on a solid pure white (#FFFFFF) background. "
    "Remove all shadows, reflections, and the tabletop surface completely. "
    "The entire background must be exactly white (#FFFFFF) with no gradients, "
    "shadows, grays, or variations. "
    "CRITICAL: Preserve the exact frame colors, lens tints, and lens "
    "transparency as they appear in the original image. Do NOT change, "
    "recolor, or tint the lenses. If the lenses are gray gradient, keep them "
    "gray gradient. If green, keep them green. If brown, keep them brown. "
    "Do not modify, resize, or crop the product."
)

DESKTOP_ROOT = Path.home() / "Desktop" / "jaxy-product-images"
ORIGINALS = DESKTOP_ROOT / "01_originals"
NOBG_DIR = DESKTOP_ROOT / "02_no_background"
CROPPED_DIR = DESKTOP_ROOT / "04_cropped"
SQUARE_DIR = DESKTOP_ROOT / "05_square_f8f9fa"

SQUARE_SIZE = (2048, 2048)
SQUARE_BG = (248, 249, 250)
SQUARE_PAD = 0.05
JPEG_QUALITY = 95
# Pixels brighter than this in all channels, AND connected to an image
# edge via flood-fill, are treated as background. Tuned for the
# Jaxy studio shots which have a near-white (but not pure white) gray bg.
WHITE_THRESHOLD = 230

# {SKU}: {source: row_id}
# Sourced from prod MCP system.query on 2026-04-17 (see the docstring).
TARGETS = {
    "JX3003-BLK": {
        "no_bg":   "88f18789-5769-41d2-b86f-ecc3ff72d9fa",
        "cropped": "37cd7d2b-68cb-4e3f-90cd-dfa54a2f0cbf",
        "square":  "7230f1d2-3f47-43ff-8d05-9de019cc6ab6",
    },
    "JX3004-TOR": {
        "no_bg":   "842950cb-bb04-48f7-9bea-c7a82b0e48bf",
        "cropped": "37e419be-5a70-437f-98ff-12a16dc59f11",
        "square":  "ebe59829-ef20-4b85-94bb-02b0c8a3c3b8",
    },
    "JX3005-BRW": {
        "no_bg":   "b4741312-0ede-4b9b-99aa-a8c1a75e54b1",
        "cropped": "df12cfb8-c8a9-4d23-a3ed-1a7c0a5d6f27",
        "square":  "ff5394ef-d2a4-4d3e-b86e-ce2c8ac8f4f1",
    },
}


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
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": str(e)}


def gemini_clean_to_white(img_path: Path) -> Image.Image:
    """Send original to Gemini → return image on clean white bg, shadows removed."""
    with open(img_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()
    mime = "image/jpeg" if str(img_path).lower().endswith((".jpg", ".jpeg")) else "image/png"
    payload = {
        "contents": [{"parts": [
            {"text": GEMINI_PROMPT},
            {"inline_data": {"mime_type": mime, "data": img_b64}},
        ]}],
        "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]},
    }
    req = urllib.request.Request(
        GEMINI_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    for part in data["candidates"][0]["content"]["parts"]:
        if "inlineData" in part:
            return Image.open(io.BytesIO(base64.b64decode(part["inlineData"]["data"])))
    raise RuntimeError(f"no image in Gemini response: {data}")


def remove_white_background(img: Image.Image) -> Image.Image:
    """Return RGBA with near-white background pixels (connected to edges)
    set to alpha=0. Preserves internal lens colors regardless of
    brightness, because flood-fill stops at non-white pixels."""
    img = img.convert("RGBA")
    arr = np.array(img)
    h, w = arr.shape[:2]
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    white = (r >= WHITE_THRESHOLD) & (g >= WHITE_THRESHOLD) & (b >= WHITE_THRESHOLD)

    # BFS flood-fill from all border pixels that start out white.
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
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def jpeg_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--skip-gemini", action="store_true",
                    help="skip Gemini call, flood-fill the raw original (shadows/reflections kept)")
    args = ap.parse_args()

    summary = {"processed": [], "errors": []}

    for sku, ids in TARGETS.items():
        orig = ORIGINALS / f"{sku}-FRONT.jpg"
        if not orig.exists():
            orig = ORIGINALS / f"{sku}-FRONT.JPG"
        if not orig.exists():
            print(f"[{sku}] ERROR: original not found at {orig}")
            summary["errors"].append({"sku": sku, "reason": "original not found"})
            continue

        print(f"[{sku}] processing {orig.name}")
        try:
            if args.skip_gemini:
                cleaned = Image.open(orig)
            else:
                print(f"  calling Gemini...")
                cleaned = gemini_clean_to_white(orig)
            nobg = remove_white_background(cleaned)
            cropped = tight_crop_alpha(nobg)
            square = make_square(cropped)

            # Write new Desktop files (overwriting broken Gemini outputs)
            nobg_path = NOBG_DIR / f"{sku}-FRONT_NO_BG.png"
            cropped_path = CROPPED_DIR / f"{sku}-FRONT_CROPPED.png"
            square_path = SQUARE_DIR / f"{sku}-FRONT_SQUARE_F8F9FA.jpg"

            if not args.dry:
                nobg.save(nobg_path)
                cropped.save(cropped_path)
                square.save(square_path, format="JPEG", quality=JPEG_QUALITY)
                print(f"  wrote: {nobg_path.name}, {cropped_path.name}, {square_path.name}")
            else:
                print(f"  DRY would write: {nobg_path.name}, {cropped_path.name}, {square_path.name}")

            # Upload to prod (rekey each row)
            tasks = [
                ("no_bg", ids["no_bg"], png_bytes(nobg)),
                ("cropped", ids["cropped"], png_bytes(cropped)),
                ("square", ids["square"], jpeg_bytes(square)),
            ]
            for stage, row_id, data in tasks:
                if args.dry:
                    print(f"  DRY would rekey {stage} row={row_id[:8]}... ({len(data)}B)")
                    continue
                status, resp = api_post("/api/admin/rekey-image", {
                    "rowId": row_id,
                    "data": base64.b64encode(data).decode(),
                    "overwrite": True,
                })
                if status == 200 and resp.get("status") == "ok":
                    print(f"  rekey {stage:8} OK  {resp['oldChecksum']} → {resp['newChecksum']}  ({resp['size']}B)")
                else:
                    print(f"  rekey {stage:8} ERR {status} {resp}")
                    summary["errors"].append({"sku": sku, "stage": stage, "status": status, "resp": resp})
            summary["processed"].append(sku)
        except Exception as e:
            print(f"[{sku}] EXCEPTION: {e}")
            summary["errors"].append({"sku": sku, "exception": str(e)})

    print("\n=== Summary ===")
    print(f"  processed: {len(summary['processed'])}  ({', '.join(summary['processed'])})")
    print(f"  errors   : {len(summary['errors'])}")
    for e in summary["errors"]:
        print(f"    {e}")

    if not args.dry and summary["processed"] and not summary["errors"]:
        print("\nNext: regenerate collections for affected products")
        print("  curl -s -X POST https://theframe.getjaxy.com/api/v1/catalog/images/regen-collections | jq")


if __name__ == "__main__":
    main()
