export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expenses, expenseCategories } from "@/modules/finance/schema";
import { eq, desc, and, gte, lte, sql } from "drizzle-orm";

// GET /api/v1/finance/expenses
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const categoryId = url.searchParams.get("category");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");
  const recurring = url.searchParams.get("recurring");
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = (page - 1) * limit;

  const conditions = [];
  if (categoryId) conditions.push(eq(expenses.categoryId, categoryId));
  if (dateFrom) conditions.push(gte(expenses.date, dateFrom));
  if (dateTo) conditions.push(lte(expenses.date, dateTo));
  if (recurring === "true") conditions.push(eq(expenses.recurring, true));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const data = db
    .select({
      id: expenses.id,
      categoryId: expenses.categoryId,
      categoryName: expenseCategories.name,
      description: expenses.description,
      amount: expenses.amount,
      vendor: expenses.vendor,
      date: expenses.date,
      recurring: expenses.recurring,
      frequency: expenses.frequency,
      notes: expenses.notes,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(where)
    .orderBy(desc(expenses.date))
    .limit(limit)
    .offset(offset)
    .all();

  const countResult = db.select({ count: sql<number>`count(*)` }).from(expenses).where(where).get();

  // Also return categories for the form
  const categories = db.select().from(expenseCategories).all();

  return NextResponse.json({
    expenses: data,
    categories,
    total: countResult?.count || 0,
    page,
    limit,
  });
}

// POST /api/v1/finance/expenses — create expense
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { categoryId, description, amount, vendor, date, recurring, frequency, notes } = body;

  if (!description || !amount || !date) {
    return NextResponse.json({ error: "description, amount, and date are required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  db.insert(expenses).values({
    id,
    categoryId: categoryId || null,
    description,
    amount: parseFloat(amount),
    vendor: vendor || null,
    date,
    recurring: !!recurring,
    frequency: frequency || null,
    notes: notes || null,
  }).run();

  return NextResponse.json({ id, success: true }, { status: 201 });
}
