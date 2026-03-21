export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { orders, orderItems } from "@/modules/orders/schema";
import { companies } from "@/modules/sales/schema";
import { createManualOrder, type CreateOrderInput } from "@/modules/orders/lib/faire-sync";
import { desc, eq, and, like, sql, gte, lte } from "drizzle-orm";

// GET /api/v1/orders — list orders with filters
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "25"), 100);
  const search = url.searchParams.get("search") || "";
  const channel = url.searchParams.get("channel");
  const status = url.searchParams.get("status");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");
  const sort = url.searchParams.get("sort") || "placed_at";
  const order = url.searchParams.get("order") || "desc";

  const conditions: ReturnType<typeof eq>[] = [];
  if (channel) conditions.push(eq(orders.channel, channel as any));
  if (status) conditions.push(eq(orders.status, status as any));
  if (dateFrom) conditions.push(gte(orders.placedAt, dateFrom));
  if (dateTo) conditions.push(lte(orders.placedAt, dateTo));
  if (search) {
    conditions.push(
      sql`(${orders.orderNumber} LIKE ${'%' + search + '%'} OR EXISTS (SELECT 1 FROM companies c WHERE c.id = ${orders.companyId} AND c.name LIKE ${'%' + search + '%'}))`
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total = db.select({ count: sql<number>`count(*)` }).from(orders).where(where).get()?.count || 0;

  const sortCol = sort === "total" ? orders.total : sort === "order_number" ? orders.orderNumber : orders.placedAt;
  const orderDir = order === "asc" ? sql`ASC` : sql`DESC`;

  const data = db
    .select()
    .from(orders)
    .where(where)
    .orderBy(order === "asc" ? sortCol : desc(sortCol))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();

  // Enrich with company name and item count
  const enriched = data.map((o) => {
    const company = o.companyId
      ? db.select({ name: companies.name }).from(companies).where(eq(companies.id, o.companyId)).get()
      : null;
    const itemCount = db
      .select({ count: sql<number>`count(*)` })
      .from(orderItems)
      .where(eq(orderItems.orderId, o.id))
      .get()?.count || 0;

    return {
      ...o,
      companyName: company?.name || null,
      itemCount,
    };
  });

  return NextResponse.json({
    data: enriched,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}

// POST /api/v1/orders — create manual order
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as CreateOrderInput;

    if (!body.items || body.items.length === 0) {
      return NextResponse.json({ error: "At least one item is required" }, { status: 400 });
    }
    if (!body.channel || !["direct", "phone"].includes(body.channel)) {
      return NextResponse.json({ error: "Channel must be 'direct' or 'phone'" }, { status: 400 });
    }

    const newOrder = createManualOrder(body);
    return NextResponse.json(newOrder, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
