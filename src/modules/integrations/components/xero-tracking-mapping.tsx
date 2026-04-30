"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

type Option = { optionId: string; name: string; status: string };
type Category = { categoryId: string; name: string; status: string; options: Option[] };

type Mapping = {
  platform: string;
  trackingCategoryId: string | null;
  trackingCategoryName: string | null;
  trackingOptionId: string | null;
  trackingOptionName: string | null;
};

const PLATFORM_LABELS: Record<string, string> = {
  shopify_dtc: "Shopify Retail (DTC)",
  shopify_afterpay: "Shopify Afterpay",
  shopify_wholesale: "Shopify Wholesale",
  faire: "Faire",
  amazon: "Amazon",
  tiktok_shop: "TikTok Shop",
};

/**
 * Tracking-category mapping per source platform. Each platform picks one
 * tracking option (e.g. shopify_dtc -> "Sales Channel: Shopify - Retail")
 * and Phase 2 attaches that option to every journal line so Xero P&L
 * reports split by channel.
 */
export function XeroTrackingMapping() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [mappings, setMappings] = useState<Mapping[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function loadCategories() {
    const res = await fetch("/api/v1/integrations/xero/tracking-categories");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data?.hint ? `${data.error || "Failed"} — ${data.hint}` : data?.error || "Failed to load tracking categories");
      setCategories([]);
      return;
    }
    setCategories(data.categories || []);
  }

  async function loadMappings() {
    const res = await fetch("/api/v1/integrations/xero/tracking-mappings");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error("Failed to load tracking mappings");
      setMappings([]);
      return;
    }
    setMappings(data.mappings || []);
  }

  useEffect(() => {
    Promise.all([loadCategories(), loadMappings()]).finally(() => setLoading(false));
  }, []);

  // Flatten every category's options so the user can pick across categories
  // (most users only have one category, but supporting multiple costs nothing).
  const flatOptions = (categories ?? []).flatMap((cat) =>
    cat.options.map((opt) => ({
      compositeKey: `${cat.categoryId}:${opt.optionId}`,
      categoryId: cat.categoryId,
      categoryName: cat.name,
      optionId: opt.optionId,
      optionName: opt.name,
    })),
  );

  function getMappingFor(platform: string): Mapping {
    return (
      mappings?.find((m) => m.platform === platform) ?? {
        platform,
        trackingCategoryId: null,
        trackingCategoryName: null,
        trackingOptionId: null,
        trackingOptionName: null,
      }
    );
  }

  function compositeKeyFor(m: Mapping): string {
    if (!m.trackingCategoryId || !m.trackingOptionId) return "__none__";
    return `${m.trackingCategoryId}:${m.trackingOptionId}`;
  }

  function updateMapping(platform: string, compositeKey: string) {
    const isClear = !compositeKey || compositeKey === "__none__";
    const flat = flatOptions.find((f) => f.compositeKey === compositeKey);
    setMappings((current) => {
      const list = current ?? [];
      const without = list.filter((m) => m.platform !== platform);
      const next: Mapping = isClear || !flat
        ? {
            platform,
            trackingCategoryId: null,
            trackingCategoryName: null,
            trackingOptionId: null,
            trackingOptionName: null,
          }
        : {
            platform,
            trackingCategoryId: flat.categoryId,
            trackingCategoryName: flat.categoryName,
            trackingOptionId: flat.optionId,
            trackingOptionName: flat.optionName,
          };
      return [...without, next];
    });
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/integrations/xero/tracking-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings: mappings ?? [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      toast.success(`Saved ${data.upserted} mapping${data.upserted === 1 ? "" : "s"}${data.cleared ? `, cleared ${data.cleared}` : ""}`);
      await loadMappings();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 inline animate-spin mr-2" />Loading tracking mappings...</CardContent>
      </Card>
    );
  }

  const noCategories = !categories || categories.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sales channel tracking</CardTitle>
        <CardDescription>
          Tag each manual journal line with a Xero tracking option so P&amp;L splits automatically by channel. Set up a tracking category in Xero first (e.g. &ldquo;Sales Channel&rdquo; with options for each platform), then map each platform here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs text-muted-foreground">
            {categories?.length ?? 0} active tracking categories,{" "}
            {flatOptions.length} options
          </div>
          <Button variant="ghost" size="sm" onClick={loadCategories}>
            <RefreshCw className="h-3 w-3 mr-1" />Refresh
          </Button>
        </div>

        {noCategories ? (
          <div className="text-sm text-muted-foreground py-4">
            No active tracking categories found in Xero. Create one in Xero (Accounting &gt; Tracking) — e.g. &ldquo;Sales Channel&rdquo; with options for Faire, Shopify - Retail, Shopify - Wholesale — then click Refresh.
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%]">Source platform</TableHead>
                  <TableHead>Tracking option</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.keys(PLATFORM_LABELS).map((platform) => {
                  const m = getMappingFor(platform);
                  return (
                    <TableRow key={platform}>
                      <TableCell className="font-medium">{PLATFORM_LABELS[platform]}</TableCell>
                      <TableCell>
                        <Select
                          value={compositeKeyFor(m)}
                          onValueChange={(v) => updateMapping(platform, v ?? "__none__")}
                        >
                          <SelectTrigger className="w-full max-w-md">
                            <SelectValue placeholder="Select tracking option..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">— Not mapped —</SelectItem>
                            {flatOptions.map((opt) => (
                              <SelectItem key={opt.compositeKey} value={opt.compositeKey}>
                                <span>{opt.categoryName}</span>
                                <span className="mx-2 text-muted-foreground">→</span>
                                <span className="font-medium">{opt.optionName}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="mt-3 flex justify-end">
              <Button onClick={save} disabled={saving}>
                <Save className="h-4 w-4 mr-2" />
                Save tracking mappings
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
