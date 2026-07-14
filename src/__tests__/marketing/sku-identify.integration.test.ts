/**
 * End-to-end plumbing test for the AI SKU identifier — everything EXCEPT
 * the model's actual intelligence:
 *   - reference sheets really render from catalog images (sharp)
 *   - the vision request is well-formed (model, tool, tool_choice, base64
 *     image blocks, all the reference sheets + the frame)
 *   - clips escalate frame-by-frame (real ffmpeg extraction) until a clear
 *     shot, and stop early once one is found
 *   - results are stored on marketing_media_matches
 *
 * The Anthropic call is mocked so no key/network is needed, but the exact
 * payload we'd send in production is asserted — that's where prod broke.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import sharp from "sharp";
import { getTestDb, resetTestDb } from "../setup";

let IMAGES_DIR: string;
let VIDEOS_DIR: string;

// A solid-color JPEG standing in for a product photo.
async function writeProductImage(abs: string, color: { r: number; g: number; b: number }) {
  mkdirSync(path.dirname(abs), { recursive: true });
  const buf = await sharp({ create: { width: 400, height: 300, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
  writeFileSync(abs, buf);
}

function seedCatalog() {
  const db = getTestDb();
  const prod = db.prepare(`INSERT INTO catalog_products (id, name) VALUES (?, ?)`);
  const sku = db.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES (?, ?, ?, ?)`);
  const img = db.prepare(`INSERT INTO catalog_images (id, sku_id, file_path, is_best, status) VALUES (?, ?, ?, 1, 'approved')`);

  const catalog = [
    { pid: "p-windsor", name: "Windsor", skus: [["JX1005-BLK", "Black"], ["JX1005-OLV", "Olive"]] },
    { pid: "p-bardot", name: "Bardot", skus: [["JX1008-BLK", "Black"], ["JX1008-TOR", "Tortoise"]] },
    { pid: "p-eclipse", name: "Eclipse", skus: [["JX2001-BLK", "Black"]] },
  ];
  return { catalog, prod, sku, img };
}

describe("SKU identifier — plumbing", () => {
  beforeAll(async () => {
    IMAGES_DIR = mkdtempSync(path.join(os.tmpdir(), "skuimg-"));
    VIDEOS_DIR = mkdtempSync(path.join(os.tmpdir(), "skuvid-"));
    process.env.IMAGES_PATH = IMAGES_DIR;
    process.env.VIDEOS_PATH = VIDEOS_DIR;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  beforeEach(() => {
    resetTestDb();
    vi.restoreAllMocks();
  });

  async function seedWithImages() {
    const { catalog, prod, sku, img } = seedCatalog();
    let ci = 0;
    for (const p of catalog) {
      prod.run(p.pid, p.name);
      for (const [code, color] of p.skus) {
        const skuId = `s-${code}`;
        sku.run(skuId, p.pid, code, color);
        // Realistic catalog path: checksum-ish, NOT the product name.
        const rel = `catimg/${ci}-${code}.jpg`;
        await writeProductImage(path.join(IMAGES_DIR, rel), { r: (ci * 40) % 255, g: (ci * 70) % 255, b: (ci * 100) % 255 });
        img.run(`i-${code}`, skuId, rel);
        ci++;
      }
    }
  }

  it("builds real reference sheets from catalog images and caches them", async () => {
    await seedWithImages();
    const { getReferenceSheets } = await import("@/modules/marketing/lib/video/sku-reference");

    const first = await getReferenceSheets();
    expect(first.skus.length).toBe(5); // 5 colorways with images
    expect(first.sheets.length).toBeGreaterThanOrEqual(1);
    // Each sheet is a valid JPEG sharp can parse.
    for (const s of first.sheets) {
      const meta = await sharp(s).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBeGreaterThan(0);
    }

    // Second call hits the cache (same fingerprint) — sheet bytes identical.
    const second = await getReferenceSheets();
    expect(second.sheets.length).toBe(first.sheets.length);
    expect(second.sheets[0].equals(first.sheets[0])).toBe(true);
  });

  /** Mock the Anthropic endpoint; `answers` are returned in call order. */
  function mockAnthropic(answers: Array<{ candidates: Array<{ sku: string; confidence: number }>; noProductVisible: boolean }>) {
    const bodies: string[] = [];
    let call = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(String((init as RequestInit).body));
      const a = answers[Math.min(call, answers.length - 1)];
      call++;
      return new Response(
        JSON.stringify({
          content: [{ type: "tool_use", name: "report_sku_matches", input: a }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200 },
      );
    });
    return { spy, bodies, calls: () => call };
  }

  it("sends a well-formed vision request for a static image", async () => {
    await seedWithImages();
    const db = getTestDb();
    // A catalog image row IS the media we identify.
    const m = mockAnthropic([{ candidates: [{ sku: "JX1008-TOR", confidence: 88 }], noProductVisible: false }]);
    const { identifyMedia } = await import("@/modules/marketing/lib/video/sku-match");

    const res = await identifyMedia("image", "i-JX1008-TOR");
    expect(res.status).toBe("suggested");
    expect(res.candidates[0]).toMatchObject({ productId: "p-bardot", confidence: 88 });

    // Exactly one call (images aren't sampled) with the right shape.
    expect(m.calls()).toBe(1);
    const body = JSON.parse(m.bodies[0]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "report_sku_matches" });
    expect(body.tools[0].name).toBe("report_sku_matches");
    const images = body.messages[0].content.filter((c: { type: string }) => c.type === "image");
    // ≥1 reference sheet + 1 media frame, all base64.
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const img of images) expect(img.source.type).toBe("base64");

    // Stored on the match row.
    const row = db.prepare(`SELECT status FROM marketing_media_matches WHERE media_type='image' AND media_id='i-JX1008-TOR'`).get() as { status: string };
    expect(row.status).toBe("suggested");
  });

  async function seedClip(id: string, durationSec: number, fileName = `${id}.mp4`) {
    const db = getTestDb();
    const norm = `clips/normalized/${id}_v1.mp4`;
    const poster = `clips/posters/${id}.jpg`;
    const normAbs = path.join(VIDEOS_DIR, norm);
    const posterAbs = path.join(VIDEOS_DIR, poster);
    mkdirSync(path.dirname(normAbs), { recursive: true });
    mkdirSync(path.dirname(posterAbs), { recursive: true });
    // Real files: a short video (so frames at 2s/4s exist) + a poster.
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=blue:s=240x426:d=${durationSec}`, "-pix_fmt", "yuv420p", normAbs], { stdio: "ignore" });
    writeFileSync(posterAbs, await sharp({ create: { width: 240, height: 426, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer());
    db.prepare(`INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, normalized_path, poster_path, duration_sec, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')`).run(id, fileName, `sum-${id}`, `clips/raw/${id}.mp4`, norm, poster, durationSec);
  }

  it("resolves a named clip from the filename with ZERO api calls", async () => {
    await seedWithImages();
    // Filename carries the product name (the real shoot convention).
    await seedClip("clip-named", 6, "05_21_26_studio_Windsor_02__10.mp4");
    const m = mockAnthropic([{ candidates: [], noProductVisible: true }]);
    const { identifyMedia } = await import("@/modules/marketing/lib/video/sku-match");

    const res = await identifyMedia("clip", "clip-named");
    expect(res.status).toBe("suggested");
    expect(res.candidates[0]).toMatchObject({ productId: "p-windsor", via: "filename", confidence: 90 });
    expect(m.calls()).toBe(0); // vision skipped entirely — no wrong guesses, no cost
  });

  it("escalates clip frames until a clear shot, then stops (real ffmpeg)", async () => {
    await seedWithImages();
    await seedClip("clip-a", 6);
    // Poster = no product; second frame (2s) = a clear match → should stop.
    const m = mockAnthropic([
      { candidates: [], noProductVisible: true },
      { candidates: [{ sku: "JX1005-OLV", confidence: 90 }], noProductVisible: false },
    ]);
    const { identifyMedia } = await import("@/modules/marketing/lib/video/sku-match");

    const res = await identifyMedia("clip", "clip-a");
    expect(res.status).toBe("suggested");
    expect(res.candidates[0]).toMatchObject({ productId: "p-windsor", confidence: 90 });
    // Poster (1) + one escalated frame (2) = 2 calls, then stopped early.
    expect(m.calls()).toBe(2);
  });

  it("marks no_product after exhausting frames when nothing is ever seen", async () => {
    await seedWithImages();
    await seedClip("clip-b", 6);
    // Every frame says no product. 6s clip → poster + frames at 2s & 4s = 3.
    const m = mockAnthropic([{ candidates: [], noProductVisible: true }]);
    const { identifyMedia } = await import("@/modules/marketing/lib/video/sku-match");

    const res = await identifyMedia("clip", "clip-b");
    expect(res.status).toBe("no_product");
    expect(res.candidates).toHaveLength(0);
    expect(m.calls()).toBe(3);
  });
});
