/**
 * AI enrichment of an interested (Set Appointment) PhoneBurner lead.
 *
 * Runs as an async job (`sales.enrich_interested_lead`) enqueued by the
 * status fan-out ~30s after a company flips to `interested` — by then
 * the Pipedrive deal-creation job has normally landed the deal.
 *
 * Pipeline:
 *   1. Load the latest interested call (notes, recording, timing).
 *   2. Optionally transcribe the recording (gated) to recover the
 *      verbally-given catalog email that reps don't type.
 *   3. AI: structured analysis + a personalized email opener.
 *   4. Auto-apply a high-confidence alternate email (Frame contact +
 *      Pipedrive person).
 *   5. Enrich the Pipedrive deal: call note, a "done" call activity,
 *      and the opener written to a dedicated deal field.
 *   6. Post a consolidated Slack "AI enrichment" message with the
 *      Pipedrive deal link.
 *
 * Idempotent: a marker in activity_feed (keyed by call id) makes a
 * re-run a no-op. All external writes are best-effort (try/caught) so
 * one failing leg never blocks the others — and, because the job never
 * throws after side effects begin, retries can't duplicate them.
 */
import { sqlite } from "@/lib/db";
import {
  pdRequest,
  createNote,
  createActivity,
  createPerson,
  updateDeal,
  getPipedriveConnectionStatus,
} from "./pipedrive-client";
import { isSyncEnabled } from "./pipedrive-sync";
import { analyzeCallNote, type AnalyzeResult } from "./ai/call-note-analysis";
import { getOrCreateTranscript } from "./ai/recording-transcription";
import { postSlack, type SlackBlock } from "@/modules/integrations/lib/slack/client";

const APP_BASE_URL =
  process.env.SHOPIFY_APP_URL ||
  process.env.APP_BASE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://theframe.getjaxy.com";

interface InterestedCall {
  call_id: string;
  notes: string | null;
  recording_url: string | null;
  duration_seconds: number | null;
  connected: number | null;
  called_at: string | null;
  disposition_label: string | null;
}

interface CompanyRow {
  id: string;
  name: string | null;
  pipedrive_org_id: number | null;
  pipedrive_person_id: number | null;
}

function getSetting(key: string): string | null {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'sales', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

const ENRICHED_MARKER = "sales_interested_enriched";

function alreadyEnriched(callId: string): boolean {
  const row = sqlite
    .prepare(
      `SELECT 1 FROM activity_feed
        WHERE event_type = ? AND data LIKE ? LIMIT 1`,
    )
    .get(ENRICHED_MARKER, `%"call_id":"${callId}"%`);
  return !!row;
}

/** Ensure the "AI Email Opener" deal field exists; cache its key. */
async function ensureOpenerFieldKey(): Promise<string | null> {
  const cached = getSetting("pipedrive_ai_opener_field_key");
  if (cached) return cached;
  try {
    interface FieldDef { key: string; name: string }
    const existing = (await pdRequest<FieldDef[]>("GET", "/dealFields")) || [];
    const found = existing.find((f) => f.name.trim().toLowerCase() === "ai email opener");
    let key = found?.key;
    if (!key) {
      const created = await pdRequest<FieldDef>("POST", "/dealFields", {
        name: "AI Email Opener",
        field_type: "text",
      });
      key = created.key;
    }
    if (key) setSetting("pipedrive_ai_opener_field_key", key);
    return key ?? null;
  } catch (e) {
    console.warn("[interested-enrichment] opener field unavailable:", e instanceof Error ? e.message : e);
    return null;
  }
}

function findOpenDeal(companyId: string): { pipedrive_deal_id: number; pipeline: string | null } | undefined {
  return sqlite
    .prepare(
      `SELECT pipedrive_deal_id, pipeline FROM pipedrive_deals
        WHERE company_id = ? AND is_open = 1 AND pipedrive_deal_id IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(companyId) as { pipedrive_deal_id: number; pipeline: string | null } | undefined;
}

function emailOnFile(companyId: string): string | null {
  const row = sqlite
    .prepare(
      `SELECT email FROM contacts
        WHERE company_id = ? AND TRIM(COALESCE(email,'')) <> ''
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    )
    .get(companyId) as { email: string | null } | undefined;
  return row?.email ?? null;
}

function contactWithEmailExists(companyId: string, email: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM contacts WHERE company_id = ? AND lower(email) = lower(?) LIMIT 1")
    .get(companyId, email);
  return !!row;
}

function fmtDuration(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return "";
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m${(Math.round(s % 60)).toString().padStart(2, "0")}s`;
}

function dealUrl(dealId: number): string | null {
  const domain = getSetting("pipedrive_api_domain");
  if (!domain) return null;
  return `${domain.replace(/\/$/, "")}/deal/${dealId}`;
}

/**
 * Enrich one interested company. Returns a structured summary for the
 * job output / logs.
 */
export async function enrichInterestedLead(companyId: string): Promise<Record<string, unknown>> {
  const company = sqlite
    .prepare(
      "SELECT id, name, pipedrive_org_id, pipedrive_person_id FROM companies WHERE id = ?",
    )
    .get(companyId) as CompanyRow | undefined;
  if (!company) return { skipped: "company not found", companyId };

  const call = sqlite
    .prepare(
      `SELECT id AS call_id, notes, recording_url, duration_seconds, connected,
              called_at, disposition_label
         FROM phoneburner_call_log
        WHERE company_id = ?
          AND disposition_label LIKE '%Set Appointment%'
        ORDER BY called_at DESC LIMIT 1`,
    )
    .get(companyId) as InterestedCall | undefined;

  if (!call) return { skipped: "no interested call found", companyId };
  if (alreadyEnriched(call.call_id)) return { skipped: "already enriched", callId: call.call_id };
  if (!call.notes || !call.notes.trim()) {
    return { skipped: "call has no notes", callId: call.call_id };
  }

  const onFile = emailOnFile(companyId);

  // ── 1. Transcript — always fetched + saved on file for interested
  //       calls; feeds the analysis (recovers verbally-given emails). ──
  const transcript = await getOrCreateTranscript(call.call_id, call.recording_url);
  const transcribed = !!transcript;

  // ── 2. AI analysis (note + transcript) ──
  const ai: AnalyzeResult | null = await analyzeCallNote({
    companyName: company.name,
    notes: call.notes,
    transcript,
    emailOnFile: onFile,
  });

  if (!ai) return { skipped: "ai analysis unavailable", callId: call.call_id };
  const { analysis, emailOpener } = ai;

  const result: Record<string, unknown> = {
    ok: true,
    companyId,
    callId: call.call_id,
    transcribed,
    temperature: analysis.temperature,
    currentBrands: analysis.currentBrands,
    emailApplied: false,
    pipedrive: { deal: null as number | null, note: false, activity: false, opener: false },
  };

  const pdConnected = getPipedriveConnectionStatus().connected && isSyncEnabled();
  const deal = pdConnected ? findOpenDeal(companyId) : undefined;
  const dealId = deal?.pipedrive_deal_id ?? null;
  (result.pipedrive as Record<string, unknown>).deal = dealId;

  // ── 3. Auto-apply a high-confidence alternate email ──
  const alt = analysis.alternateEmail;
  if (alt && alt.confidence >= 0.9) {
    try {
      if (!contactWithEmailExists(companyId, alt.value)) {
        // Frame contact (secondary unless the company has no contacts).
        const hasAny = sqlite
          .prepare("SELECT 1 FROM contacts WHERE company_id = ? LIMIT 1")
          .get(companyId);
        sqlite
          .prepare(
            `INSERT INTO contacts
               (id, company_id, first_name, last_name, title, email, is_primary,
                source, notes, created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?, 'phoneburner-call-ai', ?, datetime('now'), datetime('now'))`,
          )
          .run(
            crypto.randomUUID(),
            companyId,
            analysis.contact?.name ?? (company.name ?? "Contact"),
            analysis.contact?.role ?? null,
            alt.value,
            hasAny ? 0 : 1,
            `Captured from cold call (${call.disposition_label ?? "Set Appointment"})${transcribed ? " transcript" : " note"}`,
          );
        result.emailApplied = true;
      }
      // Pipedrive person for the new email.
      if (dealId && company.pipedrive_org_id) {
        try {
          await createPerson({
            name: analysis.contact?.name ?? (company.name ?? "Contact"),
            org_id: company.pipedrive_org_id,
            email: [alt.value],
          });
        } catch (e) {
          console.warn("[interested-enrichment] pd person create failed:", e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.error("[interested-enrichment] email apply failed:", e instanceof Error ? e.message : e);
    }
  }

  // ── 4. Pipedrive deal enrichment (best-effort) ──
  if (dealId) {
    const pd = result.pipedrive as Record<string, unknown>;
    const noteHtml = buildDealNoteHtml(company.name, analysis, call, transcribed);
    try {
      await createNote({ content: noteHtml, deal_id: dealId, org_id: company.pipedrive_org_id ?? undefined });
      pd.note = true;
    } catch (e) {
      console.warn("[interested-enrichment] pd note failed:", e instanceof Error ? e.message : e);
    }
    try {
      await createActivity({
        subject: `Cold call — ${call.disposition_label ?? "Set Appointment"}`,
        type: "call",
        deal_id: dealId,
        org_id: company.pipedrive_org_id ?? undefined,
        done: true,
        note: (call.notes ?? "").slice(0, 1000),
      });
      pd.activity = true;
    } catch (e) {
      console.warn("[interested-enrichment] pd activity failed:", e instanceof Error ? e.message : e);
    }
    try {
      const fieldKey = await ensureOpenerFieldKey();
      if (fieldKey) {
        await updateDeal(dealId, { [fieldKey]: emailOpener.slice(0, 1000) });
        pd.opener = true;
      }
    } catch (e) {
      console.warn("[interested-enrichment] pd opener field failed:", e instanceof Error ? e.message : e);
    }
  }

  // ── 5. Consolidated Slack message with the deal link ──
  try {
    await postEnrichmentSlack({
      companyId,
      companyName: company.name,
      analysis,
      emailOpener,
      dealId,
      dealUrl: dealId ? dealUrl(dealId) : null,
      emailApplied: result.emailApplied === true,
      altEmail: alt && alt.confidence >= 0.9 ? alt.value : null,
      emailUncaptured: analysis.emailReferencedUncaptured && !transcribed,
      transcribed,
      duration: fmtDuration(call.duration_seconds),
    });
  } catch (e) {
    console.error("[interested-enrichment] slack post failed:", e instanceof Error ? e.message : e);
  }

  // ── 6. Idempotency marker + timeline event ──
  try {
    sqlite
      .prepare(
        `INSERT INTO activity_feed
           (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
         VALUES (?, ?, 'sales', 'company', ?, ?, NULL, datetime('now'))`,
      )
      .run(
        crypto.randomUUID(),
        ENRICHED_MARKER,
        companyId,
        JSON.stringify({
          call_id: call.call_id,
          temperature: analysis.temperature,
          current_brands: analysis.currentBrands,
          email_applied: result.emailApplied,
          alt_email: alt?.value ?? null,
          transcribed,
          pipedrive_deal_id: dealId,
          opener: emailOpener,
        }),
      );
  } catch (e) {
    console.error("[interested-enrichment] marker insert failed:", e instanceof Error ? e.message : e);
  }

  return result;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildDealNoteHtml(
  companyName: string | null,
  analysis: AnalyzeResult["analysis"],
  call: InterestedCall,
  transcribed: boolean,
): string {
  const lines: string[] = [];
  lines.push(`<b>📞 Cold call — ${esc(analysis.repSummary || "Set Appointment")}</b>`);
  const meta: string[] = [];
  meta.push(`Temperature: ${analysis.temperature}`);
  if (analysis.spokeWith) meta.push(`Spoke with: ${esc(analysis.spokeWith)}`);
  if (analysis.carriesSunglasses !== "unknown")
    meta.push(`Carries sunglasses: ${analysis.carriesSunglasses}`);
  if (analysis.currentBrands.length) meta.push(`Currently carries: ${esc(analysis.currentBrands.join(", "))}`);
  lines.push(meta.join(" · "));
  if (analysis.objections.length) lines.push(`<b>Objections:</b> ${esc(analysis.objections.join("; "))}`);
  if (analysis.followUp) lines.push(`<b>Next:</b> ${esc(analysis.followUp)}`);
  if (analysis.catalogSendTo) lines.push(`<b>Send catalog to:</b> ${esc(analysis.catalogSendTo)}`);
  lines.push("");
  lines.push(`<b>Rep note:</b> ${esc((call.notes ?? "").trim())}`);
  if (transcribed) lines.push("<i>(email/details recovered from call recording)</i>");
  return lines.join("<br>");
}

async function postEnrichmentSlack(o: {
  companyId: string;
  companyName: string | null;
  analysis: AnalyzeResult["analysis"];
  emailOpener: string;
  dealId: number | null;
  dealUrl: string | null;
  emailApplied: boolean;
  altEmail: string | null;
  emailUncaptured: boolean;
  transcribed: boolean;
  duration: string;
}): Promise<void> {
  const frameLink = `${APP_BASE_URL.replace(/\/$/, "")}/prospects/${o.companyId}`;
  const name = o.companyName ?? "(unknown company)";

  const contextBits: string[] = [];
  contextBits.push(`🌡️ ${o.analysis.temperature}`);
  if (o.analysis.currentBrands.length) contextBits.push(`carries ${o.analysis.currentBrands.join(", ")}`);
  else if (o.analysis.carriesSunglasses === "no") contextBits.push("no sunglasses yet");
  if (o.transcribed) contextBits.push("🎙️ transcribed");

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🧠 *AI enrichment* — *${name}*\n_${o.analysis.repSummary}_`,
      },
    },
  ];

  if (o.analysis.objections.length || o.analysis.followUp) {
    const parts: string[] = [];
    if (o.analysis.followUp) parts.push(`*Next:* ${o.analysis.followUp}`);
    if (o.analysis.objections.length) parts.push(`*Objections:* ${o.analysis.objections.join("; ")}`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: parts.join("\n") } });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*✍️ Email opener*\n>${o.emailOpener.replace(/\n/g, "\n>")}` },
  });

  const emailLine = o.emailApplied
    ? `✅ Added email: ${o.altEmail}`
    : o.emailUncaptured
      ? "⚠️ An email was mentioned on the call but not captured — check the recording"
      : null;
  if (emailLine) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: emailLine }] });
  }

  const pills: string[] = [`<${frameLink}|🔗 Open in The Frame>`];
  if (o.dealUrl) pills.push(`<${o.dealUrl}|🟢 Pipedrive deal>`);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${contextBits.join(" · ")}   ·   ${pills.join("   ·   ")}` }],
  });

  await postSlack({
    topic: "sales.phoneburner_interested",
    text: `🧠 AI enrichment — ${name}`,
    blocks,
  });
}
