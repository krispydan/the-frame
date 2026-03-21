export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expenses } from "@/modules/finance/schema";
import { eq } from "drizzle-orm";

// GET /api/v1/finance/expenses/:id
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const expense = db.select().from(expenses).where(eq(expenses.id, id)).get();
  if (!expense) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(expense);
}

// PATCH /api/v1/finance/expenses/:id
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  const updates: Record<string, unknown> = {};
  if (body.categoryId !== undefined) updates.categoryId = body.categoryId;
  if (body.description !== undefined) updates.description = body.description;
  if (body.amount !== undefined) updates.amount = parseFloat(body.amount);
  if (body.vendor !== undefined) updates.vendor = body.vendor;
  if (body.date !== undefined) updates.date = body.date;
  if (body.recurring !== undefined) updates.recurring = !!body.recurring;
  if (body.frequency !== undefined) updates.frequency = body.frequency;
  if (body.notes !== undefined) updates.notes = body.notes;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  db.update(expenses).set(updates).where(eq(expenses.id, id)).run();
  return NextResponse.json({ success: true });
}

// DELETE /api/v1/finance/expenses/:id
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  db.delete(expenses).where(eq(expenses.id, id)).run();
  return NextResponse.json({ success: true });
}
