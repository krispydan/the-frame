export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { decideVerdict } from "@/modules/sales/lib/llm-verdict";
import { isKnownIndustry, type LlmOutputRow } from "@/modules/sales/lib/llm-prompt";

/**
 * POST /api/v1/sales/prospects/llm-classify-batch
 *
 * Mac-mini classifier worker posts batched classification results here.
 * For each row in the batch we:
 *   1. Compute the deterministic verdict (decideVerdict)
 *   2. Update companies.industry, companies.status, disqualify_reason
 *   3. Backfill email/phone/contact_form_url/socials WHERE empty (never
 *      overwrite human-entered values)
 *   4. Cache enrichment_text + enrichment_source + enrichment_fetched_at
 *   5. Insert a row in prospect_llm_classifications (audit trail)
 *
 * Auth: header `X-Classifier-Token: <CLASSIFIER_TOKEN>`.
 *
 * Body:
 * {
 *   "model": "qwen2.5:7b-instruct-q4_K_M",
 *   "prompt_version": "v2.1-2026-05-13",
 *   "results": [
 *     {
 *       "llm": <LlmOutputRow>,
 *       "enrichment_text": <string or null>,
 *       "enrichment_source": "homepage" | "brave" | "none",
 *       "contacts": {
 *         "emails": [...],
 *         "phones": [...],
 *         "contact_form_url": <url or null>,
 *         "instagram_url": <url or null>,
 *         "facebook_url": <url or null>
 *       }
 *     }
 *   ]
 * }
 *
 * Returns: { accepted, approved, rejected, needs_human, failed: [...] }
 */

interface BatchItem {
  llm: LlmOutputRow;
  enrichment_text: string | null;
  enrichment_source: "homepage" | "brave" | "none";
  contacts: {
    emails: string[];
    phones: string[];
    contact_form_url: string | null;
    instagram_url: string | null;
    facebook_url: string | null;
  };
}

interface BatchBody {
  model: string;
  prompt_version: string;
  results: BatchItem[];
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Invalid X-Classifier-Token" }, { status: 401 });
  }

  let body: BatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.results || !Array.isArray(body.results) || body.results.length === 0) {
    return NextResponse.json({ error: "results[] required" }, { status: 400 });
  }
  if (!body.model || !body.prompt_version) {
    return NextResponse.json({ error: "model + prompt_version required" }, { status: 400 });
  }

  const stats = { accepted: 0, approved: 0, rejected: 0, needs_human: 0 };
  const failed: Array<{ id: string; error: string }> = [];

  const updateCompany = sqlite.prepare(`
    UPDATE companies
    SET
      industry = ?,
      status = CASE WHEN ? IS NOT NULL THEN ? ELSE status END,
      disqualify_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE disqualify_reason END,
      enrichment_text = ?,
      enrichment_source = ?,
      enrichment_fetched_at = datetime('now'),
      email = CASE WHEN (email IS NULL OR email = '') AND ? IS NOT NULL THEN ? ELSE email END,
      phone = CASE WHEN (phone IS NULL OR phone = '') AND ? IS NOT NULL THEN ? ELSE phone END,
      contact_form_url = CASE WHEN contact_form_url IS NULL AND ? IS NOT NULL THEN ? ELSE contact_form_url END,
      instagram_url = CASE WHEN (instagram_url IS NULL OR instagram_url = '') AND ? IS NOT NULL THEN ? ELSE instagram_url END,
      facebook_url = CASE WHEN (facebook_url IS NULL OR facebook_url = '') AND ? IS NOT NULL THEN ? ELSE facebook_url END,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  const insertAudit = sqlite.prepare(`
    INSERT INTO prospect_llm_classifications (
      id, company_id, model_name, prompt_version, industry, is_chain,
      confidence, reasoning, flags, raw_response, verdict, enrichment_source
    ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = sqlite.transaction((items: BatchItem[]) => {
    for (const item of items) {
      const { llm, enrichment_text, enrichment_source, contacts } = item;
      if (!llm?.id) {
        failed.push({ id: "<missing>", error: "missing llm.id" });
        continue;
      }
      if (!isKnownIndustry(llm.industry)) {
        failed.push({ id: llm.id, error: `unknown industry: ${llm.industry}` });
        continue;
      }

      // Look up the company's country to feed decideVerdict
      const country = sqlite.prepare(`SELECT country FROM companies WHERE id = ?`).get(llm.id) as { country: string | null } | undefined;
      if (!country) {
        failed.push({ id: llm.id, error: "company not found" });
        continue;
      }

      const decision = decideVerdict({ llm, country: country.country });
      // map verdict → stats key
      if (decision.verdict === "approve") stats.approved++;
      else if (decision.verdict === "reject") stats.rejected++;
      else stats.needs_human++;

      const email = contacts.emails[0] ?? null;
      const phone = contacts.phones[0] ?? null;
      const formUrl = contacts.contact_form_url;
      const ig = contacts.instagram_url;
      const fb = contacts.facebook_url;

      updateCompany.run(
        llm.industry,
        decision.status, decision.status,                    // status
        decision.verdict === "reject" ? decision.reason : null,
        decision.verdict === "reject" ? decision.reason : null,
        enrichment_text,
        enrichment_source,
        email, email,
        phone, phone,
        formUrl, formUrl,
        ig, ig,
        fb, fb,
        llm.id,
      );

      insertAudit.run(
        llm.id,
        body.model,
        body.prompt_version,
        llm.industry,
        llm.is_chain ? 1 : 0,
        llm.confidence,
        llm.reasoning,
        JSON.stringify(llm.flags ?? []),
        JSON.stringify(llm),
        decision.verdict,
        enrichment_source,
      );

      stats.accepted++;
    }
  });

  try {
    tx(body.results);
  } catch (err) {
    console.error("[llm-classify-batch] tx error:", err);
    return NextResponse.json({
      error: err instanceof Error ? err.message : "tx failed",
      partial_stats: stats,
      failed,
    }, { status: 500 });
  }

  return NextResponse.json({
    ...stats,
    failed,
  });
}

function checkAuth(req: NextRequest): boolean {
  const provided = req.headers.get("x-classifier-token");
  const expected = process.env.CLASSIFIER_TOKEN;
  if (!expected) {
    console.error("[llm-classify-batch] CLASSIFIER_TOKEN env var not set");
    return false;
  }
  return !!provided && provided === expected;
}
