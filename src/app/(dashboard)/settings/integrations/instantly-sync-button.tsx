"use client";

/**
 * "Sync campaigns from Instantly" button for the Instantly card on
 * /settings/integrations. Calls POST
 * /api/v1/integrations/instantly/sync-campaigns and surfaces the
 * upsert counts (created / updated / unchanged) via a toast.
 *
 * Distinct from the generic Test Connection button: this one actually
 * pulls + persists campaign rows so the StoreLeads "Push to Instantly"
 * dropdown has real options to choose from.
 */

import { useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface SyncResp {
  ok: boolean;
  isMock?: boolean;
  stats?: {
    fetched: number;
    created: number;
    updated: number;
    unchanged: number;
    errors: string[];
  };
  error?: string;
}

export function InstantlySyncButton() {
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/integrations/instantly/sync-campaigns", {
        method: "POST",
      });
      const data = (await res.json()) as SyncResp;
      if (!data.ok || !data.stats) {
        toast.error("Sync failed", { description: data.error });
        return;
      }
      if (data.isMock) {
        toast.message("No Instantly API key configured", {
          description:
            "Paste your key above and save first, or set INSTANTLY_API_KEY in Railway env. The sync ran in mock mode and pulled fake campaigns.",
          duration: 12000,
        });
      }
      toast.success("Synced campaigns from Instantly", {
        description: `${data.stats.fetched} fetched · ${data.stats.created} created · ${data.stats.updated} updated · ${data.stats.unchanged} unchanged${data.stats.errors.length ? ` · ${data.stats.errors.length} errors` : ""}`,
        duration: 12000,
      });
    } catch (e) {
      toast.error("Sync request failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={busy}>
      {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
      Sync campaigns
    </Button>
  );
}
