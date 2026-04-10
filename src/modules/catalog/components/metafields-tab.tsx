"use client";

import { useState, useCallback, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RefreshCw, Send, Save, Loader2 } from "lucide-react";

interface AiCategorization {
  seo: { title: string; description: string };
  category_metafields: {
    color_pattern: string[];
    eyewear_frame_color: string[];
    lens_color: string[];
    age_group: string;
    lens_polarization: string;
    target_gender: string;
    eyewear_frame_design: string;
  };
}

interface MetafieldsTabProps {
  productId: string;
  aiCategorization: string | null;
  aiCategorizedAt: string | null;
  aiCategorizationModel: string | null;
  onRefresh: () => void;
}

const METAFIELD_LABELS: Record<string, string> = {
  color_pattern: "Color/Pattern",
  eyewear_frame_color: "Frame Color",
  lens_color: "Lens Color",
  age_group: "Age Group",
  lens_polarization: "Lens Polarization",
  target_gender: "Target Gender",
  eyewear_frame_design: "Frame Design",
};

export function MetafieldsTab({
  productId,
  aiCategorization,
  aiCategorizedAt,
  aiCategorizationModel,
  onRefresh,
}: MetafieldsTabProps) {
  const [categorizing, setCategorizing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingSeo, setSavingSeo] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // Parse the JSON blob
  let parsed: AiCategorization | null = null;
  try {
    if (aiCategorization) parsed = JSON.parse(aiCategorization);
  } catch {
    /* invalid JSON — show "not categorized" */
  }

  const [seoTitle, setSeoTitle] = useState(parsed?.seo?.title ?? "");
  const [seoDescription, setSeoDescription] = useState(parsed?.seo?.description ?? "");

  // Keep SEO fields in sync when parent data changes
  useEffect(() => {
    let p: AiCategorization | null = null;
    try { if (aiCategorization) p = JSON.parse(aiCategorization); } catch { /* */ }
    setSeoTitle(p?.seo?.title ?? "");
    setSeoDescription(p?.seo?.description ?? "");
  }, [aiCategorization]);

  const handleRecategorize = async () => {
    setCategorizing(true);
    try {
      const res = await fetch("/api/v1/catalog/shopify-metafields-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: [productId],
          stores: [],
          dryRun: true,
          force: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncResult(`Error: ${data.error || res.statusText}`);
      } else {
        setSyncResult("Re-categorized. Refresh to see updated data.");
        onRefresh();
      }
    } catch (err) {
      setSyncResult(`Error: ${err instanceof Error ? err.message : "unknown"}`);
    }
    setCategorizing(false);
  };

  const handleSyncToShopify = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/v1/catalog/shopify-metafields-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: [productId],
          stores: ["dtc", "wholesale"],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncResult(`Sync error: ${data.error || res.statusText}`);
      } else {
        const results = data.results || [];
        const ok = results.filter((r: { status: string }) => r.status === "ok").length;
        const errs = results.filter((r: { status: string }) => r.status !== "ok").length;
        setSyncResult(`Synced: ${ok} success, ${errs} errors`);
        onRefresh();
      }
    } catch (err) {
      setSyncResult(`Error: ${err instanceof Error ? err.message : "unknown"}`);
    }
    setSyncing(false);
  };

  const handleSaveSeo = async () => {
    if (!parsed) return;
    setSavingSeo(true);
    const updated = {
      ...parsed,
      seo: { title: seoTitle, description: seoDescription },
    };
    await fetch(`/api/v1/catalog/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiCategorization: JSON.stringify(updated) }),
    });
    setSavingSeo(false);
    onRefresh();
  };

  const metafields = parsed?.category_metafields;

  return (
    <div className="space-y-4">
      {/* Status row */}
      <Card>
        <CardContent className="p-4 flex items-center justify-between">
          <div className="text-sm">
            {parsed ? (
              <span>
                Last categorized:{" "}
                <span className="font-medium">
                  {aiCategorizedAt
                    ? new Date(aiCategorizedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "unknown date"}
                </span>
                {aiCategorizationModel && (
                  <span className="text-muted-foreground"> by {aiCategorizationModel}</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">Not yet categorized</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleRecategorize}
              disabled={categorizing}
            >
              {categorizing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Re-categorize
            </Button>
            <Button
              size="sm"
              onClick={handleSyncToShopify}
              disabled={syncing || !parsed}
            >
              {syncing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Send className="h-3 w-3 mr-1" />
              )}
              Sync to Shopify
            </Button>
          </div>
        </CardContent>
      </Card>

      {syncResult && (
        <div className="text-sm px-1 text-muted-foreground">{syncResult}</div>
      )}

      {parsed && (
        <>
          {/* SEO */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">SEO</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Title</Label>
                <Input
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Description</Label>
                <Input
                  value={seoDescription}
                  onChange={(e) => setSeoDescription(e.target.value)}
                  className="h-8"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveSeo}
                disabled={savingSeo}
              >
                <Save className="h-3 w-3 mr-1" />
                Save SEO
              </Button>
            </CardContent>
          </Card>

          {/* Category metafields */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Shopify Category Metafields</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {metafields &&
                  Object.entries(metafields).map(([key, value]) => (
                    <div key={key} className="space-y-1.5">
                      <p className="text-xs text-muted-foreground font-medium">
                        {METAFIELD_LABELS[key] || key.replace(/_/g, " ")}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {Array.isArray(value) ? (
                          value.map((v) => (
                            <Badge key={v} variant="secondary" className="text-xs">
                              {v}
                            </Badge>
                          ))
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            {String(value)}
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
