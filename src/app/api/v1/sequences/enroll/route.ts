/** Manual + bulk enrollment. Guards are in the lib, never in the caller. */
import { NextRequest, NextResponse } from "next/server";
import { enrollOne, enrollMany, companiesFromSmartList, checkEnrollable } from "@/modules/sequences/lib/enroll";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const { sequenceId, companyId, companyIds, smartListId, by, force, dryRun } = b as {
    sequenceId?: string; companyId?: string; companyIds?: string[];
    smartListId?: string; by?: string; force?: boolean; dryRun?: boolean;
  };
  if (!sequenceId) return NextResponse.json({ error: "sequenceId required" }, { status: 400 });

  if (companyId) {
    // A "preview" that actually enrolls is worse than no preview — and because
    // of the one-live-enrollment index it would bar the shop from everything else.
    if (dryRun) {
      const blocked = checkEnrollable(sequenceId, companyId, { force });
      return NextResponse.json(blocked ? { ok: false, skipped: blocked.reason, detail: blocked.detail } : { ok: true });
    }
    return NextResponse.json(enrollOne(sequenceId, companyId, { by, force }));
  }

  let ids = companyIds || [];
  if (ids.length && !ids.every((x) => typeof x === "string")) {
    return NextResponse.json({ error: "companyIds must be strings" }, { status: 400 });
  }
  if (smartListId) ids = companiesFromSmartList(smartListId);
  if (!ids.length) return NextResponse.json({ error: "companyId, companyIds or smartListId required" }, { status: 400 });
  // Bulk enrollment is a synchronous SQLite loop; an unbounded list would block
  // the event loop for the whole process.
  if (ids.length > 500) return NextResponse.json({ error: "max 500 companies per call" }, { status: 400 });
  return NextResponse.json(enrollMany(sequenceId, ids, { by, force, dryRun }));
}
