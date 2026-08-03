"use client";

/**
 * Split review queue — work through the clips that are too long to use.
 *
 * A dedicated page rather than a dialog in the library, because this is
 * bulk work: the queue is on the left, the clip under review on the
 * right, and "Split & next" moves you on without a round-trip through a
 * grid. Longest clips lead, since they're the worst offenders.
 *
 * Every clip leaves the queue exactly once — split, or dismissed as
 * fine — so the same footage is never re-triaged.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClipSplitter, type Segment } from "@/modules/marketing/components/videos/clip-splitter";
import { ArrowLeft, Check, Loader2, RefreshCw, Scissors, SkipForward } from "lucide-react";

interface QueueClip {
  id: string;
  fileName: string;
  durationSec: number;
  categoryName: string | null;
  talent: string | null;
  productCount: number;
  posterUrl: string | null;
  previewUrl: string | null;
}

interface Stats {
  pending: number;
  reviewed: number;
  longestSec: number;
  pendingSec: number;
}

const API = "/api/v1/marketing/videos/clips";

/** "45s" / "12 min" — rounding a half-minute backlog to "0 min" reads as
 *  nothing left to do. */
function formatFootage(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s of footage`;
  return `${Math.round(sec / 60)} min of footage`;
}

export default function SplitReviewPage() {
  const [clips, setClips] = useState<QueueClip[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [minSec, setMinSec] = useState(10);
  const [loading, setLoading] = useState(true);

  const [current, setCurrent] = useState<QueueClip | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [sceneCuts, setSceneCuts] = useState<number[]>([]);
  const [filmstripUrl, setFilmstripUrl] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keepParent, setKeepParent] = useState(false);

  const loadQueue = useCallback(async (sec: number) => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/review?minSec=${sec}`);
      if (!res.ok) return;
      const d = await res.json();
      setClips(d.clips ?? []);
      setStats(d.stats ?? null);
      return d.clips as QueueClip[];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`${API}/review?minSec=${minSec}`).catch(() => null);
      const d = res?.ok ? await res.json() : null;
      if (cancelled) return;
      setClips(d?.clips ?? []);
      setStats(d?.stats ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [minSec]);

  /** Open a clip and fetch its proposed segments. */
  const open = useCallback(async (clip: QueueClip, force = false) => {
    setCurrent(clip);
    setSegments([]);
    setSceneCuts([]);
    setFilmstripUrl(null);
    setSuggesting(true);
    // Fire-and-forget: the strip is decoration, so it must never hold up
    // the segments the reviewer actually needs.
    fetch(`${API}/${clip.id}/filmstrip`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setFilmstripUrl(d?.url ?? null))
      .catch(() => {});
    try {
      const res = await fetch(`${API}/${clip.id}/split${force ? "?force=1" : ""}`);
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? "Couldn't analyse this clip");
        return;
      }
      setSceneCuts(d.sceneCuts ?? []);
      setSegments(d.segments ?? []);
    } finally {
      setSuggesting(false);
    }
  }, []);

  /** Drop the finished clip from the queue and open the next one. */
  const advance = useCallback(
    (doneId: string) => {
      const remaining = clips.filter((c) => c.id !== doneId);
      setClips(remaining);
      setStats((s) => (s ? { ...s, pending: Math.max(0, s.pending - 1), reviewed: s.reviewed + 1 } : s));
      const next = remaining[0] ?? null;
      if (next) open(next);
      else {
        setCurrent(null);
        setSegments([]);
      }
    },
    [clips, open],
  );

  const split = async () => {
    if (!current) return;
    if (segments.length === 0) {
      toast.error("Add at least one segment, or skip this clip");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/${current.id}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments, parentAction: keepParent ? "keep" : "archive" }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? "Split failed");
        return;
      }
      toast.success(
        `Cutting ${d.queued} clip${d.queued === 1 ? "" : "s"} from ${current.fileName} — they'll appear in the library shortly`,
      );
      advance(current.id);
    } finally {
      setSaving(false);
    }
  };

  const dismiss = async () => {
    if (!current) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/${current.id}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismiss: true }),
      });
      if (!res.ok) {
        toast.error("Couldn't dismiss");
        return;
      }
      toast.message("Left as-is");
      advance(current.id);
    } finally {
      setSaving(false);
    }
  };

  // ⌘↵ / Ctrl+↵ splits — the hands-stay-on-keyboard path.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && current && !saving) {
        e.preventDefault();
        split();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, saving, segments, keepParent]);

  const done = stats ? stats.reviewed : 0;
  const total = stats ? stats.pending + stats.reviewed : 0;

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/marketing/videos/clips" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Clip library
        </Button>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Scissors className="h-5 w-5" /> Split review
        </h1>
        {stats && (
          <span className="text-xs text-muted-foreground">
            {done} of {total} reviewed · {stats.pending} left · {formatFootage(stats.pendingSec)} to triage
          </span>
        )}
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Longer than</span>
          <select
            value={minSec}
            onChange={(e) => setMinSec(Number(e.target.value))}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            {[6, 8, 10, 15, 20, 30].map((s) => (
              <option key={s} value={s}>{s}s</option>
            ))}
          </select>
        </label>
        <Button variant="ghost" size="sm" onClick={() => loadQueue(minSec)}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)] min-w-0">
        {/* Queue */}
        <Card className="min-w-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Queue <span className="font-normal text-muted-foreground">longest first</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-[70vh] space-y-1 overflow-y-auto">
            {loading && <div className="h-24 animate-pulse rounded bg-muted" />}
            {!loading && clips.length === 0 && (
              <p className="p-2 text-sm text-muted-foreground">
                Nothing over {minSec}s to review. Every long clip has been split or left as-is.
              </p>
            )}
            {clips.map((c) => (
              <button
                key={c.id}
                onClick={() => open(c)}
                className={`flex w-full items-center gap-2 rounded border p-1.5 text-left hover:bg-muted ${
                  current?.id === c.id ? "border-primary bg-muted/60" : ""
                }`}
              >
                <span className="relative block h-12 w-8 shrink-0 overflow-hidden rounded bg-muted">
                  {c.posterUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.posterUrl} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium" title={c.fileName}>
                    {c.fileName}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {c.durationSec.toFixed(1)}s · {c.categoryName ?? "uncategorized"}
                  </span>
                </span>
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Splitter */}
        <Card className="min-w-0">
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              {current ? (
                <>
                  <span className="truncate" title={current.fileName}>{current.fileName}</span>
                  <Badge variant="outline">{current.durationSec.toFixed(1)}s</Badge>
                  {current.categoryName && <Badge variant="secondary">{current.categoryName}</Badge>}
                  {current.productCount > 0 && (
                    <span className="text-xs font-normal text-muted-foreground">
                      {current.productCount} product tag{current.productCount === 1 ? "" : "s"} — inherited by every cut
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">Pick a clip from the queue</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!current && (
              <p className="p-4 text-sm text-muted-foreground">
                Segments are proposed automatically from scene changes — you adjust them rather than draw them.
              </p>
            )}

            {current && (
              <>
                {suggesting && segments.length === 0 ? (
                  <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Finding the scene changes…
                  </div>
                ) : (
                  <ClipSplitter
                    previewUrl={current.previewUrl}
                    durationSec={current.durationSec}
                    sceneCuts={sceneCuts}
                    segments={segments}
                    onChange={setSegments}
                    filmstripUrl={filmstripUrl}
                    onSuggest={() => open(current, true)}
                    suggesting={suggesting}
                    disabled={saving}
                  />
                )}

                <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                  <Button onClick={split} disabled={saving || segments.length === 0}>
                    {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Scissors className="h-4 w-4 mr-1" />}
                    Split into {segments.length} & next
                  </Button>
                  <Button variant="outline" onClick={dismiss} disabled={saving}>
                    <Check className="h-4 w-4 mr-1" /> Fine as-is
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => current && advance(current.id)}
                    disabled={saving}
                    title="Leave it in the queue and come back to it"
                  >
                    <SkipForward className="h-4 w-4 mr-1" /> Skip
                  </Button>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" checked={keepParent} onChange={(e) => setKeepParent(e.target.checked)} />
                    Keep the original active too
                  </label>
                  <span className="text-xs text-muted-foreground">⌘↵ to split</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Cuts inherit this clip&apos;s category, person and product tags. The original is archived (never
                  deleted) once the cuts land — posts that already use it keep working.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
