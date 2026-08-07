"use client";

/**
 * Ad Studio library — every generated ad creative, newest first.
 * The name IS the tracking key, so it's shown verbatim (mono) and
 * click-to-copy: what you paste into Meta Ads Manager must be exactly
 * this string.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Copy, Loader2, Megaphone, Plus, RefreshCw } from "lucide-react";

type Render = { ratio: string; status: string; url: string | null; posterUrl: string | null };
type Ad = {
  id: string;
  name: string;
  recipe: string;
  kind: string;
  status: string;
  talent: string;
  sku: string | null;
  product_name: string | null;
  created_at: string;
  renders: Render[];
};

const STATUS_CLS: Record<string, string> = {
  rendering: "bg-blue-100 text-blue-800 border-blue-300",
  ready: "bg-emerald-100 text-emerald-800 border-emerald-300",
  published: "bg-purple-100 text-purple-800 border-purple-300",
  failed: "bg-red-100 text-red-800 border-red-300",
  draft: "bg-muted text-muted-foreground border-border",
};

export default function AdsLibraryPage() {
  const [ads, setAds] = useState<Ad[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (search.trim()) qs.set("search", search.trim());
    fetch(`/api/v1/marketing/ads?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        setAds(d.ads ?? []);
        setTotal(d.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [status, search]);
  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  // Rendering ads resolve in the background — poll gently while any exist.
  useEffect(() => {
    if (!ads.some((a) => a.status === "rendering")) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [ads, load]);

  const anyRendering = useMemo(() => ads.some((a) => a.status === "rendering"), [ads]);

  const copyName = (name: string) => {
    navigator.clipboard.writeText(name);
    toast.success("Ad name copied — use it verbatim in Ads Manager");
  };

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link href="/marketing" />}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Marketing
        </Button>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Megaphone className="h-5 w-5" /> Ad Studio
        </h1>
        {anyRendering && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
        <div className="flex-1" />
        <Button render={<Link href="/marketing/ads/new" />}>
          <Plus className="h-4 w-4 mr-1" /> New ad
        </Button>
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {["", "rendering", "ready", "published", "failed"].map((s) => (
          <button
            key={s || "all"}
            onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              status === s ? "border-primary ring-1 ring-primary" : "hover:bg-muted"
            }`}
          >
            {s || `all (${total})`}
          </button>
        ))}
        <Input
          placeholder="Search names — JADE, PCARD, BLK…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 max-w-xs ml-auto"
        />
      </div>

      {loading && ads.length === 0 ? (
        <div className="h-96 animate-pulse rounded-lg bg-muted" />
      ) : ads.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            No ads yet.{" "}
            <Link href="/marketing/ads/new" className="underline">
              Make the first one
            </Link>{" "}
            — pick a clip, pick the product, and every Meta ratio renders itself.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {ads.map((ad) => {
            const poster = ad.renders.find((r) => r.posterUrl)?.posterUrl;
            return (
              <Link
                key={ad.id}
                href={`/marketing/ads/${ad.id}`}
                className="group overflow-hidden rounded-lg border transition hover:shadow-md"
              >
                <div className="relative aspect-[4/5] bg-muted">
                  {poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={poster} alt={ad.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      {ad.status === "rendering" ? <Loader2 className="h-6 w-6 animate-spin" /> : <Megaphone className="h-6 w-6" />}
                    </div>
                  )}
                  <span
                    className={`absolute left-1.5 top-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_CLS[ad.status] ?? STATUS_CLS.draft}`}
                  >
                    {ad.status}
                  </span>
                  <span className="absolute right-1.5 top-1.5 flex gap-1">
                    {ad.renders.map((r) => (
                      <span
                        key={r.ratio}
                        title={`${r.ratio}: ${r.status}`}
                        className={`rounded px-1 py-0.5 text-[9px] font-mono ${
                          r.status === "done"
                            ? "bg-emerald-600/90 text-white"
                            : r.status === "failed"
                              ? "bg-red-600/90 text-white"
                              : "bg-black/50 text-white"
                        }`}
                      >
                        {r.ratio}
                      </span>
                    ))}
                  </span>
                </div>
                <div className="space-y-1 p-2">
                  <div className="flex items-center gap-1">
                    <span className="truncate font-mono text-[10px]" title={ad.name}>
                      {ad.name}
                    </span>
                    <button
                      className="opacity-0 transition group-hover:opacity-100"
                      onClick={(e) => {
                        e.preventDefault();
                        copyName(ad.name);
                      }}
                      title="Copy ad name"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {ad.product_name ?? "—"} · {ad.talent}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
