"use client";

/**
 * Validate-batch button. POSTs to /api/v1/integrations/amazon/validate,
 * surfaces a toast summary + reloads so the page re-fetches the per-
 * product status table. No destructive action — no confirm dialog.
 */

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ValidateResponse {
  ok: boolean;
  productCount: number;
  summary: {
    ready: number;
    warning: number;
    blocked: number;
    missingListing: number;
    missingImages: number;
  };
}

export function ValidateButton() {
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/integrations/amazon/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error("Validation failed", { description: text || `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as ValidateResponse;
      const s = data.summary;
      const description = [
        `${s.ready} ready`,
        `${s.warning} warning`,
        `${s.blocked} blocked`,
        s.missingListing ? `${s.missingListing} need AI` : "",
        s.missingImages ? `${s.missingImages} no images` : "",
      ].filter(Boolean).join(" · ");
      if (s.blocked === 0) {
        toast.success(`Batch is releasable`, { description, duration: 12000 });
      } else {
        toast.warning(`${s.blocked} product${s.blocked === 1 ? "" : "s"} blocked`, {
          description,
          duration: 14000,
        });
      }
      window.location.reload();
    } catch (e) {
      toast.error("Validation failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={busy}>
      <ShieldCheck className={`h-3 w-3 mr-1 ${busy ? "animate-pulse" : ""}`} />
      Validate
    </Button>
  );
}
