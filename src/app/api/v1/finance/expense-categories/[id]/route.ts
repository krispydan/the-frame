export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expenseCategories } from "@/modules/finance/schema";
import { eq } from "drizzle-orm";

// PATCH /api/v1/finance/expense-categories/:id
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.parentId !== undefined) updates.parentId = body.parentId || null;
  if (body.budgetMonthly !== undefined) updates.budgetMonthly = body.budgetMonthly ? parseFloat(body.budgetMonthly) : null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  db.update(expenseCategories).set(updates).where(eq(expenseCategories.id, id)).run();
  return NextResponse.json({ success: true });
}

// DELETE /api/v1/finance/expense-categories/:id
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  db.delete(expenseCategories).where(eq(expenseCategories.id, id)).run();
  return NextResponse.json({ success: true });
}
