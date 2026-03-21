export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settlements, settlementLineItems } from "@/modules/finance/schema";
import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
import { importShopifySettlementsFromCSV } from "@/modules/finance/lib/shopify-settlements";
import { importFaireSettlementCSV } from "@/modules/finance/lib/faire-settlements";

// GET /api/v1/finance/settlements
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const channel = url.searchParams.get("channel");
  const status = url.searchParams.get("status");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "25"), 100);
  const offset = (page - 1) * limit;

  const conditions = [];
  if (channel) conditions.push(eq(settlements.channel, channel as "shopify_dtc"));
  if (status) conditions.push(eq(settlements.status, status as "pending"));
  if (dateFrom) conditions.push(gte(settlements.periodStart, dateFrom));
  if (dateTo) conditions.push(lte(settlements.periodEnd, dateTo));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const data = db.select().from(settlements).where(where).orderBy(desc(settlements.periodEnd)).limit(limit).offset(offset).all();
  const countResult = db.select({ count: sql<number>`count(*)` }).from(settlements).where(where).get();

  return NextResponse.json({
    settlements: data,
    total: countResult?.count || 0,
    page,
    limit,
  });
}

// POST /api/v1/finance/settlements — import from CSV
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { csvData, channel, source } = body;

  if (!csvData) {
    return NextResponse.json({ error: "csvData is required" }, { status: 400 });
  }

  try {
    if (source === "faire" || channel === "faire") {
      const result = await importFaireSettlementCSV(csvData);
      return NextResponse.json(result);
    } else {
      const ch = channel === "shopify_wholesale" ? "shopify_wholesale" : "shopify_dtc";
      const result = await importShopifySettlementsFromCSV(csvData, ch);
      return NextResponse.json(result);
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
