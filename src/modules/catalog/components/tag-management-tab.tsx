"use client";

import { useState, useEffect, useCallback } from "react";
import { Wand2, Plus, X, Tag, Zap, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { TAG_PRESETS } from "@/modules/catalog/lib/tag-presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type TagItem = { id: string; tagName: string | null; dimension: string | null; source: string | null };

// Dimension names match the actual catalog_tags data (camelCase). The
// previous list used snake_case keys (frame_shape / lens_type) which silently
// hid every curated camelCase tag from the UI. Source of truth: tag rows
// in prod, by descending row count.
const DIMENSIONS = [
  "frameShape", "style", "color", "materialFrame",
  "lens", "gender", "productType", "seasonal", "price", "other",
];

const DIMENSION_LABELS: Record<string, string> = {
  frameShape: "Frame Shape",
  style: "Style",
  color: "Color",
  materialFrame: "Material",
  lens: "Lens Type",
  gender: "Gender",
  productType: "Product Type",
  seasonal: "Season",
  price: "Price",
  other: "Other",
};

/** Fetch the best front image URL for a product's first SKU */
async function fetchProductThumb(productId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/v1/catalog/products/${productId}`);
    const data = await res.json();
    const skus = data.skus || [];
    if (skus.length === 0) return null;

    // Try to find an approved front image from any SKU
    const imgRes = await fetch(`/api/v1/media?productId=${productId}&status=approved&limit=1`);
    const imgData = await imgRes.json();
    if (imgData.images?.length > 0 && imgData.images[0].url) {
      return imgData.images[0].url;
    }

    // Fallback: try any image
    const anyRes = await fetch(`/api/v1/media?productId=${productId}&limit=1`);
    const anyData = await anyRes.json();
    if (anyData.images?.length > 0 && anyData.images[0].url) {
      return anyData.images[0].url;
    }
    return null;
  } catch {
    return null;
  }
}

export function TagManagementTab({
  productId, tags, onRefresh, productName, skuPrefix,
}: {
  productId: string;
  tags: TagItem[];
  onRefresh: () => void;
  productName?: string | null;
  skuPrefix?: string | null;
}) {
  const [newTag, setNewTag] = useState("");
  const [newDimension, setNewDimension] = useState("style");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<{ tagName: string; dimension: string }[]>([]);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    fetchProductThumb(productId).then(setThumbUrl);
  }, [productId]);

  const grouped = tags.reduce<Record<string, TagItem[]>>((acc, t) => {
    const dim = t.dimension || "other";
    if (!acc[dim]) acc[dim] = [];
    acc[dim].push(t);
    return acc;
  }, {});

  const handleAddTag = async () => {
    if (!newTag.trim()) return;
    await fetch("/api/v1/catalog/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, tagName: newTag.trim(), dimension: newDimension, source: "manual" }),
    });
    setNewTag("");
    onRefresh();
  };

  const handleDeleteTag = async (tagId: string) => {
    await fetch(`/api/v1/catalog/tags/${tagId}`, { method: "DELETE" });
    onRefresh();
  };

  const handleAddPreset = async (tagName: string, dimension: string) => {
    await fetch("/api/v1/catalog/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, tagName, dimension, source: "manual" }),
    });
    onRefresh();
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    try {
      const res = await fetch("/api/v1/catalog/tags/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const data = await res.json();
      setSuggestions(data.suggestions || []);
    } catch {
      alert("Tag suggestion failed");
    }
    setSuggesting(false);
  };

  const handleAcceptSuggestion = async (tagName: string, dimension: string) => {
    await fetch("/api/v1/catalog/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, tagName, dimension, source: "ai" }),
    });
    setSuggestions((prev) => prev.filter((s) => s.tagName !== tagName));
    onRefresh();
  };

  // Check which presets are already applied
  const existingTagNames = new Set(tags.map((t) => t.tagName?.toLowerCase()));

  return (
    <div className="space-y-6">
      {/* Product header with thumbnail */}
      <div className="flex items-start gap-5 bg-muted/30 rounded-lg p-4">
        {/* Thumbnail */}
        <div className="w-28 h-28 rounded-lg bg-white border overflow-hidden flex-shrink-0 flex items-center justify-center">
          {thumbUrl ? (
            <img src={thumbUrl} alt={productName || "Product"} className="w-full h-full object-contain p-1" />
          ) : (
            <Tag className="h-8 w-8 text-muted-foreground/30" />
          )}
        </div>

        {/* Product info + summary */}
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-lg truncate">{productName || skuPrefix || "Untitled Product"}</h3>
          <p className="text-sm text-muted-foreground">{skuPrefix}</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="outline" className="text-xs">
              {tags.length} tag{tags.length !== 1 ? "s" : ""}
            </Badge>
            {Object.keys(grouped).map((dim) => (
              <Badge key={dim} variant="secondary" className="text-[10px]">
                {DIMENSION_LABELS[dim] || dim}: {grouped[dim].length}
              </Badge>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <Button size="sm" variant="outline" onClick={handleSuggest} disabled={suggesting}>
              <Wand2 className="h-3 w-3 mr-1" /> {suggesting ? "Suggesting..." : "AI Suggest"}
            </Button>
          </div>
        </div>
      </div>

      {/* AI Suggestions banner */}
      {suggestions.length > 0 && (
        <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Wand2 className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-medium text-blue-900 dark:text-blue-100">AI Suggestions</span>
            <span className="text-xs text-blue-600">Click to add</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={`${s.dimension}-${s.tagName}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm
                  bg-white dark:bg-blue-900/50 border border-blue-200 dark:border-blue-700
                  hover:bg-blue-100 dark:hover:bg-blue-800/50 transition-colors cursor-pointer"
                onClick={() => handleAcceptSuggestion(s.tagName, s.dimension)}
              >
                <Plus className="h-3 w-3 text-blue-500" />
                <span>{s.tagName}</span>
                <span className="text-[10px] text-muted-foreground">
                  {DIMENSION_LABELS[s.dimension] || s.dimension}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tag dimensions - each as a row */}
      <div className="space-y-3">
        {DIMENSIONS.map((dim) => {
          const items = grouped[dim] || [];
          const presets = TAG_PRESETS[dim] || [];
          const availablePresets = presets.filter((p) => !existingTagNames.has(p.toLowerCase()));

          return (
            <div
              key={dim}
              className="flex items-start gap-4 py-3 px-4 rounded-lg border bg-card hover:bg-accent/5 transition-colors"
            >
              {/* Dimension label */}
              <div className="w-28 flex-shrink-0 pt-0.5">
                <span className="text-sm font-medium text-muted-foreground">
                  {DIMENSION_LABELS[dim] || dim}
                </span>
              </div>

              {/* Active tags + presets */}
              <div className="flex-1 flex flex-wrap items-center gap-1.5 min-h-[32px]">
                {/* Active tags */}
                {items.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm
                      bg-primary text-primary-foreground"
                  >
                    <Check className="h-3 w-3" />
                    {t.tagName}
                    <button
                      className="ml-0.5 hover:text-destructive-foreground/70 transition-colors"
                      onClick={() => handleDeleteTag(t.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}

                {/* Available presets as toggleable chips */}
                {availablePresets.map((preset) => (
                  <button
                    key={preset}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm
                      border border-dashed border-muted-foreground/30 text-muted-foreground
                      hover:border-primary/50 hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                    onClick={() => handleAddPreset(preset, dim)}
                  >
                    <Plus className="h-3 w-3" />
                    {preset}
                  </button>
                ))}

                {/* Empty state */}
                {items.length === 0 && availablePresets.length === 0 && (
                  <span className="text-xs text-muted-foreground/50 italic">No tags</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Custom tag input */}
      <div className="flex items-center gap-2 pt-2 border-t">
        <span className="text-sm text-muted-foreground whitespace-nowrap">Add custom:</span>
        <Select value={newDimension} onValueChange={(v) => v && setNewDimension(v)}>
          <SelectTrigger className="w-[140px] h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIMENSIONS.map((d) => (
              <SelectItem key={d} value={d}>{DIMENSION_LABELS[d] || d}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Tag name..."
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          className="max-w-[200px] h-8 text-sm"
          onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
        />
        <Button size="sm" variant="outline" className="h-8" onClick={handleAddTag} disabled={!newTag.trim()}>
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}
