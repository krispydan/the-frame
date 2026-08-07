"use client";

/**
 * Ad detail — every ratio side by side, live while rendering. Download
 * all (the Ads Manager zip), publish (locks the name as a fact), and
 * re-render after failures. The canvas editor lands here next (A3).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Archive, Copy, Download, Loader2, Megaphone, RefreshCw, Upload } from "lucide-react";

type Render = {
  ratio: string;
  status: string;
  url: string | null;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  error: string | null;
};
type Detail = {
  ad: {
    id: string;
    name: string;
    status: string;
    talent: string;
    copy_variant: string;
    headline: string | null;
    version: number;
    sku: string | null;
    product_name: string | null;
    error: string | null;
  };
  renders: Render[];
  clip: { id: string; file_name: string } | null;
  cardImage: { url: string | null; source: string } | null;
};

const RATIO_ASPECT: Record<string, string> = {
  "1x1": "aspect-square",
  "4x5": "aspect-[4/5]",
  "9x16": "aspect-[9/16]",
  "16x9": "aspect-video",
};

export default function AdDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/v1/marketing/ads/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setDetail)
      .catch(() => toast.error("Ad not found"));
  }, [id]);
  useEffect(() => load(), [load]);

  // Live-follow while anything renders.
  useEffect(() => {
    if (!detail?.renders.some((r) => r.status === "queued" || r.status === "rendering")) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [detail, load]);

  if (!detail) return <div className="h-96 animate-pulse rounded-lg bg-muted" />;
  const { ad, renders, clip } = detail;
  const doneCount = renders.filter((r) => r.status === "done").length;
  const failed = renders.filter((r) => r.status === "failed");

  const patch = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      const res = await fetch(`/api/v1/marketing/ads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (res.ok) {
        toast.success(label === "published" ? "Published — the name is now a fact in Ads Manager" : "Updated");
        load();
      } else toast.error(d.error ?? "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const rerender = async (ratios?: string[]) => {
    setBusy("rerender");
    try {
      const res = await fetch(`/api/v1/marketing/ads/${id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ratios ? { ratios } : {}),
      });
      if (res.ok) {
        toast.success("Re-render queued");
        load();
      } else toast.error((await res.json()).error ?? "Failed to queue");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/marketing/ads" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Ad Studio
        </Button>
        <h1 className="text-lg font-bold tracking-tight flex items-center gap-2 min-w-0">
          <Megaphone className="h-5 w-5 shrink-0" />
          <span className="truncate font-mono text-base">{ad.name}</span>
        </h1>
        <button
          onClick={() => {
            navigator.clipboard.writeText(ad.name);
            toast.success("Ad name copied");
          }}
          title="Copy — use verbatim as the ad name in Ads Manager"
        >
          <Copy className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        {ad.status === "ready" && (
          <Button variant="secondary" disabled={busy !== null} onClick={() => patch({ status: "published" }, "published")}>
            <Upload className="h-4 w-4 mr-1" /> Mark published
          </Button>
        )}
        <Button
          variant="outline"
          disabled={doneCount === 0}
          render={<a href={`/api/v1/marketing/ads/${id}/download`} />}
        >
          <Download className="h-4 w-4 mr-1" /> Download all ({doneCount})
        </Button>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => rerender()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={async () => {
            await fetch(`/api/v1/marketing/ads/${id}`, { method: "DELETE" });
            toast.success("Archived");
            router.push("/marketing/ads");
          }}
        >
          <Archive className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
        <span>
          Status <b className="text-foreground">{ad.status}</b>
        </span>
        <span>
          Product <b className="text-foreground">{ad.product_name ?? "—"}</b> ({ad.sku})
        </span>
        <span>
          Model <b className="text-foreground">{ad.talent}</b>
        </span>
        <span>
          Copy <b className="text-foreground">{ad.copy_variant}</b>
        </span>
        <span>
          v<b className="text-foreground">{String(ad.version).padStart(2, "0")}</b>
        </span>
        {clip && (
          <span>
            Clip <b className="text-foreground">{clip.file_name}</b>
          </span>
        )}
      </div>

      {failed.length > 0 && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
          {failed.length} render{failed.length > 1 ? "s" : ""} failed: {failed[0].error ?? "unknown error"}{" "}
          <button className="underline" onClick={() => rerender(failed.map((f) => f.ratio))}>
            retry failed
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-4">
        {renders.map((r) => (
          <div key={r.ratio} className="w-[240px] shrink-0 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono font-medium">{r.ratio}</span>
              <span
                className={
                  r.status === "done"
                    ? "text-emerald-600"
                    : r.status === "failed"
                      ? "text-red-600"
                      : "text-blue-600"
                }
              >
                {r.status}
              </span>
            </div>
            <div className={`overflow-hidden rounded-lg border bg-black ${RATIO_ASPECT[r.ratio] ?? "aspect-[4/5]"}`}>
              {r.status === "done" && r.url ? (
                <video src={r.url} poster={r.posterUrl ?? undefined} controls playsInline className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center text-white/60">
                  {r.status === "failed" ? "failed" : <Loader2 className="h-5 w-5 animate-spin" />}
                </div>
              )}
            </div>
            {r.status === "done" && (
              <div className="text-[10px] text-muted-foreground">
                {r.width}×{r.height}
                {r.size_bytes ? ` · ${(r.size_bytes / 1024 / 1024).toFixed(1)} MB` : ""}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
