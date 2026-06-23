export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailThemes, emailCampaigns } from "@/modules/marketing/schema";
import { eq, and, desc } from "drizzle-orm";
import { generateThemes } from "@/modules/marketing/lib/email-ai";

/**
 * POST /api/v1/marketing/email/themes/generate
 *
 * Body:
 *   audience    required: retail | wholesale
 *   weekStart   optional: ISO Monday date. Defaults to next Monday.
 *   count       optional: how many weeks of themes (default 4)
 *
 * Pulls the last 6 themes already used for this audience to avoid
 * repeats, calls Claude with the v3 theme prompt, inserts the
 * returned themes into marketing_email_themes.
 *
 * Returns the inserted theme rows.
 */
export async function POST(req: NextRequest) {
  let body: {
    audience?: "retail" | "wholesale";
    weekStart?: string;
    count?: number;
  } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }

  if (body.audience !== "retail" && body.audience !== "wholesale") {
    return NextResponse.json(
      { error: "audience required: retail | wholesale" },
      { status: 400 },
    );
  }

  const count = Math.min(Math.max(body.count ?? 4, 1), 8);
  const weekStart = body.weekStart ?? nextMonday();

  // Pull the most recent 6 campaigns for this audience to feed
  // into the "avoid repeating" guidance.
  const recent = await db
    .select({
      weekOf: emailCampaigns.weekOf,
      subject: emailCampaigns.subject,
      heroHeadline: emailCampaigns.heroHeadline,
    })
    .from(emailCampaigns)
    .where(eq(emailCampaigns.audience, body.audience))
    .orderBy(desc(emailCampaigns.scheduledDate))
    .limit(6);

  const result = await generateThemes({
    audience: body.audience,
    weekStart,
    count,
    recentCampaigns: recent.map((r) => ({
      weekOf: r.weekOf ?? "",
      theme: r.subject ?? r.heroHeadline ?? "(no subject)",
      productHook: null,
    })),
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  const themes = (result.output.themes ?? []) as Array<{
    weekOf: string;
    title: string;
    angle: string;
    productHook?: string | null;
    seasonalContext?: string | null;
    visualSuggestion?: string;
    themeShape?: string;
  }>;

  // Insert themes — return the inserted rows.
  const inserted = [];
  const insertStmt = sqlite.prepare(
    `INSERT INTO marketing_email_themes
       (id, week_of, audience, title, angle, product_hook, seasonal_context, raw_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );

  for (const t of themes) {
    const id = crypto.randomUUID();
    insertStmt.run(
      id,
      t.weekOf,
      body.audience,
      t.title,
      t.angle ?? null,
      t.productHook ?? null,
      t.seasonalContext ?? null,
      JSON.stringify(t),
    );
    inserted.push({ id, ...t });
  }

  return NextResponse.json({
    ok: true,
    themes: inserted,
    usage: result.usage,
  });
}

/** Next Monday ISO date — used as default weekStart. */
function nextMonday(): string {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + (day === 1 ? 7 : 8 - day));
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/v1/marketing/email/themes
 *
 * Query: ?audience=retail|wholesale  ?weekOf=YYYY-MM-DD
 * Lists themes for picker UI.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const audience = sp.get("audience");
  const weekOf = sp.get("weekOf");
  const conditions = [];
  if (audience === "retail" || audience === "wholesale") {
    conditions.push(eq(emailThemes.audience, audience));
  }
  if (weekOf) conditions.push(eq(emailThemes.weekOf, weekOf));

  const rows =
    conditions.length > 0
      ? await db.select().from(emailThemes).where(and(...conditions)).orderBy(desc(emailThemes.createdAt))
      : await db.select().from(emailThemes).orderBy(desc(emailThemes.createdAt));
  return NextResponse.json({ themes: rows });
}
