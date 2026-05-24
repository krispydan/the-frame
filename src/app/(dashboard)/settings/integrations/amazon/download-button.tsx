"use client";

/**
 * Download-spreadsheet button. Issues a GET so the browser handles the
 * file save dialog natively. We do a HEAD-style fetch first to check
 * whether the validate-gate is open — if the server returns 422 we
 * surface the blocked count rather than letting the browser show a
 * useless empty download.
 *
 * The `disabled` prop is driven by the page: when validation results
 * include any blocked product, the page passes disabled=true so the
 * button is grey + tooltip-y.
 */

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function DownloadButton({ disabled }: { disabled: boolean }) {
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (disabled) return;
    setBusy(true);
    try {
      // Probe with a GET — if the server short-circuits with 422 we show
      // the reason. On 200 we still have to use a real navigation so the
      // browser actually saves the file; we trigger that via a hidden
      // anchor click.
      const res = await fetch("/api/v1/integrations/amazon/download");
      if (res.status === 422) {
        const data = await res.json().catch(() => null) as { blockedProducts?: number; error?: string } | null;
        toast.error("Download blocked by validation", {
          description: data?.blockedProducts != null
            ? `${data.blockedProducts} product${data.blockedProducts === 1 ? "" : "s"} blocked. Click Validate to see details.`
            : data?.error || "Validation failed",
        });
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error("Download failed", { description: text || `HTTP ${res.status}` });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `jaxy_amazon_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Spreadsheet downloaded");
    } catch (e) {
      toast.error("Download failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" onClick={onClick} disabled={disabled || busy} title={disabled ? "Resolve blocked validation issues first" : undefined}>
      <Download className={`h-3 w-3 mr-1 ${busy ? "animate-pulse" : ""}`} />
      Download spreadsheet
    </Button>
  );
}
