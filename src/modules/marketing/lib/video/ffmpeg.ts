/**
 * Thin, safe wrappers around the ffmpeg/ffprobe binaries.
 *
 * ffmpeg is provisioned by nixpacks on Railway (see nixpacks.toml) and
 * must be on PATH. All invocations use execFile with an args array —
 * never a shell string — so filenames can't inject anything.
 */
import { execFile } from "child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/** Default hard timeout — a 10s clip should never take this long. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class FfmpegError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
  maxBuffer = 32 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer },
      (err, stdout, stderr) => {
        if (err) {
          reject(new FfmpegError(`${bin} failed: ${err.message}`, String(stderr).slice(-4000)));
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });
}

/**
 * Transcodes run ONE AT A TIME, process-wide.
 *
 * A 1080x1920 libx264 encode is roughly 800MB resident. Nothing upstream
 * limited how many could run together — the job worker took three jobs per
 * five-second tick with no guard, and the upload/trim routes invoke ffmpeg
 * straight off the request — so three concurrent renders reached ~2.4GB and
 * the container was OOM-killed, restarted, picked the same jobs back up, and
 * did it again. That restart loop took production down on 2026-08-04.
 *
 * The gate lives here rather than in the job handlers because handlers are not
 * the only caller: serialising at the binary means every path is covered,
 * including the next one someone adds.
 *
 * Waiting for the gate is deliberately NOT inside the execFile timeout — the
 * clock starts when the process actually launches, so a queued render can't
 * fail merely for having waited its turn.
 *
 * Note this is per-process. It bounds one container; if replicas are ever
 * scaled past one, memory headroom needs revisiting.
 */
let transcodeChain: Promise<unknown> = Promise.resolve();

function serializeTranscode<T>(fn: () => Promise<T>): Promise<T> {
  // Chain on both settle paths — a failed render must not wedge the queue.
  const result = transcodeChain.then(fn, fn);
  transcodeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function runFfmpeg(args: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
  await serializeTranscode(() =>
    run(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
}

/**
 * Run ffmpeg and hand back stderr, through the same one-at-a-time gate.
 *
 * Exists for analysis passes that read ffmpeg's diagnostic output rather than
 * writing a file — scene detection being the one that matters, since it
 * decodes the whole source and is the single most expensive thing this module
 * does. It used to call execFile directly and so ran outside the gate, which
 * made it the likeliest way to stack decodes on top of an in-flight render.
 */
export async function runFfmpegCapture(
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<string> {
  const { stderr } = await serializeTranscode(() =>
    run(FFMPEG, ["-hide_banner", ...args], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.maxBuffer),
  );
  return stderr;
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string | null;
  sizeBytes: number;
}

/** ffprobe a media file (absolute path). Throws FfmpegError on failure. */
export async function ffprobe(fullPath: string): Promise<ProbeResult> {
  const { stdout } = await run(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", fullPath],
    60_000,
  );
  const data = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
    }>;
    format?: { duration?: string; size?: string };
  };

  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  if (!video) throw new FfmpegError("No video stream found", stdout.slice(0, 2000));

  let fps = 0;
  if (video.avg_frame_rate && video.avg_frame_rate !== "0/0") {
    const [num, den] = video.avg_frame_rate.split("/").map(Number);
    if (den > 0) fps = num / den;
  }

  const durationSec = parseFloat(data.format?.duration || video.duration || "0");

  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps,
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name ?? null,
    sizeBytes: parseInt(data.format?.size || "0", 10) || 0,
  };
}

let availabilityLogged = false;

/**
 * Boot-time probe — logs the ffmpeg version once, or a loud warning if
 * the binary is missing (e.g. nixpacks entry dropped). Callers treat a
 * missing binary as a job failure, not a crash.
 */
export async function assertFfmpegAvailable(): Promise<boolean> {
  try {
    const { stdout } = await run(FFMPEG, ["-version"], 15_000);
    if (!availabilityLogged) {
      availabilityLogged = true;
      console.info(`[video] ${stdout.split("\n")[0]}`);
    }
    return true;
  } catch (e) {
    console.error(
      `[video] ffmpeg NOT AVAILABLE — video normalization/rendering will fail. ` +
      `Check nixpacks.toml nixPkgs. ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }
}

/**
 * A message worth showing a human.
 *
 * FfmpegError.message is only ever "ffmpeg failed: Command failed: …" —
 * the actual reason lives in stderr, which callers were dropping. That's
 * how a broken trim reached the operator as a bare "Trim failed" with
 * nothing to act on. Pull out the last real stderr line instead.
 */
export function describeMediaError(e: unknown): string {
  if (e instanceof FfmpegError) {
    const line = e.stderr
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (/timed out|ETIMEDOUT/i.test(e.message)) {
      return "Video processing timed out — the clip may be too long or storage too slow";
    }
    return line ? `Video processing failed: ${line}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Encoder flags that make a file cheap to SEEK, not just to play.
 *
 * libx264 defaults to keyint=250 — at 30fps that's a keyframe every 8.3
 * seconds, so scrubbing to an arbitrary point makes the browser decode up
 * to 249 1080x1920 frames to show one. That is why dragging a trim handle
 * stutters, and no amount of UI throttling fixes it.
 *
 * -g 15 puts a keyframe every 0.5s (worst case 14 frames to decode).
 * -sc_threshold 0 forces fixed, closed GOPs; without it scenecut detection
 * makes the spacing unpredictable and open GOPs need the PREVIOUS GOP
 * decoded too.
 *
 * Measured on 1080x1920@30 moving content: +6.8% file size against a 16x
 * improvement in seek granularity.
 *
 * Functions, not consts: callers spread these into module-level arrays,
 * and a const export was reaching them uninitialised depending on module
 * evaluation order ("SEEK_FRIENDLY_FLAGS is not iterable"). Function
 * declarations hoist, so this can't happen.
 */
export function seekFriendlyFlags(): string[] {
  return ["-g", "15", "-keyint_min", "15", "-sc_threshold", "0"];
}

/** Put the moov atom first so a player can build its seek index without
 *  fetching the tail of the file. */
export function faststartFlags(): string[] {
  return ["-movflags", "+faststart"];
}

/**
 * Cut `[inSec, outSec)` out of an already-normalized clip, frame-accurately.
 *
 * Both concat pipelines (social posts and product videos) apply
 * non-destructive trims this way, so the cut lives here rather than being
 * written twice.
 *
 * Why re-encode rather than lean on the concat demuxer's inpoint/outpoint:
 * under `-c:v copy` those snap to the nearest keyframe, up to half a
 * second away, so a deliberate in-point lands somewhere the operator
 * didn't choose. `-ss` BEFORE `-i` still seeks fast (ffmpeg jumps to the
 * preceding keyframe and decodes forward, discarding); the re-encode is
 * what makes the boundary exact.
 *
 * The output profile matches normalize.ts exactly, so the cut still
 * stream-copy concats with its untrimmed neighbours.
 */
export async function cutAccurate(
  srcPath: string,
  outPath: string,
  inSec: number,
  outSec: number,
): Promise<void> {
  await runFfmpeg([
    "-y",
    "-ss", inSec.toFixed(3),
    "-i", srcPath,
    "-t", (outSec - inSec).toFixed(3),
    "-c:v", "libx264", "-profile:v", "high", "-level", "4.1",
    "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-video_track_timescale", "15360",
    ...seekFriendlyFlags(),
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
    ...faststartFlags(),
    outPath,
  ]);
}
