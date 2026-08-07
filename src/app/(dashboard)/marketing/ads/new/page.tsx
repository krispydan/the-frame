"use client";

/**
 * New-ad wizard.
 *
 * Video ad: pick a clip (library search) → SKU pre-fills from its tags.
 * Image ad: pick a catalog image or upload a background.
 * Then ratios + copy variant + optional text → create; every enabled
 * ratio renders itself. The generated tracking name previews live so
 * what's about to exist is never a surprise.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Check, Clapperboard, Image as ImageIcon, Loader2, Megaphone, UploadCloud } from "lucide-react";

type Clip = {
  id: string;
  file_name: string;
  duration_sec: number | null;
  talent: string | null;
  posterUrl: string | null;
  products: Array<{ skuId: string; sku: string; productName: string; colorName: string | null }>;
};
type BgImage = { id: string; sku: string; productName: string; url: string | null };
type SkuOption = { id: string; sku: string; colorName: string | null; productName: string; hasImage: number };
type RatioOption = { slug: string; width: number; height: number; default: boolean };
type CopyVariant = { code: string; primaryText: string; headline: string | null };

export default function NewAdPage() {
  const router = useRouter();

  const [kind, setKind] = useState<"video" | "image">("video");

  // Video background
  const [clipSearch, setClipSearch] = useState("");
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipsLoading, setClipsLoading] = useState(false);
  const [clip, setClip] = useState<Clip | null>(null);

  // Image background
  const [bgSearch, setBgSearch] = useState("");
  const [bgImages, setBgImages] = useState<BgImage[]>([]);
  const [bgImage, setBgImage] = useState<BgImage | null>(null);
  const [uploadKey, setUploadKey] = useState<string | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [skus, setSkus] = useState<SkuOption[]>([]);
  const [ratioOptions, setRatioOptions] = useState<RatioOption[]>([]);
  const [copyVariants, setCopyVariants] = useState<CopyVariant[]>([]);
  const [copyVariant, setCopyVariant] = useState("C00");
  const [skuId, setSkuId] = useState("");
  const [skuFilter, setSkuFilter] = useState("");
  const [ratios, setRatios] = useState<string[]>([]);
  const [headline, setHeadline] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/v1/marketing/ads/options")
      .then((r) => r.json())
      .then((d) => {
        setSkus((d.skus ?? []).filter((s: SkuOption) => s.hasImage));
        setRatioOptions(d.ratios ?? []);
        setRatios((d.ratios ?? []).filter((r: RatioOption) => r.default).map((r: RatioOption) => r.slug));
        setCopyVariants(d.copyVariants ?? []);
      });
  }, []);

  const loadClips = useCallback(() => {
    setClipsLoading(true);
    const qs = new URLSearchParams({ status: "ready", limit: "24" });
    if (clipSearch.trim()) qs.set("search", clipSearch.trim());
    fetch(`/api/v1/marketing/videos/clips?${qs}`)
      .then((r) => r.json())
      .then((d) => setClips(d.clips ?? []))
      .finally(() => setClipsLoading(false));
  }, [clipSearch]);
  useEffect(() => {
    if (kind !== "video") return;
    const t = setTimeout(loadClips, clipSearch ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadClips, clipSearch, kind]);

  const loadBgImages = useCallback(() => {
    const qs = new URLSearchParams({ limit: "36" });
    if (bgSearch.trim()) qs.set("search", bgSearch.trim());
    fetch(`/api/v1/marketing/ads/backgrounds?${qs}`)
      .then((r) => r.json())
      .then((d) => setBgImages(d.images ?? []));
  }, [bgSearch]);
  useEffect(() => {
    if (kind !== "image") return;
    const t = setTimeout(loadBgImages, bgSearch ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadBgImages, bgSearch, kind]);

  const pickClip = (c: Clip) => {
    setClip(c);
    if (c.products.length && !skuId) setSkuId(c.products[0].skuId);
  };

  const uploadBackground = async (file: File) => {
    setUploading(true);
    try {
      const res = await fetch(`/api/v1/marketing/ads/backgrounds?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      });
      const d = await res.json();
      if (res.ok) {
        setUploadKey(d.key);
        setUploadPreview(URL.createObjectURL(file));
        setBgImage(null);
        toast.success("Background uploaded");
      } else toast.error(d.error ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const selectedSku = useMemo(() => skus.find((s) => s.id === skuId), [skus, skuId]);

  // Live preview of the generated name — client-side mirror of buildAdName,
  // display-only (the server's version is authoritative on create).
  const namePreview = useMemo(() => {
    if (!selectedSku) return null;
    if (kind === "video" && !clip) return null;
    if (kind === "image" && !bgImage && !uploadKey) return null;
    const segment = (v: string, max: number) => v.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, max);
    const talentMap: Record<string, string> = { missjademonet: "JADE", daria: "DARIA", "shianne bateman": "SHIA" };
    const t = kind === "video" ? (clip?.talent ?? "").trim().toLowerCase() : "";
    const model = !t ? "NONE" : talentMap[t] ?? segment(t.split(/\s+/)[0], 6) ?? "NONE";
    const parts = selectedSku.sku.split("-").filter(Boolean);
    const color = segment(parts[parts.length - 1] ?? "", 6) || "NA";
    const fmt = kind === "video" ? "VID" : "IMG";
    return `JX_PCARD_${fmt}_${segment(selectedSku.productName, 10)}-${color}_${model}_${copyVariant}_v01`;
  }, [kind, clip, bgImage, uploadKey, selectedSku, copyVariant]);

  const filteredSkus = useMemo(() => {
    const q = skuFilter.trim().toLowerCase();
    if (!q) return skus;
    return skus.filter(
      (s) =>
        s.productName.toLowerCase().includes(q) ||
        s.sku.toLowerCase().includes(q) ||
        (s.colorName ?? "").toLowerCase().includes(q),
    );
  }, [skus, skuFilter]);

  const backgroundReady = kind === "video" ? !!clip : !!bgImage || !!uploadKey;

  const create = async () => {
    if (!backgroundReady || !skuId || !ratios.length) return;
    setCreating(true);
    try {
      const res = await fetch("/api/v1/marketing/ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe: "pcard",
          backgroundType: kind === "video" ? "clip" : bgImage ? "catalog_image" : "upload",
          backgroundRef: kind === "video" ? clip!.id : bgImage ? bgImage.id : uploadKey!,
          skuId,
          ratios,
          copyVariant,
          headline: headline.trim() || undefined,
          displayNameOverride: displayName.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (res.ok) {
        toast.success(`Rendering ${d.name} in ${ratios.length} ratios`);
        router.push(`/marketing/ads/${d.id}`);
      } else if (res.status === 409 && d.id) {
        toast.message(`That exact ad already exists — taking you to it`);
        router.push(`/marketing/ads/${d.id}`);
      } else {
        toast.error(d.error ?? "Create failed");
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/marketing/ads" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Ad Studio
        </Button>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Megaphone className="h-5 w-5" /> New ad
        </h1>
        <div className="flex-1" />
        <div className="flex rounded-lg border p-0.5">
          {(["video", "image"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition ${
                kind === k ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
            >
              {k === "video" ? <Clapperboard className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
              {k === "video" ? "Video ad" : "Image ad"}
            </button>
          ))}
        </div>
      </div>

      {/* Step 1 — background */}
      {kind === "video" ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            1 · Background clip {clip && <span className="font-normal text-muted-foreground">— {clip.file_name}</span>}
          </h2>
          <Input
            placeholder="Search clips — model, product, SKU, shot type…"
            value={clipSearch}
            onChange={(e) => setClipSearch(e.target.value)}
            className="h-9 max-w-md"
          />
          {clipsLoading ? (
            <div className="h-40 animate-pulse rounded-lg bg-muted" />
          ) : (
            <div className="grid max-h-[340px] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {clips.map((c) => (
                <button
                  key={c.id}
                  onClick={() => pickClip(c)}
                  className={`relative aspect-[9/16] overflow-hidden rounded-md border-2 transition ${
                    clip?.id === c.id ? "border-primary ring-2 ring-primary" : "border-transparent hover:border-muted-foreground/40"
                  }`}
                >
                  {c.posterUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.posterUrl} alt={c.file_name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center bg-muted text-[10px] text-muted-foreground p-1">
                      {c.file_name}
                    </div>
                  )}
                  {clip?.id === c.id && (
                    <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                  <span className="absolute bottom-0 inset-x-0 bg-black/60 px-1 py-0.5 text-left text-[9px] text-white truncate">
                    {c.talent ?? "no model"} · {c.duration_sec ? `${Math.round(c.duration_sec)}s` : ""}
                  </span>
                </button>
              ))}
              {clips.length === 0 && (
                <div className="col-span-full p-6 text-center text-sm text-muted-foreground">No clips match.</div>
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">
            1 · Background image{" "}
            {(bgImage || uploadKey) && (
              <span className="font-normal text-muted-foreground">
                — {bgImage ? `${bgImage.productName} (${bgImage.sku})` : "uploaded file"}
              </span>
            )}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search catalog images — product, SKU, colour…"
              value={bgSearch}
              onChange={(e) => setBgSearch(e.target.value)}
              className="h-9 max-w-md"
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && uploadBackground(e.target.files[0])}
            />
            <Button variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <UploadCloud className="h-4 w-4 mr-1" />}
              Upload
            </Button>
          </div>
          <div className="grid max-h-[340px] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
            {uploadPreview && (
              <button
                onClick={() => { setBgImage(null); }}
                className={`relative aspect-[4/5] overflow-hidden rounded-md border-2 ${
                  uploadKey && !bgImage ? "border-primary ring-2 ring-primary" : "border-transparent"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={uploadPreview} alt="upload" className="h-full w-full object-cover" />
                <span className="absolute bottom-0 inset-x-0 bg-black/60 px-1 py-0.5 text-[9px] text-white">your upload</span>
              </button>
            )}
            {bgImages.map((img) => (
              <button
                key={img.id}
                onClick={() => { setBgImage(img); }}
                className={`relative aspect-[4/5] overflow-hidden rounded-md border-2 transition ${
                  bgImage?.id === img.id ? "border-primary ring-2 ring-primary" : "border-transparent hover:border-muted-foreground/40"
                }`}
              >
                {img.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img.url} alt={img.sku} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center bg-muted text-[10px]">{img.sku}</div>
                )}
                <span className="absolute bottom-0 inset-x-0 bg-black/60 px-1 py-0.5 text-left text-[9px] text-white truncate">
                  {img.productName}
                </span>
              </button>
            ))}
            {bgImages.length === 0 && !uploadPreview && (
              <div className="col-span-full p-6 text-center text-sm text-muted-foreground">No images match.</div>
            )}
          </div>
        </section>
      )}

      {/* Step 2 — the product on the card */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">2 · Product on the card</h2>
        {kind === "video" && clip && clip.products.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {clip.products.map((p) => (
              <button
                key={p.skuId}
                onClick={() => setSkuId(p.skuId)}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  skuId === p.skuId ? "border-primary ring-1 ring-primary font-medium" : "hover:bg-muted"
                }`}
              >
                {p.productName} · {p.sku}
              </button>
            ))}
            <span className="self-center text-[11px] text-muted-foreground">tagged in this clip</span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Or search all SKUs…"
            value={skuFilter}
            onChange={(e) => setSkuFilter(e.target.value)}
            className="h-9 max-w-xs"
          />
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={skuId}
            onChange={(e) => setSkuId(e.target.value)}
          >
            <option value="">Pick a SKU…</option>
            {filteredSkus.slice(0, 200).map((s) => (
              <option key={s.id} value={s.id}>
                {s.productName} — {s.sku}
                {s.colorName ? ` (${s.colorName})` : ""}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Step 3 — ratios, copy, text */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">3 · Ratios, copy & text</h2>
        <div className="flex flex-wrap gap-1.5">
          {ratioOptions.map((r) => (
            <button
              key={r.slug}
              onClick={() =>
                setRatios((prev) => (prev.includes(r.slug) ? prev.filter((x) => x !== r.slug) : [...prev, r.slug]))
              }
              className={`rounded-full border px-3 py-1 font-mono text-xs transition ${
                ratios.includes(r.slug) ? "border-primary ring-1 ring-primary font-medium" : "hover:bg-muted"
              }`}
            >
              {r.slug} · {r.width}×{r.height}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Copy</span>
          {[{ code: "C00", primaryText: "No copy", headline: null }, ...copyVariants].map((v) => (
            <button
              key={v.code}
              onClick={() => setCopyVariant(v.code)}
              title={v.primaryText}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                copyVariant === v.code ? "border-primary ring-1 ring-primary font-medium" : "hover:bg-muted"
              }`}
            >
              {v.code}
            </button>
          ))}
          <span className="text-[11px] text-muted-foreground">manage variants on any ad&apos;s page</span>
        </div>
        <div className="flex max-w-2xl flex-wrap gap-2">
          <Input
            placeholder="Card name override (blank = product name)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="h-9 flex-1 min-w-[220px]"
          />
          <Input
            placeholder="Headline on the media (optional)"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            className="h-9 flex-1 min-w-[220px]"
          />
        </div>
      </section>

      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Ad name (the tracking key)</div>
          <div className="truncate font-mono text-sm">{namePreview ?? "pick a background and a SKU…"}</div>
        </div>
        <Button onClick={create} disabled={!backgroundReady || !skuId || !ratios.length || creating}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
          Create & render {ratios.length ? `(${ratios.length})` : ""}
        </Button>
      </div>
    </div>
  );
}
