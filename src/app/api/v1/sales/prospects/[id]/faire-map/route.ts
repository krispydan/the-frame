export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { sqlite } from "@/lib/db";

/**
 * POST /api/v1/sales/prospects/[id]/faire-map
 *
 * Manually map an anonymized Faire customer to a real website + email. Sets the
 * company website, adds the real email as a contact (canonical store), logs the
 * change, and best-effort propagates the website/email to Pipedrive if the
 * company is already an org there.
 *
 * Body: { website?: string, email?: string }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { website?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  const website = (body.website || "").trim();
  const email = (body.email || "").trim();
  if (!website && !email) {
    return NextResponse.json({ error: "Provide a website and/or email" }, { status: 400 });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const company = sqlite.prepare("SELECT id, website FROM companies WHERE id = ?").get(id) as
    | { id: string; website: string | null }
    | undefined;
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 1. Website on the company row.
  if (website) {
    sqlite.prepare("UPDATE companies SET website = ?, updated_at = datetime('now') WHERE id = ?").run(website, id);
    sqlite
      .prepare(
        `INSERT INTO change_logs (id, entity_type, entity_id, field, old_value, new_value, source)
         VALUES (?, 'company', ?, 'website', ?, ?, 'ui')`,
      )
      .run(crypto.randomUUID(), id, company.website ?? "", website);
  }

  // 2. Real email → canonical contacts store.
  if (email) {
    const { addCompanyEmail } = await import("@/modules/sales/lib/company-emails");
    addCompanyEmail(id, email, "faire_manual_map");
    sqlite
      .prepare(
        `INSERT INTO change_logs (id, entity_type, entity_id, field, old_value, new_value, source)
         VALUES (?, 'company', ?, 'email', '', ?, 'ui')`,
      )
      .run(crypto.randomUUID(), id, email);
  }

  // 3. Best-effort propagate to Pipedrive if this company is already an org.
  let pipedrive: Record<string, unknown> = { updated: false };
  try {
    const org = sqlite.prepare("SELECT pipedrive_org_id, pipedrive_person_id FROM companies WHERE id = ?").get(id) as
      | { pipedrive_org_id: number | null; pipedrive_person_id: number | null }
      | undefined;
    if (org?.pipedrive_org_id) {
      const { ensureCustomFields } = await import("@/modules/sales/lib/pipedrive-sync");
      const { updateOrganization, pdRequest } = await import("@/modules/sales/lib/pipedrive-client");
      const keys = await ensureCustomFields();
      if (website && keys.orgWebsite) {
        await updateOrganization(org.pipedrive_org_id, { [keys.orgWebsite]: website });
      }
      if (email && org.pipedrive_person_id) {
        await pdRequest("PUT", `/persons/${org.pipedrive_person_id}`, { email: [email] });
      }
      pipedrive = { updated: true };
    }
  } catch (e) {
    pipedrive = { updated: false, error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({ success: true, pipedrive });
}
