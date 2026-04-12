"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Image as ImageIcon,
  Search,
  LayoutGrid,
  List,
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
  Star,
  ZoomIn,
  ZoomOut,
  Keyboard,
  ExternalLink,
  RotateCw,
  Tag,
  ArrowLeft,
  ArrowRight,
  ThumbsUp,
  ThumbsDown,
  SkipForward,
  Maximize2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
        method: "PATCH",
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

      {/* ── Full-Screen Image Review Editor ── */}
      {previewImage && (
        <ImageReviewEditor
          images={images}
          initialImage={previewImage}
          onClose={() => setPreviewImage(null)}
          onStatusChange={(id, status) => {
            updateImageStatus([id], status);
          }}
          onDelete={(id) => {
            deleteImages([id]);
            setPreviewImage(null);
          }}
          onToggleBest={(id, isBest) => {
            fetch(`/api/v1/catalog/images/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isBest }),
            }).then(() => fetchImages());
          }}
          onNavigateEnd={() => {
            // When user hits the end of current page, load next page
            if (page < totalPages - 1) {
              setPage((p) => p + 1);
            }
          }}
          currentPage={page}
          totalImages={total}
          pageSize={PAGE_SIZE}
        />
      )}
    </div>
  );
}

// ── Image Review Editor (full-screen overlay) ──

interface ImageReviewEditorProps {
  images: MediaImage[];
  initialImage: MediaImage;
  onClose: () => void;
  onStatusChange: (id: string, status: string) => void;
  onDelete: (id: string) => void;
  onToggleBest: (id: string, isBest: boolean) => void;
  onNavigateEnd: () => void;
  currentPage: number;
  totalImages: number;
  pageSize: number;
}

function ImageReviewEditor({
  images,
  initialImage,
  onClose,
  onStatusChange,
  onDelete,
  onToggleBest,
  onNavigateEnd,
  currentPage,
  totalImages,
  pageSize,
}: ImageReviewEditorProps) {
  const [currentIndex, setCurrentIndex] = useState(() =>
    images.findIndex((img) => img.id === initialImage.id)
  );
  const [zoom, setZoom] = useState(1);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bgMode, setBgMode] = useState<"light" | "dark" | "checker">("light");
  const containerRef = useRef<HTMLDivElement>(null);

  const current = images[currentIndex] || initialImage;
  const globalIndex = currentPage * pageSize + currentIndex + 1;

  // Navigation
  const canPrev = currentIndex > 0;
  const canNext = currentIndex < images.length - 1;

  const goNext = useCallback(() => {
    if (canNext) {
      setCurrentIndex((i) => i + 1);
      setZoom(1);
    } else {
      onNavigateEnd();
    }
  }, [canNext, onNavigateEnd]);

  const goPrev = useCallback(() => {
    if (canPrev) {
      setCurrentIndex((i) => i - 1);
      setZoom(1);
    }
  }, [canPrev]);

  // Approve + advance
  const approveAndNext = useCallback(() => {
    onStatusChange(current.id, "approved");
    goNext();
  }, [current.id, onStatusChange, goNext]);

  const rejectAndNext = useCallback(() => {
    onStatusChange(current.id, "rejected");
    goNext();
  }, [current.id, onStatusChange, goNext]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't handle if user is in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case "ArrowRight":
        case "j":
          e.preventDefault();
          goNext();
          break;
        case "ArrowLeft":
        case "k":
          e.preventDefault();
          goPrev();
          break;
        case "a":
          e.preventDefault();
          onStatusChange(current.id, "approved");
          break;
        case "r":
          e.preventDefault();
          onStatusChange(current.id, "rejected");
          break;
        case "w":
          e.preventDefault();
          onStatusChange(current.id, "review");
          break;
        case "b":
          e.preventDefault();
          onToggleBest(current.id, current.is_best !== 1);
          break;
        case "f":
          e.preventDefault();
          approveAndNext();
          break;
        case "x":
          e.preventDefault();
          rejectAndNext();
          break;
        case "+":
        case "=":
          e.preventDefault();
          setZoom((z) => Math.min(z + 0.25, 4));
          break;
        case "-":
          e.preventDefault();
          setZoom((z) => Math.max(z - 0.25, 0.25));
          break;
        case "0":
          e.preventDefault();
          setZoom(1);
          break;
        case "c":
          e.preventDefault();
          navigator.clipboard.writeText(getImageUrl(current));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
          break;
        case "d":
          e.preventDefault();
          setBgMode((m) => m === "light" ? "dark" : m === "dark" ? "checker" : "light");
          break;
        case "?":
          e.preventDefault();
          setShowShortcuts((s) => !s);
          break;
        case "Escape":
          e.preventDefault();
          if (showShortcuts) setShowShortcuts(false);
          else onClose();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [current, goNext, goPrev, onStatusChange, onToggleBest, approveAndNext, rejectAndNext, onClose, showShortcuts]);

  // Focus container on mount
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const bgClass = bgMode === "dark"
    ? "bg-neutral-900"
    : bgMode === "checker"
    ? "bg-[length:20px_20px] bg-[image:linear-gradient(45deg,#e5e5e5_25%,transparent_25%,transparent_75%,#e5e5e5_75%),linear-gradient(45deg,#e5e5e5_25%,transparent_25%,transparent_75%,#e5e5e5_75%)] bg-[position:0_0,10px_10px] bg-white"
    : "bg-[#F8F9FA]";

  return (
    <TooltipProvider delay={300}>
      <div
        ref={containerRef}
        tabIndex={-1}
        className="fixed inset-0 z-50 bg-white flex flex-col outline-none"
      >
        {/* ── Top Bar ── */}
        <div className="flex items-center justify-between px-4 py-2 border-b bg-white shrink-0">
          {/* Left: close + nav */}
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-4 w-4 mr-1" /> Close
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger>
                  <Button variant="outline" size="sm" disabled={!canPrev} onClick={goPrev}>
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Previous (← or K)</TooltipContent>
              </Tooltip>
              <span className="text-sm text-muted-foreground px-2 min-w-[80px] text-center">
                {globalIndex} of {totalImages}
              </span>
              <Tooltip>
                <TooltipTrigger>
                  <Button variant="outline" size="sm" disabled={!canNext} onClick={goNext}>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Next (→ or J)</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Center: image info */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{current.sku}</span>
            {current.image_type_label && (
              <Badge variant="outline" className="text-xs">{current.image_type_label}</Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {SOURCE_LABELS[current.source] || current.source}
            </Badge>
            <Badge className={`text-xs ${statusColors[current.status] || ""}`}>
              {current.status}
            </Badge>
            {current.is_best === 1 && (
              <Badge className="bg-amber-500 text-white text-xs">
                <Star className="h-3 w-3 mr-0.5 fill-current" /> BEST
              </Badge>
            )}
          </div>

          {/* Right: tools */}
          <div className="flex items-center gap-1">
            {/* Zoom controls */}
            <Tooltip>
              <TooltipTrigger>
                <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))}>
                  <ZoomOut className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom Out (−)</TooltipContent>
            </Tooltip>
            <button
              className="text-xs text-muted-foreground hover:text-foreground px-1 min-w-[40px] text-center"
              onClick={() => setZoom(1)}
              title="Reset zoom (0)"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Tooltip>
              <TooltipTrigger>
                <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.min(z + 0.25, 4))}>
                  <ZoomIn className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom In (+)</TooltipContent>
            </Tooltip>

            <Separator orientation="vertical" className="h-6 mx-1" />

            {/* Background toggle */}
            <Tooltip>
              <TooltipTrigger>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setBgMode((m) => m === "light" ? "dark" : m === "dark" ? "checker" : "light")}
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Toggle Background (D)</TooltipContent>
            </Tooltip>

            {/* Keyboard shortcuts help */}
            <Tooltip>
              <TooltipTrigger>
                <Button variant="ghost" size="sm" onClick={() => setShowShortcuts((s) => !s)}>
                  <Keyboard className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Shortcuts (?)</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* ── Main Content ── */}
        <div className="flex-1 flex min-h-0">
          {/* ── Image Area ── */}
          <div className="flex-1 flex items-center justify-center overflow-auto relative">
            {/* Prev overlay button */}
            {canPrev && (
              <button
                onClick={goPrev}
                className="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/20 hover:bg-black/40 text-white flex items-center justify-center transition-colors"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}

            <div className={`w-full h-full flex items-center justify-center ${bgClass} overflow-auto`}>
              <img
                src={getImageUrl(current)}
                alt={current.alt_text || current.sku}
                className="max-w-full max-h-full object-contain transition-transform duration-200"
                style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
                draggable={false}
              />
            </div>

            {/* Next overlay button */}
            {canNext && (
              <button
                onClick={goNext}
                className="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/20 hover:bg-black/40 text-white flex items-center justify-center transition-colors"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            )}
          </div>

          {/* ── Right Sidebar ── */}
          <div className="w-[320px] border-l bg-white flex flex-col shrink-0 overflow-y-auto">
            {/* Quick Actions */}
            <div className="p-4 space-y-2 border-b">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Quick Actions</h3>

              <div className="grid grid-cols-2 gap-2">
                <Tooltip>
                  <TooltipTrigger>
                    <Button
                      size="sm"
                      className={`w-full ${current.status === "approved" ? "bg-green-600 hover:bg-green-700 text-white" : ""}`}
                      variant={current.status === "approved" ? "default" : "outline"}
                      onClick={() => onStatusChange(current.id, "approved")}
                    >
                      <ThumbsUp className="h-3.5 w-3.5 mr-1.5" /> Approve
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Approve (A)</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger>
                    <Button
                      size="sm"
                      className={`w-full ${current.status === "rejected" ? "bg-red-600 hover:bg-red-700 text-white" : ""}`}
                      variant={current.status === "rejected" ? "default" : "outline"}
                      onClick={() => onStatusChange(current.id, "rejected")}
                    >
                      <ThumbsDown className="h-3.5 w-3.5 mr-1.5" /> Reject
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reject (R)</TooltipContent>
                </Tooltip>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Tooltip>
                  <TooltipTrigger>
                    <Button
                      size="sm"
                      variant="outline"
                      className={`w-full ${current.status === "review" ? "border-yellow-400 bg-yellow-50" : ""}`}
                      onClick={() => onStatusChange(current.id, "review")}
                    >
                      <Eye className="h-3.5 w-3.5 mr-1.5" /> Review
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Send to Review (W)</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger>
                    <Button
                      size="sm"
                      variant="outline"
                      className={`w-full ${current.is_best === 1 ? "border-amber-400 bg-amber-50" : ""}`}
                      onClick={() => onToggleBest(current.id, current.is_best !== 1)}
                    >
                      <Star className={`h-3.5 w-3.5 mr-1.5 ${current.is_best === 1 ? "fill-amber-500 text-amber-500" : ""}`} />
                      {current.is_best === 1 ? "Unset Best" : "Set Best"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Toggle Best (B)</TooltipContent>
                </Tooltip>
              </div>

              <Separator className="my-2" />

              {/* Approve + Next / Reject + Next */}
              <div className="grid grid-cols-2 gap-2">
                <Tooltip>
                  <TooltipTrigger>
                    <Button size="sm" className="w-full bg-green-600 hover:bg-green-700 text-white" onClick={approveAndNext}>
                      <Check className="h-3.5 w-3.5 mr-1" /> Approve + Next
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Approve &amp; Next (F)</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger>
                    <Button size="sm" variant="destructive" className="w-full" onClick={rejectAndNext}>
                      <X className="h-3.5 w-3.5 mr-1" /> Reject + Next
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reject &amp; Next (X)</TooltipContent>
                </Tooltip>
              </div>

              <Tooltip>
                <TooltipTrigger>
                  <Button size="sm" variant="outline" className="w-full" onClick={goNext} disabled={!canNext}>
                    <SkipForward className="h-3.5 w-3.5 mr-1.5" /> Skip
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Skip to Next (→)</TooltipContent>
              </Tooltip>
            </div>

            {/* Image Details */}
            <div className="p-4 space-y-3 border-b">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Details</h3>

              <div className="grid grid-cols-2 gap-y-2.5 gap-x-4 text-sm">
                <div>
                  <span className="text-muted-foreground text-xs">Product</span>
                  <p className="font-medium truncate">{current.sku_prefix}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">SKU</span>
                  <p className="font-medium">{current.sku}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Color</span>
                  <p className="font-medium">{current.color_name || "—"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Angle</span>
                  <p className="font-medium">{current.image_type_label || "—"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Dimensions</span>
                  <p className="font-medium">{current.width && current.height ? `${current.width} × ${current.height}` : "—"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">File Size</span>
                  <p className="font-medium">{formatBytes(current.file_size)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Format</span>
                  <p className="font-medium">{current.mime_type?.split("/")[1]?.toUpperCase() || "—"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Pipeline</span>
                  <p className="font-medium">{current.pipeline_status}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Source</span>
                  <p className="font-medium">{SOURCE_LABELS[current.source] || current.source || "upload"}</p>
                </div>
                <div>
                  <span className="text-muted-foreground text-xs">Created</span>
                  <p className="font-medium">{formatDate(current.created_at)}</p>
                </div>
              </div>

              {current.product_name && (
                <div className="text-sm">
                  <span className="text-muted-foreground text-xs">Product Name</span>
                  <p className="font-medium">{current.product_name}</p>
                </div>
              )}

              {current.alt_text && (
                <div className="text-sm">
                  <span className="text-muted-foreground text-xs">Alt Text</span>
                  <p className="font-medium">{current.alt_text}</p>
                </div>
              )}
            </div>

            {/* File Actions */}
            <div className="p-4 space-y-2 border-b">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">File Actions</h3>

              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  navigator.clipboard.writeText(getImageUrl(current));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Copy className="h-3.5 w-3.5 mr-2" />
                {copied ? "Copied!" : "Copy URL"}
                <kbd className="ml-auto text-[10px] bg-muted px-1.5 py-0.5 rounded">C</kbd>
              </Button>

              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => window.open(getImageUrl(current), "_blank")}
              >
                <ExternalLink className="h-3.5 w-3.5 mr-2" /> Open Full Size
              </Button>

              <a
                href={getImageUrl(current)}
                download={`${current.sku}-${current.image_type_slug || "image"}-${current.source}.${current.mime_type?.split("/")[1] || "jpg"}`}
                className="inline-flex items-center justify-start w-full"
              >
                <Button variant="outline" size="sm" className="w-full justify-start">
                  <Download className="h-3.5 w-3.5 mr-2" /> Download
                </Button>
              </a>
            </div>

            {/* Danger Zone */}
            <div className="p-4 mt-auto">
              <Button
                variant="outline"
                size="sm"
                className="w-full text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                onClick={() => onDelete(current.id)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete Image
              </Button>
            </div>
          </div>
        </div>

        {/* ── Keyboard Shortcuts Overlay ── */}
        {showShortcuts && (
          <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center" onClick={() => setShowShortcuts(false)}>
            <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Keyboard Shortcuts</h3>
                <Button variant="ghost" size="sm" onClick={() => setShowShortcuts(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-3">
                <ShortcutSection title="Navigation">
                  <ShortcutRow keys={["←", "K"]} label="Previous image" />
                  <ShortcutRow keys={["→", "J"]} label="Next image" />
                  <ShortcutRow keys={["Esc"]} label="Close editor" />
                </ShortcutSection>
                <ShortcutSection title="Review">
                  <ShortcutRow keys={["A"]} label="Approve" />
                  <ShortcutRow keys={["R"]} label="Reject" />
                  <ShortcutRow keys={["W"]} label="Send to review" />
                  <ShortcutRow keys={["B"]} label="Toggle best" />
                  <ShortcutRow keys={["F"]} label="Approve + next" />
                  <ShortcutRow keys={["X"]} label="Reject + next" />
                </ShortcutSection>
                <ShortcutSection title="View">
                  <ShortcutRow keys={["+", "="]} label="Zoom in" />
                  <ShortcutRow keys={["−"]} label="Zoom out" />
                  <ShortcutRow keys={["0"]} label="Reset zoom" />
                  <ShortcutRow keys={["D"]} label="Toggle background" />
                </ShortcutSection>
                <ShortcutSection title="Other">
                  <ShortcutRow keys={["C"]} label="Copy URL" />
                  <ShortcutRow keys={["?"]} label="Toggle shortcuts" />
                </ShortcutSection>
              </div>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}

function ShortcutSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">{title}</h4>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        {keys.map((key, i) => (
          <span key={i}>
            {i > 0 && <span className="text-muted-foreground text-xs mx-0.5">/</span>}
            <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-xs font-medium bg-muted border rounded">
              {key}
            </kbd>
          </span>
        ))}
      </div>
    </div>
  );
}
