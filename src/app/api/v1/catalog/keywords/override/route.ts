export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/v1/catalog/keywords/override
 *
 * JSON body: { phrase: string, status: "whitelist" | "blacklist" | "clear" }
 *
 * Sets catalog_keywords.override_status for every row of `phrase` (across
 * sources). The assembler honors it: whitelist forces a keep even if the
 * scrub said otherwise; blacklist removes the phrase from every product's
 * pools; clear reverts to the scrub verdict.
 *
 * Survives re-imports — the importer preserves override_status on upsert.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const phrase = typeof body.phrase === "string" ? body.phrase.trim().toLowerCase() : "";
    const status = body.status;

    if (!phrase) {
      return NextResponse.json({ ok: false, error: "phrase required" }, { status: 400 });
    }
    if (status !== "whitelist" && status !== "blacklist" && status !== "clear") {
      return NextResponse.json(
        { ok: false, error: "status must be whitelist | blacklist | clear" },
        { status: 400 },
      );
    }

    const value = status === "clear" ? null : status;
    const res = sqlite
      .prepare("UPDATE catalog_keywords SET override_status = ? WHERE phrase = ?")
      .run(value, phrase);

    return NextResponse.json({ ok: true, phrase, status, rowsUpdated: res.changes });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
