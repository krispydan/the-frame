export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { smartLists } from "@/modules/sales/schema";
import { eq, desc } from "drizzle-orm";

export async function GET() {
  const lists = db.select().from(smartLists).orderBy(desc(smartLists.isDefault), smartLists.name).all();
  return NextResponse.json({ data: lists });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, description, filters, is_shared } = body;

  if (!name || !filters) {
    return NextResponse.json({ error: "name and filters required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  db.insert(smartLists).values({
    id,
    name,
    description: description || null,
    filters,
    isShared: is_shared !== false,
    resultCount: 0,
  }).run();

  // Calculate result count
  try {
    const count = countForFilters(filters);
    db.update(smartLists).set({ resultCount: count }).where(eq(smartLists.id, id)).run();
  } catch {}

  const created = db.select().from(smartLists).where(eq(smartLists.id, id)).get();
  return NextResponse.json({ data: created }, { status: 201 });
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const { id, name, description, filters, is_shared } = body;

  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (filters !== undefined) updates.filters = filters;
  if (is_shared !== undefined) updates.isShared = is_shared;

  db.update(smartLists).set(updates).where(eq(smartLists.id, id)).run();

  if (filters) {
    try {
      const count = countForFilters(filters);
      db.update(smartLists).set({ resultCount: count }).where(eq(smartLists.id, id)).run();
    } catch {}
  }

  const updated = db.select().from(smartLists).where(eq(smartLists.id, id)).get();
  return NextResponse.json({ data: updated });
}

export async function DELETE(request: NextRequest) {
  const { id } = await request.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Don't delete default lists
  const list = db.select().from(smartLists).where(eq(smartLists.id, id)).get();
  if (list?.isDefault) {
    return NextResponse.json({ error: "Cannot delete default smart lists" }, { status: 403 });
  }

  db.delete(smartLists).where(eq(smartLists.id, id)).run();
  return NextResponse.json({ success: true });
}

// Helper: count companies matching filters
function countForFilters(filters: Record<string, unknown>): number {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const stateArr = filters.state as string[] | undefined;
  if (stateArr?.length) {
    clauses.push(`state IN (${stateArr.map(() => "?").join(",")})`);
    params.push(...stateArr);
  }

  const catArr = filters.category as string[] | undefined;
  if (catArr?.length) {
    clauses.push(`(${catArr.map(() => "tags LIKE ?").join(" OR ")})`);
    params.push(...catArr.map(c => `%${c}%`));
  }

  const srcArr = filters.source as string[] | undefined;
  if (srcArr?.length) {
    clauses.push(`(${srcArr.map(() => "source LIKE ?").join(" OR ")})`);
    params.push(...srcArr.map(s => `%${s}%`));
  }

  const statusArr = filters.status as string[] | undefined;
  if (statusArr?.length) {
    clauses.push(`status IN (${statusArr.map(() => "?").join(",")})`);
    params.push(...statusArr);
  }

  if (filters.icp_min) { clauses.push(`icp_score >= ?`); params.push(Number(filters.icp_min)); }
  if (filters.icp_max) { clauses.push(`icp_score <= ?`); params.push(Number(filters.icp_max)); }
  if (filters.has_email === "true") clauses.push(`email IS NOT NULL AND email != ''`);
  else if (filters.has_email === "false") clauses.push(`(email IS NULL OR email = '')`);
  if (filters.has_phone === "true") clauses.push(`phone IS NOT NULL AND phone != ''`);
  else if (filters.has_phone === "false") clauses.push(`(phone IS NULL OR phone = '')`);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = sqlite.prepare(`SELECT count(*) as c FROM companies ${where}`).get(...params) as { c: number };
  return row.c;
}
