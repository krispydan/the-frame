export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";
import { formatToPbPhone } from "@/modules/sales/lib/phone-utils";

/**
 * POST /api/admin/sales/push-apify-enriched-to-phoneburner
 *
 * Pushes every Apify-enriched company whose phone landed in
 * company_phones (source='gmaps') to the named PhoneBurner folder
 * so Sandra can dial them. Idempotent — already-pushed leads
 * (tracked in phoneburner_folder_pushes) are skipped.
 *
 * Body:
 *   {
 *     folder_id: "66244741",   // required — PB folder ID
 *     tier?: "A,B",            // optional — ICP tier filter
 *     limit?: 100,             // optional — cap per call (default 100, max 500)
 *     dryRun?: true            // optional — return cohort + sample, no PB calls
 *   }
 *
 * Returns:
 *   {
 *     ok, dry_run, cohort_total, pushed, already_pushed,
 *     skipped_no_phone, errors[], sample[]
 *   }
 *
 * Auth: x-admin-key.
 */

interface CandidateRow {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  domain: string | null;
  website: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  gmaps_subtypes: string | null;
  primary_phone: string | null;
  primary_email: string | null;
}

export async function POST(req: NextRequest) {
  try {
    return await handlePush(req);
  } catch (e) {
    console.error("[push-apify-enriched-to-phoneburner] crashed:", e);
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack?.split("\n").slice(0, 6) : undefined,
      },
      { status: 500 },
    );
  }
}

async function handlePush(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: {
    folder_id?: string;
    tier?: string;
    limit?: number;
    dryRun?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }

  const folderId = String(body.folder_id || "").trim();
  if (!folderId) {
    return NextResponse.json(
      { ok: false, error: "folder_id required (PhoneBurner folder ID)" },
      { status: 400 },
    );
  }

  const limit = Math.min(500, Math.max(1, body.limit ?? 100));
  const tiers = body.tier
    ? body.tier.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;

  // Cohort: companies whose primary phone was added by Apify, in an
  // active/callable status, NOT already pushed to this PB folder.
  const tierClause =
    tiers && tiers.length > 0
      ? `AND c.icp_tier IN (${tiers.map(() => "?").join(",")})`
      : "";

  const cohort = sqlite
    .prepare(
      `SELECT c.id, c.name, c.city, c.state, c.domain, c.website,
              c.google_rating, c.google_review_count, c.gmaps_subtypes,
              (SELECT cp.phone FROM company_phones cp
                WHERE cp.company_id = c.id AND cp.source = 'gmaps'
                ORDER BY cp.created_at ASC LIMIT 1) AS primary_phone,
              (SELECT ct.email FROM contacts ct
                WHERE ct.company_id = c.id
                  AND TRIM(COALESCE(ct.email, '')) <> ''
                ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS primary_email
         FROM companies c
        WHERE c.status NOT IN ('not_interested','ghosted','not_qualified','rejected','customer')
          AND EXISTS (SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id AND cp.source = 'gmaps')
          AND NOT EXISTS (
            SELECT 1 FROM phoneburner_folder_pushes pfp
             WHERE pfp.company_id = c.id AND pfp.folder_id = ?
          )
          ${tierClause}
        ORDER BY c.icp_score DESC NULLS LAST, c.google_rating DESC NULLS LAST
        LIMIT ?`,
    )
    .all(folderId, ...(tiers ?? []), limit) as CandidateRow[];

  const cohortTotal = cohort.length;

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      folder_id: folderId,
      cohort_total: cohortTotal,
      sample: cohort.slice(0, 10).map((c) => ({
        id: c.id,
        name: c.name,
        city: c.city,
        state: c.state,
        phone: c.primary_phone,
        rating: c.google_rating,
      })),
    });
  }

  if (cohortTotal === 0) {
    return NextResponse.json({
      ok: true,
      cohort_total: 0,
      pushed: 0,
      already_pushed: 0,
      skipped_no_phone: 0,
      errors: [],
      message: "Nothing to push — cohort is empty.",
    });
  }

  // Resolve owner_id once (PB requires it on every create). Settings
  // cache first — discoverOwnerId() is unauthenticated against PB's
  // /me-less API and can 401 in some workspaces.
  let ownerId: string;
  try {
    const cached = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'phoneburner_owner_id' LIMIT 1")
      .get() as { value: string | null } | undefined;
    if (cached?.value) {
      ownerId = cached.value;
    } else {
      const discovered = await phoneBurnerClient.discoverOwnerId();
      if (!discovered) {
        throw new Error(
          "PhoneBurner owner_id not cached in settings and discoverOwnerId returned null",
        );
      }
      ownerId = discovered;
    }
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `owner_id discovery failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 },
    );
  }

  const stampStmt = sqlite.prepare(
    `INSERT OR IGNORE INTO phoneburner_folder_pushes
       (id, company_id, folder_id, pb_contact_id, phone_pushed, pushed_at, error)
     VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'), ?)`,
  );

  let pushed = 0;
  let alreadyPushed = 0;
  let skippedNoPhone = 0;
  const errors: Array<{ company_id: string; reason: string }> = [];

  for (const row of cohort) {
    const formatted = formatToPbPhone(row.primary_phone);
    if (!formatted) {
      skippedNoPhone++;
      continue;
    }

    // Build PB note for Sandra's call screen
    const noteLines: string[] = [];
    noteLines.push(
      `${row.name}${row.city ? ` — ${row.city}` : ""}${row.state ? `, ${row.state}` : ""}`,
    );
    if (row.website || row.domain) {
      noteLines.push(row.website || `https://${row.domain}`);
    }
    if (row.google_rating != null) {
      noteLines.push(
        `${row.google_rating}★${row.google_review_count != null ? ` (${row.google_review_count} reviews)` : ""}`,
      );
    }
    if (row.gmaps_subtypes) {
      try {
        const subtypes = JSON.parse(row.gmaps_subtypes) as string[];
        if (Array.isArray(subtypes) && subtypes.length > 0) {
          noteLines.push(`Categories: ${subtypes.slice(0, 3).join(", ")}`);
        }
      } catch {
        /* JSON parse failure — skip categories line */
      }
    }
    noteLines.push("Source: Apify Google Maps");
    const notes = noteLines.join("\n");

    try {
      const created = await phoneBurnerClient.createContact({
        owner_id: ownerId,
        first_name: row.name.slice(0, 64),
        last_name: row.state || "",
        email: row.primary_email || undefined,
        phone: formatted,
        category_id: folderId,
        notes,
        on_duplicate: "skip",
      });
      stampStmt.run(row.id, folderId, created.id || null, formatted, null);
      pushed++;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const lowered = reason.toLowerCase();
      if (lowered.includes("duplicate") || lowered.includes("already exists")) {
        // PB rejected as duplicate — still record so we don't retry.
        stampStmt.run(row.id, folderId, null, formatted, "pb_duplicate");
        alreadyPushed++;
      } else {
        errors.push({ company_id: row.id, reason });
        stampStmt.run(row.id, folderId, null, formatted, reason.slice(0, 300));
      }
    }
  }

  return NextResponse.json({
    ok: true,
    folder_id: folderId,
    cohort_total: cohortTotal,
    pushed,
    already_pushed: alreadyPushed,
    skipped_no_phone: skippedNoPhone,
    errors,
    note: `Push complete. Sandra can now dial ${pushed} new contacts in PhoneBurner folder ${folderId}.`,
  });
}
