/**
 * Local test harness for frame-shape classification — validate the crop +
 * AI prompt on real images/videos BEFORE wiring it into the app.
 *
 * It never touches the database: it exercises only the DB-free vision
 * primitives (crop + classify), so you can point it at any files and see
 * exactly what the model would decide.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/test-frame-shape.ts \
 *     [--vocab aviator,cat-eye,round,square,rectangle,oval,wayfarer] \
 *     [--save-crops <dir>] \
 *     <image-or-video> [more files...]
 *
 * Without a key it still runs the crop step (so you can eyeball the
 * close-ups it would send) and reports that classification was skipped.
 *
 * For a clip it pulls a still at 0.5s via ffmpeg. Give it the raw shoot
 * files whose SKU you already know and check the detected shape matches.
 */
import { execFile } from "child_process";
import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import {
  cropGlasses,
  classifyFrameShapeFromImage,
} from "@/modules/marketing/lib/video/frame-shape-vision";

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const DEFAULT_VOCAB = [
  "aviator", "cat-eye", "rectangle", "round", "square",
  "oval", "oversized", "geometric", "butterfly", "wayfarer", "hexagonal",
];

function parseArgs(argv: string[]): { files: string[]; vocab: string[]; saveCrops: string | null } {
  const files: string[] = [];
  let vocab = DEFAULT_VOCAB;
  let saveCrops: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vocab") vocab = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--save-crops") saveCrops = argv[++i] ?? null;
    else files.push(a);
  }
  return { files, vocab, saveCrops };
}

function extractStill(videoPath: string, atSec: number): Promise<string> {
  const out = path.join(tmpdir(), `fs-harness-${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`);
  const bin = process.env.FFMPEG_PATH || "ffmpeg";
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(atSec), "-i", videoPath, "-frames:v", "1", "-q:v", "3", out],
      { timeout: 60_000 },
      (err) => (err ? reject(err) : resolve(out)),
    );
  });
}

async function main() {
  const { files, vocab, saveCrops } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error("Usage: npx tsx scripts/test-frame-shape.ts [--vocab a,b,c] [--save-crops dir] <file> [...]");
    process.exit(1);
  }
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  if (saveCrops) await mkdir(saveCrops, { recursive: true });

  console.log(`Vocabulary (${vocab.length}): ${vocab.join(", ")}`);
  console.log(hasKey ? `Model: ${process.env.MARKETING_SKU_MATCH_MODEL || process.env.ANTHROPIC_VISION_MODEL || "claude-haiku-4-5-20251001"}` : "No ANTHROPIC_API_KEY — crop only, classification skipped.");
  console.log("─".repeat(72));

  let totalIn = 0;
  let totalOut = 0;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const isVideo = VIDEO_EXT.has(ext);
    let stillPath = file;
    let tempStill: string | null = null;
    try {
      if (isVideo) {
        stillPath = await extractStill(file, 0.5);
        tempStill = stillPath;
      }
      const crop = await cropGlasses(stillPath);
      if (saveCrops) {
        const dest = path.join(saveCrops, `${path.basename(file).replace(/\.[^.]+$/, "")}_crop.jpg`);
        await writeFile(dest, crop.buffer);
      }

      let verdict = "(classification skipped — no key)";
      if (hasKey) {
        const r = await classifyFrameShapeFromImage(crop.base64, crop.mime, vocab);
        if (!r.ok) {
          verdict = `ERROR: ${r.error}`;
        } else if (!r.clearShot || r.shapes.length === 0) {
          verdict = "no clear frame visible";
        } else {
          verdict = r.shapes.map((s) => `${s.shape} ${s.confidence}%`).join(", ");
        }
        if (r.usage) {
          totalIn += r.usage.input_tokens;
          totalOut += r.usage.output_tokens;
        }
      }
      console.log(`${path.basename(file)}  [crop ${crop.width}x${crop.height}]  →  ${verdict}`);
    } catch (e) {
      console.log(`${path.basename(file)}  →  FAILED: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (tempStill) await unlink(tempStill).catch(() => {});
    }
  }

  if (hasKey && (totalIn || totalOut)) {
    // Haiku 4.5 pricing (approx): $1/M input, $5/M output.
    const cost = (totalIn / 1e6) * 1 + (totalOut / 1e6) * 5;
    console.log("─".repeat(72));
    console.log(`Tokens: ${totalIn} in / ${totalOut} out across ${files.length} files ≈ $${cost.toFixed(4)} (~$${((cost / files.length) * 1000).toFixed(2)} per 1000)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
