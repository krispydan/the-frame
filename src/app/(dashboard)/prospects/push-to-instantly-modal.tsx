"use client";

/**
 * Modal that drives the full "verify → push to Instantly" workflow for
 * an arbitrary selection of prospects. Opened from the bulk-action bar
 * on /prospects.
 *
 * Flow on open:
 *   1. Load campaigns (only those synced to Instantly)
 *   2. Load preview via /preview-by-ids — counters + a 20-row sample
 *   3. Operator picks a campaign
 *   4. If `pendingVerification > 0`, Verify loops /verify-by-ids in
 *      50-row batches until `remaining` hits 0
 *   5. Push hits /push-by-ids and reports the result
 *
 * Selected/passed companyIds is the only filter — the modal trusts the
 * caller (the prospects list page) to have already applied tier, source,
 * status, etc. filters before opening. This keeps the modal simple +
 * reusable from anywhere we want to push a set of prospects.
 */

import { useEffect, useState } from "react";
import { X, Loader2, Send, MailCheck, Award } from "lucide-react";
import { toast } from "sonner";

interface Campaign {
  id: string;
  name: string;
  status: string;
  instantly_campaign_id: string | null;
}

interface Preview {
  selected: number;
  eligible: number;
  pushable: number;
  pendingVerification: number;
  ruledOut: number;
  alreadyOnInstantly: number;
  alreadyInCampaign: number;
  sample: Array<{
    id: string;
    name: string | null;
    domain: string | null;
    email: string | null;
    icp_tier: string | null;
    icp_score: number | null;
    email_verification_status: string | null;
    source_type: string | null;
  }>;
}

interface VerifyResp {
  ok: boolean;
  verified: number;
  remaining: number;
  error?: string;
}

interface PushResp {
  ok: boolean;
  campaign?: { id: string; name: string };
  candidateCount?: number;
  inserted?: number;
  instantly?: { pushed?: { leads: number }; errors?: string[] };
  error?: string;
}

interface Props {
  companyIds: string[];
  onClose: () => void;
  onPushed?: () => void;
}

export function PushToInstantlyModal({ companyIds, onClose, onPushed }: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<{ verified: number; remaining: number } | null>(null);
  const [pushing, setPushing] = useState(false);

  // Load campaigns once on mount.
  useEffect(() => {
    fetch("/api/v1/sales/campaigns?limit=100")
      .then((r) => r.json())
      .then((d: { data: Campaign[] }) => setCampaigns(d.data || []))
      .catch(() => setCampaigns([]));
  }, []);

  // Refresh the preview whenever campaign changes (or on first
  // selection).
  useEffect(() => {
    if (!campaignId) return;
    void refreshPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  async function refreshPreview() {
    if (!campaignId) return;
    setLoadingPreview(true);
    try {
      const res = await fetch("/api/v1/integrations/instantly/preview-by-ids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, companyIds }),
      });
      const data = (await res.json()) as Preview & { error?: string };
      if ((data as { error?: string }).error) {
        toast.error("Preview failed", { description: (data as { error?: string }).error });
        return;
      }
      setPreview(data);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function onVerify() {
    if (!campaignId) return;
    if (!preview || preview.pendingVerification === 0) return;
    setVerifying(true);
    setVerifyProgress(null);
    let totalVerified = 0;
    try {
      let loops = 0;
      // 200-loop cap × 50/batch = 10k emails max per session. Defensive
      // against an endpoint that never converges.
      while (loops < 200) {
        const res = await fetch("/api/v1/integrations/instantly/verify-by-ids", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyIds, campaignId, limit: 50 }),
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
      toast.success(`Verified ${totalVerified} email${totalVerified === 1 ? "" : "s"}`);
      await refreshPreview();
    } finally {
      setVerifying(false);
    }
  }

  async function onPush() {
    if (!campaignId || !preview || preview.pushable === 0) return;
    const camp = campaigns.find((c) => c.id === campaignId);
    if (!window.confirm(
      `Push ${preview.pushable.toLocaleString()} verified lead${preview.pushable === 1 ? "" : "s"} to "${camp?.name ?? "this campaign"}"? Already-pushed leads + emails already on Instantly anywhere are skipped automatically.`,
    )) return;
    setPushing(true);
    try {
      const res = await fetch("/api/v1/integrations/instantly/push-by-ids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, companyIds }),
      });
      const data = (await res.json()) as PushResp;
      if (!data.ok) {
        toast.error("Push failed", { description: data.error });
        return;
      }
      toast.success("Pushed to Instantly", {
        description: `${data.inserted ?? 0} queued · ${data.instantly?.pushed?.leads ?? 0} delivered · ${data.instantly?.errors?.length ?? 0} sync errors`,
        duration: 15000,
      });
      onPushed?.();
      onClose();
    } finally {
      setPushing(false);
    }
  }

  const eligibleCampaigns = campaigns.filter((c) => c.instantly_campaign_id);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Send className="h-5 w-5" />
              Push to Instantly
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {companyIds.length.toLocaleString()} prospect{companyIds.length === 1 ? "" : "s"} selected
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Campaign dropdown */}
          <div>
            <label className="block text-sm font-medium mb-1">Instantly campaign</label>
            <select
              className="w-full border rounded px-2 py-1.5 text-sm bg-background"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
            >
              <option value="">— pick a campaign —</option>
              {eligibleCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.status})
                </option>
              ))}
            </select>
            {eligibleCampaigns.length === 0 && (
              <p className="text-xs text-yellow-700 mt-1">
                No Instantly-synced campaigns. Go to Settings → Integrations and
                click <strong>Sync campaigns</strong> on the Instantly card.
              </p>
            )}
          </div>

          {/* Preview counters */}
          {loadingPreview && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading preview…
            </div>
          )}
          {preview && !loadingPreview && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Counter label="Eligible" value={preview.eligible} note="email + not in this campaign" />
                <Counter label="Verified" value={preview.pushable} accent="green" note="ok or catch-all" />
                <Counter label="Need verify" value={preview.pendingVerification} accent={preview.pendingVerification > 0 ? "yellow" : undefined} />
                <Counter label="Ruled out" value={preview.ruledOut} note="invalid / disposable / unknown" />
                <Counter label="Already on Instantly" value={preview.alreadyOnInstantly} note="any campaign" />
                <Counter label="Already in this campaign" value={preview.alreadyInCampaign} />
              </div>
              {preview.sample.length > 0 && (
                <div>
                  <div className="text-muted-foreground mb-1">Top 20 push-eligible sample</div>
                  <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                    {preview.sample.map((s) => (
                      <li key={s.id} className="flex items-center gap-2">
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] border">
                          {s.icp_tier ?? "—"}
                        </span>
                        <span className="font-mono">{s.domain || s.name || s.id}</span>
                        <span className="text-muted-foreground">{s.email}</span>
                        <span className="text-[10px] text-muted-foreground ml-auto">{s.source_type ?? ""}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Verify progress */}
          {verifying && verifyProgress && (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Verifying… {verifyProgress.verified.toLocaleString()} done, {verifyProgress.remaining.toLocaleString()} remaining.
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 p-5 border-t bg-muted/20">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={onVerify}
            disabled={!campaignId || verifying || pushing || !preview || preview.pendingVerification === 0}
            className="px-3 py-1.5 rounded-lg border bg-background text-sm font-medium hover:bg-muted disabled:opacity-50 flex items-center gap-1.5"
          >
            {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailCheck className="h-4 w-4" />}
            Verify {preview ? preview.pendingVerification.toLocaleString() : ""}
          </button>
          <button
            onClick={onPush}
            disabled={!campaignId || pushing || verifying || !preview || preview.pushable === 0}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {pushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Award className="h-4 w-4" />}
            Push {preview ? preview.pushable.toLocaleString() : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

function Counter({ label, value, note, accent }: {
  label: string;
  value: number;
  note?: string;
  accent?: "green" | "yellow";
}) {
  const color = accent === "green" ? "text-green-700" : accent === "yellow" ? "text-yellow-700" : "";
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className={`font-mono font-semibold text-base ${color}`}>{value.toLocaleString()}</div>
      {note && <div className="text-[10px] text-muted-foreground/70">{note}</div>}
    </div>
  );
}
