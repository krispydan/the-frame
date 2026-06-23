/**
 * Render an HTML string to a JPG image using headless Chromium.
 *
 * Uses Playwright (already a dev dep — `playwright` package is in
 * node_modules alongside @playwright/test). On Railway the chromium
 * binary needs to be present — install with `npx playwright install
 * chromium` at build time. If it isn't, this throws a clear error
 * with the install command in the message.
 *
 * Why Playwright and not puppeteer-core / chrome-aws-lambda /
 * @sparticuz/chromium: Playwright is already in package.json (for
 * e2e tests), so we get the screenshot capability for zero extra
 * dependencies. The Railway container is a regular Node container
 * (not serverless), so the full chromium binary works fine.
 */

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let browserSingleton: import("playwright").Browser | null = null;

async function getBrowser(): Promise<import("playwright").Browser> {
  if (browserSingleton && browserSingleton.isConnected()) {
    return browserSingleton;
  }
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (e) {
    throw new Error(
      `Playwright not available. Install with: npm install playwright && npx playwright install chromium. Underlying error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    browserSingleton = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  } catch (e) {
    throw new Error(
      `Chromium launch failed. The binary may not be installed — run: npx playwright install chromium. Underlying error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return browserSingleton;
}

export interface ScreenshotOptions {
  /** Logical viewport width — usually 600 (email body) or 1200 (retina). */
  viewportWidth?: number;
  /** Device-scale (2 = retina). */
  deviceScaleFactor?: number;
  /** JPG quality 0–100. Default 92. */
  quality?: number;
  /** Wait for fonts to load before screenshotting. Default true. */
  waitForFonts?: boolean;
}

/**
 * Render an HTML string and return a JPG buffer of the full body.
 *
 * The image is naturally cropped to the body bounding box —
 * whitespace below the rendered content is excluded. This means
 * a hero section returns a tight 600×~580px image, not a tall
 * page-height JPG with empty space.
 */
export async function renderHtmlToJpg(
  html: string,
  opts: ScreenshotOptions = {},
): Promise<Buffer> {
  const {
    viewportWidth = 600,
    deviceScaleFactor = 2,
    quality = 92,
    waitForFonts = true,
  } = opts;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: 800 },
    deviceScaleFactor,
  });

  // Write HTML to a temp file rather than data: URL — Playwright
  // handles local files cleanly + relative font URLs resolve.
  // (We use full URLs for fonts anyway, but this is robust.)
  const dir = await mkdtemp(join(tmpdir(), "jaxy-screenshot-"));
  const htmlPath = join(dir, "page.html");
  await writeFile(htmlPath, html, "utf8");

  try {
    const page = await context.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
    if (waitForFonts) {
      // Document.fonts.ready resolves when all linked font faces
      // have either loaded or definitively failed. Without this,
      // the screenshot can race the Google Fonts CSS download.
      await page.evaluate(() => document.fonts.ready);
    }
    // fullPage: true would give body-height. But body's natural
    // height matches the content's actual height (no extra padding
    // in our template), so this is the tight crop we want.
    const buffer = await page.screenshot({
      type: "jpeg",
      quality,
      fullPage: true,
    });
    return buffer;
  } finally {
    await context.close();
    await rm(dir, { recursive: true, force: true });
  }
}
