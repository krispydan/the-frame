export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";

/**
 * POST /api/admin/sales/create-ajm-callable-folder
 *
 * Fresh-folder cleanup pivot: PB's API cannot remove contacts from a
 * folder (PUT/PATCH/DELETE all silent no-ops on category_id). So we
 * create a NEW folder containing ONLY the verified callable cohort,
 * and Sandra & Christina dial from that folder. The old ignore-riddled
 * folder gets abandoned.
 *
 * Body: {
 *   folder_name?: "AJM Callable - Verified 2026-08",
 *   callable: [{email, company, phone, first_name, last_name, city, state,
 *               total_orders, total_spend, first_order, last_order, category}, ...],
 *   dryRun?: true,
 *   existing_folder_id?: string  // reuse instead of creating
 * }
 *
 * Auth: x-admin-key: jaxy2026
 */

interface Callable {
  email: string;
  company?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  state?: string;
  total_orders?: string;
  total_spend?: string;
  first_order?: string;
  last_order?: string;
  category?: string;
  // If provided, use as-is (verbatim) as the PB note. Overrides the
  // built-in thin template. The caller — usually a Python generator
  // that has all AJM columns handy — builds the rich note.
  notes?: string;
}

async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("[create-ajm-callable-folder] crashed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

async function handle(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as {
    folder_name?: string;
    callable?: Callable[];
    dryRun?: boolean;
    existing_folder_id?: string;
  };
  const callable = (body.callable || []).filter((r) => r.email);
  if (callable.length === 0) {
    return NextResponse.json({ ok: false, error: "callable[] required" }, { status: 400 });
  }
  const folderName = body.folder_name || `AJM Callable - Verified ${new Date().toISOString().slice(0, 10)}`;

  // Resolve owner_id
  const cached = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'phoneburner_owner_id' LIMIT 1")
    .get() as { value: string | null } | undefined;
  const ownerId = cached?.value || (await phoneBurnerClient.discoverOwnerId()) || "";
  if (!ownerId) {
    return NextResponse.json({ ok: false, error: "PhoneBurner owner_id unavailable" }, { status: 502 });
  }

  // Step 1: create or reuse folder
  let folderId = body.existing_folder_id?.trim() || "";
  let created = false;
  if (!folderId && !body.dryRun) {
    const folder = await phoneBurnerClient.createFolder({
      folder_name: folderName,
      description: `Verified callable AJM leads (ignore-list scrubbed). Created by Frame.`,
      owner_id: ownerId,
    });
    folderId = String(folder.id || (folder as unknown as { category_id?: string }).category_id || "");
    created = true;
    if (!folderId) {
      return NextResponse.json(
        { ok: false, error: "createFolder returned no id", folder },
        { status: 502 },
      );
    }
  }

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      folder_name: folderName,
      would_create_folder: !body.existing_folder_id,
      would_add: callable.length,
      sample: callable.slice(0, 5),
    });
  }

  // Step 2: push callables into the new folder
  let added = 0;
  const errors: Array<{ email: string; reason: string }> = [];

  await runWithConcurrency(callable, 6, async (r) => {
    try {
      let noteBody: string;
      if (r.notes && r.notes.trim().length > 0) {
        noteBody = r.notes;
      } else {
        const noteLines: string[] = [
          `AJM callable: ${r.company || ""}${r.city ? ` — ${r.city}, ${r.state || ""}` : ""}`,
        ];
        if (r.total_orders) noteLines.push(`${r.total_orders} orders / ${r.total_spend || "-"} lifetime`);
        if (r.first_order || r.last_order) noteLines.push(`first ${r.first_order || "-"} last ${r.last_order || "-"}`);
        if (r.category) noteLines.push(`AJM cat: ${r.category}`);
        noteBody = noteLines.join("\n");
      }

      const { id } = await phoneBurnerClient.createOrGetContact({
        owner_id: ownerId,
        first_name: (r.first_name || r.company || "").slice(0, 64) || "-",
        last_name: r.last_name || r.company?.slice(0, 40) || "-",
        email: r.email,
        phone: r.phone || undefined,
        category_id: folderId,
        notes: noteBody,
        on_duplicate: "update",
      });
      if (!id) throw new Error("createOrGetContact returned no id");
      added++;
    } catch (e) {
      errors.push({ email: r.email, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  });

  return NextResponse.json({
    ok: true,
    folder_id: folderId,
    folder_name: folderName,
    folder_created: created,
    input_count: callable.length,
    added,
    error_count: errors.length,
    errors: errors.slice(0, 20),
  });
}
