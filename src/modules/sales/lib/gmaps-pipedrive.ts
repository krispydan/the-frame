/**
 * Push a store's Google Maps profile into Pipedrive.
 *
 * Reps open Pipedrive, not the frame, when they're about to call — so the
 * context has to live where the work happens. This writes a single, clearly
 * delimited note on the organisation covering what the store actually is:
 * Google's own categorisation, how established it looks (rating, review count,
 * price band), whether it's still trading, and its hours.
 *
 * Written as ONE note that is rewritten in place rather than appended, because
 * a listing refresh should update the picture, not bury the current one under
 * six months of near-identical copies. The note is found by its marker line.
 */

import { sqlite } from "@/lib/db";
import { pdRequest, createNote, getPipedriveConnectionStatus } from "./pipedrive-client";
import { getCompanyListing } from "./gmaps-profile";

/** Marker that identifies our note so a refresh replaces rather than duplicates. */
const MARKER = "⟦jaxy-gmaps⟧";

export interface PushResult {
  companyId: string;
  status: "updated" | "created" | "skipped" | "error";
  orgId?: number | null;
  noteId?: number | null;
  reason?: string;
}

function buildNote(name: string | null, l: NonNullable<ReturnType<typeof getCompanyListing>>): string {
  const lines: string[] = [MARKER];
  lines.push(`<b>Google Maps — ${l.title || name || "store"}</b>`);

  if (l.permanentlyClosed) lines.push("<b>⚠️ PERMANENTLY CLOSED per Google — do not call.</b>");
  else if (l.temporarilyClosed) lines.push("<b>⚠️ Temporarily closed per Google.</b>");

  // What kind of store this is — the thing a rep most wants to know before
  // pitching a sunglasses line.
  const kinds = [...new Set([l.categoryName, ...l.subTypes, ...l.categories].filter(Boolean))];
  if (kinds.length) lines.push(`<b>Type:</b> ${kinds.slice(0, 8).join(" · ")}`);

  const signals: string[] = [];
  if (l.rating != null) signals.push(`${l.rating}★`);
  if (l.reviewCount != null) signals.push(`${l.reviewCount} reviews`);
  if (l.price) signals.push(`price ${l.price}`);
  if (l.imageCount != null) signals.push(`${l.imageCount} photos`);
  if (signals.length) lines.push(`<b>Signals:</b> ${signals.join(" · ")}`);

  if (l.address) lines.push(`<b>Address:</b> ${l.address}`);
  if (l.phone) lines.push(`<b>Phone (Google):</b> ${l.phone}`);
  if (l.website) lines.push(`<b>Website:</b> ${l.website}`);
  if (l.description) lines.push(`<b>Google description:</b> ${l.description.slice(0, 400)}`);

  if (l.openingHours.length) {
    lines.push("<b>Hours:</b>");
    for (const h of l.openingHours) lines.push(`&nbsp;&nbsp;${h.day}: ${h.hours}`);
  }

  if (l.mapsUrl) lines.push(`<b>Listing:</b> ${l.mapsUrl}`);
  lines.push(`<i>Captured ${(l.scrapedAt || "").slice(0, 10)} — refreshed automatically.</i>`);
  return lines.join("<br>");
}

export async function pushListingToPipedrive(companyId: string): Promise<PushResult> {
  if (!getPipedriveConnectionStatus().connected) {
    return { companyId, status: "skipped", reason: "pipedrive not connected" };
  }

  const company = sqlite
    .prepare("SELECT name, pipedrive_org_id FROM companies WHERE id = ?")
    .get(companyId) as { name: string | null; pipedrive_org_id: number | null } | undefined;
  if (!company?.pipedrive_org_id) {
    return { companyId, status: "skipped", reason: "no Pipedrive organization linked" };
  }

  const listing = getCompanyListing(companyId);
  if (!listing) return { companyId, status: "skipped", reason: "no Google Maps listing captured" };

  const orgId = company.pipedrive_org_id;
  const content = buildNote(company.name, listing);

  try {
    // Structured fields go on the org itself so they're filterable in
    // Pipedrive; the note carries the narrative a human reads.
    const orgPatch: Record<string, unknown> = {};
    if (listing.address) orgPatch.address = listing.address;
    if (Object.keys(orgPatch).length) {
      await pdRequest("PUT", `/organizations/${orgId}`, orgPatch).catch(() => null);
    }

    // Find our previous note by its marker and rewrite it, so a refresh
    // updates the picture instead of stacking near-identical copies.
    const notes = (await pdRequest<Array<{ id: number; content: string }>>(
      "GET",
      `/notes?org_id=${orgId}&limit=50`,
    ).catch(() => [])) || [];
    const mine = notes.find((n) => typeof n.content === "string" && n.content.includes(MARKER));

    if (mine) {
      await pdRequest("PUT", `/notes/${mine.id}`, { content });
      return { companyId, status: "updated", orgId, noteId: mine.id };
    }

    const created = await createNote({ content, org_id: orgId });
    return { companyId, status: "created", orgId, noteId: created?.id ?? null };
  } catch (e) {
    return { companyId, status: "error", orgId, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/** Backfill: push listings for customers that have one but no Pipedrive note yet. */
export async function backfillListingsToPipedrive(limit = 25): Promise<{
  attempted: number; created: number; updated: number; skipped: number; errors: string[];
}> {
  const rows = sqlite
    .prepare(
      `SELECT c.id FROM companies c
         JOIN gmaps_listings g ON g.company_id = c.id
        WHERE c.pipedrive_org_id IS NOT NULL
        ORDER BY g.scraped_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string }>;

  let created = 0, updated = 0, skipped = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const res = await pushListingToPipedrive(r.id);
    if (res.status === "created") created++;
    else if (res.status === "updated") updated++;
    else if (res.status === "skipped") skipped++;
    else if (res.status === "error") errors.push(`${r.id}: ${res.reason}`);
  }
  return { attempted: rows.length, created, updated, skipped, errors };
}
