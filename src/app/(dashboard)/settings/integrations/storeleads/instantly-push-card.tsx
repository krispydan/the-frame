"use client";

/**
 * Score + push to Instantly card.
 *
 * Two distinct actions on the same workflow:
 *
 *   1. Score imported leads — runs the ICP classifier on every
 *      StoreLeads-sourced row that doesn't yet have an icp_score.
 *      Reuses the existing classifier with its 500-batch behaviour.
 *   2. Push to Instantly — pick a campaign + tiers, preview the count,
 *      then commit. Inserts campaign_leads rows + runs the Instantly
 *      sync so they ship in one call.
 *
 * Dedup guard: unique index on campaign_leads(campaign_id, company_id)
 * makes "push the same set twice" a safe no-op for the rows that
 * already moved.
 */

import { useEffect, useState } from "react";
import { Award, Send, Loader2, Eye, Sparkles, MailCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface Campaign {
  id: string;
  name: string;
  status: string;
  instantly_campaign_id: string | null;
  lead_count: number;
}

interface Pushable {
  campaignId: string;
  tiers: string[];
  /** Total candidates by score (before NeverBounce filter). */
  total: number;
  /** Verified valid+catchall — what Push actually moves. */
  pushable: number;
  /** Still need NeverBounce verification. */
  pendingVerification: number;
  /** NeverBounce ruled out (invalid/disposable/unknown/error). */
  ruledOut: number;
  perTier: Array<{ tier: string; c: number }>;
  sample: Array<{
    id: string;
    name: string | null;
    domain: string | null;
    email: string | null;
    icp_tier: string | null;
    icp_score: number | null;
    email_verification_status: string | null;
  }>;
}

interface VerifyResp {
  ok: boolean;
  verified: number;
  remaining: number;
  stats: {
    apiCallsMade: number;
    results: Record<string, number>;
    skippedFresh: number;
    skippedNoEmail: number;
    errors: Array<{ email: string; message: string }>;
  } | null;
  error?: string;
}

interface ScoreResult {
  ok: boolean;
  candidateCount: number;
  result?: { success: boolean; data?: unknown; error?: string };
  error?: string;
}

interface PushResult {
  ok: boolean;
  candidateCount: number;
  inserted: number;
  campaign?: { id: string; name: string };
  instantly?: { pushed: { campaigns: number; leads: number }; errors: string[] };
  error?: string;
}

const TIER_OPTIONS = ["A", "B", "C", "D"] as const;

export function InstantlyPushCard() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState<string>("");
  const [tiers, setTiers] = useState<string[]>(["A", "B"]);
  const [pushable, setPushable] = useState<Pushable | null>(null);
  const [loadingPushable, setLoadingPushable] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<{ verified: number; remaining: number } | null>(null);
  const [unscoredCount, setUnscoredCount] = useState<number | null>(null);

  useEffect(() => {
    void refreshCampaigns();
    void refreshUnscored();
  }, []);

  async function refreshCampaigns() {
    try {
      const res = await fetch("/api/v1/sales/campaigns?limit=100");
      const data = (await res.json()) as { data: Campaign[] };
      setCampaigns(data.data || []);
    } catch {
      /* surfaced via empty dropdown */
    }
  }

  async function refreshUnscored() {
    try {
      const res = await fetch("/api/v1/integrations/storeleads/score-imported", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      const d = (await res.json()) as { ok: boolean; candidateCount?: number };
      setUnscoredCount(d.candidateCount ?? 0);
    } catch {
      setUnscoredCount(null);
    }
  }

  async function refreshPushable() {
    if (!campaignId) return;
    setLoadingPushable(true);
    try {
      const qs = new URLSearchParams({ campaignId, tiers: tiers.join(",") });
      const res = await fetch(`/api/v1/integrations/storeleads/instantly-pushable?${qs}`);
      const data = (await res.json()) as Pushable;
      setPushable(data);
    } finally {
      setLoadingPushable(false);
    }
  }

  async function onScore() {
    setScoring(true);
    try {
      const res = await fetch("/api/v1/integrations/storeleads/score-imported", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 5000 }),
      });
      const data = (await res.json()) as ScoreResult;
      if (!data.ok) {
        toast.error("Scoring failed", { description: data.error });
        return;
      }
      toast.success(
        `Scored ${data.candidateCount} StoreLeads ${data.candidateCount === 1 ? "row" : "rows"}`,
        {
          description: data.result?.success
            ? "Open the prospects list filtered by source=storeleads to review tiers."
            : data.result?.error,
        },
      );
      void refreshUnscored();
      void refreshPushable();
    } finally {
      setScoring(false);
    }
  }

  /** Verify all pending emails for this campaign+tiers. Loops the
   *  endpoint until `remaining` hits 0 (each call is capped at 50 to
   *  fit under Cloudflare edge timeout). Refreshes the pushable
   *  preview between batches so the operator sees live progress. */
  async function onVerify() {
    if (!campaignId) {
      toast.error("Pick a campaign first");
      return;
    }
    setVerifying(true);
    setVerifyProgress(null);
    let totalVerified = 0;
    try {
      let loops = 0;
      // Hard ceiling on loops — defensive against an endpoint that always
      // returns remaining>0 (shouldn't happen but better than infinite).
      while (loops < 200) {
        const res = await fetch("/api/v1/integrations/storeleads/verify-pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId, tiers, limit: 50 }),
        });
        const data = (await res.json()) as VerifyResp;
        if (!data.ok) {
          toast.error("Verification failed", { description: data.error });
          break;
        }
        totalVerified += data.verified;
        setVerifyProgress({ verified: totalVerified, remaining: data.remaining });
        if (data.verified === 0 || data.remaining === 0) break;
        loops++;
      }
      toast.success(`Verified ${totalVerified} email${totalVerified === 1 ? "" : "s"}`, {
        description: "Refresh preview to see what's now push-eligible.",
        duration: 10000,
      });
      void refreshPushable();
    } finally {
      setVerifying(false);
    }
  }

  async function onPush() {
    if (!campaignId) {
      toast.error("Pick a campaign first");
      return;
    }
    if (!pushable || pushable.pushable === 0) {
      const hint = pushable && pushable.pendingVerification > 0
        ? `${pushable.pendingVerification} need NeverBounce verification — click Verify first.`
        : "No qualifying leads. Try widening the tier filter or scoring more rows.";
      toast.message("Nothing to push", { description: hint });
      return;
    }
    if (
      !window.confirm(
        `Push ${pushable.pushable.toLocaleString()} verified ${tiers.join("/")} StoreLeads lead${pushable.pushable === 1 ? "" : "s"} to "${campaigns.find((c) => c.id === campaignId)?.name}"? Already-pushed leads are skipped by the unique index, so re-runs are safe.`,
      )
    ) {
      return;
    }
    setPushing(true);
    try {
      const res = await fetch("/api/v1/integrations/storeleads/push-to-instantly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, tiers, limit: pushable.total }),
      });
      const data = (await res.json()) as PushResult;
      if (!data.ok) {
        toast.error("Push failed", { description: data.error });
        return;
      }
      toast.success("Pushed to Instantly", {
        description: `${data.inserted} queued · ${data.instantly?.pushed.leads ?? 0} delivered to Instantly · ${data.instantly?.errors.length ?? 0} sync errors`,
        duration: 15000,
      });
      void refreshPushable();
    } finally {
      setPushing(false);
    }
  }

  const eligibleCampaigns = campaigns.filter((c) => c.instantly_campaign_id);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4" />
          Score + push to Instantly
        </CardTitle>
        <CardDescription>
          Run the ICP classifier on newly-imported StoreLeads rows, then push the
          high-fit ones (tier A/B by default) into an Instantly campaign. Re-runs
          are safe — the unique index on campaign_leads(campaign_id, company_id)
          stops the same lead from being pushed twice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Score step */}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button variant="outline" onClick={onScore} disabled={scoring}>
            {scoring ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
            Score imported leads
          </Button>
          <span className="text-muted-foreground">
            {unscoredCount === null
              ? "…"
              : unscoredCount === 0
                ? "All StoreLeads rows already scored."
                : `${unscoredCount.toLocaleString()} StoreLeads ${unscoredCount === 1 ? "row" : "rows"} not yet scored.`}
          </span>
        </div>

        <hr className="border-muted" />

        {/* Push step — pick campaign + tiers */}
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs text-muted-foreground block mb-1">Instantly campaign</label>
              <select
                className="w-full border rounded px-2 py-1 text-sm bg-background"
                value={campaignId}
                onChange={(e) => {
                  setCampaignId(e.target.value);
                  setPushable(null);
                }}
              >
                <option value="">— pick a campaign —</option>
                {eligibleCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.lead_count} leads)
                  </option>
                ))}
              </select>
              {eligibleCampaigns.length === 0 && (
                <p className="text-xs text-yellow-600 mt-1">
                  No campaigns synced to Instantly yet. Create one in the sales
                  pipeline first, then push it via Sync once so it gets an
                  instantly_campaign_id.
                </p>
              )}
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">ICP tiers</label>
              <div className="flex gap-1">
                {TIER_OPTIONS.map((t) => {
                  const on = tiers.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        const next = on ? tiers.filter((x) => x !== t) : [...tiers, t];
                        setTiers(next);
                        setPushable(null);
                      }}
                      className={`px-2 py-1 text-xs rounded border ${
                        on ? "bg-primary text-primary-foreground border-primary" : "bg-background"
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
            <Button variant="outline" onClick={refreshPushable} disabled={!campaignId || loadingPushable}>
              {loadingPushable ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Eye className="h-4 w-4 mr-1" />}
              Preview
            </Button>
            <Button
              variant="outline"
              onClick={onVerify}
              disabled={!campaignId || verifying || pushing || !pushable || pushable.pendingVerification === 0}
              title={
                !pushable
                  ? "Preview first to see what needs verification"
                  : pushable.pendingVerification === 0
                    ? "All eligible emails already verified"
                    : `Verify ${pushable.pendingVerification} unverified emails via NeverBounce`
              }
            >
              {verifying ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <MailCheck className="h-4 w-4 mr-1" />}
              Verify {pushable ? `${pushable.pendingVerification}` : ""}
            </Button>
            <Button onClick={onPush} disabled={!pushable || pushable.pushable === 0 || pushing}>
              {pushing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
              Push {pushable ? `${pushable.pushable}` : ""}
            </Button>
          </div>

          {verifying && verifyProgress && (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Verifying… {verifyProgress.verified.toLocaleString()} done, {verifyProgress.remaining.toLocaleString()} remaining.
            </div>
          )}

          {pushable && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <Award className="h-3 w-3" />
                  <span className="font-medium">{pushable.total.toLocaleString()}</span>
                  <span className="text-muted-foreground">candidates by score</span>
                </span>
                <span className="flex items-center gap-1.5 text-green-700">
                  <span className="font-medium">{pushable.pushable.toLocaleString()}</span>
                  <span>verified — push-eligible</span>
                </span>
                {pushable.pendingVerification > 0 && (
                  <span className="flex items-center gap-1.5 text-yellow-700">
                    <span className="font-medium">{pushable.pendingVerification.toLocaleString()}</span>
                    <span>need verification</span>
                  </span>
                )}
                {pushable.ruledOut > 0 && (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="font-medium">{pushable.ruledOut.toLocaleString()}</span>
                    <span>ruled out by NeverBounce</span>
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-muted-foreground">By tier:</span>
                {pushable.perTier.map((pt) => (
                  <Badge key={pt.tier} variant="outline" className="text-xs">
                    {pt.tier}: {pt.c}
                  </Badge>
                ))}
              </div>
              {pushable.sample.length > 0 && (
                <div>
                  <div className="text-muted-foreground mb-1">Top 20 sample</div>
                  <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                    {pushable.sample.map((s) => (
                      <li key={s.id} className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">{s.icp_tier ?? "—"}</Badge>
                        {s.email_verification_status === "valid" || s.email_verification_status === "catchall" ? (
                          <Badge className="text-[10px] bg-green-600 hover:bg-green-700">{s.email_verification_status}</Badge>
                        ) : s.email_verification_status ? (
                          <Badge variant="outline" className="text-[10px] text-red-600 border-red-300">{s.email_verification_status}</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-yellow-700">unverified</Badge>
                        )}
                        <span className="font-mono">{s.domain || s.name}</span>
                        <span className="text-muted-foreground">{s.email}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
