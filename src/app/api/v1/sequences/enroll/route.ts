/** Manual + bulk enrollment. Guards are in the lib, never in the caller. */
import { NextRequest, NextResponse } from "next/server";
import { enrollOne, enrollMany, companiesFromSmartList } from "@/modules/sequences/lib/enroll";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const { sequenceId, companyId, companyIds, smartListId, by, force, dryRun } = b as {
    sequenceId?: string; companyId?: string; companyIds?: string[];
    smartListId?: string; by?: string; force?: boolean; dryRun?: boolean;
  };
  if (!sequenceId) return NextResponse.json({ error: "sequenceId required" }, { status: 400 });

  if (companyId) return NextResponse.json(enrollOne(sequenceId, companyId, { by, force }));

  let ids = companyIds || [];
  if (smartListId) ids = companiesFromSmartList(smartListId);
  if (!ids.length) return NextResponse.json({ error: "companyId, companyIds or smartListId required" }, { status: 400 });
  return NextResponse.json(enrollMany(sequenceId, ids, { by, force, dryRun }));
}
