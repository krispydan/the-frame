export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { and, eq, gte, lte, desc, asc } from "drizzle-orm";

/**
 * GET /api/v1/marketing/email/campaigns
 *
 * Query params:
 *   audience    retail | wholesale
 *   status      one of the 10 workflow states
 *   weekOf      ISO date of the Monday — exact match
 *   from / to   inclusive date range on scheduled_date
 *   order       'date_asc' (default) | 'date_desc'
 *
 * Returns array of campaign rows, no pagination yet (volume = ~4/week,
 * we never load more than a few hundred at once).
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const audience = sp.get("audience");
  const status = sp.get("status");
  const weekOf = sp.get("weekOf");
  const from = sp.get("from");
  const to = sp.get("to");
  const order = sp.get("order") === "date_desc" ? "date_desc" : "date_asc";

  const conditions = [];
  if (audience === "retail" || audience === "wholesale") {
    conditions.push(eq(emailCampaigns.audience, audience));
  }
  if (status) {
    // Cast through unknown — Drizzle's typed enum column doesn't accept
    // a raw string at compile time, but we accept whatever the user
    // passes and let SQLite filter (unknown statuses just return 0 rows).
    conditions.push(eq(emailCampaigns.status, status as never));
  }
  if (weekOf) conditions.push(eq(emailCampaigns.weekOf, weekOf));
  if (from) conditions.push(gte(emailCampaigns.scheduledDate, from));
  if (to) conditions.push(lte(emailCampaigns.scheduledDate, to));

  const orderClause =
    order === "date_desc"
      ? desc(emailCampaigns.scheduledDate)
      : asc(emailCampaigns.scheduledDate);

  const rows =
    conditions.length > 0
      ? await db
          .select()
          .from(emailCampaigns)
          .where(and(...conditions))
          .orderBy(orderClause)
      : await db.select().from(emailCampaigns).orderBy(orderClause);

  return NextResponse.json({ campaigns: rows });
}

/**
 * POST /api/v1/marketing/email/campaigns
 *
 * Body:
 *   audience       required: retail | wholesale
 *   scheduledDate  required: ISO date (YYYY-MM-DD)
 *   weekOf         optional: ISO Monday date (auto-computed from
 *                  scheduledDate if omitted)
 *
 * Creates an empty campaign in status 'idea'. Variants get their
 * schema defaults. Everything else is fillable later via PATCH or
 * AI generation.
 */
export async function POST(req: NextRequest) {
  let body: {
    audience?: "retail" | "wholesale";
    scheduledDate?: string;
    weekOf?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  if (body.audience !== "retail" && body.audience !== "wholesale") {
    return NextResponse.json(
      { error: "audience must be 'retail' or 'wholesale'" },
      { status: 400 },
    );
  }
  if (!body.scheduledDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.scheduledDate)) {
    return NextResponse.json(
      { error: "scheduledDate (YYYY-MM-DD) required" },
      { status: 400 },
    );
  }

  // Compute the Monday of the campaign's scheduledDate week if not given.
  const weekOf = body.weekOf ?? mondayOf(body.scheduledDate);

  const id = crypto.randomUUID();
  await db.insert(emailCampaigns).values({
    id,
    audience: body.audience,
    scheduledDate: body.scheduledDate,
    weekOf,
    status: "idea",
  });

  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);

  return NextResponse.json({ campaign: row }, { status: 201 });
}

/** Return the ISO date of the Monday of the week containing `iso`. */
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dayOfWeek = d.getUTCDay(); // 0 = Sun, 1 = Mon
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
