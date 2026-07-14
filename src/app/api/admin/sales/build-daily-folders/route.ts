export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { buildDailyCallFolders } from "@/modules/sales/lib/pipedrive-call-sync";

/**
 * POST /api/admin/sales/build-daily-folders
 *
 * Run the daily-call-folder builder (Model A): for each rep, pull their open
 * Pipedrive "call" activities due through `through` (default today) and stage
 * the contacts into their PhoneBurner folder.
 *
 *   commit=false (default): dry-run — fast, reports per-rep what WOULD stage.
 *   commit=true: creates/moves the PhoneBurner contacts. This can touch
 *     hundreds of contacts (many PhoneBurner API calls) so it runs in the
 *     BACKGROUND — poll GET on this route for the result.
 *   through=YYYY-MM-DD: include activities due through this date (default today;
 *     bump it out to pull a whole campaign week forward).
 *
 * Auth: x-admin-key: jaxy2026.
 */

const RUN_KEY = "daily_folders_run";

function getSetting(key: string): string | null {
  return (sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'phoneburner', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

export async function GET() {
  const raw = getSetting(RUN_KEY);
  return NextResponse.json(raw ? JSON.parse(raw) : { state: "idle" });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const commit = url.searchParams.get("commit") === "true";
  const through = url.searchParams.get("through") || undefined;

  // Dry-run is fast (a couple of list calls) — run it inline.
  if (!commit) {
    const result = await buildDailyCallFolders({ dryRun: true, through });
    return NextResponse.json({ commit: false, ...result });
  }

  // Commit can move hundreds of contacts → background it so it doesn't hit the
  // ~100s edge timeout. Poll GET for the result.
  setSetting(RUN_KEY, JSON.stringify({ state: "running", through: through ?? "today", startedAt: new Date().toISOString() }));
  void (async () => {
    try {
      const result = await buildDailyCallFolders({ dryRun: false, through });
      setSetting(RUN_KEY, JSON.stringify({ state: "done", ...result, finishedAt: new Date().toISOString() }));
    } catch (e) {
      setSetting(RUN_KEY, JSON.stringify({ state: "error", error: e instanceof Error ? e.message : String(e), finishedAt: new Date().toISOString() }));
    }
  })();

  return NextResponse.json({ ok: true, commit: true, started: true, through: through ?? "today", note: "Running in background — poll GET on this route for the result." });
}
