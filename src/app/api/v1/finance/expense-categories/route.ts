export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expenseCategories } from "@/modules/finance/schema";

// GET /api/v1/finance/expense-categories
export async function GET() {
  const data = db.select().from(expenseCategories).all();
  return NextResponse.json({ categories: data });
}

// POST /api/v1/finance/expense-categories
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, parentId, budgetMonthly } = body;
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const id = crypto.randomUUID();
  db.insert(expenseCategories).values({
    id,
    name,
    parentId: parentId || null,
    budgetMonthly: budgetMonthly ? parseFloat(budgetMonthly) : null,
  }).run();

  return NextResponse.json({ id, success: true }, { status: 201 });
}
