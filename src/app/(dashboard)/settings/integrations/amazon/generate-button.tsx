"use client";

/**
 * Generate-listings button + dry-run preview for the Amazon settings page.
 *
 * Two-step UX (preview → confirm + run), same as the ShipHero slip-backfill
 * button. Defaults to batches of 5 since Claude Opus vision calls run
 * 30-90s each — that keeps every invocation well under Cloudflare's edge
 * timeout. Re-run until the toast reports `candidatesRemaining: 0`.
 */

import { useState } from "react";
import { Eye, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface GenerateResponse {
  ok: boolean;
  processed: number;
  candidatesRemaining: number;
  results: Array<{
    productId: string;
    productName: string | null;
    status: "ok" | "error";
    errors: string[];
    warnings: string[];
    persisted: boolean;
    title?: string;
  }>;
}

// One product per click. Opus vision averages 30-90s per product on a
// 5-8 image batch; Cloudflare drops the connection at ~100s. Earlier
// limits of 5 caused 524s — the server kept generating but the browser
// never saw the toast / page-reload. limit=1 keeps every call under
// the edge timeout so the operator gets immediate feedback on each
// generation.
async function callGenerate(opts: { dryRun: boolean; regenerate?: boolean }): Promise<GenerateResponse> {
  const res = await fetch("/api/v1/integrations/amazon/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dryRun: opts.dryRun,
      regenerate: !!opts.regenerate,
      limit: 1,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<GenerateResponse>;
}

export function GenerateListingsButtons() {
  const [busy, setBusy] = useState<"none" | "preview" | "run">("none");

  async function onPreview() {
    setBusy("preview");
    try {
      const result = await callGenerate({ dryRun: true });
      const ok = result.results.filter((r) => r.status === "ok").length;
      const err = result.results.filter((r) => r.status === "error").length;
      toast.message("Generation preview", {
        description: `${result.processed} processed in this dry-run batch (${ok} ok, ${err} errors). About ${result.candidatesRemaining} more products without a listing remain.`,
        duration: 14000,
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
        "Run AI listing generation on 1 product?\n\nClaude will look at the product's Shopify photos plus its tags + keyword research and write Amazon-ready title / 5 bullets / description / search keywords. Takes 30-90 seconds. Re-click to process the next product.",
      )
    ) {
      return;
    }
    setBusy("run");
    try {
      const result = await callGenerate({ dryRun: false });
      const ok = result.results.filter((r) => r.status === "ok").length;
      const err = result.results.filter((r) => r.status === "error").length;
      toast.success(`Generated ${ok} / ${result.processed}`, {
        description: `${err} errors. ${result.candidatesRemaining} products without a listing remain — click again to continue.`,
        duration: 15000,
      });
      window.location.reload();
    } catch (err) {
      toast.error("Generation failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy("none");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={onPreview} disabled={busy !== "none"}>
        <Eye className={`h-3 w-3 mr-1 ${busy === "preview" ? "animate-pulse" : ""}`} />
        Preview
      </Button>
      <Button size="sm" onClick={onRun} disabled={busy !== "none"}>
        <Sparkles className={`h-3 w-3 mr-1 ${busy === "run" ? "animate-pulse" : ""}`} />
        Generate next
      </Button>
    </div>
  );
}
