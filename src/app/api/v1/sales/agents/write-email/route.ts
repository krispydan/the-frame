export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { writeEmail } from "@/modules/sales/agents/email-copywriter";

export async function POST(req: NextRequest) {
  const { companyId, template } = await req.json();
  if (!companyId) return NextResponse.json({ error: "companyId required" }, { status: 400 });
  const result = writeEmail(companyId, template || "intro");
  if (!result) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  return NextResponse.json({ data: result });
}
