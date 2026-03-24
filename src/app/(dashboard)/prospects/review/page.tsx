"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import {
  Globe, Phone, Mail, MapPin, Star, Search, ExternalLink,
  CheckCircle, XCircle, SkipForward, ChevronLeft, ChevronRight,
  Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

interface Prospect {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  domain: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  source_type: string | null;
  source_query: string | null;
  category: string | null;
  segment: string | null;
  status: string;
  source: string | null;
  tags: string[];
}

interface PendingUpdate {
  id: string;
  status: string;
  disqualify_reason?: string;
}

function ReviewQueueInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // toast from sonner is used directly

  // Filters
  const [sourceType, setSourceType] = useState(searchParams.get("source_type") || "all");
  const [stateFilter, setStateFilter] = useState(searchParams.get("state") || "all");
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get("category") || "all");
  const [statusFilter, setStatusFilter] = useState(searchParams.get("status") || "new");
  const [sortBy, setSortBy] = useState(searchParams.get("sort") || "random");

  // Data
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const [allCount, setAllCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);

  // Batch updates queue
  const pendingUpdates = useRef<PendingUpdate[]>([]);
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Processed IDs (to skip already-reviewed in this session)
  const processedIds = useRef<Set<string>>(new Set());

  // Iframe state
  const [iframeError, setIframeError] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Filter options (fetched once)
  const [filterOptions, setFilterOptions] = useState<{
    sourceTypes: { source_type: string; count: number }[];
    states: { state: string; count: number }[];
    categories: { category: string; count: number }[];
  } | null>(null);

  // Swipe support
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // Fetch filter options
  useEffect(() => {
    fetch("/api/v1/sales/prospects/filters")
      .then(r => r.json())
      .then(data => setFilterOptions(data));
  }, []);

  // Fetch prospects
  const fetchProspects = useCallback(async (newOffset = 0, append = false) => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("limit", "20");
    params.set("offset", String(newOffset));
    if (sourceType !== "all") params.set("source_type", sourceType);
    if (stateFilter !== "all") params.append("state", stateFilter);
    if (categoryFilter !== "all") params.set("category", categoryFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    params.set("sort", sortBy);

    try {
      const res = await fetch(`/api/v1/prospects/review?${params}`);
      const data = await res.json();
      const filtered = data.data.filter((p: Prospect) => !processedIds.current.has(p.id));
      if (append) {
        setProspects(prev => [...prev, ...filtered]);
      } else {
        setProspects(filtered);
        setCurrentIndex(0);
      }
      setTotal(data.total);
      setReviewed(data.reviewed);
      setAllCount(data.allCount);
      setOffset(newOffset);
    } catch (e) {
      console.error("Failed to fetch prospects", e);
    } finally {
      setLoading(false);
    }
  }, [sourceType, stateFilter, categoryFilter, statusFilter, sortBy]);

  useEffect(() => {
    fetchProspects(0, false);
  }, [fetchProspects]);

  // Flush pending updates
  const flushUpdates = useCallback(async () => {
    if (pendingUpdates.current.length === 0) return;
    const updates = [...pendingUpdates.current];
    pendingUpdates.current = [];
    try {
      await fetch("/api/v1/prospects/review/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
    } catch (e) {
      console.error("Failed to flush updates", e);
      // Re-queue failed updates
      pendingUpdates.current.unshift(...updates);
    }
  }, []);

  // Auto-flush every 5 seconds
  useEffect(() => {
    flushTimer.current = setInterval(flushUpdates, 5000);
    return () => {
      if (flushTimer.current) clearInterval(flushTimer.current);
      // Flush on unmount
      flushUpdates();
    };
  }, [flushUpdates]);

  // Flush on page leave
  useEffect(() => {
    const handleBeforeUnload = () => flushUpdates();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [flushUpdates]);

  const current = prospects[currentIndex];
  const next = prospects[currentIndex + 1];

  // Prefetch more when running low
  useEffect(() => {
    if (prospects.length - currentIndex <= 3 && !loading && total > prospects.length) {
      fetchProspects(offset + 20, true);
    }
  }, [currentIndex, prospects.length, loading, total, offset, fetchProspects]);

  // Get website URL for iframe
  const getWebsiteUrl = (p: Prospect | undefined) => {
    if (!p) return null;
    if (p.website) {
      const url = p.website.startsWith("http") ? p.website : `https://${p.website}`;
      return url;
    }
    return `https://www.google.com/search?igu=1&q=${encodeURIComponent(`${p.name} ${p.city || ""} ${p.state || ""}`.trim())}`;
  };

  // Actions
  const doAction = useCallback((action: "qualified" | "rejected" | "skip") => {
    if (!current) return;

    const name = current.name;

    if (action !== "skip") {
      pendingUpdates.current.push({
        id: current.id,
        status: action,
      });
      processedIds.current.add(current.id);
      setReviewed(r => r + 1);
    }

    if (action === "qualified") {
      toast.success(`Qualified: ${name}`);
    } else if (action === "rejected") {
      toast.error(`Rejected: ${name}`);
    }

    // Advance
    setIframeError(false);
    if (action === "skip") {
      setCurrentIndex(i => i + 1);
    } else {
      // Remove from list and stay at same index (or advance)
      setProspects(prev => prev.filter(p => p.id !== current.id));
    }
  }, [current, toast]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

      switch (e.key.toLowerCase()) {
        case "a":
          doAction("qualified");
          break;
        case "r":
        case "d":
          doAction("rejected");
          break;
        case "s":
          doAction("skip");
          break;
        case "w":
          if (current?.website) {
            window.open(current.website.startsWith("http") ? current.website : `https://${current.website}`, "_blank");
          }
          break;
        case "g":
          if (current) {
            window.open(`https://www.google.com/search?q=${encodeURIComponent(`${current.name} ${current.city || ""} ${current.state || ""}`.trim())}`, "_blank");
          }
          break;
        case "m":
          if (current) {
            window.open(`https://www.google.com/maps/search/${encodeURIComponent(`${current.name} ${current.address || ""} ${current.city || ""} ${current.state || ""}`.trim())}`, "_blank");
          }
          break;
        case "arrowleft":
          if (currentIndex > 0) setCurrentIndex(i => i - 1);
          break;
        case "arrowright":
          doAction("skip");
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [doAction, current, currentIndex]);

  // Touch/swipe handling
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const dx = e.changedTouches[0].clientX - touchStart.current.x;
    const dy = e.changedTouches[0].clientY - touchStart.current.y;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 80) {
      if (dx > 0) doAction("qualified");
      else doAction("rejected");
    }
    touchStart.current = null;
  };

  const progressPercent = allCount > 0 ? Math.round((reviewed / allCount) * 100) : 0;

  // Star rating display
  const renderStars = (rating: number) => {
    const full = Math.floor(rating);
    const half = rating - full >= 0.5;
    return (
      <span className="flex items-center gap-0.5">
        {Array.from({ length: 5 }, (_, i) => (
          <Star
            key={i}
            className={`w-4 h-4 ${i < full ? "text-yellow-400 fill-yellow-400" : i === full && half ? "text-yellow-400 fill-yellow-400/50" : "text-gray-300"}`}
          />
        ))}
      </span>
    );
  };

  if (loading && prospects.length === 0) {
    return (
      <div className="flex items-center justify-center h-[80vh] text-gray-400">
        <div className="animate-spin w-6 h-6 border-2 border-gray-300 border-t-blue-600 rounded-full mr-3" />
        Loading review queue...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      {/* Top Filter Bar */}
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 flex flex-wrap items-center gap-3">
        <Filter className="w-4 h-4 text-gray-400" />

        <Select value={sourceType} onValueChange={v => setSourceType(v)}>
          <SelectTrigger className="w-[150px] h-9 text-sm">
            <SelectValue placeholder="Source Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            {filterOptions?.sourceTypes?.map(s => (
              <SelectItem key={s.source_type} value={s.source_type}>
                {s.source_type} ({s.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={stateFilter} onValueChange={v => setStateFilter(v)}>
          <SelectTrigger className="w-[130px] h-9 text-sm">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            {filterOptions?.states?.slice(0, 30).map(s => (
              <SelectItem key={s.state} value={s.state}>
                {s.state} ({s.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={categoryFilter} onValueChange={v => setCategoryFilter(v)}>
          <SelectTrigger className="w-[150px] h-9 text-sm">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {filterOptions?.categories?.map(c => (
              <SelectItem key={c.category} value={c.category}>
                {c.category} ({c.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={v => setStatusFilter(v)}>
          <SelectTrigger className="w-[120px] h-9 text-sm">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="contacted">Contacted</SelectItem>
            <SelectItem value="qualified">Qualified</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sortBy} onValueChange={v => setSortBy(v)}>
          <SelectTrigger className="w-[130px] h-9 text-sm">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="random">Random</SelectItem>
            <SelectItem value="name">Alphabetical</SelectItem>
            <SelectItem value="rating">By Rating</SelectItem>
            <SelectItem value="reviews">By Reviews</SelectItem>
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-gray-500">
            Reviewing <span className="font-semibold text-gray-900 dark:text-white">{total.toLocaleString()}</span> prospects
          </span>
          <div className="flex items-center gap-2 min-w-[200px]">
            <Progress value={progressPercent} className="h-2" />
            <span className="text-xs text-gray-400 whitespace-nowrap">{progressPercent}% reviewed</span>
          </div>
        </div>
      </div>

      {/* Main Content - Split Screen */}
      {!current ? (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          <div className="text-center">
            <CheckCircle className="w-12 h-12 mx-auto mb-3 text-green-400" />
            <p className="text-lg font-medium text-gray-600 dark:text-gray-300">All done!</p>
            <p className="text-sm mt-1">No more prospects to review with current filters.</p>
            <Button variant="outline" className="mt-4" onClick={() => router.push("/prospects")}>
              Back to Prospects
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
          {/* LEFT SIDE - Prospect Card */}
          <div className="w-full lg:w-[40%] border-r border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-gray-900">
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Business Name */}
              <div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white leading-tight">
                  {current.name}
                </h2>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {current.source_type && (
                    <Badge variant="secondary" className="capitalize text-xs">
                      {current.source_type}
                    </Badge>
                  )}
                  {current.category && (
                    <Badge variant="outline" className="text-xs">
                      {current.category}
                    </Badge>
                  )}
                  <Badge variant={current.status === "new" ? "default" : current.status === "qualified" ? "default" : "destructive"} className="text-xs">
                    {current.status}
                  </Badge>
                </div>
              </div>

              {/* Location */}
              {(current.address || current.city) && (
                <div className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
                  <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-gray-400" />
                  <span>
                    {[current.address, current.city, current.state, current.zip].filter(Boolean).join(", ")}
                  </span>
                </div>
              )}

              {/* Phone */}
              {current.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="w-4 h-4 text-gray-400" />
                  <a href={`tel:${current.phone}`} className="text-blue-600 hover:underline">
                    {current.phone}
                  </a>
                </div>
              )}

              {/* Email */}
              {current.email && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="w-4 h-4 text-gray-400" />
                  <a href={`mailto:${current.email}`} className="text-blue-600 hover:underline">
                    {current.email}
                  </a>
                </div>
              )}

              {/* Google Rating */}
              {current.google_rating != null && (
                <div className="flex items-center gap-2">
                  {renderStars(current.google_rating)}
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {current.google_rating}
                  </span>
                  {current.google_review_count != null && (
                    <span className="text-sm text-gray-400">
                      ({current.google_review_count.toLocaleString()} reviews)
                    </span>
                  )}
                </div>
              )}

              {/* Source Query / Segment */}
              {current.source_query && (
                <div className="text-sm text-gray-500">
                  <span className="text-gray-400">Source query:</span> {current.source_query}
                </div>
              )}
              {current.segment && (
                <div className="text-sm text-gray-500">
                  <span className="text-gray-400">Segment:</span> {current.segment}
                </div>
              )}

              {/* Tags */}
              {current.tags && current.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {current.tags.map(t => (
                    <Badge key={t} variant="outline" className="text-xs">{t}</Badge>
                  ))}
                </div>
              )}

              {/* Quick Action Links */}
              <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (current.website) {
                      window.open(current.website.startsWith("http") ? current.website : `https://${current.website}`, "_blank");
                    }
                  }}
                  disabled={!current.website}
                  title="Open Website (W)"
                >
                  <Globe className="w-4 h-4 mr-1" /> Website
                  <kbd className="ml-1.5 text-[10px] bg-gray-100 dark:bg-gray-700 px-1 rounded">W</kbd>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    window.open(`https://www.google.com/search?q=${encodeURIComponent(`${current.name} ${current.city || ""} ${current.state || ""}`.trim())}`, "_blank");
                  }}
                  title="Google It (G)"
                >
                  <Search className="w-4 h-4 mr-1" /> Google
                  <kbd className="ml-1.5 text-[10px] bg-gray-100 dark:bg-gray-700 px-1 rounded">G</kbd>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    window.open(`https://www.google.com/maps/search/${encodeURIComponent(`${current.name} ${current.address || ""} ${current.city || ""} ${current.state || ""}`.trim())}`, "_blank");
                  }}
                  title="Google Maps (M)"
                >
                  <MapPin className="w-4 h-4 mr-1" /> Maps
                  <kbd className="ml-1.5 text-[10px] bg-gray-100 dark:bg-gray-700 px-1 rounded">M</kbd>
                </Button>
              </div>
            </div>

            {/* Sticky Action Bar */}
            <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-6 py-4 flex items-center gap-3">
              <Button
                className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold"
                onClick={() => doAction("qualified")}
              >
                <CheckCircle className="w-4 h-4 mr-1.5" /> Qualify
                <kbd className="ml-2 text-[10px] bg-green-700/50 px-1 rounded">A</kbd>
              </Button>
              <Button
                variant="destructive"
                className="flex-1 font-semibold"
                onClick={() => doAction("rejected")}
              >
                <XCircle className="w-4 h-4 mr-1.5" /> Reject
                <kbd className="ml-2 text-[10px] bg-red-700/50 px-1 rounded">R</kbd>
              </Button>
              <Button
                variant="outline"
                className="font-semibold"
                onClick={() => doAction("skip")}
              >
                <SkipForward className="w-4 h-4 mr-1.5" /> Skip
                <kbd className="ml-2 text-[10px] bg-gray-200 dark:bg-gray-700 px-1 rounded">S</kbd>
              </Button>
            </div>
          </div>

          {/* RIGHT SIDE - Website iframe */}
          <div className="w-full lg:w-[60%] bg-gray-100 dark:bg-gray-950 relative">
            {iframeError ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
                <Globe className="w-10 h-10" />
                <p className="text-sm">This site can&apos;t be embedded</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const url = current.website
                      ? (current.website.startsWith("http") ? current.website : `https://${current.website}`)
                      : `https://www.google.com/search?q=${encodeURIComponent(`${current.name} ${current.city || ""} ${current.state || ""}`.trim())}`;
                    window.open(url, "_blank");
                  }}
                >
                  <ExternalLink className="w-4 h-4 mr-1.5" /> Open in New Tab
                </Button>
              </div>
            ) : (
              <>
                {/* Current iframe */}
                <iframe
                  ref={iframeRef}
                  key={current.id}
                  src={getWebsiteUrl(current) || "about:blank"}
                  className="w-full h-full border-0"
                  sandbox="allow-scripts allow-same-origin allow-popups"
                  onError={() => setIframeError(true)}
                  onLoad={(e) => {
                    // Try to detect X-Frame-Options blocks (limited detection)
                    try {
                      const iframe = e.currentTarget;
                      // If iframe loaded but content is empty/blocked, show fallback after a delay
                      setTimeout(() => {
                        try {
                          // This will throw if blocked by CSP/X-Frame-Options in some browsers
                          if (iframe.contentDocument?.body?.innerHTML === "") {
                            setIframeError(true);
                          }
                        } catch {
                          // Cross-origin — iframe loaded successfully
                        }
                      }, 2000);
                    } catch {
                      // Normal cross-origin behavior
                    }
                  }}
                />
                {/* Preload next prospect's website in hidden iframe */}
                {next && (
                  <iframe
                    key={`preload-${next.id}`}
                    src={getWebsiteUrl(next) || "about:blank"}
                    className="hidden"
                    sandbox="allow-scripts allow-same-origin"
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Keyboard shortcuts hint */}
      <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-4 py-1.5 flex items-center justify-center gap-6 text-[11px] text-gray-400">
        <span><kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded">A</kbd> Qualify</span>
        <span><kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded">R</kbd>/<kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded">D</kbd> Reject</span>
        <span><kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded">S</kbd> Skip</span>
        <span><kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded">W</kbd> Website</span>
        <span><kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded">G</kbd> Google</span>
        <span><kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded">M</kbd> Maps</span>
        <span><kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded">←</kbd>/<kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded">→</kbd> Navigate</span>
      </div>
    </div>
  );
}

export default function ReviewQueuePage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-400">Loading review queue...</div>}>
      <ReviewQueueInner />
    </Suspense>
  );
}
