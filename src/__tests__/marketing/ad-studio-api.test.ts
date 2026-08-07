/**
 * Ad Studio A1 — the API surface and the REAL ffmpeg render.
 *
 * The E2E test generates a synthetic clip + product image, runs
 * renderVideoAd through the production code path (crop → card overlay →
 * drawtext → store), and asserts the output file, its probed geometry,
 * and the DB roll-up. Same pattern as video-trim.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { execFile } from "child_process";
import { mkdtempSync } from "fs";
import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import sharp from "sharp";
import JSZip from "jszip";
import { getTestDb, resetTestDb } from "../setup";
import { createRequest, parseResponse } from "../api-helpers";
import { GET as listAds, POST as createAd } from "@/app/api/v1/marketing/ads/route";
import { GET as getAdDetail, PATCH as patchAd, DELETE as archiveAd } from "@/app/api/v1/marketing/ads/[id]/route";
import { POST as renderAd } from "@/app/api/v1/marketing/ads/[id]/render/route";
import { GET as downloadAd } from "@/app/api/v1/marketing/ads/[id]/download/route";
import { GET as adOptions } from "@/app/api/v1/marketing/ads/options/route";
import { renderVideoAd, settleAdStatus, escapeDrawtext, adRenderPath } from "@/modules/marketing/lib/ads/render-video";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const sh = (args: string[]) =>
  new Promise<void>((resolve, reject) =>
    execFile(FFMPEG, args, { timeout: 120_000 }, (err) => (err ? reject(err) : resolve())),
  );

let videosRoot: string;
let imagesRoot: string;

beforeAll(async () => {
  videosRoot = mkdtempSync(path.join(tmpdir(), "ads-videos-"));
  imagesRoot = mkdtempSync(path.join(tmpdir(), "ads-images-"));
  process.env.VIDEOS_PATH = videosRoot;
  process.env.IMAGES_PATH = imagesRoot;
  await mkdir(path.join(videosRoot, "clips/normalized"), { recursive: true });
  await mkdir(path.join(imagesRoot, "skus/s1"), { recursive: true });

  // 2s vertical clip with audio — the ad background.
  await sh([
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    path.join(videosRoot, "clips/normalized/bg_v1.mp4"),
  ]);

  // Product "front shot": red glasses-ish rectangle on transparency.
  await sharp({
    create: { width: 600, height: 260, channels: 4, background: { r: 190, g: 40, b: 40, alpha: 1 } },
  }).png().toFile(path.join(imagesRoot, "skus/s1/front.png"));
}, 120_000);

function seed() {
  const d = getTestDb();
  d.prepare(`INSERT INTO catalog_products (id, name) VALUES ('p1', 'Shipo')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES ('s1', 'p1', 'JX4011-S-TIGYEL', 'Tigris Yellow')`).run();
  d.prepare(
    `INSERT INTO catalog_images (id, sku_id, file_path, status, is_best) VALUES ('img1', 's1', 'skus/s1/front.png', 'approved', 1)`,
  ).run();
  d.prepare(
    `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, normalized_path, duration_sec, width, height, status, talent)
     VALUES ('clip1', 'IMG_555.mp4', 'ck1', 'clips/raw/bg.mp4', 'clips/normalized/bg_v1.mp4', 2.0, 540, 960, 'ready', 'missjademonet')`,
  ).run();
  d.prepare(`INSERT INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES ('cp1', 'clip1', 's1')`).run();
}

beforeEach(() => {
  resetTestDb();
  seed();
});

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function createTestAd(over: Record<string, unknown> = {}) {
  const res = await createAd(
    createRequest("POST", "/api/v1/marketing/ads", {
      body: {
        recipe: "pcard",
        backgroundType: "clip",
        backgroundRef: "clip1",
        skuId: "s1",
        ratios: ["1x1"],
        ...over,
      },
    }),
  );
  return parseResponse<{ id: string; name: string; error?: string }>(res);
}

describe("ad creation", () => {
  it("creates the ad with a convention name and queued renders", async () => {
    const { status, data } = await createTestAd();
    expect(status).toBe(201);
    expect(data.name).toBe("JX_PCARD_VID_SHIPO-TIGYEL_JADE_C00_v01");

    const d = getTestDb();
    const renders = d.prepare(`SELECT ratio, status FROM marketing_ad_renders WHERE ad_id = ?`).all(data.id);
    expect(renders).toEqual([{ ratio: "1x1", status: "queued" }]);
    const jobs = d.prepare(`SELECT COUNT(*) n FROM jobs WHERE type = 'marketing.ads.render'`).get() as { n: number };
    expect(jobs.n).toBe(1);
  });

  it("refuses the exact same ad twice — the name is the identity", async () => {
    await createTestAd();
    const { status, data } = await createTestAd();
    expect(status).toBe(409);
    expect(data.id).toBeTruthy(); // points at the existing ad
  });

  it("refuses a not-ready clip and a SKU with no card image", async () => {
    const d = getTestDb();
    d.prepare(`UPDATE marketing_video_clips SET status = 'uploaded' WHERE id = 'clip1'`).run();
    expect((await createTestAd()).status).toBe(400);

    d.prepare(`UPDATE marketing_video_clips SET status = 'ready' WHERE id = 'clip1'`).run();
    d.prepare(`DELETE FROM catalog_images`).run();
    const { status, data } = await createTestAd();
    expect(status).toBe(400);
    expect(data.error).toContain("no catalog image");
  });

  it("lists the ad with its renders and searches by name segments", async () => {
    const { data: created } = await createTestAd();
    const list = await parseResponse<{ total: number; ads: Array<{ id: string; renders: unknown[] }> }>(
      await listAds(createRequest("GET", "/api/v1/marketing/ads", { searchParams: { search: "JADE TIGYEL" } })),
    );
    expect(list.data.total).toBe(1);
    expect(list.data.ads[0].id).toBe(created.id);
    expect(list.data.ads[0].renders).toHaveLength(1);

    const miss = await parseResponse<{ total: number }>(
      await listAds(createRequest("GET", "/api/v1/marketing/ads", { searchParams: { search: "DARIA" } })),
    );
    expect(miss.data.total).toBe(0);
  });

  it("detail returns renders, the clip and the resolved card image", async () => {
    const { data: created } = await createTestAd();
    const { status, data } = await parseResponse<{
      ad: { name: string };
      renders: unknown[];
      clip: { file_name: string };
      cardImage: { source: string };
    }>(await getAdDetail(createRequest("GET", "x"), routeParams(created.id)));
    expect(status).toBe(200);
    expect(data.ad.name).toBe("JX_PCARD_VID_SHIPO-TIGYEL_JADE_C00_v01");
    expect(data.renders).toHaveLength(1);
    expect(data.clip.file_name).toBe("IMG_555.mp4");
    // No pipeline artifact seeded → the raw catalog photo is the card image.
    expect(data.cardImage.source).toBe("base");
  });

  it("options endpoint feeds the wizard", async () => {
    const { data } = await parseResponse<{ recipes: Array<{ slug: string }>; skus: Array<{ sku: string; hasImage: number }>; ratios: unknown[] }>(
      await adOptions(),
    );
    expect(data.recipes.map((r) => r.slug)).toContain("pcard");
    expect(data.skus[0].hasImage).toBe(1);
    expect(data.ratios.length).toBe(4);
  });
});

describe("status roll-up + lifecycle", () => {
  it("settles rendering → ready → published, and edit-after-publish bumps the version", async () => {
    const { data: created } = await createTestAd();
    const d = getTestDb();

    d.prepare(`UPDATE marketing_ad_renders SET status = 'done', r2_key = 'ads/2026-08/x_1x1.mp4' WHERE ad_id = ?`).run(created.id);
    settleAdStatus(created.id);
    expect((d.prepare(`SELECT status FROM marketing_ads WHERE id = ?`).get(created.id) as { status: string }).status).toBe("ready");

    // Publish.
    let res = await patchAd(
      createRequest("PATCH", `x`, { body: { status: "published" } }), routeParams(created.id),
    );
    expect((await parseResponse(res)).status).toBe(200);

    // Edit the layout of the published ad → v02 + regenerated name + rendering again.
    res = await patchAd(
      createRequest("PATCH", `x`, { body: { layoutOverrides: { "1x1": { cardY: 0.7 } } } }), routeParams(created.id),
    );
    expect((await parseResponse(res)).status).toBe(200);
    const ad = d.prepare(`SELECT name, version, status FROM marketing_ads WHERE id = ?`).get(created.id) as
      { name: string; version: number; status: string };
    expect(ad.version).toBe(2);
    expect(ad.name).toBe("JX_PCARD_VID_SHIPO-TIGYEL_JADE_C00_v02");
    expect(ad.status).toBe("rendering");
    // Renders were requeued.
    const r = d.prepare(`SELECT status FROM marketing_ad_renders WHERE ad_id = ?`).get(created.id) as { status: string };
    expect(r.status).toBe("queued");
  });

  it("failure surfaces on the ad and the render route requeues it", async () => {
    const { data: created } = await createTestAd();
    const d = getTestDb();
    d.prepare(`UPDATE marketing_ad_renders SET status = 'failed', error = 'boom' WHERE ad_id = ?`).run(created.id);
    settleAdStatus(created.id);
    const ad = d.prepare(`SELECT status, error FROM marketing_ads WHERE id = ?`).get(created.id) as { status: string; error: string };
    expect(ad.status).toBe("failed");
    expect(ad.error).toBe("boom");

    const res = await renderAd(createRequest("POST", `x`, { body: {} }), routeParams(created.id));
    expect((await parseResponse(res)).status).toBe(200);
    const r = d.prepare(`SELECT status, error FROM marketing_ad_renders WHERE ad_id = ?`).get(created.id) as { status: string; error: string | null };
    expect(r.status).toBe("queued");
    expect(r.error).toBeNull();
  });

  it("archives via DELETE and drops out of the default list", async () => {
    const { data: created } = await createTestAd();
    await archiveAd(createRequest("DELETE", `x`), routeParams(created.id));
    const list = await parseResponse<{ total: number }>(await listAds(createRequest("GET", "x")));
    expect(list.data.total).toBe(0);
  });

  it("rejects illegal status jumps", async () => {
    const { data: created } = await createTestAd(); // status=rendering
    const res = await patchAd(
      createRequest("PATCH", `x`, { body: { status: "published" } }), routeParams(created.id),
    );
    expect((await parseResponse(res)).status).toBe(400);
  });
});

describe("card image loading (volume vs R2)", () => {
  // Production has two generations of catalog images: older rows have
  // bytes on the images volume (file_path), newer MCP uploads live on
  // R2 only (url). The first real ad in production failed on exactly
  // this — these tests pin the fallback.
  it("prefers the local file when it exists", async () => {
    const { resolveCardImage, loadCardImageBuffer } = await import("@/modules/marketing/lib/ads/card");
    const resolved = resolveCardImage("s1", null)!;
    expect(resolved.source).toBe("base");
    const buf = await loadCardImageBuffer(resolved);
    expect((await sharp(buf).metadata()).width).toBe(600);
  });

  it("falls back to the R2 url when the volume file is gone", async () => {
    const d = getTestDb();
    d.prepare(`UPDATE catalog_images SET file_path = NULL, url = 'https://r2.example/front.png' WHERE id = 'img1'`).run();
    const { resolveCardImage, loadCardImageBuffer } = await import("@/modules/marketing/lib/ads/card");
    const resolved = resolveCardImage("s1", null)!;
    expect(resolved.url).toBe("https://r2.example/front.png");

    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: "#fff" } }).png().toBuffer();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array(png), { status: 200 })) as typeof fetch;
    try {
      const buf = await loadCardImageBuffer(resolved);
      expect((await sharp(buf).metadata()).width).toBe(10);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("names the image and what was tried when nothing is readable", async () => {
    const d = getTestDb();
    d.prepare(`UPDATE catalog_images SET file_path = 'skus/s1/DELETED.png', url = NULL WHERE id = 'img1'`).run();
    const { resolveCardImage, loadCardImageBuffer } = await import("@/modules/marketing/lib/ads/card");
    await expect(loadCardImageBuffer(resolveCardImage("s1", null)!)).rejects.toThrow(/img1.*DELETED\.png.*no R2 url/);
  });
});

describe("render helpers", () => {
  it("escapes drawtext metacharacters", () => {
    expect(escapeDrawtext("It's 50%: fine")).toBe("It\\'s 50\\%\\: fine");
  });

  it("keys renders under ads/{yyyy-mm}/ with the convention file name", () => {
    expect(adRenderPath("JX_PCARD_VID_A-B_JADE_C00_v01", "4x5", "video", new Date("2026-08-06T12:00:00Z")))
      .toBe("ads/2026-08/JX_PCARD_VID_A-B_JADE_C00_v01_4x5.mp4");
  });
});

describe("renderVideoAd — real ffmpeg E2E", () => {
  it("renders 1x1 with the card + name burned in, settles the ad ready, and zips", async () => {
    const { data: created } = await createTestAd();

    const result = await renderVideoAd(created.id, "1x1");
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1080);
    expect(result.durationSec).toBeGreaterThan(1.5);
    expect(result.r2Key).toMatch(/^ads\/\d{4}-\d{2}\/JX_PCARD_VID_SHIPO-TIGYEL_JADE_C00_v01_1x1\.mp4$/);

    const d = getTestDb();
    const render = d.prepare(`SELECT * FROM marketing_ad_renders WHERE ad_id = ?`).get(created.id) as Record<string, unknown>;
    expect(render.status).toBe("done");
    expect(render.poster_key).toBeTruthy();
    const ad = d.prepare(`SELECT status FROM marketing_ads WHERE id = ?`).get(created.id) as { status: string };
    expect(ad.status).toBe("ready");

    // The card is IN the pixels. 1x1 defaults: card spans x 0.07–0.93,
    // y 0.62–0.978. Sample the left padding strip (white rect) and the
    // product image centre (our red test cutout) — proof both layers
    // composited where the geometry says they are.
    const posterBuf = await sharp(path.join(videosRoot, render.poster_key as string)).raw().toBuffer({ resolveWithObject: true });
    const { data: px, info } = posterBuf;
    const at = (fx: number, fy: number) => {
      const i = (Math.round(fy * info.height) * info.width + Math.round(fx * info.width)) * info.channels;
      return [px[i], px[i + 1], px[i + 2]];
    };
    const [wr, wg, wb] = at(0.085, 0.75); // card's left padding strip
    expect(wr).toBeGreaterThan(200);
    expect(wg).toBeGreaterThan(200);
    expect(wb).toBeGreaterThan(200);
    const [pr, pg] = at(0.5, 0.68); // product image centre — red cutout
    expect(pr).toBeGreaterThan(120);
    expect(pg).toBeLessThan(110);

    // Download zip contains the convention-named file.
    const res = await downloadAd(createRequest("GET", "x"), routeParams(created.id));
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(Object.keys(zip.files)).toEqual(["JX_PCARD_VID_SHIPO-TIGYEL_JADE_C00_v01_1x1.mp4"]);
  }, 180_000);

  it("marks the render failed when the background is gone", async () => {
    const { data: created } = await createTestAd();
    getTestDb().prepare(`UPDATE marketing_video_clips SET normalized_path = NULL WHERE id = 'clip1'`).run();
    await expect(renderVideoAd(created.id, "1x1")).rejects.toThrow(/not ready/);
    const r = getTestDb().prepare(`SELECT status, error FROM marketing_ad_renders WHERE ad_id = ?`).get(created.id) as
      { status: string; error: string };
    expect(r.status).toBe("failed");
    expect(r.error).toContain("not ready");
  });
});
