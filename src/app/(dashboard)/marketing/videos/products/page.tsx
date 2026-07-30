"use client";

/**
 * Product video coverage — the worklist for the product-video programme.
 *
 * One row per parent frame: how much footage it has, whether any clip
 * actually shows the product, and therefore whether we can generate its
 * video today. Worst coverage first, because the gaps are the shot list.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Boxes, Check, Loader2, Pencil, RefreshCw, Sparkles } from "lucide-react";

type Type = { slug: string; name: string; count: number; isProductShot: boolean };
type Product = {
  productId: string;
  productName: string;
  skuPrefix: string | null;
  clipCount: number;
  productShotCount: number;
  totalSec: number;
  byType: Type[];
  status: "ready" | "thin" | "no_footage";
  gap: string | null;
};
type Report = {
  totalProducts: number;
  ready: number;
  thin: number;
  noFootage: number;
  productShotFlagMissing: boolean;
  products: Product[];
};

type ProductVideo = {
  productId: string;
  productName: string;
  status: "pending" | "rendering" | "ready" | "failed";
  videoUrl: string | null;
  posterUrl: string | null;
  durationSec: number | null;
  caption: string | null;
  approvedAt: string | null;
  error: string | null;
};

const STATUS: Record<Product["status"], { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  thin: { label: "Thin", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  no_footage: { label: "No footage", cls: "bg-red-100 text-red-800 border-red-300" },
};

export default function ProductCoveragePage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | Product["status"]>("all");
  const [search, setSearch] = useState("");

  const [videos, setVideos] = useState<Record<string, ProductVideo>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [batching, setBatching] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/v1/marketing/videos/product-coverage").then((r) => r.json()),
      fetch("/api/v1/marketing/videos/product-videos").then((r) => r.json()),
    ])
      .then(([cov, vid]) => {
        setReport(cov);
        const map: Record<string, ProductVideo> = {};
        for (const v of (vid.videos ?? []) as ProductVideo[]) map[v.productId] = v;
        setVideos(map);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  useEffect(() => load(), [load]);

  /** Build (or rebuild) one product's video. */
  const generate = async (productId: string) => {
    setBusy(productId);
    try {
      const res = await fetch("/api/v1/marketing/videos/product-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const d = await res.json();
      if (res.ok) {
        setVideos((prev) => ({ ...prev, [productId]: d.video }));
        toast.success("Product video ready");
      } else {
        toast.error(d.error ?? "Build failed");
      }
    } finally {
      setBusy(null);
    }
  };

  const generateAll = async () => {
    setBatching(true);
    const res = await fetch("/api/v1/marketing/videos/product-videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    const d = await res.json();
    setBatching(false);
    if (res.ok && d.queued) {
      toast.success(`Building ${d.total} product videos in the background — refresh to follow along.`, { duration: 8000 });
    } else {
      toast.message(d.message ?? d.error ?? "Nothing to build");
    }
  };

  const rows = useMemo(() => {
    if (!report) return [];
    const q = search.trim().toLowerCase();
    return report.products.filter(
      (p) => (filter === "all" || p.status === filter) && (!q || p.productName.toLowerCase().includes(q)),
    );
  }, [report, filter, search]);

  const pct = (n: number) => (report && report.totalProducts ? Math.round((n / report.totalProducts) * 100) : 0);

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/marketing/videos" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Studio
        </Button>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Boxes className="h-5 w-5" /> Product video coverage
        </h1>
        <div className="flex-1" />
        <Button onClick={generateAll} disabled={batching || !report?.ready}>
          <Sparkles className="h-4 w-4 mr-1" />
          {batching ? "Queuing…" : `Generate all ready${report?.ready ? ` (${report.ready})` : ""}`}
        </Button>
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {report?.productShotFlagMissing && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          No video type is marked <b>&ldquo;shows product&rdquo;</b> yet — using the built-in defaults. Set it per type in{" "}
          <Link href="/marketing/videos/clips" className="underline">Clip Library → Categories</Link> for accurate grading.
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { k: "all" as const, n: report?.totalProducts ?? 0, label: "products", cls: "" },
          { k: "ready" as const, n: report?.ready ?? 0, label: "ready to generate", cls: "text-emerald-700" },
          { k: "thin" as const, n: report?.thin ?? 0, label: "need a product shot", cls: "text-amber-700" },
          { k: "no_footage" as const, n: report?.noFootage ?? 0, label: "no footage", cls: "text-red-700" },
        ].map((c) => (
          <button
            key={c.k}
            onClick={() => setFilter(c.k)}
            className={`rounded-lg border p-3 text-left transition ${filter === c.k ? "border-primary ring-1 ring-primary" : "hover:bg-muted"}`}
          >
            <div className={`text-2xl font-bold tabular-nums ${c.cls}`}>{c.n}</div>
            <div className="text-xs text-muted-foreground">
              {c.label}
              {c.k !== "all" && report ? ` · ${pct(c.n)}%` : ""}
            </div>
          </button>
        ))}
      </div>

      <Input
        placeholder="Search products…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-9 max-w-xs"
      />

      {loading && !report ? (
        <div className="h-96 animate-pulse rounded-lg bg-muted" />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">No products match.</CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="p-2.5">Product</th>
                <th className="p-2.5">Status</th>
                <th className="p-2.5 text-right">Clips</th>
                <th className="p-2.5 text-right">Product shots</th>
                <th className="p-2.5 text-right">Footage</th>
                <th className="p-2.5">Video types</th>
                <th className="p-2.5">Gap</th>
                <th className="p-2.5 text-right">Video</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.productId} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="p-2.5 font-medium">{p.productName}</td>
                  <td className="p-2.5">
                    <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS[p.status].cls}`}>
                      {STATUS[p.status].label}
                    </span>
                  </td>
                  <td className="p-2.5 text-right tabular-nums">{p.clipCount}</td>
                  <td className={`p-2.5 text-right tabular-nums ${p.productShotCount === 0 ? "text-red-600 font-medium" : ""}`}>
                    {p.productShotCount}
                  </td>
                  <td className="p-2.5 text-right tabular-nums text-muted-foreground">{p.totalSec ? `${p.totalSec}s` : "—"}</td>
                  <td className="p-2.5">
                    <span className="flex flex-wrap gap-1">
                      {p.byType.slice(0, 4).map((t) => (
                        <span
                          key={t.slug}
                          title={t.isProductShot ? "shows the product" : "doesn't show the product"}
                          className={`rounded px-1.5 py-0.5 text-[10px] ${t.isProductShot ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}
                        >
                          {t.name} ×{t.count}
                        </span>
                      ))}
                      {p.byType.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                    </span>
                  </td>
                  <td className="p-2.5 text-xs text-muted-foreground">{p.gap ?? "—"}</td>
                  <td className="p-2.5 text-right">
                    {(() => {
                      const v = videos[p.productId];
                      if (v?.status === "ready") {
                        return (
                          <span className="flex items-center justify-end gap-1">
                            {v.approvedAt && (
                              <span title="Approved for publishing" className="text-emerald-600">
                                <Check className="h-4 w-4" />
                              </span>
                            )}
                            <Button size="sm" variant="outline" render={<Link href={`/marketing/videos/products/${p.productId}`} />}>
                              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                            </Button>
                          </span>
                        );
                      }
                      if (p.status !== "ready") return <span className="text-xs text-muted-foreground">—</span>;
                      return (
                        <Button size="sm" variant="secondary" disabled={busy === p.productId} onClick={() => generate(p.productId)}>
                          {busy === p.productId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Generate"}
                        </Button>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
