"use client";

/**
 * Ad detail — preview every ratio, edit the layout on a drag-and-drop
 * canvas, pick/generate copy, download the Ads Manager zip, publish.
 *
 * Edit mode swaps each preview for an AdCanvas (same math as the
 * renderer). Save PATCHes the accumulated overrides + text/copy and
 * re-renders every ratio in one go — drags are local until then.
 * Editing a PUBLISHED ad bumps the version server-side (the old name
 * keeps meaning the old creative in Ads Manager).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, Archive, Copy, Download, Loader2, Megaphone,
  Pencil, RefreshCw, Sparkles, Upload, X,
} from "lucide-react";
import { AdCanvas } from "@/modules/marketing/components/ad-canvas";
import { getAdRecipe, effectiveLayout, type RatioLayout } from "@/modules/marketing/lib/ads/recipes";
import { isAdRatio, type AdRatio } from "@/modules/marketing/lib/ads/ratios";

type Render = {
  ratio: string;
  kind: string;
  status: string;
  url: string | null;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  error: string | null;
};
type CopyVariant = { code: string; primaryText: string; headline: string | null; usedBy: number };
type Detail = {
  ad: {
    id: string;
    name: string;
    recipe: string;
    kind: string;
    status: string;
    talent: string;
    copy_variant: string;
    display_name_override: string | null;
    headline: string | null;
    version: number;
    sku: string | null;
    product_name: string | null;
    error: string | null;
    layout_overrides: Partial<Record<string, Partial<RatioLayout>>>;
    ratios: string[];
  };
  renders: Render[];
  clip: { id: string; file_name: string } | null;
  backgroundUrl: string | null;
  srcDims: { width: number; height: number } | null;
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

  // Edit-mode state, local until Save.
  const [editing, setEditing] = useState(false);
  const [overrides, setOverrides] = useState<Partial<Record<string, Partial<RatioLayout>>>>({});
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [headline, setHeadline] = useState("");
  const [copyVariant, setCopyVariant] = useState("C00");
  const [copyVariants, setCopyVariants] = useState<CopyVariant[]>([]);
  const [generatingCopy, setGeneratingCopy] = useState(false);

  // Poll must not clobber in-flight edits — the ref lets the stable
  // load() closure see the CURRENT editing flag.
  const editingRef = useRef(false);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  const load = useCallback(() => {
    fetch(`/api/v1/marketing/ads/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: Detail) => {
        setDetail(d);
        if (!editingRef.current) {
          setOverrides(d.ad.layout_overrides ?? {});
          setDisplayName(d.ad.display_name_override);
          setHeadline(d.ad.headline ?? "");
          setCopyVariant(d.ad.copy_variant);
        }
      })
      .catch(() => toast.error("Ad not found"));
  }, [id]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    fetch("/api/v1/marketing/ads/copy").then((r) => r.json()).then((d) => setCopyVariants(d.variants ?? []));
  }, []);

  useEffect(() => {
    if (editing) return; // don't refresh under the user's pointer
    if (!detail?.renders.some((r) => r.status === "queued" || r.status === "rendering")) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [detail, load, editing]);

  if (!detail) return <div className="h-96 animate-pulse rounded-lg bg-muted" />;
  const { ad, renders, clip } = detail;
  const recipe = getAdRecipe(ad.recipe);
  const doneCount = renders.filter((r) => r.status === "done").length;
  const failed = renders.filter((r) => r.status === "failed");
  const rendering = renders.some((r) => r.status === "queued" || r.status === "rendering");
  const cardText = (displayName ?? ad.product_name ?? "").trim();

  const saveEdits = async () => {
    setBusy("save");
    try {
      const res = await fetch(`/api/v1/marketing/ads/${id}?rerender=1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          layoutOverrides: overrides,
          displayNameOverride: displayName,
          headline: headline || null,
          ...(copyVariant !== ad.copy_variant ? { copyVariant } : {}),
        }),
      });
      const d = await res.json();
      if (res.ok) {
        toast.success(ad.status === "published" ? "Saved as a new version — re-rendering" : "Saved — re-rendering");
        setEditing(false);
        load();
      } else toast.error(d.error ?? "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const generateCopy = async () => {
    setGeneratingCopy(true);
    try {
      const res = await fetch("/api/v1/marketing/ads/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generate: true, count: 3, productName: ad.product_name ?? undefined }),
      });
      const d = await res.json();
      if (res.ok) {
        toast.success(`Generated ${d.created.length} copy variants`);
        const list = await fetch("/api/v1/marketing/ads/copy").then((r) => r.json());
        setCopyVariants(list.variants ?? []);
      } else toast.error(d.error ?? "Generation failed");
    } finally {
      setGeneratingCopy(false);
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
        {editing ? (
          <>
            <Button onClick={saveEdits} disabled={busy !== null}>
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Save & re-render
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setOverrides(ad.layout_overrides ?? {});
                setDisplayName(ad.display_name_override);
                setHeadline(ad.headline ?? "");
                setCopyVariant(ad.copy_variant);
              }}
            >
              <X className="h-4 w-4 mr-1" /> Discard
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={rendering} onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4 mr-1" /> Edit layout
            </Button>
            {ad.status === "ready" && (
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy("publish");
                  const res = await fetch(`/api/v1/marketing/ads/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: "published" }),
                  });
                  setBusy(null);
                  if (res.ok) {
                    toast.success("Published — the name is now a fact in Ads Manager");
                    load();
                  } else toast.error((await res.json()).error ?? "Failed");
                }}
              >
                <Upload className="h-4 w-4 mr-1" /> Mark published
              </Button>
            )}
            <Button variant="outline" disabled={doneCount === 0} render={<a href={`/api/v1/marketing/ads/${id}/download`} />}>
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
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
        <span>Status <b className="text-foreground">{ad.status}</b></span>
        <span>Kind <b className="text-foreground">{ad.kind}</b></span>
        <span>Product <b className="text-foreground">{ad.product_name ?? "—"}</b> ({ad.sku})</span>
        <span>Model <b className="text-foreground">{ad.talent}</b></span>
        <span>Copy <b className="text-foreground">{ad.copy_variant}</b></span>
        <span>v<b className="text-foreground">{String(ad.version).padStart(2, "0")}</b></span>
        {clip && <span>Clip <b className="text-foreground">{clip.file_name}</b></span>}
      </div>

      {failed.length > 0 && !editing && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
          {failed.length} render{failed.length > 1 ? "s" : ""} failed: {failed[0].error ?? "unknown error"}{" "}
          <button className="underline" onClick={() => rerender(failed.map((f) => f.ratio))}>
            retry failed
          </button>
        </div>
      )}

      {editing && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="text-xs text-muted-foreground">
            Drag the card to place it · corner dot scales it · drag the background to reframe the crop.
            Changes render exactly as previewed.
          </div>
          <div className="flex max-w-3xl flex-wrap gap-2">
            <Input
              placeholder={`Card text (blank = ${ad.product_name ?? "product name"})`}
              value={displayName ?? ""}
              onChange={(e) => setDisplayName(e.target.value === "" ? null : e.target.value)}
              className="h-9 flex-1 min-w-[200px]"
            />
            <Input
              placeholder="Headline on the media (optional)"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              className="h-9 flex-1 min-w-[200px]"
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-4">
        {renders.map((r) => {
          if (!isAdRatio(r.ratio) || !recipe) return null;
          const ratio = r.ratio as AdRatio;
          if (editing) {
            const layout = effectiveLayout(recipe, ratio, overrides[ratio]);
            return (
              <div key={r.ratio} className="space-y-1.5">
                <div className="font-mono text-xs font-medium">{r.ratio}</div>
                <AdCanvas
                  ratio={ratio}
                  layout={layout}
                  cardAspect={recipe.cardAspect}
                  backgroundUrl={detail.backgroundUrl}
                  cardImageUrl={detail.cardImage?.url ?? null}
                  cardText={cardText}
                  srcWidth={detail.srcDims?.width ?? 1080}
                  srcHeight={detail.srcDims?.height ?? 1350}
                  onChange={(patch) =>
                    setOverrides((prev) => ({ ...prev, [ratio]: { ...prev[ratio], ...patch } }))
                  }
                />
                <button
                  className="text-[11px] text-muted-foreground underline"
                  onClick={() => setOverrides((prev) => ({ ...prev, [ratio]: {} }))}
                >
                  reset to default
                </button>
              </div>
            );
          }
          return (
            <div key={r.ratio} className="w-[240px] shrink-0 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono font-medium">{r.ratio}</span>
                <span className={r.status === "done" ? "text-emerald-600" : r.status === "failed" ? "text-red-600" : "text-blue-600"}>
                  {r.status}
                </span>
              </div>
              <div className={`overflow-hidden rounded-lg border bg-black ${RATIO_ASPECT[r.ratio] ?? "aspect-[4/5]"}`}>
                {r.status === "done" && r.url ? (
                  r.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.url} alt={r.ratio} className="h-full w-full object-contain" />
                  ) : (
                    <video src={r.url} poster={r.posterUrl ?? undefined} controls playsInline className="h-full w-full object-contain" />
                  )
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
          );
        })}
      </div>

      {/* Copy — the C-code half of the tracking name. */}
      <div className="max-w-2xl space-y-2 rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Ad copy (variant {editing ? copyVariant : ad.copy_variant})</h2>
          <div className="flex-1" />
          <Button size="sm" variant="outline" disabled={generatingCopy} onClick={generateCopy}>
            {generatingCopy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
            AI variants
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[{ code: "C00", primaryText: "No copy", headline: null, usedBy: 0 } as CopyVariant, ...copyVariants].map((v) => (
            <button
              key={v.code}
              disabled={!editing}
              onClick={() => setCopyVariant(v.code)}
              title={v.primaryText}
              className={`rounded-full border px-3 py-1 text-xs transition disabled:opacity-70 ${
                (editing ? copyVariant : ad.copy_variant) === v.code
                  ? "border-primary ring-1 ring-primary font-medium"
                  : editing ? "hover:bg-muted" : ""
              }`}
            >
              {v.code}
              {v.usedBy > 0 && <span className="ml-1 text-muted-foreground">×{v.usedBy}</span>}
            </button>
          ))}
        </div>
        {(() => {
          const active = copyVariants.find((v) => v.code === (editing ? copyVariant : ad.copy_variant));
          if (!active) return <div className="text-xs text-muted-foreground">No copy — text lives in Ads Manager only.</div>;
          return (
            <div className="space-y-1 text-sm">
              <div>{active.primaryText}</div>
              {active.headline && <div className="text-xs text-muted-foreground">Headline: {active.headline}</div>}
            </div>
          );
        })()}
        {!editing && (
          <div className="text-[11px] text-muted-foreground">
            Changing the copy variant happens in <b>Edit layout</b> — it renames the ad (the copy code is part of the name).
          </div>
        )}
      </div>
    </div>
  );
}
