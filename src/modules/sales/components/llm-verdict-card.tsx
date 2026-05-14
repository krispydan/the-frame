"use client";

import { useEffect, useState } from "react";
import { Sparkles, AlertTriangle, CheckCircle2, XCircle, RefreshCw, ExternalLink, Mail, Phone } from "lucide-react";

/**
 * Shows the latest LLM classification for a prospect: industry verdict,
 * confidence bar, reasoning, flags, and the enrichment source. Used in
 * the /prospects/review page.
 *
 * Renders nothing if the prospect has never been LLM-classified (e.g.
 * was tagged by the rule-based backfill or by a human). The card is
 * INFORMATIONAL — approve/reject still goes through the existing
 * review-page action buttons.
 */

interface LatestClassification {
  id: string;
  model_name: string;
  prompt_version: string;
  industry: string | null;
  is_chain: boolean;
  confidence: number | null;
  reasoning: string | null;
  flags: string[];
  verdict: string | null;
  enrichment_source: string | null;
  classified_at: string;
}

interface IndustryMeta {
  label: string;
  tier: "A" | "B" | "C" | "D" | "F";
  description: string;
}

interface LlmClassificationResponse {
  current_industry: string | null;
  current_industry_meta: IndustryMeta | null;
  enrichment_text: string | null;
  enrichment_source: string | null;
  enrichment_fetched_at: string | null;
  contact_form_url: string | null;
  latest_classification: LatestClassification | null;
}

const FLAG_TONE: Record<string, "warn" | "danger" | "info"> = {
  kids_focused:           "danger",
  luxury_brand_focused:   "danger",
  non_retail_pharmacy:    "danger",
  outside_us:             "danger",
  small_chain_likely:     "warn",
  low_traffic_signal:     "warn",
  weak_data:              "info",
};

const TIER_COLOR: Record<string, string> = {
  A: "bg-green-500",
  B: "bg-blue-500",
  C: "bg-gray-400",
  D: "bg-orange-400",
  F: "bg-red-400",
};

export function LlmVerdictCard({ prospectId }: { prospectId: string }) {
  const [data, setData] = useState<LlmClassificationResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    fetch(`/api/v1/sales/prospects/${prospectId}/llm-classification`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => alive && setData(j))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [prospectId]);

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-3 flex items-center gap-2 text-xs text-muted-foreground">
        <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading classification…
      </div>
    );
  }

  if (!data) return null;

  const cls = data.latest_classification;
  const industryLabel = data.current_industry_meta?.label || data.current_industry || "—";
  const tier = data.current_industry_meta?.tier || "C";

  if (!cls && !data.current_industry) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-3 text-xs text-muted-foreground">
        <Sparkles className="w-3.5 h-3.5 inline mr-1" />
        Not yet classified by the LLM. Will be picked up by the next worker run.
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Header: industry + verdict */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <Sparkles className="w-3.5 h-3.5" /> LLM verdict
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${TIER_COLOR[tier]}`} />
            <span className="font-semibold text-base">{industryLabel}</span>
            <span className="text-xs text-muted-foreground">Tier {tier}</span>
          </div>
        </div>
        <VerdictBadge v={cls?.verdict ?? null} />
      </div>

      {/* Confidence */}
      {typeof cls?.confidence === "number" && (
        <div>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>Confidence</span>
            <span>{(cls.confidence * 100).toFixed(0)}%</span>
          </div>
          <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden">
            <div
              className={`h-full ${cls.confidence >= 0.8 ? "bg-green-500" : cls.confidence >= 0.6 ? "bg-blue-500" : "bg-orange-400"}`}
              style={{ width: `${Math.round(cls.confidence * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Reasoning */}
      {cls?.reasoning && (
        <p className="text-sm text-muted-foreground italic">&ldquo;{cls.reasoning}&rdquo;</p>
      )}

      {/* Flags */}
      {cls?.flags && cls.flags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cls.flags.map((f) => {
            const tone = FLAG_TONE[f] ?? "info";
            const cls = tone === "danger"
              ? "bg-red-50 text-red-700 border-red-200"
              : tone === "warn"
              ? "bg-orange-50 text-orange-700 border-orange-200"
              : "bg-gray-50 text-gray-700 border-gray-200";
            return (
              <span key={f} className={`text-xs px-1.5 py-0.5 rounded border ${cls}`}>
                <AlertTriangle className="w-2.5 h-2.5 inline mr-0.5" />
                {f.replace(/_/g, " ")}
              </span>
            );
          })}
        </div>
      )}

      {/* Enrichment source + classified at */}
      <div className="text-xs text-muted-foreground flex items-center gap-3 pt-2 border-t">
        {cls?.enrichment_source && (
          <span className="inline-flex items-center gap-1">
            <ExternalLink className="w-3 h-3" />
            Saw {cls.enrichment_source === "homepage" ? "the homepage" : cls.enrichment_source === "brave" ? "Brave Search results" : "no enrichment"}
          </span>
        )}
        {cls?.classified_at && (
          <span>{new Date(cls.classified_at).toLocaleDateString()}</span>
        )}
        {cls?.is_chain && (
          <span className="text-red-600 font-medium">⚠ marked as chain</span>
        )}
      </div>

      {/* Contact form fallback (when no email/phone on record) */}
      {data.contact_form_url && (
        <a
          href={data.contact_form_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 pt-1"
        >
          <Mail className="w-3 h-3" />
          Contact form: {data.contact_form_url.length > 40 ? data.contact_form_url.slice(0, 40) + "…" : data.contact_form_url}
        </a>
      )}
    </div>
  );
}

function VerdictBadge({ v }: { v: string | null }) {
  if (v === "approve") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 text-xs font-medium shrink-0">
        <CheckCircle2 className="w-3 h-3" /> Approve
      </span>
    );
  }
  if (v === "reject") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 text-xs font-medium shrink-0">
        <XCircle className="w-3 h-3" /> Reject
      </span>
    );
  }
  if (v === "needs_human") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200 text-xs font-medium shrink-0">
        <AlertTriangle className="w-3 h-3" /> Review
      </span>
    );
  }
  return null;
}
