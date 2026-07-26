"use client";

/**
 * Video post detail — the per-video editor (the video-side twin of the
 * email campaign editor).
 *
 *   • Watch the rendered video.
 *   • Edit caption / hashtags / posting instructions (text overlay etc).
 *   • "Improve with AI": natural-language feedback that revises the copy
 *     from its current state (same chat pattern as the email editor).
 *   • Mini clip editor: add / remove / reorder the clips, then save —
 *     the video re-renders in the background with the new sequence.
 */

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { VideoPlayer } from "@/components/ui/video-player";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import {
  ArrowLeft, ArrowRight, Clapperboard, Crop, FastForward, Focus, Loader2,
  MessageSquare, Plus, RefreshCw, Rewind, Scissors, Send, X,
} from "lucide-react";

type OnScreenText = { text: string; timing: string; placement: string };
type Instructions = {
  hook?: string;
  pillar?: string;
  scriptBeats?: string[];
  audio?: string;
  onScreenText?: OnScreenText[];
  tagProducts?: string[];
  coverSuggestion?: string;
  firstComment?: string;
  suggestedSounds?: Array<{ id: string; title: string; author: string | null; tiktokLink: string | null }>;
};

type PostClip = {
  position: number;
  id: string;
  fileName?: string;
  durationSec?: number | null;
  posterUrl?: string | null;
  previewUrl?: string | null;
  category?: string | null;
};

type Post = {
  id: string;
  status: string;
  caption: string | null;
  hashtags: string[];
  instructions: Instructions | null;
  videoUrl: string | null;
  posterUrl: string | null;
  duration_sec?: number | null;
  recipe_name?: string | null;
  scheduled_date?: string | null;
  scheduled_slot?: string | null;
  platform?: string;
  audio_treatment?: string;
  error?: string | null;
  clips: PostClip[];
};

type LibClip = {
  id: string;
  fileName: string;
  durationSec: number | null;
  posterUrl: string | null;
  category: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  queued: "bg-amber-100 text-amber-800",
  rendering: "bg-blue-100 text-blue-800",
  rendered: "bg-violet-100 text-violet-800",
  ready: "bg-green-100 text-green-800",
  posted: "bg-gray-200 text-gray-600",
  failed: "bg-red-100 text-red-800",
};

export default function VideoPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const api = `/api/v1/marketing/videos/posts/${id}`;

  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Show the video's name in the breadcrumb instead of the raw id.
  const { setOverride } = useBreadcrumbOverride();

  // Editable copy state
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [instr, setInstr] = useState<Instructions>({});

  // Clip editor state
  const [clipSeq, setClipSeq] = useState<PostClip[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [library, setLibrary] = useState<LibClip[]>([]);
  const [libSearch, setLibSearch] = useState("");
  // Trim dialog: which sequence index is being trimmed + the in/out points.
  const [trimIdx, setTrimIdx] = useState<number | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimming, setTrimming] = useState(false);
  const trimVideoRef = useRef<HTMLVideoElement | null>(null);
  // Reframe dialog: which sequence index, zoom factor + normalized focal point.
  const [reframeIdx, setReframeIdx] = useState<number | null>(null);
  const [reframeZoom, setReframeZoom] = useState(1.4);
  const [reframeFocus, setReframeFocus] = useState({ x: 0.5, y: 0.42 });
  // Which clip index currently has an effect applying (disables its tools).
  const [fxBusyIdx, setFxBusyIdx] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(api);
    if (!res.ok) {
      setLoading(false);
      setPost(null);
      return;
    }
    const d = await res.json();
    const p = d.post as Post;
    setPost(p);
    setCaption(p.caption ?? "");
    setHashtags((p.hashtags ?? []).join(" "));
    setInstr(p.instructions ?? {});
    setClipSeq(p.clips ?? []);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  // Reflect the video in the breadcrumb ("… / Videos / <name>"); clear on leave.
  useEffect(() => {
    setOverride(post?.recipe_name ? post.recipe_name : "Video");
    return () => setOverride(null);
  }, [post?.recipe_name, setOverride]);

  // Poll while a re-render is in flight so the player appears when done.
  useEffect(() => {
    if (!post || !["queued", "rendering"].includes(post.status)) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [post, load]);

  const patch = async (body: Record<string, unknown>, okMsg: string) => {
    setSaving(true);
    const res = await fetch(api, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    setSaving(false);
    if (res.ok) {
      toast.success(okMsg);
      await load();
      return true;
    }
    toast.error(d.error ?? "Save failed");
    return false;
  };

  const saveCopy = () =>
    patch(
      {
        caption,
        hashtags: hashtags.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean).map((h) => (h.startsWith("#") ? h : `#${h}`)),
      },
      "Caption saved",
    );

  const saveInstructions = () => patch({ instructions: instr }, "Posting instructions saved");

  const clipsDirty = useMemo(() => {
    if (!post) return false;
    const a = post.clips.map((c) => c.id).join("|");
    const b = clipSeq.map((c) => c.id).join("|");
    return a !== b;
  }, [post, clipSeq]);

  const totalDuration = useMemo(
    () => clipSeq.reduce((s, c) => s + (c.durationSec ?? 0), 0),
    [clipSeq],
  );

  const saveClips = async () => {
    if (!clipsDirty || clipSeq.length === 0) return;
    const ok = await patch({ clipIds: clipSeq.map((c) => c.id) }, "Clip sequence saved — re-rendering in the background");
    if (ok) setPickerOpen(false);
  };

  const moveClip = (i: number, dir: -1 | 1) => {
    setClipSeq((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const openPicker = async () => {
    setPickerOpen(true);
    if (library.length > 0) return;
    const res = await fetch(`/api/v1/marketing/videos/clips?status=ready&limit=500`);
    const d = await res.json();
    setLibrary(
      (d.clips ?? []).map((c: Record<string, unknown>) => ({
        id: String(c.id),
        fileName: String(c.fileName ?? c.file_name ?? ""),
        durationSec: (c.durationSec ?? c.duration_sec) as number | null,
        posterUrl: (c.posterUrl ?? c.poster_url ?? null) as string | null,
        category: (c.category ?? null) as string | null,
      })),
    );
  };

  // AI revise chat
  const [chatInput, setChatInput] = useState("");
  const [chatThread, setChatThread] = useState<Array<{ role: "you" | "ai"; text: string }>>([]);
  const [chatBusy, setChatBusy] = useState(false);

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setChatThread((t) => [...t, { role: "you", text }]);
    setChatInput("");
    setChatBusy(true);
    try {
      const res = await fetch(`${api}/revise-copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: text }),
      });
      const d = await res.json();
      if (res.ok) {
        await load();
        setChatThread((t) => [...t, { role: "ai", text: "✓ Updated the caption + instructions — review below." }]);
      } else {
        setChatThread((t) => [...t, { role: "ai", text: `⚠ ${d.error ?? "Couldn't apply that."}` }]);
      }
    } finally {
      setChatBusy(false);
    }
  };

  const openTrim = (i: number) => {
    const c = clipSeq[i];
    setTrimIdx(i);
    setTrimStart(0);
    setTrimEnd(Math.round((c.durationSec ?? 0) * 10) / 10);
  };

  const applyTrim = async () => {
    if (trimIdx === null) return;
    const target = clipSeq[trimIdx];
    setTrimming(true);
    try {
      const res = await fetch(`/api/v1/marketing/videos/clips/${target.id}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startSec: trimStart, endSec: trimEnd }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? "Trim failed");
        return;
      }
      const c = d.clip as { id: string; fileName: string; durationSec: number | null; posterUrl: string | null; previewUrl: string | null; category: string | null };
      setClipSeq((prev) => prev.map((row, j) => (j === trimIdx ? { position: row.position, ...c } : row)));
      setTrimIdx(null);
      toast.success(
        d.deduped
          ? "That exact trim already existed — swapped it in. Hit Save & re-render."
          : "Trimmed clip ready — hit Save & re-render to apply it.",
      );
    } finally {
      setTrimming(false);
    }
  };

  // Apply a visual transform (reframe / punch / speed) to a clip in the
  // sequence, swapping in the resulting new clip. `idx` tracks the row so
  // its tools disable while the effect renders.
  const applyTransform = async (
    idx: number,
    spec: Record<string, unknown>,
    label: string,
  ) => {
    const target = clipSeq[idx];
    if (!target) return;
    setFxBusyIdx(idx);
    try {
      const res = await fetch(`/api/v1/marketing/videos/clips/${target.id}/transform`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(spec),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? `${label} failed`);
        return false;
      }
      const c = d.clip as { id: string; fileName: string; durationSec: number | null; posterUrl: string | null; previewUrl: string | null; category: string | null };
      setClipSeq((prev) => prev.map((row, j) => (j === idx ? { position: row.position, ...c } : row)));
      toast.success(
        d.deduped
          ? `${label} already existed — swapped it in. Hit Save & re-render.`
          : `${label} applied — hit Save & re-render to bake it in.`,
      );
      return true;
    } finally {
      setFxBusyIdx(null);
    }
  };

  const openReframe = (i: number) => {
    setReframeIdx(i);
    setReframeZoom(1.4);
    setReframeFocus({ x: 0.5, y: 0.42 });
  };

  const applyReframe = async () => {
    if (reframeIdx === null) return;
    const ok = await applyTransform(
      reframeIdx,
      { kind: "reframe", zoom: reframeZoom, x: reframeFocus.x, y: reframeFocus.y },
      "Reframe",
    );
    if (ok) setReframeIdx(null);
  };

  const setOverlay = (i: number, field: keyof OnScreenText, value: string) =>
    setInstr((prev) => {
      const rows = [...(prev.onScreenText ?? [])];
      rows[i] = { ...rows[i], [field]: value };
      return { ...prev, onScreenText: rows };
    });

  if (loading) return <div className="animate-pulse h-96 bg-muted rounded-lg" />;
  if (!post) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">Video not found.</p>
        <Button variant="outline" render={<Link href="/marketing/videos" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to queue
        </Button>
      </div>
    );
  }

  const rendering = ["queued", "rendering"].includes(post.status);

  return (
    <div className="space-y-4 min-w-0">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/marketing/videos" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Queue
        </Button>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Clapperboard className="h-5 w-5" /> {post.recipe_name ?? "Video"}
        </h1>
        <Badge className={STATUS_COLORS[post.status] ?? ""}>{post.status}</Badge>
        {post.scheduled_date && (
          <span className="text-sm text-muted-foreground">
            {post.scheduled_date} · {post.scheduled_slot}
          </span>
        )}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Clip editor (hero) — the video IS this sequence of clips ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <Clapperboard className="h-4 w-4" /> Clip editor
            <span className="text-xs font-normal text-muted-foreground">
              trim · reframe · add effects · reorder — this is your video, in order
            </span>
            <span className="ml-auto flex items-center gap-2">
              <span className="text-xs font-normal text-muted-foreground">
                {clipSeq.length} clips · {totalDuration.toFixed(1)}s
              </span>
              <Button variant="outline" size="sm" onClick={openPicker}>
                <Plus className="h-4 w-4 mr-1" /> Add clip
              </Button>
              <Button
                size="sm"
                onClick={saveClips}
                disabled={saving || !clipsDirty || clipSeq.length === 0 || post.status === "posted"}
                title={post.status === "posted" ? "Posted videos can't be edited" : undefined}
              >
                {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                Save &amp; re-render
              </Button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {clipsDirty && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700">
              Unsaved changes — hit <b>Save &amp; re-render</b> to bake your edits into the video.
            </p>
          )}

          {/* Filmstrip — the sequence, left to right */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {clipSeq.map((c, i) => {
              const busy = fxBusyIdx === i;
              return (
                <div key={`${c.id}-${i}`} className="group/clip w-32 shrink-0">
                  <div className="relative aspect-[9/16] overflow-hidden rounded-lg border bg-muted">
                    {c.posterUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.posterUrl} alt="" className="h-full w-full object-cover" />
                    ) : null}
                    <span className="absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/70 px-1 text-[10px] font-semibold text-white">
                      {i + 1}
                    </span>
                    <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] font-medium text-white">
                      {(c.durationSec ?? 0).toFixed(1)}s
                    </span>
                    <button
                      onClick={() => setClipSeq((prev) => prev.filter((_, j) => j !== i))}
                      disabled={clipSeq.length <= 1}
                      title={clipSeq.length <= 1 ? "A video needs at least one clip" : "Remove clip"}
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition hover:bg-red-600 group-hover/clip:opacity-100 disabled:hidden"
                    >
                      <X className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => moveClip(i, -1)}
                      disabled={i === 0}
                      title="Move earlier"
                      className="absolute left-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition hover:bg-black/70 group-hover/clip:opacity-100 disabled:hidden"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => moveClip(i, 1)}
                      disabled={i === clipSeq.length - 1}
                      title="Move later"
                      className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition hover:bg-black/70 group-hover/clip:opacity-100 disabled:hidden"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                    {busy && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                        <Loader2 className="h-5 w-5 animate-spin text-white" />
                      </div>
                    )}
                  </div>
                  {/* Per-clip tools */}
                  <div className="mt-1 flex items-center justify-center gap-0.5">
                    <Button variant="ghost" size="icon-xs" onClick={() => openTrim(i)} disabled={busy || !c.previewUrl} title="Trim — cut at a different point">
                      <Scissors />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => openReframe(i)} disabled={busy || !c.previewUrl} title="Reframe — zoom / crop tighter">
                      <Crop />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => applyTransform(i, { kind: "punch" }, "Punch-in")} disabled={busy || !c.previewUrl} title="Punch-in — slow Ken Burns zoom">
                      <Focus />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => applyTransform(i, { kind: "speed", factor: 0.5 }, "Slow-mo")} disabled={busy || !c.previewUrl} title="Slow-mo (0.5×)">
                      <Rewind />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => applyTransform(i, { kind: "speed", factor: 2 }, "Speed-up")} disabled={busy || !c.previewUrl} title="Speed up (2×)">
                      <FastForward />
                    </Button>
                  </div>
                  <p className="truncate text-center text-[10px] text-muted-foreground" title={c.fileName}>
                    {c.category ?? c.fileName}
                  </p>
                </div>
              );
            })}
            <button
              onClick={openPicker}
              className="flex aspect-[9/16] w-32 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground hover:bg-muted"
              title="Add a clip from the library"
            >
              <Plus className="h-5 w-5" />
              <span className="text-xs">Add clip</span>
            </button>
          </div>

          {/* Trim dialog */}
          {trimIdx !== null && clipSeq[trimIdx] && (
            <div className="space-y-2 rounded-lg border p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <Scissors className="h-3.5 w-3.5" /> Trim “{clipSeq[trimIdx].fileName}”
                </p>
                <Button variant="ghost" size="sm" onClick={() => setTrimIdx(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-wrap items-start gap-3">
                <video
                  ref={trimVideoRef}
                  key={clipSeq[trimIdx].id}
                  src={clipSeq[trimIdx].previewUrl ?? undefined}
                  controls
                  muted
                  playsInline
                  className="aspect-[9/16] w-36 rounded bg-muted object-cover"
                />
                <div className="min-w-[240px] flex-1 space-y-2">
                  {(
                    [
                      ["Start", trimStart, setTrimStart],
                      ["End", trimEnd, setTrimEnd],
                    ] as Array<[string, number, (v: number) => void]>
                  ).map(([label, value, setter]) => (
                    <div key={label} className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="w-9 text-xs font-medium">{label}</span>
                        <input
                          type="range"
                          min={0}
                          max={clipSeq[trimIdx].durationSec ?? 0}
                          step={0.1}
                          value={value}
                          onChange={(e) => setter(Number(e.target.value))}
                          className="flex-1"
                        />
                        <span className="w-10 text-right text-xs tabular-nums">{value.toFixed(1)}s</span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-1.5 text-[11px]"
                          onClick={() => {
                            const t = trimVideoRef.current?.currentTime ?? 0;
                            setter(Math.round(t * 10) / 10);
                          }}
                          title="Use the player's current position"
                        >
                          playhead
                        </Button>
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Keeps {Math.max(0, trimEnd - trimStart).toFixed(1)}s of {(clipSeq[trimIdx].durationSec ?? 0).toFixed(1)}s.
                    The original clip stays in the library; the trim becomes a new clip in this position.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={applyTrim} disabled={trimming || trimEnd - trimStart < 1}>
                      {trimming ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Scissors className="h-4 w-4 mr-1" />}
                      {trimming ? "Trimming…" : "Apply trim"}
                    </Button>
                    {trimEnd - trimStart < 1 && <span className="self-center text-xs text-amber-600">Minimum 1s</span>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Reframe dialog — click the preview to set the focal point */}
          {reframeIdx !== null && clipSeq[reframeIdx] && (
            <div className="space-y-2 rounded-lg border p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <Crop className="h-3.5 w-3.5" /> Reframe “{clipSeq[reframeIdx].fileName}” — zoom in for a tighter shot
                </p>
                <Button variant="ghost" size="sm" onClick={() => setReframeIdx(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-wrap items-start gap-3">
                <div
                  className="relative aspect-[9/16] w-40 shrink-0 cursor-crosshair overflow-hidden rounded bg-muted"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setReframeFocus({
                      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
                      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
                    });
                  }}
                  title="Click to set the focal point"
                >
                  {clipSeq[reframeIdx].posterUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={clipSeq[reframeIdx].posterUrl!} alt="" className="h-full w-full object-cover" />
                  ) : null}
                  {(() => {
                    const w = 100 / reframeZoom;
                    const h = 100 / reframeZoom;
                    const left = Math.min(100 - w, Math.max(0, reframeFocus.x * 100 - w / 2));
                    const top = Math.min(100 - h, Math.max(0, reframeFocus.y * 100 - h / 2));
                    return (
                      <div
                        className="pointer-events-none absolute border-2 border-primary bg-primary/10"
                        style={{ left: `${left}%`, top: `${top}%`, width: `${w}%`, height: `${h}%` }}
                      />
                    );
                  })()}
                </div>
                <div className="min-w-[240px] flex-1 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Click the preview to choose what to center on. The highlighted box is what fills the final 9:16 frame.
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="w-12 text-xs font-medium">Zoom</span>
                    <input
                      type="range"
                      min={1.1}
                      max={2.5}
                      step={0.05}
                      value={reframeZoom}
                      onChange={(e) => setReframeZoom(Number(e.target.value))}
                      className="flex-1"
                    />
                    <span className="w-10 text-right text-xs tabular-nums">{reframeZoom.toFixed(2)}×</span>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={applyReframe} disabled={fxBusyIdx === reframeIdx}>
                      {fxBusyIdx === reframeIdx ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Crop className="h-4 w-4 mr-1" />}
                      {fxBusyIdx === reframeIdx ? "Reframing…" : "Apply reframe"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setReframeIdx(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Clip picker */}
          {pickerOpen && (
            <div className="space-y-1.5 rounded-lg border p-2">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium">Clip library</p>
                <Input placeholder="Search clips…" value={libSearch} onChange={(e) => setLibSearch(e.target.value)} className="h-8 flex-1" />
                <Button variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-6 md:grid-cols-8">
                {library
                  .filter((c) => !libSearch.trim() || c.fileName.toLowerCase().includes(libSearch.trim().toLowerCase()))
                  .map((c) => (
                    <button
                      key={c.id}
                      onClick={() =>
                        setClipSeq((prev) => [
                          ...prev,
                          { position: prev.length + 1, id: c.id, fileName: c.fileName, durationSec: c.durationSec, posterUrl: c.posterUrl, category: c.category },
                        ])
                      }
                      className="rounded-lg border p-1 text-left hover:bg-muted"
                      title={`${c.fileName} (${(c.durationSec ?? 0).toFixed(1)}s) — click to append`}
                    >
                      <span className="block aspect-[9/16] w-full overflow-hidden rounded bg-muted">
                        {c.posterUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.posterUrl} alt="" className="h-full w-full object-cover" />
                        ) : null}
                      </span>
                      <span className="block truncate text-[10px]">{c.fileName}</span>
                    </button>
                  ))}
                {library.length === 0 && (
                  <span className="col-span-full p-3 text-center text-xs text-muted-foreground">Loading clips…</span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)] min-w-0">
        {/* Video */}
        <div className="space-y-2 min-w-0">
          {rendering ? (
            <div className="flex aspect-[9/16] w-full max-w-[300px] mx-auto lg:mx-0 flex-col items-center justify-center gap-2 rounded-lg bg-muted text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-sm">Re-rendering…</span>
            </div>
          ) : (
            <VideoPlayer
              key={post.videoUrl ?? "none"}
              src={post.videoUrl}
              poster={post.posterUrl}
              size="lg"
              className="aspect-[9/16] w-full max-w-[300px] mx-auto lg:mx-0 rounded-lg"
              placeholder={<span className="text-sm text-muted-foreground">No render yet</span>}
            />
          )}
          <p className="text-xs text-muted-foreground">
            {(post.duration_sec ?? 0).toFixed(1)}s · audio: {post.audio_treatment} · {post.platform}
          </p>
          {post.error && <p className="text-xs text-red-600">{post.error}</p>}
        </div>

        {/* Editors */}
        <div className="space-y-3 min-w-0">
          {/* Improve with AI */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <MessageSquare className="h-4 w-4" /> Improve with AI
                <span className="text-xs font-normal text-muted-foreground">
                  tell it what to change — it rewrites the caption + posting instructions
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {chatThread.length > 0 && (
                <div className="max-h-40 space-y-1.5 overflow-auto rounded border p-2">
                  {chatThread.map((m, i) => (
                    <div key={i} className={`text-xs ${m.role === "you" ? "text-foreground" : "text-muted-foreground"}`}>
                      <span className="font-medium">{m.role === "you" ? "You: " : "AI: "}</span>
                      {m.text}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") sendChat();
                  }}
                  placeholder="e.g. Make the caption punchier, add a CTA to the fit quiz, and suggest bolder on-screen text."
                  rows={2}
                  disabled={chatBusy}
                  className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                />
                <Button size="sm" onClick={sendChat} disabled={chatBusy || !chatInput.trim()} title="Send (⌘/Ctrl+Enter)">
                  {chatBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Caption + hashtags */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Caption</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <textarea
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                rows={3}
                placeholder="Caption for TikTok / Instagram"
                className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
              />
              <Input
                value={hashtags}
                onChange={(e) => setHashtags(e.target.value)}
                placeholder="#sunglasses #eyewear #fyp"
              />
              <Button size="sm" onClick={saveCopy} disabled={saving}>
                Save caption
              </Button>
            </CardContent>
          </Card>

          {/* Posting instructions (text overlay etc.) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Posting instructions
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  what you do in the TikTok/IG app — on-screen text, audio, cover
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <label className="block text-xs font-medium">
                <span className="flex items-center gap-1.5">
                  Hook <span className="text-[10px] font-normal text-muted-foreground">first 0–2s · burned on-screen · the scroll-stopper</span>
                  {instr.pillar && <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{instr.pillar}</span>}
                </span>
                <Input
                  value={instr.hook ?? ""}
                  onChange={(e) => setInstr((p) => ({ ...p, hook: e.target.value }))}
                  placeholder="e.g. This shape has no business being $25"
                  className="mt-0.5 font-medium"
                />
              </label>
              <label className="block text-xs font-medium">
                Audio
                <Input value={instr.audio ?? ""} onChange={(e) => setInstr((p) => ({ ...p, audio: e.target.value }))} className="mt-0.5" />
              </label>

              <div className="space-y-1.5">
                <span className="text-xs font-medium">On-screen text</span>
                {(instr.onScreenText ?? []).map((row, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5">
                    <Input value={row.text} onChange={(e) => setOverlay(i, "text", e.target.value)} placeholder="Text" className="min-w-[160px] flex-1" />
                    <Input value={row.timing} onChange={(e) => setOverlay(i, "timing", e.target.value)} placeholder="Timing (e.g. 0-3s)" className="w-28" />
                    <Input value={row.placement} onChange={(e) => setOverlay(i, "placement", e.target.value)} placeholder="Placement" className="w-32" />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setInstr((p) => ({ ...p, onScreenText: (p.onScreenText ?? []).filter((_, j) => j !== i) }))}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setInstr((p) => ({ ...p, onScreenText: [...(p.onScreenText ?? []), { text: "", timing: "", placement: "" }] }))}
                >
                  <Plus className="h-4 w-4 mr-1" /> Add text overlay
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block text-xs font-medium">
                  Cover suggestion
                  <Input value={instr.coverSuggestion ?? ""} onChange={(e) => setInstr((p) => ({ ...p, coverSuggestion: e.target.value }))} className="mt-0.5" />
                </label>
                <label className="block text-xs font-medium">
                  First comment
                  <Input value={instr.firstComment ?? ""} onChange={(e) => setInstr((p) => ({ ...p, firstComment: e.target.value }))} className="mt-0.5" />
                </label>
              </div>

              {(instr.suggestedSounds?.length ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  Suggested sounds: {instr.suggestedSounds!.map((s) => s.title).join(" · ")}
                </p>
              )}
              <Button size="sm" onClick={saveInstructions} disabled={saving}>
                Save instructions
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
