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
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
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

export async function runFfmpeg(args: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
