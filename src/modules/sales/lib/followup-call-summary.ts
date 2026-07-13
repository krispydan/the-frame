/**
 * Follow-up call summary → Pipedrive note.
 *
 * The first interested call gets full enrichment (analysis + openers).
 * EVERY subsequent (follow-up) call should also be transcribed + summarized
 * and the summary saved as a note on the company's Pipedrive deal — so the
 * rep sees a running log of what was said on each call. No email openers
 * here; just the transcript summary + key facts.
 *
 * Idempotent per call (activity_feed marker). Best-effort; never throws.
 */
import { sqlite } from "@/lib/db";
import { analyzeCallNote } from "./ai/call-note-analysis";
import { getOrCreateTranscript } from "./ai/recording-transcription";
import { loadLeadContext } from "./lead-context";
import { createNote, getPipedriveConnectionStatus } from "./pipedrive-client";
import { isSyncEnabled } from "./pipedrive-sync";

const MARKER = "sales_followup_summarized";

interface CallRow {
  call_id: string;
  company_id: string | null;
  notes: string | null;
  recording_url: string | null;
  disposition_label: string | null;
  connected: number | null;
  duration_seconds: number | null;
  called_at: string | null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtDur(s: number | null): string {
  if (!s || s <= 0) return "";
  return ` · ${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
function alreadySummarized(callId: string): boolean {
  return !!sqlite
    .prepare(`SELECT 1 FROM activity_feed WHERE event_type = ? AND data LIKE ? LIMIT 1`)
    .get(MARKER, `%"call_id":"${callId}"%`);
}
function openDeal(companyId: string): { pipedrive_deal_id: number } | undefined {
  return sqlite
    .prepare(
      `SELECT pipedrive_deal_id FROM pipedrive_deals
        WHERE company_id = ? AND is_open = 1 AND pipedrive_deal_id IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(companyId) as { pipedrive_deal_id: number } | undefined;
}

export async function summarizeFollowupCall(callId: string): Promise<Record<string, unknown>> {
  const call = sqlite
    .prepare(
      `SELECT id AS call_id, company_id, notes, recording_url, disposition_label,
              connected, duration_seconds, called_at
         FROM phoneburner_call_log WHERE id = ?`,
    )
    .get(callId) as CallRow | undefined;
  if (!call) return { skipped: "call not found", callId };
  if (!call.company_id) return { skipped: "no company", callId };
  if (alreadySummarized(callId)) return { skipped: "already summarized", callId };

  if (!(getPipedriveConnectionStatus().connected && isSyncEnabled())) {
    return { skipped: "pipedrive disabled", callId };
  }
  const deal = openDeal(call.company_id);
  if (!deal) return { skipped: "no open pipedrive deal", callId };

  const company = sqlite
    .prepare("SELECT name, pipedrive_org_id FROM companies WHERE id = ?")
    .get(call.company_id) as { name: string | null; pipedrive_org_id: number | null } | undefined;

  // Transcript (create + cache on demand) feeds the summary.
  const transcript = await getOrCreateTranscript(callId, call.recording_url);
  const ai = await analyzeCallNote({
    companyName: company?.name ?? null,
    notes: call.notes,
    transcript,
    leadContext: loadLeadContext(call.company_id),
  });
  if (!ai) return { skipped: "no summary (no notes/transcript or AI unavailable)", callId };
  const a = ai.analysis;

  // Build the note (summary only — no openers).
  const lines: string[] = [];
  const dateTxt = call.called_at ? ` — ${String(call.called_at).slice(0, 10)}` : "";
  lines.push(`<b>📞 Follow-up call — ${esc(call.disposition_label ?? "call")}${fmtDur(call.duration_seconds)}${dateTxt}</b>`);
  lines.push(esc(a.repSummary || ""));
  const meta: string[] = [];
  if (a.temperature) meta.push(`Temperature: ${a.temperature}`);
  if (a.currentBrands.length) meta.push(`Carries: ${esc(a.currentBrands.join(", "))}`);
  if (meta.length) lines.push(meta.join(" · "));
  if (a.objections.length) lines.push(`<b>Objections:</b> ${esc(a.objections.join("; "))}`);
  if (a.followUp) lines.push(`<b>Next:</b> ${esc(a.followUp)}`);
  if (call.notes && call.notes.trim()) lines.push(`<b>Rep note:</b> ${esc(call.notes.trim())}`);
  lines.push(transcript ? "<i>(from call transcript)</i>" : "<i>(from rep note)</i>");
  const content = lines.filter(Boolean).join("<br>");

  try {
    await createNote({ content, deal_id: deal.pipedrive_deal_id, org_id: company?.pipedrive_org_id ?? undefined });
  } catch (e) {
    return { skipped: `note failed: ${e instanceof Error ? e.message : e}`, callId };
  }

  try {
    sqlite
      .prepare(
        `INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
         VALUES (?, ?, 'sales', 'company', ?, ?, NULL, datetime('now'))`,
      )
      .run(
        crypto.randomUUID(),
        MARKER,
        call.company_id,
        JSON.stringify({ call_id: callId, deal_id: deal.pipedrive_deal_id, transcribed: !!transcript, summary: a.repSummary }),
      );
  } catch (e) {
    console.error("[followup-summary] marker insert failed:", e instanceof Error ? e.message : e);
  }

  return { ok: true, callId, dealId: deal.pipedrive_deal_id, transcribed: !!transcript };
}
