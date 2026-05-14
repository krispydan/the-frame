export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { INDUSTRY_DISPLAY, type Industry } from "@/modules/sales/lib/industry-mapping";

/**
 * GET /api/v1/sales/prospects/:id/llm-classification
 *
 * Returns the most recent LLM classification audit row for a prospect, plus
 * the current `industry` value on the company row and the helpful
 * INDUSTRY_DISPLAY metadata for the UI.
 *
 * Used by the /prospects/review page to show the LLM verdict card.
 * Returns null fields if the prospect has never been classified by the
 * LLM worker (e.g. it was classified by the rule-based backfill or by a
 * human).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const company = sqlite.prepare(`
    SELECT industry, enrichment_text, enrichment_source, enrichment_fetched_at,
           contact_form_url
    FROM companies WHERE id = ?
  `).get(id) as {
    industry: string | null;
    enrichment_text: string | null;
    enrichment_source: string | null;
    enrichment_fetched_at: string | null;
    contact_form_url: string | null;
  } | undefined;

  if (!company) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const latest = sqlite.prepare(`
    SELECT id, model_name, prompt_version, industry, is_chain, confidence,
           reasoning, flags, verdict, enrichment_source, classified_at
    FROM prospect_llm_classifications
    WHERE company_id = ?
    ORDER BY classified_at DESC
    LIMIT 1
  `).get(id) as
    | {
        id: string;
        model_name: string;
        prompt_version: string;
        industry: string | null;
        is_chain: number | null;
        confidence: number | null;
        reasoning: string | null;
        flags: string | null;
        verdict: string | null;
        enrichment_source: string | null;
        classified_at: string;
      }
    | undefined;

  const industryMeta = company.industry
    ? INDUSTRY_DISPLAY[company.industry as Industry] ?? null
    : null;

  return NextResponse.json({
    current_industry: company.industry,
    current_industry_meta: industryMeta,
    enrichment_text: company.enrichment_text,
    enrichment_source: company.enrichment_source,
    enrichment_fetched_at: company.enrichment_fetched_at,
    contact_form_url: company.contact_form_url,
    latest_classification: latest
      ? {
          id: latest.id,
          model_name: latest.model_name,
          prompt_version: latest.prompt_version,
          industry: latest.industry,
          is_chain: !!latest.is_chain,
          confidence: latest.confidence,
          reasoning: latest.reasoning,
          flags: safeJsonArray(latest.flags),
          verdict: latest.verdict,
          enrichment_source: latest.enrichment_source,
          classified_at: latest.classified_at,
        }
      : null,
  });
}

function safeJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
