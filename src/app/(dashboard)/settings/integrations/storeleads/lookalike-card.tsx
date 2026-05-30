"use client";

/**
 * Lookalike-audience pipeline card. Three buttons:
 *
 *   1. Sync customer list — ships our customer domains to StoreLeads
 *      and enriches each one. Run this first; you only need to re-run
 *      it after new orders ship.
 *   2. Preview lookalikes — pure read; aggregates the enriched
 *      customer profile and runs the search with dryRun=true so you
 *      can see who'd be imported without committing.
 *   3. Generate + import lookalikes — same search, but actually
 *      upserts the results as new prospects.
 *
 * All three return rich JSON; this card surfaces the headline counters
 * + lets the operator drill in via console for the full payload.
 */

import { useState } from "react";
import { Users, Sparkles, Loader2, Eye, Wand2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface SyncStats {
  totalCustomers: number;
  storeleadsAccepted: number;
  storeleadsUnrecognized: string[];
  enriched: number;
  notFoundInStoreLeads: string[];
  errors: Array<{ domain: string; message: string }>;
  durationMs: number;
}

interface PreviewResp {
  ok: boolean;
  resultCount: number;
  profile: {
    totalCustomers: number;
    categories: Array<{ category: string; count: number }>;
    platforms: Array<{ platform: string; count: number }>;
    countries: Array<{ country: string; count: number }>;
  };
  perCategory: Array<{ category: string; count: number }>;
  effectiveFilters: Record<string, string | number>;
  durationMs: number;
}

interface RunResp extends PreviewResp {
  merge: { inspected: number; created: number; alreadyKnown: number; errors: number };
}

export function LookalikeCard() {
  const [syncing, setSyncing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [lastSync, setLastSync] = useState<SyncStats | null>(null);
  const [lastPreview, setLastPreview] = useState<PreviewResp | null>(null);

  async function onSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/v1/integrations/storeleads/sync-customer-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { ok: boolean; stats?: SyncStats; error?: string };
      if (!data.ok || !data.stats) {
        toast.error("Sync failed", { description: data.error });
        return;
      }
      setLastSync(data.stats);
      toast.success("Customer list synced", {
        description: `${data.stats.totalCustomers} customers · ${data.stats.enriched} enriched · ${data.stats.storeleadsUnrecognized.length} not in StoreLeads`,
      });
    } catch (e) {
      toast.error("Sync request failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSyncing(false);
    }
  }

  async function onPreview() {
    setPreviewing(true);
    try {
      const res = await fetch("/api/v1/integrations/storeleads/generate-lookalikes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true, maxResults: 200 }),
      });
      const data = (await res.json()) as PreviewResp & { error?: string };
      if (!data.ok) {
        toast.error("Preview failed", { description: data.error });
        return;
      }
      setLastPreview(data);
      toast.message("Lookalike preview", {
        description: `${data.resultCount} candidates from ${data.perCategory.length} categories. ${data.profile.totalCustomers} customers seeded the search.`,
        duration: 12000,
      });
    } catch (e) {
      toast.error("Preview request failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPreviewing(false);
    }
  }

  async function onGenerate() {
    if (!window.confirm("Import lookalike prospects into the CRM? They'll appear under source=storeleads with status='new'. Idempotent — already-known domains are skipped.")) {
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/v1/integrations/storeleads/generate-lookalikes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxResults: 500 }),
      });
      const data = (await res.json()) as RunResp & { error?: string };
      if (!data.ok) {
        toast.error("Lookalike generation failed", { description: data.error });
        return;
      }
      toast.success("Lookalikes imported", {
        description: `${data.merge.created} new prospects · ${data.merge.alreadyKnown} already known · ${data.merge.errors} errors`,
        duration: 15000,
      });
    } catch (e) {
      toast.error("Generation request failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          Customer lookalike audience
        </CardTitle>
        <CardDescription>
          Push our existing customers up to StoreLeads, learn their categories /
          platform / sales bands, then surface new prospects that match the
          same profile. Three-step pipeline (sync → preview → import). Run
          each whenever you want — they're idempotent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onSync} disabled={syncing || generating || previewing}>
            {syncing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Users className="h-4 w-4 mr-1" />}
            1. Sync customer list
          </Button>
          <Button variant="outline" onClick={onPreview} disabled={syncing || generating || previewing}>
            {previewing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Eye className="h-4 w-4 mr-1" />}
            2. Preview lookalikes
          </Button>
          <Button onClick={onGenerate} disabled={syncing || generating || previewing}>
            {generating ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Wand2 className="h-4 w-4 mr-1" />}
            3. Generate + import
          </Button>
        </div>

        {lastSync && (
          <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
            <div className="font-medium text-sm flex items-center gap-2">
              <Users className="h-3 w-3" /> Customer list sync
              <span className="text-muted-foreground font-normal">
                ({(lastSync.durationMs / 1000).toFixed(1)}s)
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Customers" value={lastSync.totalCustomers} />
              <Stat label="Accepted" value={lastSync.storeleadsAccepted} accent="green" />
              <Stat label="Enriched" value={lastSync.enriched} accent="blue" />
              <Stat
                label="Not in SL"
                value={lastSync.storeleadsUnrecognized.length + lastSync.notFoundInStoreLeads.length}
              />
            </div>
            {lastSync.errors.length > 0 && (
              <p className="text-xs text-red-600 mt-1">
                {lastSync.errors.length} errors (check browser console for details)
              </p>
            )}
          </div>
        )}

        {lastPreview && (
          <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-2">
            <div className="font-medium text-sm flex items-center gap-2">
              <Eye className="h-3 w-3" /> Lookalike preview
              <span className="text-muted-foreground font-normal">
                ({(lastPreview.durationMs / 1000).toFixed(1)}s)
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Customers seeded" value={lastPreview.profile.totalCustomers} />
              <Stat label="Candidate prospects" value={lastPreview.resultCount} accent="green" />
            </div>
            <div>
              <div className="text-muted-foreground mb-1">Filters sent to StoreLeads</div>
              <code className="block bg-background border rounded px-2 py-1">
                {JSON.stringify(lastPreview.effectiveFilters)}
              </code>
            </div>
            <div>
              <div className="text-muted-foreground mb-1">Per-category results</div>
              <div className="flex flex-wrap gap-1">
                {lastPreview.perCategory.map(({ category, count }) => (
                  <span key={category} className="font-mono bg-background border rounded px-1.5 py-0.5">
                    {category} <span className="text-muted-foreground">({count})</span>
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground mb-1">Top customer categories</div>
              <div className="flex flex-wrap gap-1">
                {lastPreview.profile.categories.slice(0, 6).map(({ category, count }) => (
                  <span key={category} className="font-mono bg-background border rounded px-1.5 py-0.5">
                    {category} <span className="text-muted-foreground">({count})</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "green" | "blue" }) {
  const color = accent === "green" ? "text-green-600" : accent === "blue" ? "text-blue-600" : "";
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className={`font-mono font-semibold ${color}`}>{value.toLocaleString()}</div>
    </div>
  );
}
