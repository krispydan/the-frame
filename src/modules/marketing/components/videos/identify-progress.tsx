"use client";

/**
 * Identification progress — the gamified header for the SKU Identifier.
 *
 * Tagging hundreds of clips is repetitive work, so the goal here is to make
 * the finish line visible and the effort feel rewarded:
 *   - a progress bar with the exact "N left" countdown (the motivating number)
 *   - a streak counter that builds with each save and resets on a skip
 *   - session pace + a live ETA, so "how much longer?" always has an answer
 *   - milestone celebrations (10, 25, 50, 100 …) and a rank that levels up
 *
 * All state above the API's totals is session-local — no schema needed, and
 * nothing to reset tomorrow.
 */

import { useEffect, useMemo, useState } from "react";
import { Flame, Trophy, Zap, Clock, PartyPopper } from "lucide-react";
import { STATUS, seriesColor } from "@/components/dashboard/palette";

export type Progress = {
  type: "clip" | "image";
  total: number;
  done: number;
  tagged: number;
  noProduct: number;
  remaining: number;
  doneToday: number;
};

/** Ranks unlock on session count — cheap, silly, and surprisingly effective. */
const RANKS: Array<{ at: number; name: string; emoji: string }> = [
  { at: 0, name: "Rookie", emoji: "🌱" },
  { at: 10, name: "Spotter", emoji: "👀" },
  { at: 25, name: "Frame Hunter", emoji: "🕶️" },
  { at: 50, name: "Sharp Eye", emoji: "🎯" },
  { at: 100, name: "Catalog Whisperer", emoji: "🧠" },
  { at: 200, name: "Legend", emoji: "👑" },
];

function rankFor(n: number) {
  return [...RANKS].reverse().find((r) => n >= r.at) ?? RANKS[0];
}
function nextRankFor(n: number) {
  return RANKS.find((r) => n < r.at) ?? null;
}

const MILESTONES = [10, 25, 50, 100, 150, 200, 300, 500];

export function IdentifyProgress({
  progress,
  sessionCount,
  streak,
  celebrate,
}: {
  progress: Progress | null;
  sessionCount: number;
  streak: number;
  /** Milestone just crossed, if any — drives the celebration banner. */
  celebrate: number | null;
}) {
  // This component owns the session clock: the start is stamped inside the
  // mount effect and elapsed time is measured in the interval callback, so the
  // clock is never read during render (which would be impure). The exact
  // second doesn't matter for a pace estimate.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsedMs(Date.now() - start), 15_000);
    return () => clearInterval(t);
  }, []);

  const pace = useMemo(() => {
    const mins = elapsedMs / 60000;
    if (sessionCount < 2 || mins < 0.5) return null;
    return sessionCount / mins; // items per minute
  }, [sessionCount, elapsedMs]);

  if (!progress || progress.total === 0) return null;

  const pct = progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  const label = progress.type === "clip" ? "clips" : "images";
  const rank = rankFor(sessionCount);
  const next = nextRankFor(sessionCount);
  const etaMins = pace && pace > 0 ? Math.ceil(progress.remaining / pace) : null;
  const complete = progress.remaining === 0;

  return (
    <div className="space-y-2 rounded-xl border bg-card p-3">
      {/* Celebration banner */}
      {celebrate != null && (
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
          style={{ backgroundColor: `${STATUS.good}1a`, color: STATUS.good }}
        >
          <PartyPopper className="h-4 w-4 shrink-0" />
          {celebrate} tagged this session — {rank.emoji} {rank.name}! Keep going.
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums">{progress.remaining.toLocaleString()}</span>
            <span className="text-sm text-muted-foreground">{label} left to identify</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {progress.done.toLocaleString()} of {progress.total.toLocaleString()} done
            {progress.noProduct > 0 && ` · ${progress.noProduct.toLocaleString()} marked no product`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Chip icon={<Trophy className="h-3.5 w-3.5" />} label={`${rank.emoji} ${rank.name}`} tone={seriesColor(3)} title={next ? `${next.at - sessionCount} more to reach ${next.name}` : "Top rank — you've seen it all"} />
          <Chip icon={<Zap className="h-3.5 w-3.5" />} label={`${sessionCount} this session`} tone={seriesColor(0)} />
          {streak >= 3 && (
            <Chip icon={<Flame className="h-3.5 w-3.5" />} label={`${streak} streak`} tone={STATUS.serious} title="Consecutive saves without skipping" />
          )}
          {progress.doneToday > 0 && (
            <Chip label={`${progress.doneToday} today`} tone={STATUS.neutral} />
          )}
          {etaMins != null && !complete && (
            <Chip icon={<Clock className="h-3.5 w-3.5" />} label={etaMins > 90 ? `~${Math.round(etaMins / 60)}h left` : `~${etaMins}m left`} tone={STATUS.neutral} title={`At ${pace!.toFixed(1)}/min`} />
          )}
        </div>
      </div>

      {/* Progress bar — remaining is the motivating number, so the fill grows
          toward a visible finish line. */}
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${Math.max(pct > 0 ? 1.5 : 0, pct)}%`,
            backgroundColor: complete ? STATUS.good : seriesColor(0),
          }}
        />
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{pct.toFixed(pct < 10 ? 1 : 0)}% identified</span>
        {complete ? (
          <span style={{ color: STATUS.good }}>🎉 Queue clear — every {label.slice(0, -1)} is identified</span>
        ) : next ? (
          <span>{next.at - sessionCount} more to reach {next.emoji} {next.name}</span>
        ) : null}
      </div>
    </div>
  );
}

function Chip({ icon, label, tone, title }: { icon?: React.ReactNode; label: string; tone: string; title?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium"
      style={{ backgroundColor: `${tone}1a`, color: tone }}
      title={title}
    >
      {icon}
      {label}
    </span>
  );
}

/** Milestone crossed between two counts, if any. */
export function milestoneCrossed(prev: number, next: number): number | null {
  return MILESTONES.find((m) => prev < m && next >= m) ?? null;
}
