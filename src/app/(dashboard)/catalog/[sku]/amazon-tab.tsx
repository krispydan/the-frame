"use client";

/**
 * Amazon listing editor — embedded on the product detail page so the
 * operator can review and tighten Claude's draft before downloading the
 * spreadsheet. Loads from GET /api/v1/integrations/amazon/listings/:id,
 * saves via PATCH, and triggers a vision regeneration via the existing
 * /api/v1/integrations/amazon/generate endpoint (with productIds=[this]
 * + regenerate=true so it overwrites).
 *
 * Three states the panel can be in:
 *   - loading      : initial fetch in flight
 *   - missing      : no row in catalog_amazon_listings yet — empty
 *                    state with a "Generate now" button
 *   - present      : show all fields editable, Save (dirty-aware) +
 *                    Regenerate (always available)
 */

import { useEffect, useState, useCallback } from "react";
import { Sparkles, Save, RefreshCw, AlertTriangle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface AmazonListing {
  id: string;
  productId: string;
  amazonTitle: string | null;
  bulletPoint1: string | null;
  bulletPoint2: string | null;
  bulletPoint3: string | null;
  bulletPoint4: string | null;
  bulletPoint5: string | null;
  productDescription: string | null;
  genericKeywords: string | null;
  suggestedColorMap: string | null;
  suggestedLensMaterial: string | null;
  suggestedFrameMaterial: string | null;
  suggestedPolarization: string | null;
  suggestedItemShape: string | null;
  modelUsed: string | null;
  promptVersion: string | null;
  generatedAt: string | null;
  updatedAt: string | null;
}

const EDITABLE_KEYS = [
  "amazonTitle",
  "bulletPoint1", "bulletPoint2", "bulletPoint3", "bulletPoint4", "bulletPoint5",
  "productDescription",
  "genericKeywords",
  "suggestedColorMap",
  "suggestedLensMaterial",
  "suggestedFrameMaterial",
  "suggestedPolarization",
  "suggestedItemShape",
] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

/** Length budgets — soft, surfaced inline so the operator sees them. */
const SOFT_LIMITS: Partial<Record<EditableKey, number>> = {
  amazonTitle: 200,
  bulletPoint1: 500,
  bulletPoint2: 500,
  bulletPoint3: 500,
  bulletPoint4: 500,
  bulletPoint5: 500,
  productDescription: 2000,
  genericKeywords: 240,
};

export function AmazonListingTab({ productId }: { productId: string | null }) {
  const [listing, setListing] = useState<AmazonListing | null>(null);
  const [draft, setDraft] = useState<Partial<Record<EditableKey, string>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async () => {
    if (!productId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/integrations/amazon/listings/${productId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { listing: AmazonListing | null };
      setListing(data.listing);
      // Initialise the draft from the persisted row — keeps the form in
      // a "clean" state where Save is disabled until the operator edits.
      const next: Partial<Record<EditableKey, string>> = {};
      for (const k of EDITABLE_KEYS) {
        next[k] = data.listing?.[k] ?? "";
      }
      setDraft(next);
    } catch (e) {
      console.error("[amazon-tab] load failed:", e);
      toast.error("Failed to load Amazon listing", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (key: EditableKey, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const dirty = listing != null && EDITABLE_KEYS.some(
    (k) => (draft[k] ?? "") !== (listing[k] ?? ""),
  );

  async function onSave() {
    if (!productId || !dirty) return;
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      for (const k of EDITABLE_KEYS) {
        // Only send fields that actually changed.
        if ((draft[k] ?? "") !== (listing?.[k] ?? "")) {
          body[k] = draft[k] ?? "";
        }
      }
      const res = await fetch(`/api/v1/integrations/amazon/listings/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error("Save failed", { description: text || `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as { listing: AmazonListing };
      setListing(data.listing);
      toast.success("Listing saved");
    } catch (e) {
      toast.error("Save failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function onRegenerate() {
    if (!productId) return;
    if (!window.confirm(
      "Regenerate the Amazon listing with Claude vision?\n\nThis will overwrite the current draft (the previous version is saved to the audit log). Takes 30-90 seconds.",
    )) return;

    setRegenerating(true);
    try {
      const res = await fetch("/api/v1/integrations/amazon/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: [productId],
          limit: 1,
          regenerate: true,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error("Regenerate failed", { description: text || `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as {
        results: Array<{ status: "ok" | "error"; errors: string[]; warnings: string[]; title?: string }>;
      };
      const result = data.results[0];
      if (result?.status === "ok") {
        toast.success("Regenerated", {
          description: result.title ? `New title: ${result.title.slice(0, 80)}…` : undefined,
        });
      } else {
        toast.error("Regenerate had errors", {
          description: result?.errors?.join("; ") || "Unknown error",
        });
      }
      await load();
    } catch (e) {
      toast.error("Regenerate failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setRegenerating(false);
    }
  }

  if (!productId) {
    return <p className="text-sm text-muted-foreground">Loading product…</p>;
  }
  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading Amazon listing…</p>;
  }

  // Empty state — no AI copy generated yet.
  if (!listing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" />
            No Amazon listing yet
          </CardTitle>
          <CardDescription>
            Claude hasn&apos;t written copy for this product. Click below to
            generate from the product&apos;s photos + tags + keyword research.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" onClick={onRegenerate} disabled={regenerating}>
            <Sparkles className={`h-3 w-3 mr-1 ${regenerating ? "animate-pulse" : ""}`} />
            Generate now (30-90s)
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4" /> Amazon listing
              </CardTitle>
              <CardDescription className="mt-1">
                Edit AI-drafted copy. Save persists to the catalog; Regenerate replaces with a fresh vision pass.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" variant="outline" onClick={onRegenerate} disabled={regenerating || saving}>
                <RefreshCw className={`h-3 w-3 mr-1 ${regenerating ? "animate-spin" : ""}`} />
                Regenerate
              </Button>
              <Button size="sm" onClick={onSave} disabled={!dirty || saving || regenerating}>
                <Save className="h-3 w-3 mr-1" />
                Save
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <Field label="Generated" value={listing.generatedAt ? formatStamp(listing.generatedAt) : "—"} />
            <Field label="Last edit" value={listing.updatedAt ? formatStamp(listing.updatedAt) : "—"} />
            <Field label="Model" value={listing.modelUsed ?? "—"} />
            <Field label="Prompt version" value={listing.promptVersion ?? "—"} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Title + content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <EditableInput
            label="Title (item_name)"
            value={draft.amazonTitle ?? ""}
            onChange={(v) => update("amazonTitle", v)}
            softLimit={SOFT_LIMITS.amazonTitle}
            placeholder="Polarized Cat-Eye Sunglasses for Women — UV400 Vintage Acetate Frames | Jaxy"
          />
          {[1, 2, 3, 4, 5].map((n) => (
            <EditableTextarea
              key={n}
              label={`Bullet ${n}`}
              value={(draft[`bulletPoint${n}` as EditableKey] ?? "")}
              onChange={(v) => update(`bulletPoint${n}` as EditableKey, v)}
              softLimit={500}
              rows={2}
            />
          ))}
          <EditableTextarea
            label="Description (product_description)"
            value={draft.productDescription ?? ""}
            onChange={(v) => update("productDescription", v)}
            softLimit={SOFT_LIMITS.productDescription}
            rows={6}
          />
          <EditableTextarea
            label="Generic keywords (search terms, space-delimited)"
            value={draft.genericKeywords ?? ""}
            onChange={(v) => update("genericKeywords", v)}
            softLimit={SOFT_LIMITS.genericKeywords}
            rows={2}
            sub="Amazon caps at ~250 bytes. All lowercase, no commas."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Suggested classification</CardTitle>
          <CardDescription>
            AI&apos;s picks for Amazon&apos;s enum-validated columns. Edits are written verbatim — typos here will block the spreadsheet at validation time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <EditableInput
              label="Color map (lens_color_map)"
              value={draft.suggestedColorMap ?? ""}
              onChange={(v) => update("suggestedColorMap", v)}
              sub="Black, Brown, Gold, Multicolor, …"
            />
            <EditableInput
              label="Frame material (frame_material_type)"
              value={draft.suggestedFrameMaterial ?? ""}
              onChange={(v) => update("suggestedFrameMaterial", v)}
              sub="Plastic, Metal, Wood, Rubber"
            />
            <EditableInput
              label="Lens material (lens_material_type)"
              value={draft.suggestedLensMaterial ?? ""}
              onChange={(v) => update("suggestedLensMaterial", v)}
              sub="Polarized, Polycarbonate, Acrylic, …"
            />
            <EditableInput
              label="Polarization (polarization_type)"
              value={draft.suggestedPolarization ?? ""}
              onChange={(v) => update("suggestedPolarization", v)}
              sub="Polarized, Non-Polarized, Mirrored"
            />
            <EditableInput
              label="Item shape (item_shape)"
              value={draft.suggestedItemShape ?? ""}
              onChange={(v) => update("suggestedItemShape", v)}
              sub="Cat Eye, Round, Aviator, Rectangular, …"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Small atoms ─────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span>{label}:</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

function CharCount({ value, softLimit }: { value: string; softLimit?: number }) {
  if (!softLimit) return <span className="text-muted-foreground">{value.length} chars</span>;
  const over = value.length > softLimit;
  const close = !over && value.length > softLimit * 0.9;
  return (
    <Badge
      variant="outline"
      className={`text-[10px] font-mono ${over ? "border-red-500 text-red-600" : close ? "border-yellow-500 text-yellow-700" : "text-muted-foreground"}`}
    >
      {over && <AlertTriangle className="h-2.5 w-2.5 mr-1" />}
      {!over && <CheckCircle className="h-2.5 w-2.5 mr-1" />}
      {value.length} / {softLimit}
    </Badge>
  );
}

function EditableInput({
  label, value, onChange, softLimit, placeholder, sub,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  softLimit?: number;
  placeholder?: string;
  sub?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <CharCount value={value} softLimit={softLimit} />
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function EditableTextarea({
  label, value, onChange, softLimit, rows = 3, sub,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  softLimit?: number;
  rows?: number;
  sub?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <CharCount value={value} softLimit={softLimit} />
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="text-sm"
      />
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function formatStamp(iso: string): string {
  // Display in local time, second-precision is overkill.
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}
