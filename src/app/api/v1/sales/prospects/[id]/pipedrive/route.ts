export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import {
  getPipedriveConnectionStatus,
  getOrganization,
  getPerson,
  listDealsForOrg,
  listActivitiesForOrg,
  listStages,
  listPipelines,
  listUsers,
  createDeal,
  updateDeal,
} from "@/modules/sales/lib/pipedrive-client";
import {
  resolveOrg,
  resolvePerson,
  ensureOutreachDeal,
  reassignOwner,
  isSyncEnabled,
  PipedriveNotReadyError,
} from "@/modules/sales/lib/pipedrive-sync";
import { getPipelineConfig, getPipedriveOwner, getPipelineOwner } from "@/modules/sales/lib/pipedrive-setup";

function getCompany(id: string) {
  return sqlite
    .prepare("SELECT id, name, pipedrive_org_id, pipedrive_person_id FROM companies WHERE id = ?")
    .get(id) as { id: string; name: string | null; pipedrive_org_id: number | null; pipedrive_person_id: number | null } | undefined;
}

function ownerName(user: { id?: number; name?: string } | number | undefined, users: Map<number, string>): string | null {
  if (user == null) return null;
  if (typeof user === "number") return users.get(user) ?? null;
  return user.name ?? (user.id ? users.get(user.id) ?? null : null);
}

/**
 * Pipedrive person email/phone are arrays of { value, primary, label }
 * (occasionally a bare string). Return the primary value, else the first.
 */
function primaryValue(field: unknown): string | null {
  if (field == null) return null;
  if (typeof field === "string") return field || null;
  if (Array.isArray(field)) {
    const arr = field as Array<{ value?: string; primary?: boolean }>;
    const primary = arr.find((e) => e?.primary && e?.value) ?? arr.find((e) => e?.value);
    return primary?.value ?? null;
  }
  return null;
}

/**
 * GET /api/v1/sales/prospects/[id]/pipedrive
 *
 * Live Pipedrive summary for a company's detail page: the org, its deals
 * (pipeline · stage · owner · value · status + deep link) and recent
 * activities. Falls back to the local pipedrive_deals projection if a live
 * call fails or the company isn't synced yet.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = getCompany(id);
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const status = getPipedriveConnectionStatus();
  const projection = sqlite
    .prepare("SELECT pipedrive_deal_id, pipeline, stage, status, value, title FROM pipedrive_deals WHERE company_id = ? ORDER BY updated_at DESC")
    .all(id) as Array<Record<string, unknown>>;

  const out: Record<string, unknown> = {
    connected: status.connected,
    apiDomain: status.apiDomain ?? null,
    syncEnabled: isSyncEnabled(),
    orgId: company.pipedrive_org_id,
    personId: company.pipedrive_person_id,
    synced: !!company.pipedrive_org_id,
    projection,
  };

  if (!status.connected || !company.pipedrive_org_id) {
    return NextResponse.json(out);
  }

  try {
    const [org, person, deals, activities, stages, pipelines, users] = await Promise.all([
      getOrganization(company.pipedrive_org_id),
      company.pipedrive_person_id ? getPerson(company.pipedrive_person_id) : Promise.resolve(null),
      listDealsForOrg(company.pipedrive_org_id),
      listActivitiesForOrg(company.pipedrive_org_id),
      listStages(),
      listPipelines(),
      listUsers(),
    ]);
    const stageName = new Map(stages.map((s) => [s.id, s.name]));
    const pipeName = new Map(pipelines.map((p) => [p.id, p.name]));
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const base = status.apiDomain ?? "";

    out.org = org
      ? {
          name: org.name,
          address: org.address ?? null,
          website: (org.website as string) ?? null,
          owner: ownerName(org.owner_id as { id?: number; name?: string } | number | undefined, userName),
          url: base ? `${base}/organization/${org.id}` : null,
        }
      : null;
    out.person = company.pipedrive_person_id
      ? {
          id: company.pipedrive_person_id,
          name: person?.name ?? null,
          email: primaryValue(person?.email),
          phone: primaryValue(person?.phone),
          url: base ? `${base}/person/${company.pipedrive_person_id}` : null,
        }
      : null;
    out.deals = (deals || []).map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status,
      value: d.value ?? null,
      currency: d.currency ?? "USD",
      pipeline: d.pipeline_id != null ? pipeName.get(d.pipeline_id) ?? null : null,
      stage: d.stage_id != null ? stageName.get(d.stage_id) ?? null : null,
      owner: ownerName(d.user_id, userName),
      updateTime: d.update_time ?? d.add_time ?? null,
      url: base ? `${base}/deal/${d.id}` : null,
    }));
    out.activities = (activities || []).map((a) => ({
      subject: a.subject ?? a.type ?? "activity",
      type: a.type ?? null,
      done: !!a.done,
      date: a.marked_as_done_time ?? a.due_date ?? a.add_time ?? null,
      note: a.note ?? null,
    }));
  } catch (e) {
    out.liveError = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json(out);
}

/**
 * POST /api/v1/sales/prospects/[id]/pipedrive
 *
 *   { action: "push" }                                   → create/link org + person
 *   { action: "create-deal", pipelineKey, stageName,
 *     ownerId?, value?, title? }                          → create a deal in a pipeline
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = getCompany(id);
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { action?: string; pipelineKey?: "ajm" | "catalog" | "customers"; stageName?: string; ownerId?: number; value?: number; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body required" }, { status: 400 });
  }

  try {
    if (body.action === "push") {
      const owner = getPipedriveOwner()?.id;
      const orgId = await resolveOrg(id, owner);
      const personId = await resolvePerson(id, orgId, owner);
      return NextResponse.json({ ok: true, orgId, personId });
    }

    if (body.action === "reassign-owner") {
      const r = await reassignOwner(id);
      return NextResponse.json({ ok: !r.skipped, ...r });
    }

    if (body.action === "create-deal") {
      const config = getPipelineConfig();
      if (!config) return NextResponse.json({ ok: false, error: "Pipelines not provisioned" }, { status: 409 });
      const pipelineKey = body.pipelineKey || "catalog";
      const owner = body.ownerId || getPipelineOwner(pipelineKey)?.id;

      if (pipelineKey === "ajm" || pipelineKey === "catalog") {
        const stageName = body.stageName || (pipelineKey === "ajm" ? "To Contact" : "Interested");
        const r = await ensureOutreachDeal(id, pipelineKey, stageName);
        if (r.dealId && body.ownerId) await updateDeal(r.dealId, { user_id: body.ownerId });
        return NextResponse.json({ ok: true, ...r });
      }

      // Customers pipeline — direct create.
      const meta = config.customers;
      const stageName = body.stageName || Object.keys(meta.stages)[0];
      const orgId = await resolveOrg(id, owner);
      const personId = await resolvePerson(id, orgId, owner);
      const c = getCompany(id);
      const dealBody: Record<string, unknown> = {
        title: body.title || `${c?.name || "Customer"} — deal`,
        org_id: orgId,
        pipeline_id: meta.pipelineId,
        stage_id: meta.stages[stageName],
        status: "open",
      };
      if (personId) dealBody.person_id = personId;
      if (owner) dealBody.user_id = owner;
      if (body.value != null) dealBody.value = body.value;
      const created = await createDeal(dealBody as { title: string });
      return NextResponse.json({ ok: true, dealId: created.id });
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${body.action}` }, { status: 400 });
  } catch (e) {
    if (e instanceof PipedriveNotReadyError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
