"use client";

/**
 * Post Queue — the daily driver of the Video Remix Studio.
 *
 * Week view of generated posts grouped by day/slot. Each card is the
 * complete posting kit: video preview + download, caption + hashtags
 * with copy buttons, and the manual checklist (add trending audio,
 * type on-screen text, tag products) written by the AI.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Check,
  Copy,
  Download,
  Music,
  RefreshCw,
  Sparkles,
  Trash2,
  Type,
} from "lucide-react";

type Instructions = {
  audio?: string;
  onScreenText?: Array<{ text: string; timing: string; placement: string }>;
  tagProducts?: string[];
  coverSuggestion?: string;
  firstComment?: string;
};

type Post = {
  id: string;
  status: string;
  scheduled_date: string | null;
  scheduled_slot: string | null;
  recipe_name: string | null;
  audio_treatment: "silent" | "partial" | "full";
  duration_sec: number | null;
  caption: string | null;
  hashtags: string[];
  instructions: Instructions | null;
  error: string | null;
  videoUrl: string | null;
  posterUrl: string | null;
  clips: Array<{ position: number; id: string; category?: string; posterUrl: string | null }>;
};

const SLOT_LABEL: Record<string, string> = {
  morning: "Morning · ~8am",
  midday: "Midday · ~12pm",
  evening: "Evening · ~6pm",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  ready: "default",
  rendered: "secondary",
  queued: "outline",
  rendering: "secondary",
  posted: "outline",
  failed: "destructive",
};

function copyText(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error("Copy failed"),
  );
}

export function PostQueue() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [showGenerate, setShowGenerate] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = useCallback(() => {
    const from = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    fetch(`/api/v1/marketing/videos/posts?from=${from}`)
      .then((r) => r.json())
      .then((res) => {
        setPosts(res.posts ?? []);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live-refresh while renders are in flight.
  useEffect(() => {
    const pending = posts.some((p) => p.status === "queued" || p.status === "rendering");
    if (!pending) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [posts, load]);

  const groups = useMemo(() => {
    const byDay = new Map<string, Post[]>();
    for (const post of posts) {
      const key = post.scheduled_date ?? "Unscheduled";
      byDay.set(key, [...(byDay.get(key) ?? []), post]);
    }
    return [...byDay.entries()].sort(([a], [b]) => {
      if (a === "Unscheduled") return 1;
      if (b === "Unscheduled") return -1;
      return a.localeCompare(b);
    });
  }, [posts]);

  const readyToday = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return posts.filter((p) => p.status === "ready" && (p.scheduled_date ?? today) <= today).length;
  }, [posts]);

  if (loading) return <div className="animate-pulse h-96 bg-muted rounded-lg" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-muted-foreground">
          <span className="text-2xl font-bold text-foreground mr-1">{readyToday}</span>
          ready to post today
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
        <Button onClick={() => setShowGenerate(true)}>
          <Sparkles className="h-4 w-4 mr-1" /> Generate videos
        </Button>
      </div>

      {warnings.map((w) => (
        <div key={w} className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          {w}
        </div>
      ))}

      {groups.length === 0 && (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            Nothing in the queue. Hit <b>Generate videos</b> — the composer will mix your clip
            library into unique posts for the week.
          </CardContent>
        </Card>
      )}

      {groups.map(([day, dayPosts]) => (
        <div key={day} className="space-y-2">
          <h3 className="font-semibold text-sm text-muted-foreground sticky top-0 bg-background py-1">
            {day === "Unscheduled"
              ? "Unscheduled"
              : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
                  weekday: "long", month: "short", day: "numeric",
                })}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {dayPosts.map((post) => (
              <PostCard key={post.id} post={post} onChanged={load} />
            ))}
          </div>
        </div>
      ))}

      {showGenerate && (
        <GenerateDialog
          onClose={() => setShowGenerate(false)}
          onDone={(w) => {
            setWarnings(w);
            setShowGenerate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ── Post card ──

function PostCard({ post, onChanged }: { post: Post; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  const patch = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    const res = await fetch(`/api/v1/marketing/videos/posts/${post.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) {
      toast.success(okMsg);
      onChanged();
    } else toast.error((await res.json()).error ?? "Failed");
  };

  const regenerate = async (copyOnly: boolean) => {
    setBusy(true);
    const res = await fetch(`/api/v1/marketing/videos/posts/${post.id}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ copyOnly }),
    });
    setBusy(false);
    if (res.ok) {
      toast.success(copyOnly ? "Rewriting caption…" : "Composing a fresh video for this slot");
      onChanged();
    } else toast.error((await res.json()).error ?? "Failed");
  };

  const discard = async () => {
    setBusy(true);
    await fetch(`/api/v1/marketing/videos/posts/${post.id}`, { method: "DELETE" });
    setBusy(false);
    toast.success("Discarded — that edit will never be regenerated");
    onChanged();
  };

  const instructions = post.instructions;
  const captionFull = [post.caption ?? "", (post.hashtags ?? []).join(" ")].filter(Boolean).join("\n\n");

  return (
    <Card className={post.status === "posted" ? "opacity-60" : ""}>
      <CardContent className="p-3 space-y-2">
        <div className="flex gap-3">
          <div className="w-24 shrink-0">
            <div className="aspect-[9/16] rounded bg-muted overflow-hidden">
              {post.videoUrl ? (
                <video
                  src={post.videoUrl}
                  poster={post.posterUrl ?? undefined}
                  controls
                  muted
                  preload="none"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground text-center p-1">
                  {post.status === "failed" ? "render failed" : "rendering…"}
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <Badge variant={STATUS_VARIANT[post.status] ?? "outline"}>{post.status}</Badge>
              {post.scheduled_slot && (
                <Badge variant="outline" className="text-[10px]">{SLOT_LABEL[post.scheduled_slot]}</Badge>
              )}
              {post.recipe_name && <Badge variant="secondary" className="text-[10px]">{post.recipe_name}</Badge>}
              <Badge variant="outline" className="text-[10px]">
                <Music className="h-2.5 w-2.5 mr-0.5" />
                {post.audio_treatment === "silent" ? "add trending audio" : `${post.audio_treatment} original audio`}
              </Badge>
              {post.duration_sec != null && (
                <span className="text-[10px] text-muted-foreground">{post.duration_sec.toFixed(0)}s · {post.clips.length} clips</span>
              )}
            </div>

            {post.caption ? (
              <p className="text-sm leading-snug line-clamp-3">{post.caption}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">caption pending…</p>
            )}
            {post.hashtags?.length > 0 && (
              <p className="text-xs text-muted-foreground truncate">{post.hashtags.join(" ")}</p>
            )}
            {post.error && <p className="text-xs text-destructive line-clamp-2">{post.error}</p>}

            {/* Clip strip */}
            <div className="flex gap-0.5">
              {post.clips.slice(0, 8).map((c) => (
                <div key={c.position} className="h-8 w-5 rounded-sm bg-muted overflow-hidden" title={c.category}>
                  {c.posterUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.posterUrl} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Posting checklist */}
        {instructions && post.status !== "posted" && (
          <div className="rounded border bg-muted/30 p-2 text-xs space-y-1">
            {instructions.audio && (
              <div className="flex gap-1.5"><Music className="h-3.5 w-3.5 shrink-0 mt-px" /><span>{instructions.audio}</span></div>
            )}
            {(instructions.onScreenText ?? []).map((t, i) => (
              <div key={i} className="flex gap-1.5">
                <Type className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>
                  <b>&ldquo;{t.text}&rdquo;</b> — {t.timing}, {t.placement}
                </span>
              </div>
            ))}
            {instructions.tagProducts && instructions.tagProducts.length > 0 && (
              <div className="flex gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 mt-px" /><span>Tag: {instructions.tagProducts.join(", ")}</span></div>
            )}
            {instructions.coverSuggestion && (
              <div className="text-muted-foreground">Cover: {instructions.coverSuggestion}</div>
            )}
            {instructions.firstComment && (
              <div className="text-muted-foreground">First comment: {instructions.firstComment}</div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-1.5">
          {post.videoUrl && (
            <Button
              size="sm"
              variant="outline"
              render={
                <a
                  href={post.videoUrl}
                  download={`${post.scheduled_date ?? "video"}-${post.scheduled_slot ?? post.id.slice(0, 6)}.mp4`}
                />
              }
            >
              <Download className="h-3.5 w-3.5 mr-1" /> Video
            </Button>
          )}
          {captionFull && (
            <Button size="sm" variant="outline" onClick={() => copyText(captionFull, "Caption + hashtags")}>
              <Copy className="h-3.5 w-3.5 mr-1" /> Caption
            </Button>
          )}
          {post.status !== "posted" && post.videoUrl && (
            <Button size="sm" disabled={busy} onClick={() => patch({ status: "posted" }, "Marked as posted 🎉")}>
              <Check className="h-3.5 w-3.5 mr-1" /> Posted
            </Button>
          )}
          {post.status !== "posted" && (
            <>
              <Button size="sm" variant="ghost" disabled={busy || !post.videoUrl} onClick={() => regenerate(true)} title="Rewrite caption + instructions only">
                <Sparkles className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => regenerate(false)} title="Discard and compose a fresh video for this slot">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={discard} title="Discard">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Generate dialog ──

function GenerateDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (warnings: string[]) => void;
}) {
  const [mode, setMode] = useState<"week" | "count">("week");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState(7);
  const [slotsPerDay, setSlotsPerDay] = useState(3);
  const [count, setCount] = useState(5);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    const body =
      mode === "week"
        ? {
            startDate,
            endDate: new Date(new Date(startDate).getTime() + (days - 1) * 86400000).toISOString().slice(0, 10),
            slotsPerDay,
          }
        : { count };
    const res = await fetch("/api/v1/marketing/videos/posts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setRunning(false);
    if (!res.ok) {
      toast.error(data.error ?? "Generation failed");
      return;
    }
    toast.success(`Composed ${data.created} videos — rendering in the background`);
    onDone(data.warnings ?? []);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate videos</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex gap-2">
            <Button variant={mode === "week" ? "default" : "outline"} size="sm" onClick={() => setMode("week")}>
              Fill schedule
            </Button>
            <Button variant={mode === "count" ? "default" : "outline"} size="sm" onClick={() => setMode("count")}>
              Just give me N
            </Button>
          </div>
          {mode === "week" ? (
            <div className="space-y-2">
              <label className="block">
                <span className="text-muted-foreground">Start date</span>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1" />
              </label>
              <div className="flex gap-2">
                <label className="block flex-1">
                  <span className="text-muted-foreground">Days</span>
                  <Input type="number" min={1} max={31} value={days} onChange={(e) => setDays(Number(e.target.value) || 7)} className="mt-1" />
                </label>
                <label className="block flex-1">
                  <span className="text-muted-foreground">Posts per day</span>
                  <select value={slotsPerDay} onChange={(e) => setSlotsPerDay(Number(e.target.value))} className="mt-1 w-full border rounded px-2 py-1.5 bg-background">
                    <option value={2}>2 (morning + midday)</option>
                    <option value={3}>3 (+ evening)</option>
                  </select>
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Fills every empty slot in the range — slots that already have a post are left alone.
              </p>
            </div>
          ) : (
            <label className="block">
              <span className="text-muted-foreground">How many videos</span>
              <Input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value) || 5)} className="mt-1" />
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={run} disabled={running}>
            {running ? "Composing…" : "Generate"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
