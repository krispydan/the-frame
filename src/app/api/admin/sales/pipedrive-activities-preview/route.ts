export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { listActivities, listUsers, type PdActivity } from "@/modules/sales/lib/pipedrive-client";

/**
 * GET /api/admin/sales/pipedrive-activities-preview?type=call&through=today
 *
 * Read-only preview of the open Pipedrive activities that would drive the
 * PhoneBurner call lists. Groups by owner, and for each resolves whether
 * we already have a PB contact (so we can see how many we'd need to create).
 * Also returns a raw sample so we can confirm the real activity shape
 * (owner field, person linkage, type key) before wiring the builder.
 *
 * Query: type (default "call"; pass "all" to see every open type),
 *        through ("today" default | "YYYY-MM-DD" | "all")
 * Auth: x-admin-key: jaxy2026
 */
function todayUtc(): string {
  // Date math is fine here (request-time, not persisted).
  return new Date().toISOString().slice(0, 10);
}

interface OwnerBucket {
  owner_id: number | null;
  owner_name: string | null;
  total: number;
  with_pb_contact: number;
  need_pb_contact: number;
  unresolved_company: number;
  sample: Array<{ activity_id: number; subject: string | undefined; due: string | undefined; company: string | null; has_pb_contact: boolean }>;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const typeParam = (url.searchParams.get("type") || "call").toLowerCase();
  const through = url.searchParams.get("through") || "today";

  const params: Parameters<typeof listActivities>[0] = { user_id: 0, done: 0, limit: 500 };
  if (typeParam !== "all") params.type = typeParam;
  if (through !== "all") params.end_date = through === "today" ? todayUtc() : through;

  let activities: PdActivity[];
  let users: Array<{ id: number; name: string }> = [];
  try {
    [activities, users] = await Promise.all([listActivities(params), listUsers()]);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  const userName = new Map(users.map((u) => [u.id, u.name]));

  const companyByPerson = sqlite.prepare(
    "SELECT id, name FROM companies WHERE pipedrive_person_id = ? LIMIT 1",
  );
  const pbContact = sqlite.prepare(
    "SELECT pb_contact_id FROM phoneburner_folder_pushes WHERE company_id = ? AND pb_contact_id IS NOT NULL AND TRIM(pb_contact_id) <> '' LIMIT 1",
  );

  const ownerField = (a: PdActivity): number | null => {
    const v = (a.owner_id ?? a.user_id ?? a.assigned_to_user_id) as unknown;
    return typeof v === "number" ? v : v && typeof v === "object" && "id" in (v as object) ? (v as { id: number }).id : null;
  };
  const personField = (a: PdActivity): number | null => {
    const v = a.person_id as unknown;
    return typeof v === "number" ? v : v && typeof v === "object" && "value" in (v as object) ? (v as { value: number }).value : null;
  };

  const buckets = new Map<number | string, OwnerBucket>();
  const typeCounts: Record<string, number> = {};
  for (const a of activities) {
    typeCounts[String(a.type)] = (typeCounts[String(a.type)] ?? 0) + 1;
    const oid = ownerField(a);
    const key = oid ?? "unassigned";
    let b = buckets.get(key);
    if (!b) {
      b = { owner_id: oid, owner_name: oid ? userName.get(oid) ?? null : null, total: 0, with_pb_contact: 0, need_pb_contact: 0, unresolved_company: 0, sample: [] };
      buckets.set(key, b);
    }
    b.total++;
    const pid = personField(a);
    const co = pid ? (companyByPerson.get(pid) as { id: string; name: string } | undefined) : undefined;
    if (!co) {
      b.unresolved_company++;
    } else {
      const has = !!pbContact.get(co.id);
      if (has) b.with_pb_contact++; else b.need_pb_contact++;
      if (b.sample.length < 5) b.sample.push({ activity_id: a.id, subject: a.subject, due: a.due_date, company: co.name, has_pb_contact: has });
    }
  }

  return NextResponse.json({
    ok: true,
    filter: { type: typeParam, through, end_date: params.end_date ?? null },
    total_activities: activities.length,
    type_distribution: typeCounts,
    owners: [...buckets.values()].sort((a, b) => b.total - a.total),
    raw_sample: activities.slice(0, 2),
  });
}
