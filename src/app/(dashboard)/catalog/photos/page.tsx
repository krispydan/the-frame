"use client";

/**
 * Product Photos — the SKU × kind coverage matrix, plus drag-and-drop
 * bulk upload where canonically-named files route themselves.
 *
 * Rows are SKUs (grouped visually by product), columns are the photo
 * kinds from the registry. A filled cell shows the newest thumbnail;
 * an empty REQUIRED cell is the work list. Drop files anywhere: a
 * preview shows exactly where each will land (SKU/kind/angle, parsed
 * from the name) before anything uploads — mis-named files are called
 * out instead of guessed at.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Camera, Check, Loader2, RefreshCw, UploadCloud, X } from "lucide-react";

type KindDef = {
  slug: string;
  label: string;
  scope: "sku" | "product";
  required: boolean;
  platforms: string[];
  description: string;
};
type CellData = { count: number; url: string | null; imageId: string };
type SkuRow = {
  skuId: string;
  sku: string;
  productId: string;
  productName: string;
  colorName: string | null;
  kinds: Record<string, CellData>;
  missingRequired: string[];
};
type RoutePreview = { fileName: string; ok: boolean; sku?: string; kind?: string; angle?: string | null; error?: string };

export default function ProductPhotosPage() {
  const [kinds, setKinds] = useState<KindDef[]>([]);
  const [skus, setSkus] = useState<SkuRow[]>([]);
  const [summary, setSummary] = useState<{ total: number; complete: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);

  // Upload flow state
  const [pending, setPending] = useState<File[] | null>(null);
  const [preview, setPreview] = useState<RoutePreview[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (search.trim()) qs.set("search", search.trim());
    if (missingOnly) qs.set("missingOnly", "1");
    fetch(`/api/v1/catalog/photos?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        setKinds(d.kinds ?? []);
        setSkus(d.skus ?? []);
        setSummary(d.summary ?? null);
      })
      .finally(() => setLoading(false));
  }, [search, missingOnly]);
  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  // ── Upload flow: files → dry-run routing preview → confirm → upload ──
  const stageFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|avif)$/i.test(f.name));
    if (!images.length) { toast.error("No image files in that drop"); return; }
    setPending(images);
    const form = new FormData();
    form.set("namesJson", JSON.stringify(images.map((f) => f.name)));
    const res = await fetch("/api/v1/catalog/photos/bulk", { method: "POST", body: form });
    const d = await res.json();
    setPreview(d.results ?? []);
  };

  const confirmUpload = async () => {
    if (!pending) return;
    setUploading(true);
    try {
      // Chunk: 40 files/request cap, and keep request bodies sane.
      const CHUNK = 25;
      let uploaded = 0, deduped = 0, failed = 0;
      const failures: RoutePreview[] = [];
      for (let i = 0; i < pending.length; i += CHUNK) {
        const form = new FormData();
        for (const f of pending.slice(i, i + CHUNK)) form.append("files", f);
        const res = await fetch("/api/v1/catalog/photos/bulk", { method: "POST", body: form });
        const d = await res.json();
        if (!res.ok) { toast.error(d.error ?? "Upload failed"); break; }
        uploaded += d.uploaded; deduped += d.deduped; failed += d.failed;
        for (const r of d.results ?? []) {
          if (r.status === "failed") failures.push({ fileName: r.fileName, ok: false, error: r.error });
        }
      }
      toast[failed ? "message" : "success"](
        `${uploaded} uploaded${deduped ? `, ${deduped} already existed` : ""}${failed ? `, ${failed} failed` : ""}`,
        { duration: 8000 },
      );
      setPreview(failures.length ? failures : null);
      setPending(failures.length ? [] : null);
      load();
    } finally {
      setUploading(false);
    }
  };

  const products = useMemo(() => {
    const map = new Map<string, SkuRow[]>();
    for (const s of skus) {
      const list = map.get(s.productId) ?? [];
      list.push(s);
      map.set(s.productId, list);
    }
    return [...map.values()];
  }, [skus]);

  const routable = preview?.filter((p) => p.ok).length ?? 0;

  return (
    <div
      className="space-y-4 min-w-0"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        stageFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/catalog" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Catalog
        </Button>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Camera className="h-5 w-5" /> Product Photos
        </h1>
        {summary && (
          <span className="text-sm text-muted-foreground">
            {summary.complete}/{summary.total} SKUs complete
          </span>
        )}
        <div className="flex-1" />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && stageFiles([...e.target.files])}
        />
        <Button onClick={() => fileRef.current?.click()}>
          <UploadCloud className="h-4 w-4 mr-1" /> Bulk upload
        </Button>
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search product, SKU, colour…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 max-w-xs"
        />
        <button
          onClick={() => setMissingOnly((v) => !v)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
            missingOnly ? "border-primary ring-1 ring-primary" : "hover:bg-muted"
          }`}
        >
          missing required only
        </button>
      </div>

      {/* Routing preview after a drop */}
      {preview && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            {pending?.length ? `${pending.length} files staged — ${routable} route cleanly` : "Upload issues"}
            <div className="flex-1" />
            {pending && pending.length > 0 && (
              <Button size="sm" onClick={confirmUpload} disabled={uploading || routable === 0}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <UploadCloud className="h-4 w-4 mr-1" />}
                Upload {routable}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => { setPending(null); setPreview(null); }}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto text-xs">
            {preview.map((p) => (
              <div key={p.fileName} className="flex items-center gap-2">
                {p.ok ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <X className="h-3.5 w-3.5 shrink-0 text-red-600" />}
                <span className="truncate font-mono">{p.fileName}</span>
                <span className="shrink-0 text-muted-foreground">
                  {p.ok ? `→ ${p.sku} · ${p.kind}${p.angle && p.angle !== "front" ? ` · ${p.angle}` : ""}` : p.error}
                </span>
              </div>
            ))}
          </div>
          {preview.some((p) => !p.ok) && (
            <div className="text-[11px] text-muted-foreground">
              Files that don&apos;t route are skipped — rename to <span className="font-mono">{"{SKU}[-ANGLE]_{SUFFIX}.jpg"}</span> (e.g.{" "}
              <span className="font-mono">JX1016-S-BLK_SQUARE_F8F9FA.jpg</span>) and re-drop.
            </div>
          )}
        </div>
      )}

      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-primary bg-background px-8 py-6 text-lg font-medium">
            Drop photos — they&apos;ll route by filename
          </div>
        </div>
      )}

      {loading && skus.length === 0 ? (
        <div className="h-96 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="sticky left-0 bg-muted/40 p-2">SKU</th>
                {kinds.map((k) => (
                  <th key={k.slug} className="p-2 text-center" title={`${k.description}\n→ ${k.platforms.join(", ")}`}>
                    {k.label}
                    {k.required && <span className="text-red-500">*</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((group) => (
                group.map((s, i) => (
                  <tr key={s.skuId} className={`border-b last:border-0 hover:bg-muted/30 ${i === 0 ? "border-t-2" : ""}`}>
                    <td className="sticky left-0 bg-background p-2">
                      {i === 0 && <div className="text-xs font-semibold">{s.productName}</div>}
                      <div className="font-mono text-xs text-muted-foreground">
                        {s.sku}
                        {s.colorName ? ` · ${s.colorName}` : ""}
                      </div>
                    </td>
                    {kinds.map((k) => {
                      const cell = s.kinds[k.slug];
                      return (
                        <td key={k.slug} className="p-1.5 text-center align-middle">
                          {cell?.url ? (
                            <a href={cell.url} target="_blank" rel="noreferrer" className="inline-block" title={`${k.label} · ${cell.count} file${cell.count > 1 ? "s" : ""}`}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={cell.url}
                                alt={`${s.sku} ${k.label}`}
                                loading="lazy"
                                className="mx-auto h-10 w-10 rounded border object-cover"
                              />
                              {cell.count > 1 && <span className="text-[9px] text-muted-foreground">×{cell.count}</span>}
                            </a>
                          ) : cell ? (
                            <span className="text-[10px] text-muted-foreground">×{cell.count}</span>
                          ) : k.required ? (
                            <span title="Required — missing" className="mx-auto block h-10 w-10 rounded border-2 border-dashed border-red-300" />
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))
              ))}
              {skus.length === 0 && (
                <tr><td colSpan={kinds.length + 1} className="p-8 text-center text-muted-foreground">No SKUs match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-[11px] text-muted-foreground">
        <span className="text-red-500">*</span> required per SKU · product-scope kinds (case, collage, lens, materials,
        dimensions, collection) apply to every colourway of the style · naming:{" "}
        <span className="font-mono">JX1016-S-BLK_SQUARE_F8F9FA.jpg</span>,{" "}
        <span className="font-mono">JX1019-R-BLK-SIDE_SQUARE_F8F9FA.jpg</span>,{" "}
        <span className="font-mono">JX4011_collage.png</span>,{" "}
        <span className="font-mono">JX4011-BLK_google.png</span>
      </div>
    </div>
  );
}
