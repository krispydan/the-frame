"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Image as ImageIcon,
  Search,
  LayoutGrid,
  List,
  Upload,
  Download,
  Trash2,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  HardDrive,
  FolderOpen,
  Eye,
  Copy,
  MoreHorizontal,
  RefreshCw,
  Filter,
  SlidersHorizontal,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";

// ── Types ──

interface MediaImage {
  id: string;
  sku_id: string;
  file_path: string;
  url: string;
  file_size: number;
  mime_type: string;
  width: number;
  height: number;
  position: number;
  alt_text: string | null;
  status: string;
  is_best: number;
  pipeline_status: string;
  source: string;
  created_at: string;
  sku: string;
  color_name: string;
  product_id: string;
  product_name: string;
  sku_prefix: string;
  image_type_slug: string | null;
  image_type_label: string | null;
}

interface MediaStats {
  total: number;
  approved: number;
  review: number;
  draft: number;
  rejected: number;
  processed: number;
  unprocessed: number;
  total_size: number;
  product_count: number;
  sku_count: number;
}

interface ProductFilter {
  id: string;
  sku_prefix: string;
  name: string;
  image_count: number;
}

interface ImageTypeFilter {
  slug: string;
  label: string;
}

interface SourceFilter {
  source: string;
  count: number;
}

const SOURCE_LABELS: Record<string, string> = {
  raw: "Original",
  no_bg: "No Background",
  white_bg: "White BG",
  cropped: "Cropped",
  square: "Square (Shopify)",
  collection: "Collection (Faire)",
  pipeline: "Pipeline",
  upload: "Upload",
};

// ── Helpers ──

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getImageUrl(img: MediaImage): string {
  if (img.url) return img.url;
  if (img.file_path) return `/api/images/${img.file_path}`;
  return "";
}

const statusColors: Record<string, string> = {
  approved: "bg-green-100 text-green-800",
  review: "bg-yellow-100 text-yellow-800",
  draft: "bg-gray-100 text-gray-700",
  rejected: "bg-red-100 text-red-800",
};

// ── Main Component ──

export default function MediaCenterPage() {
  // State
  const [images, setImages] = useState<MediaImage[]>([]);
  const [stats, setStats] = useState<MediaStats | null>(null);
  const [products, setProducts] = useState<ProductFilter[]>([]);
  const [imageTypes, setImageTypes] = useState<ImageTypeFilter[]>([]);
  const [sources, setSources] = useState<SourceFilter[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [productFilter, setProductFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 60;

  // UI state
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewImage, setPreviewImage] = useState<MediaImage | null>(null);

  // ── Fetch ──

  const fetchImages = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (productFilter !== "all") params.set("productId", productFilter);
    if (typeFilter !== "all") params.set("imageType", typeFilter);
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    params.set("sort", sortBy);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(page * PAGE_SIZE));

    try {
      const res = await fetch(`/api/v1/media?${params}`);
      const data = await res.json();
      setImages(data.images || []);
      setTotal(data.total || 0);
      setStats(data.stats || null);
      setProducts(data.filters?.products || []);
      setImageTypes(data.filters?.imageTypes || []);
      setSources(data.filters?.sources || []);
    } catch (e) {
      console.error("Failed to fetch media:", e);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, productFilter, typeFilter, sourceFilter, sortBy, page]);

  useEffect(() => {
    const timer = setTimeout(fetchImages, search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [fetchImages]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [search, statusFilter, productFilter, typeFilter, sourceFilter, sortBy]);

  // ── Selection ──

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === images.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(images.map((i) => i.id)));
    }
  };

  const clearSelection = () => setSelected(new Set());

  // ── Actions ──

  const updateImageStatus = async (imageIds: string[], newStatus: string) => {
    for (const id of imageIds) {
      await fetch(`/api/v1/catalog/images/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
    }
    clearSelection();
    fetchImages();
  };

  const deleteImages = async (imageIds: string[]) => {
    if (!confirm(`Delete ${imageIds.length} image(s)? This cannot be undone.`)) return;
    await fetch("/api/v1/catalog/images/bulk", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: imageIds }),
    });
    clearSelection();
    fetchImages();
  };

  const copyUrl = (img: MediaImage) => {
    navigator.clipboard.writeText(getImageUrl(img));
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ImageIcon className="h-6 w-6" />
            Media Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage all product images across the catalog
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchImages}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      {/* Stats Bar */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="p-3">
            <div className="text-2xl font-bold">{stats.total}</div>
            <div className="text-xs text-muted-foreground">Total Images</div>
          </Card>
          <Card className="p-3">
            <div className="text-2xl font-bold text-green-600">{stats.approved}</div>
            <div className="text-xs text-muted-foreground">Approved</div>
          </Card>
          <Card className="p-3">
            <div className="text-2xl font-bold text-yellow-600">{stats.review}</div>
            <div className="text-xs text-muted-foreground">In Review</div>
          </Card>
          <Card className="p-3">
            <div className="text-2xl font-bold">{stats.product_count}</div>
            <div className="text-xs text-muted-foreground">Products</div>
          </Card>
          <Card className="p-3">
            <div className="text-2xl font-bold flex items-center gap-1">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              {formatBytes(stats.total_size)}
            </div>
            <div className="text-xs text-muted-foreground">Total Size</div>
          </Card>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by SKU, product name, alt text..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="review">Review</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>

          <Select value={productFilter} onValueChange={(v) => setProductFilter(v ?? "all")}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Product" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Products</SelectItem>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.sku_prefix} ({p.image_count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? "all")}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Angle" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Angles</SelectItem>
              {imageTypes.map((t) => (
                <SelectItem key={t.slug} value={t.slug}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v ?? "all")}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Version" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Versions</SelectItem>
              {sources.map((s) => (
                <SelectItem key={s.source} value={s.source}>
                  {SOURCE_LABELS[s.source] || s.source} ({s.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={(v) => setSortBy(v ?? "newest")}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="oldest">Oldest</SelectItem>
              <SelectItem value="name">By Name</SelectItem>
              <SelectItem value="size">By Size</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center border rounded-md">
            <Button
              variant={viewMode === "grid" ? "default" : "ghost"}
              size="sm"
              onClick={() => setViewMode("grid")}
              className="rounded-r-none"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "default" : "ghost"}
              size="sm"
              onClick={() => setViewMode("list")}
              className="rounded-l-none"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => updateImageStatus([...selected], "approved")}>
            <Check className="h-3 w-3 mr-1" /> Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => updateImageStatus([...selected], "review")}>
            <Eye className="h-3 w-3 mr-1" /> To Review
          </Button>
          <Button size="sm" variant="outline" onClick={() => updateImageStatus([...selected], "rejected")}>
            <X className="h-3 w-3 mr-1" /> Reject
          </Button>
          <Button size="sm" variant="destructive" onClick={() => deleteImages([...selected])}>
            <Trash2 className="h-3 w-3 mr-1" /> Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection} className="ml-auto">
            Clear
          </Button>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading media...
        </div>
      ) : images.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
          <FolderOpen className="h-12 w-12 mb-3 opacity-50" />
          <p className="text-lg font-medium">No images found</p>
          <p className="text-sm">Try adjusting your search or filters</p>
        </div>
      ) : viewMode === "grid" ? (
        /* ── Grid View ── */
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {images.map((img) => (
            <div
              key={img.id}
              className={`group relative rounded-lg border overflow-hidden cursor-pointer transition-all hover:ring-2 hover:ring-primary/50 ${
                selected.has(img.id) ? "ring-2 ring-primary" : ""
              }`}
            >
              {/* Checkbox */}
              <div
                className={`absolute top-2 left-2 z-10 transition-opacity ${
                  selected.has(img.id) ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                <Checkbox
                  checked={selected.has(img.id)}
                  onCheckedChange={() => toggleSelect(img.id)}
                  className="bg-white/80 backdrop-blur-sm"
                />
              </div>

              {/* Best badge */}
              {img.is_best === 1 && (
                <div className="absolute top-2 right-2 z-10">
                  <Badge className="bg-amber-500 text-white text-[10px] px-1.5">BEST</Badge>
                </div>
              )}

              {/* Image */}
              <div
                className="aspect-square bg-[#F8F9FA] relative"
                onClick={() => setPreviewImage(img)}
              >
                <img
                  src={getImageUrl(img)}
                  alt={img.alt_text || img.sku}
                  className="w-full h-full object-contain"
                  loading="lazy"
                />
              </div>

              {/* Info */}
              <div className="p-2 bg-white">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-medium truncate">{img.sku}</span>
                  <Badge variant="outline" className={`text-[10px] px-1 ${statusColors[img.status] || ""}`}>
                    {img.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-1">
                  {img.image_type_label && (
                    <span className="text-[10px] text-muted-foreground">{img.image_type_label}</span>
                  )}
                  {img.source && img.source !== "upload" && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 ml-auto">
                      {SOURCE_LABELS[img.source] || img.source}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ── List View ── */
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={selected.size === images.length && images.length > 0}
                    onCheckedChange={selectAll}
                  />
                </TableHead>
                <TableHead className="w-16">Preview</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Dimensions</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {images.map((img) => (
                <TableRow key={img.id} className={selected.has(img.id) ? "bg-blue-50" : ""}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(img.id)}
                      onCheckedChange={() => toggleSelect(img.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <div
                      className="w-12 h-12 rounded bg-[#F8F9FA] overflow-hidden cursor-pointer"
                      onClick={() => setPreviewImage(img)}
                    >
                      <img
                        src={getImageUrl(img)}
                        alt={img.sku}
                        className="w-full h-full object-contain"
                        loading="lazy"
                      />
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">
                    {img.sku}
                    {img.is_best === 1 && (
                      <Badge className="ml-1 bg-amber-500 text-white text-[10px] px-1">BEST</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{img.sku_prefix} {img.product_name}</TableCell>
                  <TableCell>{img.image_type_label || "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={statusColors[img.status] || ""}>
                      {img.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatBytes(img.file_size)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {img.width && img.height ? `${img.width}x${img.height}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(img.created_at)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger>
                        <Button variant="ghost" size="sm">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setPreviewImage(img)}>
                          <Eye className="h-4 w-4 mr-2" /> Preview
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => copyUrl(img)}>
                          <Copy className="h-4 w-4 mr-2" /> Copy URL
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => updateImageStatus([img.id], "approved")}>
                          <Check className="h-4 w-4 mr-2" /> Approve
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => updateImageStatus([img.id], "rejected")}>
                          <X className="h-4 w-4 mr-2" /> Reject
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-red-600" onClick={() => deleteImages([img.id])}>
                          <Trash2 className="h-4 w-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm px-2">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Preview Dialog */}
      <Dialog open={!!previewImage} onOpenChange={() => setPreviewImage(null)}>
        <DialogContent className="max-w-4xl">
          {previewImage && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {previewImage.sku}
                  {previewImage.image_type_label && (
                    <Badge variant="outline">{previewImage.image_type_label}</Badge>
                  )}
                  <Badge variant="outline" className={statusColors[previewImage.status] || ""}>
                    {previewImage.status}
                  </Badge>
                </DialogTitle>
              </DialogHeader>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Large preview */}
                <div className="md:col-span-2 bg-[#F8F9FA] rounded-lg overflow-hidden">
                  <img
                    src={getImageUrl(previewImage)}
                    alt={previewImage.alt_text || previewImage.sku}
                    className="w-full h-auto object-contain max-h-[500px]"
                  />
                </div>

                {/* Details sidebar */}
                <div className="space-y-4">
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Product</h4>
                    <p className="text-sm">{previewImage.sku_prefix} &mdash; {previewImage.product_name}</p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">SKU</h4>
                    <p className="text-sm">{previewImage.sku} ({previewImage.color_name})</p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Dimensions</h4>
                    <p className="text-sm">{previewImage.width} x {previewImage.height}</p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">File Size</h4>
                    <p className="text-sm">{formatBytes(previewImage.file_size)}</p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Pipeline</h4>
                    <p className="text-sm">{previewImage.pipeline_status}</p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Source</h4>
                    <p className="text-sm">{previewImage.source || "upload"}</p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Created</h4>
                    <p className="text-sm">{formatDate(previewImage.created_at)}</p>
                  </div>
                  {previewImage.alt_text && (
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-1">Alt Text</h4>
                      <p className="text-sm">{previewImage.alt_text}</p>
                    </div>
                  )}

                  <div className="pt-2 space-y-2">
                    <Button className="w-full" size="sm" onClick={() => copyUrl(previewImage)}>
                      <Copy className="h-4 w-4 mr-2" /> Copy URL
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full"
                      size="sm"
                      onClick={() => window.open(getImageUrl(previewImage), "_blank")}
                    >
                      <Download className="h-4 w-4 mr-2" /> Open Full Size
                    </Button>
                    {previewImage.status !== "approved" && (
                      <Button
                        variant="outline"
                        className="w-full"
                        size="sm"
                        onClick={() => { updateImageStatus([previewImage.id], "approved"); setPreviewImage(null); }}
                      >
                        <Check className="h-4 w-4 mr-2" /> Approve
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
