"use client";

/**
 * Register-webhooks button — client island for the ShipHero settings page.
 *
 * POSTs to /api/v1/integrations/shiphero/register-webhooks. The route is
 * Phase 4 (not yet implemented); for now the button surfaces a friendly
 * "not yet implemented" message if the endpoint returns 404.
 */

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function RegisterWebhooksButton() {
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/integrations/shiphero/register-webhooks", {
        method: "POST",
      });
      if (res.status === 404) {
        toast.message("Phase 4 — not yet implemented", {
          description: "Run `npm run shiphero:register-webhooks` locally for now.",
        });
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        toast.error("Failed to register webhooks", { description: text || `HTTP ${res.status}` });
        return;
      }
      toast.success("Webhooks registered");
      // Reload so the subscriptions table re-queries.
      window.location.reload();
    } catch (err) {
      toast.error("Failed to register webhooks", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" onClick={onClick} disabled={busy}>
      <RefreshCw className={`h-3 w-3 mr-1 ${busy ? "animate-spin" : ""}`} />
      Register webhooks
    </Button>
  );
}
