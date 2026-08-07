"use client";

/**
 * Thinking indicators for waits where a spinner reads as "stuck".
 *
 * Wraps `thinking-orbs` (MIT) so the app has ONE place deciding what a
 * thinking state looks like, and one place to change it back.
 *
 * ── When to use this instead of a spinner ──
 *
 * All four have to hold, or a plain spinner/skeleton is the better answer:
 *
 *   1. The wait is long enough that a spinner starts to look broken —
 *      call it 5s+. Most fetches in this app are well under a second.
 *   2. The system is genuinely GENERATING or SEARCHING, not just fetching.
 *      An orb on a table load is decoration, and decoration on a wait is
 *      how you teach people that waiting is normal.
 *   3. The user is watching it. Background jobs don't need an animation
 *      nobody is looking at.
 *   4. There's no determinate progress available. "7 of 20 rendered" beats
 *      any animation ever will — use a progress bar there.
 *
 * Deliberately NOT applied to: table and page skeletons, save buttons,
 * navigation, video renders (they have real per-stage progress), and the
 * cron/job dashboards (those are status displays, not waits).
 *
 * ── Picking a state ──
 *
 * The nine states are semantic, not cosmetic. Match the verb to the work so
 * the animation is telling the truth about what's happening:
 *   searching  — querying an external index/API for a match
 *   composing  — an LLM writing prose
 *   connecting — reconciling records across systems
 *   working    — general compute with no better fit
 */

import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { useEffect, useState } from "react";

/**
 * Inline orb sized for a button, beside its label.
 *
 * The package ships exactly two tuned sizes (20 and 64) — they're separate
 * designs rather than one scaled, so don't invent intermediate sizes.
 */
export function ThinkingInline({
  state = "working",
  label,
}: {
  state?: OrbState;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <ThinkingOrb state={state} size={20} aria-label={label ?? "Working"} />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

/**
 * Seconds since mount, ticking once a second.
 *
 * Counts by increment rather than differencing Date.now(), because reading a
 * clock during render is impure and the React compiler rejects it. State is
 * only ever set from the interval callback, never synchronously in the effect.
 *
 * Callers mount this component conditionally, so "since mount" IS "since the
 * work started" — no reset logic needed, and none of the re-render churn that
 * a reset would cost.
 */
function useElapsed(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return seconds;
}

/**
 * Focal thinking panel for a blocking wait.
 *
 * Shows elapsed time past `showElapsedAfter` seconds. On a 60–90 second
 * scrape the single most valuable thing on screen is evidence the thing is
 * still alive — a counter does that where an animation alone can't, because
 * an animation looks identical whether the request is working or hung. That
 * is not a hypothetical here: a hung request that animated forever is exactly
 * what made a production stall hard to spot.
 */
export function ThinkingPanel({
  state = "working",
  title,
  hint,
  showElapsedAfter = 5,
}: {
  state?: OrbState;
  title: string;
  hint?: string;
  showElapsedAfter?: number;
}) {
  const seconds = useElapsed();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
      <ThinkingOrb state={state} size={64} aria-label={title} />
      <div>
        <p className="text-sm font-medium">{title}</p>
        {hint ? <p className="text-xs text-muted-foreground mt-0.5">{hint}</p> : null}
        {seconds >= showElapsedAfter ? (
          <p className="text-xs text-muted-foreground mt-1 tabular-nums">{seconds}s</p>
        ) : null}
      </div>
    </div>
  );
}
