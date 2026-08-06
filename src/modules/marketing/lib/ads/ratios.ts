/**
 * Meta aspect ratios + the shared crop engine.
 *
 * One place owns "what does 4:5 mean in pixels" and "where does the crop
 * window sit on the source" — the video renderer (ffmpeg), the image
 * renderer (sharp) and the canvas editor's preview all consume the same
 * numbers, which is what keeps a dragged preview honest against the
 * rendered file. Pending task P4 (Faire/social channel cuts) should use
 * this too rather than growing its own.
 */

export const AD_RATIOS = {
  /** FB/IG feed primary. */
  "4x5": { width: 1080, height: 1350 },
  /** Feed universal / carousel cards. */
  "1x1": { width: 1080, height: 1080 },
  /** Stories / Reels. */
  "9x16": { width: 1080, height: 1920 },
  /** In-stream / Audience Network — off by default in the UI. */
  "16x9": { width: 1920, height: 1080 },
} as const;

export type AdRatio = keyof typeof AD_RATIOS;

export const DEFAULT_RATIOS: AdRatio[] = ["4x5", "1x1", "9x16"];

export function isAdRatio(v: unknown): v is AdRatio {
  return typeof v === "string" && v in AD_RATIOS;
}

export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the crop window sits on a source frame, with upper-centre
 * gravity: faces live in the top half of our verticals, so when the
 * window is shorter than the source it anchors its centre at 40% of
 * source height rather than dead centre. `offsetX`/`offsetY` are the
 * canvas editor's background nudge, normalized −0.5…0.5 of the slack in
 * each axis (0 = gravity default), so the same numbers drive ffmpeg,
 * sharp and the browser preview.
 *
 * All outputs are even integers (H.264 requires even dimensions).
 */
export function cropWindow(
  srcW: number,
  srcH: number,
  ratio: AdRatio,
  offsetX = 0,
  offsetY = 0,
): CropWindow {
  const { width: tw, height: th } = AD_RATIOS[ratio];
  const target = tw / th;
  const src = srcW / srcH;

  let cw: number, ch: number;
  if (src > target) {
    // Source is wider — full height, trim the sides.
    ch = srcH;
    cw = srcH * target;
  } else {
    // Source is taller — full width, trim top/bottom.
    cw = srcW;
    ch = srcW / target;
  }

  const slackX = srcW - cw;
  const slackY = srcH - ch;
  // Gravity: horizontal centre; vertical centre at 40% of source height.
  const gravityY = Math.min(Math.max(srcH * 0.4 - ch / 2, 0), slackY);
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const x = clamp(slackX / 2 + offsetX * slackX, slackX);
  const y = clamp(gravityY + offsetY * slackY, slackY);

  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  return { x: Math.round(x), y: Math.round(y), width: even(cw), height: even(ch) };
}
