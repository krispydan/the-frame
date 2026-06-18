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
import { registerJobHandler } from "@/modules/core/lib/job-worker";
import type { CompanyStatus } from "./status-progression";

export type StatusChangeSource = "instantly" | "phoneburner" | "ui" | "system";

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
