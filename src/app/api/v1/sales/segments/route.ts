export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

type SegmentRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icp_profile: string | null;
  email_templates: string | null;
  outreach_notes: string | null;
  status: string;
  prospect_count: number;
  qualified_count: number;
  customer_count: number;
  active_deals: number;
  pipeline_value: number;
  order_count: number;
  revenue: number;
  campaign_count: number;
};

export async function GET() {
  const rows = sqlite.prepare(`
    SELECT
      s.id,
      s.name,
      s.slug,
      s.description,
      s.icp_profile,
      s.email_templates,
      s.outreach_notes,
      s.status,
      (
        SELECT count(*)
        FROM companies c
        WHERE c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name))
      ) as prospect_count,
      (
        SELECT count(*)
        FROM companies c
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND c.status = 'qualified'
      ) as qualified_count,
      (
        SELECT count(*)
        FROM companies c
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND c.status = 'customer'
      ) as customer_count,
      (
        SELECT count(*)
        FROM deals d
        JOIN companies c ON c.id = d.company_id
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND d.stage NOT IN ('order_placed', 'not_interested')
      ) as active_deals,
      (
        SELECT coalesce(sum(coalesce(d.value, 0)), 0)
        FROM deals d
        JOIN companies c ON c.id = d.company_id
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND d.stage NOT IN ('order_placed', 'not_interested')
      ) as pipeline_value,
      (
        SELECT count(*)
        FROM orders o
        JOIN companies c ON c.id = o.company_id
        WHERE c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name))
      ) as order_count,
      (
        SELECT coalesce(sum(coalesce(o.total, 0)), 0)
        FROM orders o
        JOIN companies c ON c.id = o.company_id
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND o.status NOT IN ('cancelled', 'returned')
      ) as revenue,
      (
        SELECT count(*)
        FROM campaigns camp
        WHERE lower(trim(camp.target_segment)) = lower(trim(s.name))
      ) as campaign_count
    FROM segments s
    ORDER BY prospect_count DESC, s.name ASC
  `).all() as SegmentRow[];

  const summary = rows.reduce((acc, row) => {
    acc.segments += 1;
    acc.prospects += row.prospect_count;
    acc.qualified += row.qualified_count;
    acc.pipelineValue += row.pipeline_value;
    acc.revenue += row.revenue;
    return acc;
  }, {
    segments: 0,
    prospects: 0,
    qualified: 0,
    pipelineValue: 0,
    revenue: 0,
  });

  return NextResponse.json({ data: rows, summary });
}

function normalizeSegmentStatus(value: unknown): "active" | "paused" | "retired" {
  return value === "paused" || value === "retired" ? value : "active";
}

function slugifySegmentName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "segment";
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const name = String(body?.name || "").trim();

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const slug = slugifySegmentName(name);
  const status = normalizeSegmentStatus(body?.status);
  const description = typeof body?.description === "string" ? body.description.trim() || null : null;
  const icpProfile = typeof body?.icp_profile === "string" ? body.icp_profile.trim() || null : null;
  const emailTemplates = typeof body?.email_templates === "string" ? body.email_templates.trim() || null : null;
  const outreachNotes = typeof body?.outreach_notes === "string" ? body.outreach_notes.trim() || null : null;

  sqlite.prepare(`
    INSERT INTO segments (id, name, slug, description, icp_profile, email_templates, outreach_notes, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, slug, description, icpProfile, emailTemplates, outreachNotes, status, now, now);

  const segment = sqlite.prepare(`
    SELECT id, name, slug, description, icp_profile, email_templates, outreach_notes, status
    FROM segments
    WHERE id = ?
  `).get(id);

  return NextResponse.json({ data: segment }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const id = String(body?.id || "").trim();
  const name = String(body?.name || "").trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const slug = slugifySegmentName(name);
  const status = normalizeSegmentStatus(body?.status);
  const description = typeof body?.description === "string" ? body.description.trim() || null : null;
  const icpProfile = typeof body?.icp_profile === "string" ? body.icp_profile.trim() || null : null;
  const emailTemplates = typeof body?.email_templates === "string" ? body.email_templates.trim() || null : null;
  const outreachNotes = typeof body?.outreach_notes === "string" ? body.outreach_notes.trim() || null : null;

  const result = sqlite.prepare(`
    UPDATE segments
    SET name = ?, slug = ?, description = ?, icp_profile = ?, email_templates = ?, outreach_notes = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(name, slug, description, icpProfile, emailTemplates, outreachNotes, status, now, id);

  if (result.changes === 0) {
    return NextResponse.json({ error: "segment not found" }, { status: 404 });
  }

  const segment = sqlite.prepare(`
    SELECT id, name, slug, description, icp_profile, email_templates, outreach_notes, status
    FROM segments
    WHERE id = ?
  `).get(id);

  return NextResponse.json({ data: segment });
}
