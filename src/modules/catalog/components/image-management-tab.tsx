"use client";

import { catalogImageUrl } from "@/lib/storage/image-url";
import { useEffect, useState, useCallback } from "react";
import { UppyUploader } from "./uppy-uploader";
import {
  Image as ImageIcon, CheckCircle, XCircle, Star, Upload, Wand2,
  Maximize2, X, ChevronLeft, ChevronRight, Copy,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type ImageItem = {
  id: string;
  skuId: string;
  filePath: string | null;
  url: string | null;
  fileSize: number | null;
  mimeType: string | null;
  checksum: string | null;
  imageTypeId: string | null;
  status: string | null;
  isBest: boolean | null;
  width: number | null;
  height: number | null;
  aiModelUsed: string | null;
  uploadedBy: string | null;
  createdAt: string | null;
};

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type Sku = {
  id: string;
  sku: string | null;
  colorName: string | null;
  colorHex: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  review: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

export function ImageManagementTab({
  productId, skus, onRefresh,
}: {
  productId: string;
  skus: Sku[];
  onRefresh: () => void;
}) {
  const [imageList, setImageList] = useState<ImageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSku, setSelectedSku] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [showUploader, setShowUploader] = useState(false);

  const loadImages = useCallback(async () => {
    const res = await fetch(`/api/v1/catalog/images?productId=${productId}`);
    const data = await res.json();
    setImageList(data.images || []);
    setLoading(false);
  }, [productId]);

  useEffect(() => { loadImages(); }, [loadImages]);

  // Keyboard navigation for the lightbox: ← → Esc
  useEffect(() => {
    if (lightbox === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      if (e.key === "ArrowLeft" && lightbox > 0) setLightbox(lightbox - 1);
      if (e.key === "ArrowRight") {
        setLightbox((prev) => (prev !== null && prev + 1 < filtered.length ? prev + 1 : prev));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox]);

  const filtered = imageList.filter((img) => {
    if (selectedSku !== "all" && img.skuId !== selectedSku) return false;
    if (selectedStatus !== "all" && img.status !== selectedStatus) return false;
    return true;
  });

  const handleStatusChange = async (id: string, status: string) => {
    await fetch(`/api/v1/catalog/images/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadImages();
  };

  const handleSetBest = async (id: string) => {
    await fetch(`/api/v1/catalog/images/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isBest: true }),
    });
    await loadImages();
  };

  const handleBulkAction = async (status: string) => {
    await fetch("/api/v1/catalog/images/bulk", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selected], status }),
    });
    setSelected(new Set());
    await loadImages();
  };

  const handleBulkReassign = async (newSkuId: string) => {
    if (!newSkuId) return;
    await fetch("/api/v1/catalog/images/bulk", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selected], skuId: newSkuId }),
    });
    setSelected(new Set());
    await loadImages();
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} image${selected.size === 1 ? "" : "s"}? This cannot be undone.`)) return;
    await fetch("/api/v1/catalog/images/bulk", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...selected] }),
    });
    setSelected(new Set());
    await loadImages();
  };

  const handleCopyUrl = async (img: ImageItem) => {
    const url = img.url ?? catalogImageUrl(img.filePath);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // ignore
    }
  };

  const handleGenerate = async (skuId: string) => {
    const res = await fetch("/api/v1/catalog/images/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skuId, imageType: "front-on-white" }),
    });
    const data = await res.json();
    if (data.stub) {
      alert(data.message || "Image generation requires GOOGLE_GEMINI_API_KEY");
    }
  };

  const getSkuLabel = (skuId: string) => {
    const sku = skus.find((s) => s.id === skuId);
    return sku ? `${sku.sku} (${sku.colorName || "?"})` : skuId;
  };

  const stats = {
    total: imageList.length,
    draft: imageList.filter((i) => i.status === "draft").length,
    review: imageList.filter((i) => i.status === "review").length,
    approved: imageList.filter((i) => i.status === "approved").length,
    rejected: imageList.filter((i) => i.status === "rejected").length,
  };

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-5 gap-3">
        {Object.entries(stats).map(([key, val]) => (
          <Card key={key}>
            <CardContent className="p-3 text-center">
              <p className="text-2xl font-bold">{val}</p>
              <p className="text-xs text-muted-foreground capitalize">{key}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters + Actions */}
      <div className="flex items-center gap-3">
        <Select value={selectedSku} onValueChange={(v) => setSelectedSku(v ?? "all")}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Filter by SKU" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All SKUs</SelectItem>
            {skus.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.sku} — {s.colorName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={selectedStatus} onValueChange={(v) => setSelectedStatus(v ?? "all")}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="review">Review</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>

        {selected.size > 0 && (
          <>
            <span className="text-sm text-muted-foreground">{selected.size} selected</span>
            <Button size="sm" variant="outline" onClick={() => handleBulkAction("approved")}>
              <CheckCircle className="h-3 w-3 mr-1" /> Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleBulkAction("rejected")}>
              <XCircle className="h-3 w-3 mr-1" /> Reject
            </Button>
            <Select value="" onValueChange={(v) => handleBulkReassign(v)}>
              <SelectTrigger className="w-[160px] h-8"><SelectValue placeholder="Reassign SKU…" /></SelectTrigger>
              <SelectContent>
                {skus.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.sku} — {s.colorName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={handleBulkDelete}>
              Delete
            </Button>
          </>
        )}

        <div className="flex-1" />
        <Button size="sm" variant={showUploader ? "default" : "outline"} onClick={() => setShowUploader((v) => !v)}>
          <Upload className="h-3 w-3 mr-1" /> {showUploader ? "Close uploader" : "Upload images"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => skus[0] && handleGenerate(skus[0].id)}>
          <Wand2 className="h-3 w-3 mr-1" /> AI Generate
        </Button>
      </div>

      {showUploader && (
        <Card>
          <CardContent className="p-4">
            <UppyUploader
              skus={skus.map((s) => ({ id: s.id, sku: s.sku, colorName: s.colorName }))}
              onUploadComplete={() => {
                loadImages();
                onRefresh();
              }}
            />
          </CardContent>
        </Card>
      )}

      {/* Image Grid */}
      {loading ? (
        <p className="text-muted-foreground">Loading images...</p>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            <ImageIcon className="h-12 w-12 mx-auto opacity-50 mb-2" />
            <p>No images found. Upload or generate images to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {filtered.map((img, idx) => (
            <div key={img.id} className="relative group border rounded-lg overflow-hidden bg-muted/30">
              <div className="absolute top-2 left-2 z-10">
                <Checkbox
                  checked={selected.has(img.id)}
                  onCheckedChange={() => {
                    const next = new Set(selected);
                    next.has(img.id) ? next.delete(img.id) : next.add(img.id);
                    setSelected(next);
                  }}
                  className="opacity-0 group-hover:opacity-100 data-[state=checked]:opacity-100 bg-white"
                />
              </div>
              {img.isBest && (
                <div className="absolute top-2 right-2 z-10">
                  <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                </div>
              )}

              <div
                className="aspect-square bg-muted flex items-center justify-center cursor-pointer"
                onClick={() => setLightbox(idx)}
                title={`${img.width ?? "?"}×${img.height ?? "?"}${img.fileSize ? ` · ${formatFileSize(img.fileSize)}` : ""}${img.mimeType ? ` · ${img.mimeType}` : ""}`}
              >
                {img.filePath ? (
                  <img src={catalogImageUrl(img.filePath)!} alt="" className="object-contain w-full h-full" />
                ) : (
                  <ImageIcon className="h-8 w-8 text-muted-foreground" />
                )}
              </div>

              <div className="p-2 space-y-1">
                <div className="flex items-center justify-between">
                  <Badge variant="secondary" className={`text-[10px] ${STATUS_COLORS[img.status || "draft"]}`}>
                    {img.status}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">{img.width}×{img.height}</span>
                </div>
                <p className="text-[10px] text-muted-foreground truncate">{getSkuLabel(img.skuId)}</p>

                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => handleStatusChange(img.id, "approved")} title="Approve">
                    <CheckCircle className="h-3 w-3 text-green-600" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => handleStatusChange(img.id, "rejected")} title="Reject">
                    <XCircle className="h-3 w-3 text-red-600" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => handleSetBest(img.id)} title="Set as best">
                    <Star className="h-3 w-3" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => setLightbox(idx)} title="View full size">
                    <Maximize2 className="h-3 w-3" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => handleCopyUrl(img)} title="Copy CDN URL">
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightbox !== null && filtered[lightbox] && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={() => setLightbox(null)}>
          <Button size="icon" variant="ghost" className="absolute top-4 right-4 text-white" onClick={() => setLightbox(null)}>
            <X className="h-6 w-6" />
          </Button>
          {lightbox > 0 && (
            <Button size="icon" variant="ghost" className="absolute left-4 text-white" onClick={(e) => { e.stopPropagation(); setLightbox(lightbox - 1); }}>
              <ChevronLeft className="h-6 w-6" />
            </Button>
          )}
          {lightbox < filtered.length - 1 && (
            <Button size="icon" variant="ghost" className="absolute right-4 text-white" onClick={(e) => { e.stopPropagation(); setLightbox(lightbox + 1); }}>
              <ChevronRight className="h-6 w-6" />
            </Button>
          )}
          <div className="max-w-4xl max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
            {filtered[lightbox].filePath ? (
              <img src={catalogImageUrl(filtered[lightbox].filePath)!} alt="" className="max-w-full max-h-[80vh] object-contain" />
            ) : (
              <div className="text-white text-center">No image file</div>
            )}
            <div className="text-white text-center mt-2 text-sm">
              {getSkuLabel(filtered[lightbox].skuId)} · {filtered[lightbox].status}
              {filtered[lightbox].isBest && " · ⭐ Best"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
