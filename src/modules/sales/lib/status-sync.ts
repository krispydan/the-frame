/**
 * Hub-and-spoke status sync: when companies.status changes in The
 * Frame, fan out to Instantly + PhoneBurner so the external
 * platforms reflect the new state.
 *
 * Companion to status-progression.ts — that file owns the local
 * transition rules; this file owns the propagation.
 *
 * Loop prevention: every sync carries a `source` tag identifying
 * where the change originated. We never sync back to the originating
 * platform. Combined with the idempotent-no-op behavior of
 * progressCompanyStatus (skips fan-out when status didn't actually
 * change), this prevents Instantly → Frame → Instantly echo loops.
 *
 * Async by design: every sync enqueues a job rather than firing an
 * inline HTTP call. Webhook handlers stay snappy and a slow Instantly
 * API doesn't time out our webhook receivers.
 */
import { sqlite } from "@/lib/db";
import { jobQueue } from "@/modules/core/lib/job-queue";
import { registerJobHandler } from "@/modules/core/lib/job-handler-registry";
import type { CompanyStatus } from "./status-progression";

export type StatusChangeSource = "instantly" | "phoneburner" | "pipedrive" | "ui" | "system";

/**
 * companies.status → Instantly `interest_value`. null = reset to base
 * Lead state (e.g. for revisit_later — we want the lead present in
 * Instantly but not flagged as Interested anymore).
 */
const TO_INSTANTLY_INTEREST: Record<CompanyStatus, number | null> = {
  prospect:        null,
  not_qualified:   null,    // Pre-outreach disqualification — nothing to sync
  qualified_lead:  null,    // Still being worked
  interested:      1,
  catalog_sent:    1,       // Further along but Instantly's enum doesn't distinguish
  revisit_later:   null,    // Reset so a future campaign can re-pitch
  not_interested:  -1,
  ghosted:        -3,       // Lost
  customer:        4,       // Won
};

/**
 * Statuses that ALSO get added to the workspace blocklist so the
 * lead stops receiving any future Instantly campaigns. Hard "no"
 * states only — ghosted does NOT blocklist (we may want to
 * re-engage), customer does not (they're a customer, may need other
 * comms).
 */
const SHOULD_BLOCKLIST: Set<CompanyStatus> = new Set(["not_interested"]);

/**
 * Fan-out entry point — called by progressCompanyStatus AFTER the
 * local companies.status UPDATE lands. Enqueues sync jobs for every
 * external platform EXCEPT the one that originated the change.
 *
 * Safe to call from any context (webhook handler, PATCH route, push
 * handler) — the jobs run async via the job worker.
 */
export function fanOutStatusChange(
  companyId: string,
  status: CompanyStatus,
  source: StatusChangeSource,
): void {
  if (source !== "instantly") {
    enqueueInstantlySync(companyId, status);
  }
  if (source !== "phoneburner") {
    enqueuePhoneBurnerSync(companyId, status);
  }
  if (source !== "pipedrive") {
    enqueuePipedriveSync(companyId, status);
  }
  // AI enrichment of interested leads. ALWAYS enqueued — this job owns
  // the single appointment-set Slack notification (sent after the AI
  // runs, with full call context). The lead/Pipedrive WRITE-backs inside
  // the job stay gated behind settings.interested_enrichment_enabled.
  // Scheduled ~30s out so the Pipedrive deal-creation job has landed.
  if (status === "interested") {
    enqueueInterestedEnrichment(companyId);
  }
}

function enqueueInterestedEnrichment(companyId: string): void {
  void jobQueue.enqueue(
    "sales.enrich_interested_lead",
    "sales",
    { companyId },
    { priority: 3, scheduledFor: new Date(Date.now() + 30_000).toISOString() },
  );
}

function enqueueInstantlySync(companyId: string, status: CompanyStatus): void {
  void jobQueue.enqueue(
    "sales.sync_status_to_instantly",
    "sales",
    { companyId, status },
    { priority: 3 },
  );
}

function enqueuePhoneBurnerSync(companyId: string, status: CompanyStatus): void {
  void jobQueue.enqueue(
    "sales.sync_status_to_phoneburner",
    "sales",
    { companyId, status },
    { priority: 3 },
  );
}

function enqueuePipedriveSync(companyId: string, status: CompanyStatus): void {
  void jobQueue.enqueue(
    "sales.sync_status_to_pipedrive",
    "sales",
    { companyId, status },
    { priority: 3 },
  );
}

// ── Job handlers ──────────────────────────────────────────────────
//
// Registered at module-load via side-effect imports. The webhook
// dispatcher routes that side-effect-import the webhook handlers also
// transitively import status-progression → this module → registration.

registerJobHandler(
  "sales.sync_status_to_instantly",
  async (input): Promise<Record<string, unknown>> => {
    const companyId = String(input.companyId);
    const status = String(input.status) as CompanyStatus;

    // Find the email Instantly knows this lead by. campaign_leads is
    // the right source — that's what gets pushed. Prefer the most-
    // recently-touched row.
    const row = sqlite
      .prepare(
        `SELECT email FROM campaign_leads
          WHERE company_id = ? AND email IS NOT NULL AND email != ''
          ORDER BY COALESCE(replied_at, opened_at, sent_at, created_at) DESC
          LIMIT 1`,
      )
      .get(companyId) as { email: string | null } | undefined;

    if (!row?.email) {
      return { skipped: "no email in campaign_leads" };
    }

    const interestValue = TO_INSTANTLY_INTEREST[status];
    const { instantlyClient } = await import("./instantly-client");

    // Set the interest status. Pass disableAutoInterest=true so
    // Instantly's own classifier doesn't immediately overwrite our
    // explicit decision based on a future reply.
    await instantlyClient.updateLeadInterestStatus(row.email, interestValue, {
      disableAutoInterest: true,
    });

    // Hard "no" → also blocklist so they stop receiving anything from
    // any future campaign.
    let blocklisted = false;
    if (SHOULD_BLOCKLIST.has(status)) {
      try {
        await instantlyClient.addToBlocklist(row.email);
        blocklisted = true;
      } catch (e) {
        // Blocklist add can fail if email's already there — log + continue.
        // The interest_status update is the load-bearing piece.
        console.warn("[status-sync] blocklist add failed (likely duplicate):", e);
      }
    }

    return { ok: true, email: row.email, interest_value: interestValue, blocklisted };
  },
);

registerJobHandler(
  "sales.sync_status_to_phoneburner",
  async (input): Promise<Record<string, unknown>> => {
    const companyId = String(input.companyId);
    const status = String(input.status) as CompanyStatus;

    // PB contact id lives on campaign_leads — stamped after push.
    const row = sqlite
      .prepare(
        `SELECT phoneburner_contact_id FROM campaign_leads
          WHERE company_id = ? AND phoneburner_contact_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(companyId) as { phoneburner_contact_id: string | null } | undefined;

    if (!row?.phoneburner_contact_id) {
      return { skipped: "no phoneburner_contact_id" };
    }

    const { phoneBurnerClient } = await import("./phoneburner-client");
    await phoneBurnerClient.updateContact(row.phoneburner_contact_id, {
      custom_fields: [
        { name: "frame_status", type: "text", value: status },
        {
          name: "frame_status_updated_at",
          type: "text",
          value: new Date().toISOString(),
        },
      ],
    });

    return { ok: true, pb_contact_id: row.phoneburner_contact_id, status };
  },
);

registerJobHandler(
  "sales.sync_status_to_pipedrive",
  async (input): Promise<Record<string, unknown>> => {
    const companyId = String(input.companyId);
    const status = String(input.status) as CompanyStatus;
    const { syncStatusToPipedrive } = await import("./pipedrive-sync");
    return syncStatusToPipedrive(companyId, status);
  },
);

registerJobHandler(
  "sales.enrich_interested_lead",
  async (input): Promise<Record<string, unknown>> => {
    const companyId = String(input.companyId);
    const { enrichInterestedLead } = await import("./interested-enrichment");
    return enrichInterestedLead(companyId, {
      skipSlack: input.skipSlack === true,
      ensureDeal: input.ensureDeal === true,
    });
  },
);

// Transcribe + persist the full call recording for every Set-Appointment
// call. Runs regardless of the enrichment flag — the transcript is kept
// on file for AI analysis, notes, and future use.
registerJobHandler(
  "sales.transcribe_call",
  async (input): Promise<Record<string, unknown>> => {
    const callId = String(input.callId || "");
    if (!callId) return { skipped: "no callId" };
    const row = sqlite
      .prepare("SELECT recording_url, transcript FROM phoneburner_call_log WHERE id = ?")
      .get(callId) as { recording_url: string | null; transcript: string | null } | undefined;
    if (!row) return { skipped: "call not found", callId };
    if (row.transcript && row.transcript.trim()) return { ok: true, cached: true, callId };

    // Recording may not have been on the webhook; fetch it from PB.
    let url = row.recording_url;
    if (!url) {
      try {
        const { phoneBurnerClient } = await import("./phoneburner-client");
        const call = await phoneBurnerClient.getCall(callId, { include_recording: true });
        url = call?.recording_url ?? null;
        if (url) sqlite.prepare("UPDATE phoneburner_call_log SET recording_url = ? WHERE id = ?").run(url, callId);
      } catch (e) {
        console.warn("[transcribe_call] getCall failed:", e instanceof Error ? e.message : e);
      }
    }
    const { getOrCreateTranscript } = await import("./ai/recording-transcription");
    const text = await getOrCreateTranscript(callId, url);
    return { ok: !!text, callId, chars: text?.length ?? 0 };
  },
);

// Follow-up call → transcript summary posted to the Pipedrive deal note.
// Runs for repeat calls (the first interested call gets full enrichment).
registerJobHandler(
  "sales.summarize_followup_call",
  async (input): Promise<Record<string, unknown>> => {
    const callId = String(input.callId || "");
    if (!callId) return { skipped: "no callId" };
    const { summarizeFollowupCall } = await import("./followup-call-summary");
    return summarizeFollowupCall(callId);
  },
);

/** Enqueue a follow-up call summary (transcript → Pipedrive deal note).
 *  Scheduled ~90s out so the recording is finalized + transcribable. */
export function enqueueFollowupSummary(callId: string): void {
  if (!callId) return;
  void jobQueue.enqueue(
    "sales.summarize_followup_call",
    "sales",
    { callId },
    { priority: 3, scheduledFor: new Date(Date.now() + 90_000).toISOString() },
  );
}

/** Enqueue transcription of a call recording. Defaults to ~60s out so
 *  PB has time to finalize the recording for a just-ended call; pass
 *  delayMs=0 for backfilling historical calls. */
export function enqueueCallTranscription(callId: string, delayMs = 60_000): void {
  if (!callId) return;
  void jobQueue.enqueue(
    "sales.transcribe_call",
    "sales",
    { callId },
    { priority: 3, scheduledFor: new Date(Date.now() + delayMs).toISOString() },
  );
}
