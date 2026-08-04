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

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { VideoPlayer } from "@/components/ui/video-player";
import { ClipPreviewDialog } from "@/modules/marketing/components/videos/clip-preview-dialog";
import { ClipEditor } from "@/modules/marketing/components/videos/clip-editor";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import { lintRetention, RETENTION_OPTIMIZER_FEEDBACK } from "@/modules/marketing/lib/video/retention-lint";
import { effectiveDuration } from "@/modules/marketing/lib/video/clip-trims";
import {
  ArrowLeft, Clapperboard, Gauge, Loader2, MessageSquare, Plus, RefreshCw, Send, X,
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
};

type PostClip = {
  position: number;
  id: string;
  fileName?: string;
  durationSec?: number | null;
  posterUrl?: string | null;
  previewUrl?: string | null;
  category?: string | null;
  /** Non-destructive in/out for this position, applied at render. */
  trim?: { inSec: number; outSec: number } | null;
};

type Post = {
  id: string;
  status: string;
  caption: string | null;
  hashtags: string[];
  instructions: Instructions | null;
  videoUrl: string | null;
  posterUrl: string | null;
  burnHook?: boolean;
  hookBurned?: boolean;
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
  previewUrl: string | null;
  category: string | null;
  talent: string | null;
  createdAt: string | null;
  products: string[];
};
type LibCategory = { id: string; slug: string; name: string };

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
  const [libCategory, setLibCategory] = useState("");
  const [libTalent, setLibTalent] = useState("");
  const [libCats, setLibCats] = useState<LibCategory[]>([]);
  const [libTalents, setLibTalents] = useState<string[]>([]);
  const [libTotal, setLibTotal] = useState(0);
  const [libLoading, setLibLoading] = useState(false);
  const [previewClip, setPreviewClip] = useState<LibClip | null>(null);
  /** A clip from the sequence being watched. */
  const [watching, setWatching] = useState<{ clip: PostClip; index: number } | null>(null);
  const LIB_LIMIT = 60;
  // Trim dialog: which sequence index is being trimmed + the in/out points.
  // Which clip index currently has an effect applying (disables its tools).

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
    // Signature covers the trim as well as identity/order — a changed
    // in/out point is an unsaved edit just as much as a reorder is.
    const sig = (c: PostClip) =>
      `${c.id}@${c.trim ? `${c.trim.inSec}-${c.trim.outSec}` : "full"}`;
    return post.clips.map(sig).join("|") !== clipSeq.map(sig).join("|");
  }, [post, clipSeq]);

  // Trimmed length, not raw length — the retention lint and the header
  // readout describe the video that will actually render.
  const clipDurations = useMemo(
    () => clipSeq.map((c) => effectiveDuration(c.durationSec ?? null, c.trim ?? null)),
    [clipSeq],
  );
  const totalDuration = useMemo(
    () => clipDurations.reduce((s, d) => s + d, 0),
    [clipDurations],
  );

  // Deterministic retention checks on the live edit (engine #5).
  const retentionIssues = useMemo(
    () =>
      lintRetention({
        hook: instr.hook,
        captionLength: caption.length,
        onScreenTextCount: instr.onScreenText?.length ?? 0,
        clipDurations,
        totalDurationSec: totalDuration,
      }),
    [instr.hook, instr.onScreenText, caption, clipDurations, totalDuration],
  );

  const saveClips = async () => {
    if (!clipsDirty || clipSeq.length === 0) return;
    // Trims travel WITH the sequence, index-parallel — sent apart they
    // could drift and cut the wrong position.
    const ok = await patch(
      {
        clipIds: clipSeq.map((c) => c.id),
        clipTrims: clipSeq.map((c) => c.trim ?? null),
      },
      "Clip sequence saved — re-rendering in the background",
    );
    if (ok) setPickerOpen(false);
  };

  // Server-side search/filter — never loads the whole 750+ library into
  // the browser. Fetches a capped page ordered newest-first.
  const loadLibrary = useCallback(async () => {
    setLibLoading(true);
    const params = new URLSearchParams({ status: "ready", limit: String(LIB_LIMIT) });
    if (libSearch.trim()) params.set("search", libSearch.trim());
    if (libCategory) params.set("category", libCategory);
    if (libTalent) params.set("talent", libTalent);
    const res = await fetch(`/api/v1/marketing/videos/clips?${params}`);
    const d = await res.json();
    setLibrary(
      (d.clips ?? []).map((c: Record<string, unknown>) => ({
        id: String(c.id),
        fileName: String(c.fileName ?? c.file_name ?? ""),
        durationSec: (c.durationSec ?? c.duration_sec) as number | null,
        posterUrl: (c.posterUrl ?? c.poster_url ?? null) as string | null,
        previewUrl: (c.previewUrl ?? null) as string | null,
        category: (c.category_name ?? c.category_slug ?? c.category ?? null) as string | null,
        talent: (c.talent ?? null) as string | null,
        createdAt: (c.created_at ?? null) as string | null,
        products: Array.isArray(c.products) ? (c.products as Array<{ productName?: string }>).map((p) => p.productName ?? "").filter(Boolean) : [],
      })),
    );
    setLibTotal(Number(d.total ?? 0));
    if (Array.isArray(d.talents)) setLibTalents(d.talents as string[]);
    setLibLoading(false);
  }, [libSearch, libCategory, libTalent]);

  const openPicker = async () => {
    setPickerOpen(true);
    if (libCats.length === 0) {
      fetch("/api/v1/marketing/videos/categories")
        .then((r) => r.json())
        .then((d) => setLibCats((d.categories ?? []).filter((c: { archived?: number }) => !c.archived)))
        .catch(() => {});
    }
    loadLibrary();
  };

  // Debounced refetch while the picker is open and its filters change.
  useEffect(() => {
    if (!pickerOpen) return;
    const t = setTimeout(loadLibrary, 250);
    return () => clearTimeout(t);
  }, [pickerOpen, loadLibrary]);

  const addLibClip = (c: LibClip) => {
    setClipSeq((prev) => [
      ...prev,
      { position: prev.length + 1, id: c.id, fileName: c.fileName, durationSec: c.durationSec, posterUrl: c.posterUrl, previewUrl: c.previewUrl, category: c.category },
    ]);
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

  // Engine #5 — one-click "tighten for retention" via the revise endpoint.
  const runOptimizer = async () => {
    if (chatBusy) return;
    setChatThread((t) => [...t, { role: "you", text: "Tighten this for retention." }]);
    setChatBusy(true);
    try {
      const res = await fetch(`${api}/revise-copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: RETENTION_OPTIMIZER_FEEDBACK }),
      });
      const d = await res.json();
      if (res.ok) {
        await load();
        setChatThread((t) => [...t, { role: "ai", text: "✓ Tightened the hook + caption for watch time — review below." }]);
      } else {
        setChatThread((t) => [...t, { role: "ai", text: `⚠ ${d.error ?? "Couldn't optimize."}` }]);
      }
    } finally {
      setChatBusy(false);
    }
  };

  // Apply a visual transform (reframe / punch / speed) to a clip in the
  // sequence, swapping in the resulting new clip. `idx` tracks the row so
  // its tools disable while the effect renders.
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

      {/* ── Clip editor (hero) — the video IS this sequence of clips ──
          Shared with the product-video page: same tools everywhere. */}
      <ClipEditor
        clips={clipSeq}
        onChange={setClipSeq}
        onSave={saveClips}
        dirty={clipsDirty}
        saving={saving}
        readOnly={post.status === "posted"}
        readOnlyReason="Posted videos can't be edited"
        onAddClick={openPicker}
        onClipEdited={load}
      >
          {/* Clip picker — searchable / filterable, server-side (750+ clips) */}
          {pickerOpen && (
            <div className="space-y-2 rounded-lg border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-medium">Clip library</p>
                <Input
                  placeholder="Search filename, creator, product…"
                  value={libSearch}
                  onChange={(e) => setLibSearch(e.target.value)}
                  className="h-8 min-w-[180px] flex-1"
                />
                <select
                  value={libCategory}
                  onChange={(e) => setLibCategory(e.target.value)}
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  title="Video style"
                >
                  <option value="">All styles</option>
                  {libCats.map((c) => (
                    <option key={c.id} value={c.slug}>{c.name}</option>
                  ))}
                </select>
                <select
                  value={libTalent}
                  onChange={(e) => setLibTalent(e.target.value)}
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  title="Creator"
                >
                  <option value="">All creators</option>
                  {libTalents.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <Button variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {libLoading ? "Searching…" : `Showing ${library.length}${libTotal > library.length ? ` of ${libTotal}` : ""} — newest first`}
                </span>
                {libTotal > library.length && <span>refine to narrow</span>}
              </div>
              <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 md:grid-cols-6">
                {library.map((c) => (
                  <div key={c.id} className="group/lib relative">
                    <button
                      onClick={() => setPreviewClip(c)}
                      className="block w-full rounded-lg border p-1 text-left hover:bg-muted"
                      title={`${c.fileName} — click to preview`}
                    >
                      <span className="relative block aspect-[9/16] w-full overflow-hidden rounded bg-muted">
                        {c.posterUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.posterUrl} alt="" className="h-full w-full object-cover" />
                        ) : null}
                        <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover/lib:bg-black/25 group-hover/lib:opacity-100">
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-black">▶</span>
                        </span>
                        {c.durationSec != null && (
                          <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] text-white">{c.durationSec.toFixed(1)}s</span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] font-medium">{c.fileName}</span>
                      <span className="block truncate text-[9px] text-muted-foreground">
                        {[c.category, c.talent, c.createdAt ? new Date(c.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                    <button
                      onClick={() => addLibClip(c)}
                      title="Add to video"
                      className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow transition hover:scale-110 group-hover/lib:opacity-100"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {!libLoading && library.length === 0 && (
                  <span className="col-span-full p-4 text-center text-xs text-muted-foreground">No clips match — try a different search or filter.</span>
                )}
              </div>
            </div>
          )}
      </ClipEditor>


      {/* Watch a clip that's already in the video */}
      {watching && (
        <ClipPreviewDialog
          clip={{
            id: watching.clip.id,
            fileName: watching.clip.fileName,
            durationSec: watching.clip.durationSec,
            categoryName: watching.clip.category,
            posterUrl: watching.clip.posterUrl,
            previewUrl: watching.clip.previewUrl,
          }}
          onClose={() => setWatching(null)}
          onEdited={load}
          onRemove={
            clipSeq.length > 1
              ? () => setClipSeq((prev) => prev.filter((_, j) => j !== watching.index))
              : undefined
          }
        />
      )}

      {/* Preview-before-add dialog */}
      {previewClip && (
        <Dialog open onOpenChange={(open) => !open && setPreviewClip(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="truncate pr-8 text-sm">{previewClip.fileName}</DialogTitle>
            </DialogHeader>
            <VideoPlayer
              src={previewClip.previewUrl}
              poster={previewClip.posterUrl}
              size="md"
              className="aspect-[9/16] w-full max-w-[240px] mx-auto rounded-lg"
            />
            <p className="text-center text-xs text-muted-foreground">
              {[
                previewClip.category,
                previewClip.talent,
                previewClip.durationSec != null ? `${previewClip.durationSec.toFixed(1)}s` : null,
                previewClip.createdAt ? new Date(previewClip.createdAt).toLocaleDateString() : null,
              ].filter(Boolean).join(" · ")}
              {previewClip.products.length > 0 && <><br />{previewClip.products.join(", ")}</>}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPreviewClip(null)}>Close</Button>
              <Button size="sm" onClick={() => { addLibClip(previewClip); setPreviewClip(null); }}>
                <Plus className="h-4 w-4 mr-1" /> Add to video
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

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
          {/* Hook burn-in toggle — bakes the hook onto the first seconds. */}
          <button
            type="button"
            onClick={() => patch({ burnHook: !post.burnHook }, post.burnHook ? "Hook overlay off — re-baking clean" : "Baking the hook onto the video…")}
            disabled={saving}
            className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition ${post.burnHook ? "border-primary/40 bg-primary/5" : "hover:bg-muted"}`}
            title="Burn the hook line onto the first ~3 seconds as on-screen text"
          >
            <span className={`flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition ${post.burnHook ? "bg-primary" : "bg-muted-foreground/30"}`}>
              <span className={`h-3 w-3 rounded-full bg-white transition ${post.burnHook ? "translate-x-3" : ""}`} />
            </span>
            <span className="flex-1">
              Burn hook onto video
              <span className="block text-[10px] text-muted-foreground">
                {post.hookBurned ? "on-screen text is baked in ✓" : post.burnHook ? "will bake on next render" : "clean video, no overlay"}
              </span>
            </span>
          </button>
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
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={runOptimizer} disabled={chatBusy} title="Sharpen the hook + caption for watch time">
                  <Gauge className="h-3.5 w-3.5 mr-1" /> Tighten for retention
                </Button>
                {/* Vitality checks — deterministic, live */}
                {retentionIssues.length === 0 ? (
                  <span className="text-xs text-emerald-600">✓ Vitality checks pass</span>
                ) : (
                  <span className="text-xs text-muted-foreground">{retentionIssues.filter((i) => i.level === "warn").length} to fix · {retentionIssues.filter((i) => i.level === "tip").length} tips</span>
                )}
              </div>
              {retentionIssues.length > 0 && (
                <ul className="space-y-1 rounded-md border bg-muted/30 p-2 text-xs">
                  {retentionIssues.map((i) => (
                    <li key={i.code} className="flex items-start gap-1.5">
                      <span className={i.level === "warn" ? "text-amber-600" : "text-muted-foreground"}>{i.level === "warn" ? "⚠" : "○"}</span>
                      <span className="text-muted-foreground">{i.message}</span>
                    </li>
                  ))}
                </ul>
              )}
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
