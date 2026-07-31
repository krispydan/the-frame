/**
 * POST /api/v1/marketing/videos/uploads/repair
 *
 * Body: { targets: [{ kind: "clip"|"source", id }] }
 *     | { adopt: ["clips/raw/….mp4"] }  — claim orphaned storage objects
 *     | { all: true }   — repair AND adopt everything the report found
 *
 * Re-runs the processing job for uploads whose BYTES are still in
 * storage. A failed normalize or split needs no upload at all — this is
 * what makes "re-upload everything" mostly unnecessary.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import {
  repairUploads,
  adoptOrphans,
  buildUploadHealthReport,
  type RepairTarget,
  type UploadKind,
} from "@/modules/marketing/lib/video/upload-preflight";

const KINDS = new Set<UploadKind>(["clip", "source"]);

export async function POST(request: NextRequest) {
  let body: { targets?: unknown; adopt?: unknown; all?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let targets: RepairTarget[] = [];
  let adoptPaths: string[] = [];

  if (body.all === true) {
    const report = await buildUploadHealthReport();
    targets = report.broken.filter((b) => b.repairable).map((b) => ({ kind: b.kind, id: b.id }));
    adoptPaths = report.orphans.map((o) => o.path);
  } else {
    if (Array.isArray(body.targets)) {
      targets = body.targets
        .map((t) => (t ?? {}) as Record<string, unknown>)
        .filter((t) => KINDS.has(t.kind as UploadKind) && typeof t.id === "string" && t.id)
        .map((t) => ({ kind: t.kind as UploadKind, id: t.id as string }));
    }
    if (Array.isArray(body.adopt)) {
      adoptPaths = body.adopt.filter((p): p is string => typeof p === "string" && !!p);
    }
    if (targets.length === 0 && adoptPaths.length === 0) {
      return NextResponse.json({ error: "targets, adopt, or all:true required" }, { status: 400 });
    }
  }

  try {
    const repaired = await repairUploads(targets);
    const claimed = await adoptOrphans(adoptPaths);
    return NextResponse.json({
      requeued: repaired.requeued,
      skipped: repaired.skipped + claimed.skipped,
      adopted: claimed.adopted,
      errors: [...repaired.errors, ...claimed.errors],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[upload repair] failed:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
