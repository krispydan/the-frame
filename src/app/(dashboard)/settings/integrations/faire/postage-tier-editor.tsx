"use client";

/**
 * Postage-tier editor for the Faire integration page.
 *
 * Renders the configurable tier table that controls maker_cost_cents when
 * we POST shipments to Faire. Two-step UX:
 *   • Inline editing of dollars (we display+edit dollars; library stores
 *     cents).
 *   • Reset to defaults button — undoes any drift back to Daniel's
 *     specified $5 / $15 / $25 ladder.
 *
 * Server-side validation in /api/v1/integrations/faire/postage-tiers
 * mirrors the library validator, so anyone curl-ing the endpoint can't
 * sneak in a malformed config either.
 */

import { useEffect, useState } from "react";
import { Save, RotateCcw, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

interface PostageTier {
  maxOrderTotalCents: number | null;
  postageCents: number;
}

interface DraftTier {
  /** Order-total threshold as a dollar string ("50", "250"), or empty for catch-all. */
  maxDollars: string;
  /** Postage in dollars as a string ("5", "15"). */
  postageDollars: string;
}

function toDraft(t: PostageTier): DraftTier {
  return {
    maxDollars: t.maxOrderTotalCents == null ? "" : (t.maxOrderTotalCents / 100).toString(),
    postageDollars: (t.postageCents / 100).toString(),
  };
}

function fromDraft(d: DraftTier): PostageTier {
  const maxDollars = d.maxDollars.trim();
  const postageDollars = d.postageDollars.trim();
  return {
    maxOrderTotalCents: maxDollars === "" ? null : Math.round(Number(maxDollars) * 100),
    postageCents: Math.round(Number(postageDollars) * 100),
  };
}

export function PostageTierEditor() {
  const [draft, setDraft] = useState<DraftTier[] | null>(null);
  const [defaults, setDefaults] = useState<PostageTier[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/v1/integrations/faire/postage-tiers")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { tiers: PostageTier[]; defaults: PostageTier[] };
        setDraft(data.tiers.map(toDraft));
        setDefaults(data.defaults);
      })
      .catch((e) => {
        toast.error("Failed to load postage tiers", {
          description: e instanceof Error ? e.message : String(e),
        });
      });
  }, []);

  function update(i: number, patch: Partial<DraftTier>) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }
  function addTier() {
    setDraft((prev) => {
      if (!prev) return prev;
      // New tier goes BEFORE the catch-all (last row, empty maxDollars).
      const next = [...prev];
      const catchallIdx = next.findIndex((t) => t.maxDollars === "");
      const insertAt = catchallIdx >= 0 ? catchallIdx : next.length;
      next.splice(insertAt, 0, { maxDollars: "100", postageDollars: "10" });
      return next;
    });
  }
  function removeTier(i: number) {
    setDraft((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev));
  }
  function resetDefaults() {
    if (!defaults) return;
    if (!window.confirm("Reset postage tiers to the defaults ($5 / $15 / $25)?")) return;
    setDraft(defaults.map(toDraft));
  }

  async function save() {
    if (!draft) return;
    let tiers: PostageTier[];
    try {
      tiers = draft.map((d, i) => {
        const t = fromDraft(d);
        if (Number.isNaN(t.postageCents) || t.postageCents < 0) {
          throw new Error(`Row ${i + 1}: postage must be a non-negative number`);
        }
        if (t.maxOrderTotalCents !== null && (Number.isNaN(t.maxOrderTotalCents) || t.maxOrderTotalCents < 0)) {
          throw new Error(`Row ${i + 1}: order-total threshold must be a non-negative number`);
        }
        return t;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/v1/integrations/faire/postage-tiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tiers }),
      });
      const data = (await res.json()) as { ok: boolean; tiers?: PostageTier[]; error?: string };
      if (!data.ok) {
        toast.error("Save failed", { description: data.error });
      } else {
        toast.success("Postage tiers saved");
        if (data.tiers) setDraft(data.tiers.map(toDraft));
      }
    } catch (e) {
      toast.error("Save failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return <p className="text-sm text-muted-foreground">Loading tiers…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {draft.map((row, i) => {
          const isCatchall = row.maxDollars.trim() === "";
          return (
            <div key={i} className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[180px]">
                <Label htmlFor={`max-${i}`} className="text-xs">
                  {isCatchall ? "Everything else (catch-all)" : "Order total <"}
                </Label>
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    id={`max-${i}`}
                    type="number"
                    min="0"
                    step="1"
                    value={row.maxDollars}
                    onChange={(e) => update(i, { maxDollars: e.target.value })}
                    placeholder="leave blank for catch-all"
                    disabled={isCatchall && i === draft.length - 1}
                  />
                </div>
              </div>
              <div className="flex-1 min-w-[140px]">
                <Label htmlFor={`postage-${i}`} className="text-xs">
                  Postage we declare
                </Label>
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    id={`postage-${i}`}
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.postageDollars}
                    onChange={(e) => update(i, { postageDollars: e.target.value })}
                  />
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => removeTier(i)}
                disabled={draft.length <= 1}
                title="Remove tier"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 pt-2 border-t">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Save className="h-3 w-3 mr-1" />
          )}
          Save tiers
        </Button>
        <Button size="sm" variant="outline" onClick={addTier} disabled={saving}>
          <Plus className="h-3 w-3 mr-1" /> Add tier
        </Button>
        <Button size="sm" variant="outline" onClick={resetDefaults} disabled={saving}>
          <RotateCcw className="h-3 w-3 mr-1" /> Reset to defaults
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Tiers are evaluated top-to-bottom. The first row whose order-total threshold is greater than the order total wins. The last row should have an empty threshold (catch-all).
      </p>
    </div>
  );
}
