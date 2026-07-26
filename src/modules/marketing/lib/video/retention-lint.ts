/**
 * Retention linter — deterministic, no-AI checks that flag the things
 * research says kill short-form watch time, BEFORE a video is posted.
 * Cheap, always-on, and unit-testable. Runs client-side in the editor
 * and is safe to reuse server-side.
 *
 * The rules encode the 2026 short-form consensus: the first ~2s decide
 * distribution, a visual change every ~2s holds attention, and on-screen
 * text carries the message for the (many) muted viewers.
 */

export type LintLevel = "warn" | "tip";

export interface LintIssue {
  level: LintLevel;
  code: string;
  message: string;
}

export interface LintInput {
  hook?: string | null;
  captionLength?: number;
  onScreenTextCount?: number;
  /** Per-clip durations in sequence order (seconds). */
  clipDurations?: number[];
  totalDurationSec?: number;
}

/** Longest a single clip should sit before a cut (the "rule of ~2s"). */
export const MAX_STATIC_CLIP_SEC = 4;
/** Hook must fit on screen when burned in. */
export const MAX_HOOK_CHARS = 60;
/** Short-form sweet spot upper bound. */
export const MAX_GOOD_DURATION_SEC = 60;

export function lintRetention(input: LintInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const hook = (input.hook ?? "").trim();

  if (!hook) {
    issues.push({ level: "warn", code: "no-hook", message: "No hook — the first 2 seconds decide whether this gets distributed. Add a scroll-stopping line." });
  } else if (hook.length > MAX_HOOK_CHARS) {
    issues.push({ level: "warn", code: "hook-too-long", message: `Hook is ${hook.length} chars — trim under ${MAX_HOOK_CHARS} so it reads in the first 2 seconds and fits on screen.` });
  }

  if ((input.onScreenTextCount ?? 0) === 0) {
    issues.push({ level: "tip", code: "no-captions", message: "No on-screen text — most viewers watch muted; captioned videos hold viewers ~53% longer." });
  }

  const longest = Math.max(0, ...(input.clipDurations ?? []));
  if (longest > MAX_STATIC_CLIP_SEC) {
    const idx = (input.clipDurations ?? []).findIndex((d) => d > MAX_STATIC_CLIP_SEC);
    issues.push({ level: "tip", code: "static-clip", message: `Clip ${idx + 1} runs ${longest.toFixed(1)}s with no cut — a change every ~2s holds attention. Trim it, or add a punch-in / reframe.` });
  }

  if ((input.totalDurationSec ?? 0) > MAX_GOOD_DURATION_SEC) {
    issues.push({ level: "tip", code: "too-long", message: `Video is ${Math.round(input.totalDurationSec ?? 0)}s — the sweet spot is under ${MAX_GOOD_DURATION_SEC}s. Consider trimming.` });
  }

  if ((input.captionLength ?? 0) > 220) {
    issues.push({ level: "tip", code: "caption-long", message: "Caption is over 220 chars — front-load the point; length buries the hook." });
  }

  return issues;
}

/** Preset feedback for the AI "tighten for retention" pass (engine #5). */
export const RETENTION_OPTIMIZER_FEEDBACK =
  "Act as a short-form retention editor. Find weak hooks, generic phrasing, filler, and anything killing watch time. " +
  "Sharpen the hook so it stops the scroll in the first 2 seconds (specific beats broad), tighten the caption for clarity " +
  "and emotional pull, and make sure there's a clear payoff or CTA — WITHOUT changing the core message or going salesy.";
