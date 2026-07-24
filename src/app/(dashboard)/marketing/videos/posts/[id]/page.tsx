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
import { Input } from "@/components/ui/input";
import {
  ArrowDown, ArrowLeft, ArrowUp, Clapperboard, Loader2, MessageSquare,
  Plus, RefreshCw, Send, Trash2, X,
} from "lucide-react";

type OnScreenText = { text: string; timing: string; placement: string };
type Instructions = {
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

  // Editable copy state
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [instr, setInstr] = useState<Instructions>({});

  // Clip editor state
  const [clipSeq, setClipSeq] = useState<PostClip[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [library, setLibrary] = useState<LibClip[]>([]);
  const [libSearch, setLibSearch] = useState("");

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)] min-w-0">
        {/* Video */}
        <div className="space-y-2 min-w-0">
          <div className="aspect-[9/16] w-full max-w-[300px] mx-auto lg:mx-0 overflow-hidden rounded-lg bg-muted">
            {rendering ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-sm">Re-rendering…</span>
              </div>
            ) : post.videoUrl ? (
              <video key={post.videoUrl} src={post.videoUrl} poster={post.posterUrl ?? undefined} controls playsInline className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">No render yet</div>
            )}
          </div>
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

          {/* Mini clip editor */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                Clips
                <span className="text-xs font-normal text-muted-foreground">
                  add / remove / reorder — saving re-renders the video
                </span>
                <span className="ml-auto text-xs font-normal text-muted-foreground">{totalDuration.toFixed(1)}s total</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="space-y-1.5">
                {clipSeq.map((c, i) => (
                  <div key={`${c.id}-${i}`} className="flex items-center gap-2 rounded-lg border p-1.5">
                    <span className="w-5 text-center text-xs text-muted-foreground">{i + 1}</span>
                    <span className="h-14 w-9 shrink-0 overflow-hidden rounded bg-muted">
                      {c.posterUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.posterUrl} alt="" className="h-full w-full object-cover" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{c.fileName ?? c.id}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {(c.durationSec ?? 0).toFixed(1)}s{c.category ? ` · ${c.category}` : ""}
                      </span>
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => moveClip(i, -1)} disabled={i === 0}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => moveClip(i, 1)} disabled={i === clipSeq.length - 1}>
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setClipSeq((prev) => prev.filter((_, j) => j !== i))}
                      disabled={clipSeq.length <= 1}
                      title={clipSeq.length <= 1 ? "A video needs at least one clip" : "Remove"}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
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
                {clipsDirty && <span className="text-xs text-amber-600">Unsaved changes — the video will re-render on save.</span>}
              </div>

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
                  <div className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-6">
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
        </div>
      </div>
    </div>
  );
}
