"use client";

/**
 * Product video editor — the product-side twin of the post editor.
 *
 * Watch the video, edit its clip sequence (add / remove / reorder from
 * this product's other footage), fix the PDP caption, then approve and
 * publish. The clip picker shows every OTHER clip of the same product so
 * a repetitive cut is easy to vary by hand.
 */

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { VideoPlayer } from "@/components/ui/video-player";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import { ClipPreviewDialog } from "@/modules/marketing/components/videos/clip-preview-dialog";
import {
  ArrowLeft, ArrowRight, Boxes, Check, Loader2, Play, Plus, RefreshCw, Sparkles, Upload, X,
} from "lucide-react";

type Clip = {
  id: string;
  fileName: string;
  durationSec: number | null;
  categorySlug: string | null;
  categoryName: string | null;
  isProductShot: boolean;
  posterUrl: string | null;
  previewUrl: string | null;
};
type Video = {
  productId: string;
  status: "pending" | "rendering" | "ready" | "failed";
  videoUrl: string | null;
  posterUrl: string | null;
  durationSec: number | null;
  caption: string | null;
  approvedAt: string | null;
  shopifyPublishedAt: string | null;
  error: string | null;
};
type Detail = { video: Video | null; productName: string; clips: Clip[]; available: Clip[] };

export default function ProductVideoEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const api = `/api/v1/marketing/videos/product-videos/${id}`;

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [seq, setSeq] = useState<Clip[]>([]);
  const [caption, setCaption] = useState("");
  /** Clip being watched, and whether it's already in the sequence. */
  const [watching, setWatching] = useState<{ clip: Clip; inVideo: boolean; index?: number } | null>(null);
  const { setOverride } = useBreadcrumbOverride();

  const load = useCallback(async () => {
    const res = await fetch(api);
    if (!res.ok) {
      setLoading(false);
      return;
    }
    const d = (await res.json()) as Detail;
    setDetail(d);
    setSeq(d.clips);
    setCaption(d.video?.caption ?? "");
    setLoading(false);
  }, [api]);

  // Async IIFE + cancellation: state only settles in the continuation, and
  // a slow response can't overwrite a newer one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(api);
      const d = res.ok ? ((await res.json()) as Detail) : null;
      if (cancelled) return;
      if (d) {
        setDetail(d);
        setSeq(d.clips);
        setCaption(d.video?.caption ?? "");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    setOverride(detail?.productName ?? "Product video");
    return () => setOverride(null);
  }, [detail?.productName, setOverride]);

  const dirty = useMemo(() => {
    const a = (detail?.clips ?? []).map((c) => c.id).join("|");
    return a !== seq.map((c) => c.id).join("|");
  }, [detail, seq]);

  const totalSec = useMemo(() => seq.reduce((s, c) => s + (c.durationSec ?? 0), 0), [seq]);
  const hasProductShot = useMemo(() => seq.some((c) => c.isProductShot), [seq]);
  const inSeq = useMemo(() => new Set(seq.map((c) => c.id)), [seq]);

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
    toast.error(d.error ?? "Failed");
    return false;
  };

  const move = (i: number, dir: -1 | 1) =>
    setSeq((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const publish = async () => {
    setSaving(true);
    const res = await fetch("/api/v1/marketing/videos/product-videos/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: id }),
    });
    const d = await res.json();
    setSaving(false);
    if (res.ok) {
      toast.success("Published to the Shopify product page");
      load();
    } else toast.error(d.error ?? "Publish failed");
  };

  if (loading) return <div className="h-96 animate-pulse rounded-lg bg-muted" />;
  if (!detail) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">Product not found.</p>
        <Button variant="outline" render={<Link href="/marketing/videos/products" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to coverage
        </Button>
      </div>
    );
  }

  const v = detail.video;
  const unused = detail.available.filter((c) => !inSeq.has(c.id));

  return (
    <div className="space-y-4 min-w-0">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/marketing/videos/products" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Coverage
        </Button>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Boxes className="h-5 w-5" /> {detail.productName}
        </h1>
        {v?.approvedAt && <Badge className="bg-emerald-100 text-emerald-800">approved</Badge>}
        {v?.shopifyPublishedAt && <Badge className="bg-violet-100 text-violet-800">on Shopify</Badge>}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)] min-w-0">
        {/* The video */}
        <div className="space-y-2 min-w-0">
          <VideoPlayer
            key={v?.videoUrl ?? "none"}
            src={v?.videoUrl}
            poster={v?.posterUrl}
            size="lg"
            className="aspect-[9/16] w-full max-w-[300px] mx-auto lg:mx-0 rounded-lg"
            placeholder={<span className="px-3 text-center text-sm text-muted-foreground">Not built yet — save a clip sequence to build it.</span>}
          />
          <p className="text-xs text-muted-foreground">
            {v?.durationSec ? `${v.durationSec.toFixed(1)}s · ` : ""}silent master, no on-screen hook (it autoplays muted on the product page)
          </p>
          {v?.error && <p className="text-xs text-red-600">{v.error}</p>}

          <div className="flex flex-wrap gap-2 pt-1">
            {v?.status === "ready" &&
              (v.approvedAt ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => patch({ approved: false }, "Approval removed")} disabled={saving}>
                    Approved ✓ — undo
                  </Button>
                  <Button size="sm" onClick={publish} disabled={saving}>
                    <Upload className="h-4 w-4 mr-1" /> Publish to Shopify
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={() => patch({ approved: true }, "Approved for publishing")} disabled={saving || dirty}>
                  <Check className="h-4 w-4 mr-1" /> Approve
                </Button>
              ))}
          </div>
          {dirty && <p className="text-xs text-amber-600">Unsaved clip changes — save to rebuild before approving.</p>}
        </div>

        <div className="space-y-3 min-w-0">
          {/* Clip sequence */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                Clips in this video
                <span className="text-xs font-normal text-muted-foreground">reorder or remove — saving rebuilds the video</span>
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {seq.length} clips · {totalSec.toFixed(1)}s
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {!hasProductShot && seq.length > 0 && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700">
                  No clip here shows the product — add a product shot or the build will be refused.
                </p>
              )}
              <div className="flex gap-2 overflow-x-auto pb-1">
                {seq.map((c, i) => (
                  <div key={`${c.id}-${i}`} className="group/clip w-28 shrink-0">
                    <div className="relative aspect-[9/16] overflow-hidden rounded-lg border bg-muted">
                      {/* The poster is the play surface — click to watch it. */}
                      <button
                        type="button"
                        onClick={() => setWatching({ clip: c, inVideo: true, index: i })}
                        title="Watch this clip"
                        className="absolute inset-0 h-full w-full"
                      >
                        {c.posterUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.posterUrl} alt="" className="h-full w-full object-cover" />
                        ) : null}
                        <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover/clip:bg-black/25 group-hover/clip:opacity-100">
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-black">
                            <Play className="h-4 w-4 translate-x-px fill-current" />
                          </span>
                        </span>
                      </button>
                      <span className="pointer-events-none absolute left-1 top-1 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-black/70 px-1 text-[10px] font-semibold text-white">
                        {i + 1}
                      </span>
                      {c.durationSec != null && (
                        <span className="pointer-events-none absolute bottom-1 right-1 z-10 rounded bg-black/70 px-1 text-[10px] text-white">
                          {c.durationSec.toFixed(1)}s
                        </span>
                      )}
                      <button
                        onClick={() => setSeq((prev) => prev.filter((_, j) => j !== i))}
                        title="Remove"
                        className="absolute right-1 top-1 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition hover:bg-red-600 group-hover/clip:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        title="Move earlier"
                        className="absolute left-1 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition hover:bg-black/70 group-hover/clip:opacity-100 disabled:hidden"
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => move(i, 1)}
                        disabled={i === seq.length - 1}
                        title="Move later"
                        className="absolute right-1 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition hover:bg-black/70 group-hover/clip:opacity-100 disabled:hidden"
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="truncate text-center text-[10px] text-muted-foreground" title={c.fileName}>
                      {c.categoryName ?? c.fileName}
                    </p>
                  </div>
                ))}
                {seq.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">No clips yet — add some from below.</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => patch({ clipIds: seq.map((c) => c.id) }, "Rebuilt")} disabled={saving || !dirty || seq.length === 0}>
                  {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                  Save &amp; rebuild
                </Button>
                {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
              </div>
            </CardContent>
          </Card>

          {/* Other clips of this product */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                More clips of {detail.productName}
                <span className="text-xs font-normal text-muted-foreground">
                  click to add — mix shot types so the cut isn&apos;t repetitive
                </span>
                <span className="ml-auto text-xs font-normal text-muted-foreground">{unused.length} available</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {unused.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">Every clip of this product is already in the video.</p>
              ) : (
                <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 md:grid-cols-6">
                  {unused.map((c) => (
                    <div key={c.id} className="group/add relative">
                      {/* Click to WATCH it — you shouldn't have to add a clip
                          blind just to find out what's in it. */}
                      <button
                        onClick={() => setWatching({ clip: c, inVideo: false })}
                        className="block w-full rounded-lg border p-1 text-left hover:bg-muted"
                        title={`${c.fileName} — click to watch`}
                      >
                        <span className="relative block aspect-[9/16] w-full overflow-hidden rounded bg-muted">
                          {c.posterUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.posterUrl} alt="" className="h-full w-full object-cover" />
                          ) : null}
                          <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover/add:bg-black/25 group-hover/add:opacity-100">
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-black">
                              <Play className="h-3.5 w-3.5 translate-x-px fill-current" />
                            </span>
                          </span>
                          {c.isProductShot && (
                            <span className="absolute left-0.5 top-0.5 rounded bg-emerald-600/90 px-1 text-[9px] text-white">product</span>
                          )}
                          {c.durationSec != null && (
                            <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] text-white">
                              {c.durationSec.toFixed(1)}s
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[10px] font-medium">{c.categoryName ?? "—"}</span>
                      </button>
                      {/* …and add it straight away if you already know. */}
                      <button
                        onClick={() => setSeq((prev) => [...prev, c])}
                        title="Add to video"
                        className="absolute right-1.5 top-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow transition hover:scale-110 group-hover/add:opacity-100"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* PDP caption */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Product page caption
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  sits under the video on Shopify + Faire — no hashtags, no trend voice
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="e.g. A wide, softened square that suits most faces." />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => patch({ caption }, "Caption saved")} disabled={saving}>
                  Save caption
                </Button>
                <Button size="sm" variant="outline" onClick={() => patch({ regenerateCaption: true }, "Caption rewritten")} disabled={saving}>
                  <Sparkles className="h-4 w-4 mr-1" /> Write it for me
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {watching && (
        <ClipPreviewDialog
          clip={watching.clip}
          onClose={() => setWatching(null)}
          onAdd={watching.inVideo ? undefined : () => setSeq((prev) => [...prev, watching.clip])}
          onRemove={
            watching.inVideo && watching.index !== undefined
              ? () => setSeq((prev) => prev.filter((_, j) => j !== watching.index))
              : undefined
          }
        />
      )}
    </div>
  );
}
