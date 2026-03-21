export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { batchEnrich, getCompaniesNeedingEnrichment } from "@/modules/sales/lib/enrichment";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { companyIds, source } = body;

  let ids: string[] = companyIds;
  if (!ids || ids.length === 0) {
    const needEnrichment = getCompaniesNeedingEnrichment(20);
    ids = needEnrichment.map((c) => c.id);
  }

  if (ids.length === 0) {
    return NextResponse.json({ message: "No companies need enrichment", enriched: 0, failed: 0 });
  }

  const result = await batchEnrich(ids);
  return NextResponse.json(result);
}
