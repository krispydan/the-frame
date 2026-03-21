"use client";

import { useEffect, useState } from "react";
import { ArrowUp, ArrowDown, Minus, Globe, Link2, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Keyword = {
  id: string;
  keyword: string;
  currentRank: number | null;
  previousRank: number | null;
  url: string | null;
  searchVolume: number | null;
};

type SeoData = {
  data: Keyword[];
  summary: { improving: number; declining: number; avgRank: number; totalKeywords: number };
  contentPerformance: { pageViews: number; organicTraffic: number; bounceRate: number; avgTimeOnPage: string };
  backlinks: { total: number; newThisMonth: number; dofollow: number };
};

export function SeoTab() {
  const [seo, setSeo] = useState<SeoData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/marketing/seo").then(r => r.json()).then(d => { setSeo(d); setLoading(false); });
  }, []);

  if (loading) return <div className="animate-pulse h-96 bg-muted rounded-lg" />;
  if (!seo) return null;

  const getRankChange = (curr: number | null, prev: number | null) => {
    if (!curr || !prev) return { icon: <Minus className="h-4 w-4" />, color: "text-gray-400", change: 0 };
    const diff = prev - curr;
    if (diff > 0) return { icon: <ArrowUp className="h-4 w-4" />, color: "text-green-600", change: diff };
    if (diff < 0) return { icon: <ArrowDown className="h-4 w-4" />, color: "text-red-600", change: diff };
    return { icon: <Minus className="h-4 w-4" />, color: "text-gray-400", change: 0 };
  };

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Globe className="h-4 w-4" />Avg Rank</div>
            <div className="text-3xl font-bold mt-1">#{seo.summary.avgRank}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><ArrowUp className="h-4 w-4 text-green-600" />Improving</div>
            <div className="text-3xl font-bold mt-1 text-green-600">{seo.summary.improving}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Eye className="h-4 w-4" />Page Views</div>
            <div className="text-3xl font-bold mt-1">{seo.contentPerformance.pageViews.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Link2 className="h-4 w-4" />Backlinks</div>
            <div className="text-3xl font-bold mt-1">{seo.backlinks.total}</div>
            <div className="text-xs text-green-600">+{seo.backlinks.newThisMonth} this month</div>
          </CardContent>
        </Card>
      </div>

      {/* Content Performance */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold">{seo.contentPerformance.organicTraffic.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">Organic Traffic</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold">{seo.contentPerformance.bounceRate}%</div>
            <div className="text-xs text-muted-foreground">Bounce Rate</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-2xl font-bold">{seo.contentPerformance.avgTimeOnPage}</div>
            <div className="text-xs text-muted-foreground">Avg Time on Page</div>
          </CardContent>
        </Card>
      </div>

      {/* Keyword Rankings Table */}
      <Card>
        <CardHeader><CardTitle>Keyword Rankings</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Keyword</TableHead>
                <TableHead className="text-right">Rank</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead>URL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {seo.data.map(kw => {
                const change = getRankChange(kw.currentRank, kw.previousRank);
                return (
                  <TableRow key={kw.id}>
                    <TableCell className="font-medium">{kw.keyword}</TableCell>
                    <TableCell className="text-right">#{kw.currentRank || "—"}</TableCell>
                    <TableCell className="text-right">
                      <span className={`flex items-center justify-end gap-1 ${change.color}`}>
                        {change.icon}
                        {change.change !== 0 && Math.abs(change.change)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{kw.searchVolume?.toLocaleString() || "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{kw.url || "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
