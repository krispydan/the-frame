"use client";

/**
 * Backfill button + dry-run preview for Faire packing slips.
 *
 * Two-step UX so a destructive batch action is harder to misfire:
 *   1. "Preview backfill" → POSTs with dryRun=true. Shows the count of
 *      candidate orders pulled from ShipHero.
 *   2. "Run backfill" → POSTs with dryRun=false, surfaces a summary toast,
 *      reloads the page so the attachment audit card reflects the result.
 *
 * Endpoint: POST /api/v1/integrations/shiphero/backfill-faire-slips
 * Cookie session auth — the route is behind /settings, no public route
 * needed.
 */

import { useState } from "react";
import { Eye, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface BackfillResponse {
  ok: boolean;
  window: { since: string; until: string | null; unfulfilledOnly: boolean; dryRun: boolean };
  counts: {
    total: number;
    pulledFromShipHero: number;
    success: number;
    error: number;
    skipped_not_faire: number;
    skipped_no_slip: number;
    skipped_no_order_id: number;
  };
}

async function runBackfill(dryRun: boolean): Promise<BackfillResponse> {
  const res = await fetch("/api/v1/integrations/shiphero/backfill-faire-slips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun, unfulfilledOnly: true, sinceDays: 90 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<BackfillResponse>;
}

export function BackfillFaireSlipsButtons() {
  const [busy, setBusy] = useState<"none" | "preview" | "run">("none");

  async function onPreview() {
    setBusy("preview");
    try {
      const result = await runBackfill(true);
      toast.message("Backfill preview", {
        description: `${result.counts.total} unfulfilled orders in the last 90 days would be checked (of ${result.counts.pulledFromShipHero} total). Non-Faire orders are filtered out for free, so most of these will skip immediately.`,
        duration: 12000,
      });
    } catch (err) {
      toast.error("Preview failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy("none");
    }
  }

  async function onRun() {
    if (
      !window.confirm(
        "Run backfill?\n\nThis will scan all unfulfilled ShipHero orders from the last 90 days and attach Faire packing slips + set warehouse notes for any Faire-sourced orders that don't already have them. Idempotent — already-attached orders skip safely.",
      )
    ) {
      return;
    }
    setBusy("run");
    try {
      const result = await runBackfill(false);
      const c = result.counts;
      toast.success("Backfill complete", {
        description: `${c.success} attached, ${c.skipped_not_faire} non-Faire, ${c.skipped_no_slip} slip not ready, ${c.error} errors.`,
        duration: 15000,
      });
      // Reload so the attachment audit + recent events show the new rows.
      window.location.reload();
    } catch (err) {
      toast.error("Backfill failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy("none");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={onPreview}
        disabled={busy !== "none"}
      >
        <Eye className={`h-3 w-3 mr-1 ${busy === "preview" ? "animate-pulse" : ""}`} />
        Preview backfill
      </Button>
      <Button size="sm" onClick={onRun} disabled={busy !== "none"}>
        <Play className={`h-3 w-3 mr-1 ${busy === "run" ? "animate-pulse" : ""}`} />
        Run backfill
      </Button>
    </div>
  );
}
