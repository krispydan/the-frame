export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { enrichViaGoogleMaps } from "@/modules/sales/lib/google-maps-enrichment";

/**
 * AJM Google Maps enrichment — runs in the BACKGROUND.
 *
 * The Apify actor easily exceeds the edge timeout, so a synchronous run 524s
 * (returns an HTML error page). Instead POST kicks a detached batch loop that
 * keeps running after the response, writing cumulative progress to settings
 * (key `ajm_enrich_state`); the UI polls GET for status.
 *
 *   POST  { dryRun?: true }   dryRun → return cohort preview (fast, no Apify)
 *                             else   → start the background loop, return immediately
 *   GET                        → current run state
 */

const STATE_KEY = "ajm_enrich_state";
const BATCH = 40;
const MAX_BATCHES = 60; // safety cap (~2,400 companies/run)

let inFlight = false;

function readState(): Record<string, unknown> | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(STATE_KEY) as
    | { value: string | null }
    | undefined;
  if (!r?.value) return null;
  try {
    return JSON.parse(r.value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function writeState(state: Record<string, unknown>): void {
  const value = JSON.stringify({ ...state, at: new Date().toISOString(), inFlight });
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'json', 'sales', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(STATE_KEY, value);
}

export async function GET() {
  return NextResponse.json({ ok: true, state: readState(), inFlight });
}

export async function POST(req: NextRequest) {
  let body: { dryRun?: boolean; force?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* defaults */
  }

  if (body.dryRun) {
    const r = await enrichViaGoogleMaps({ ajm: true, limit: BATCH, dryRun: true });
    return NextResponse.json({ ok: true, dryRun: true, cohortInBatch: r.companies_attempted });
  }

  if (inFlight) return NextResponse.json({ ok: false, alreadyRunning: true });

  inFlight = true;
  const totals = { batches: 0, attempted: 0, phones_added: 0, hours_updated: 0, permanently_closed_marked: 0, no_match: 0 };
  writeState({ state: "running", ...totals });

  // Detached loop — keeps running after the response (Railway is a persistent
  // Node process; this is the same fire-and-forget the long cron jobs use).
  void (async () => {
    try {
      for (let b = 0; b < MAX_BATCHES; b++) {
        const r = await enrichViaGoogleMaps({ ajm: true, limit: BATCH, force: body.force === true });
        totals.batches++;
        totals.attempted += r.companies_attempted;
        totals.phones_added += r.phones_added;
        totals.hours_updated += r.hours_updated;
        totals.permanently_closed_marked += r.permanently_closed_marked;
        totals.no_match += r.no_match;
        writeState({ state: "running", ...totals });
        if (r.companies_attempted < BATCH) break; // cohort drained
      }
      writeState({ state: "done", ...totals });
    } catch (e) {
      writeState({ state: "error", error: e instanceof Error ? e.message : String(e), ...totals });
    } finally {
      inFlight = false;
    }
  })();

  return NextResponse.json({ ok: true, started: true });
}
