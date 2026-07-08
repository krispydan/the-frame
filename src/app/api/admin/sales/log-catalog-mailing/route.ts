export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getPipedriveConnectionStatus, createActivity } from "@/modules/sales/lib/pipedrive-client";
import { resolveOrg, resolvePerson, isSyncEnabled } from "@/modules/sales/lib/pipedrive-sync";
import { getPipedriveOwner } from "@/modules/sales/lib/pipedrive-setup";

/**
 * POST /api/admin/sales/log-catalog-mailing
 *
 * Logs a "physical catalog mailed" activity in Pipedrive (and on the frame
 * timeline) for a batch of mailed customers. Takes the mailing CSV directly:
 *
 *   curl -X POST ".../log-catalog-mailing?dryRun=true" \
 *     -H "x-admin-key: jaxy2026" -H "Content-Type: text/csv" \
 *     --data-binary @Uprinting_mailing.csv
 *
 * CSV columns (header row required): Company, EMAIL_ADR, First_Name,
 * Street_Address, Street_Address 2, City, State, Zip_Code, PHONE.
 *
 * Matching (row → frame company → Pipedrive org): email, then normalized
 * company name, then phone. Matched-but-unsynced companies are pushed to
 * Pipedrive first (unless pushUnsynced=false). Unmatched rows are reported.
 *
 * dryRun (default true): match-only, returns stats + samples, no writes.
 * dryRun=false: kicks a background run; poll GET on this route for progress.
 *
 * Idempotent: a per-company `catalog_mailed` activity-feed marker (keyed by
 * vendor + mailedDate) means a re-run skips anyone already logged.
 *
 * Auth: x-admin-key: jaxy2026
 */

const VENDOR = "Uprinting";
const RUN_KEY = "catalog_mailing_run";
const MARKER = "catalog_mailed";

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  return r?.value ?? null;
}
function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'sales', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

// ── CSV parse (RFC4180-ish: handles quoted fields with commas/newlines) ──
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((c) => c.trim() !== "")) rows.push(row); }
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, idx) => (o[h] = (r[idx] ?? "").trim()));
    return o;
  });
}

interface MailRow { company: string; email: string; name: string; addr1: string; addr2: string; city: string; state: string; zip: string; phone: string; }

function toMailRow(o: Record<string, string>): MailRow {
  return {
    company: o["Company"] || "",
    email: o["EMAIL_ADR"] || "",
    name: o["First_Name"] || "",
    addr1: o["Street_Address"] || "",
    addr2: o["Street_Address 2"] || "",
    city: o["City"] || "",
    state: o["State"] || "",
    zip: o["Zip_Code"] || "",
    phone: o["PHONE"] || "",
  };
}

const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => (s || "").replace(/\D+/g, "");

// Match a row → frame company. Statements are prepared per call (cheap; and,
// crucially, NOT at module load — which would run against an empty DB during
// `next build` page-data collection and fail the build).
function matchCompany(row: MailRow): { id: string; via: string } | null {
  if (row.email) {
    const m = sqlite
      .prepare(`SELECT company_id AS id FROM contacts WHERE lower(trim(email)) = ? AND company_id IS NOT NULL LIMIT 1`)
      .get(row.email.toLowerCase().trim()) as { id: string } | undefined;
    if (m?.id) return { id: m.id, via: "email" };
  }
  if (row.company) {
    const m = sqlite
      .prepare(`SELECT id FROM companies WHERE lower(trim(name)) = ? LIMIT 1`)
      .get(normName(row.company)) as { id: string } | undefined;
    if (m?.id) return { id: m.id, via: "name" };
  }
  const d = digits(row.phone);
  if (d.length >= 10) {
    const last10 = d.slice(-10);
    const m = sqlite
      .prepare(
        `SELECT company_id AS id FROM company_phones WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'(',''),')',''),'-',''),' ',''),'+','') LIKE ? AND company_id IS NOT NULL LIMIT 1`,
      )
      .get(`%${last10}`) as { id: string } | undefined;
    if (m?.id) return { id: m.id, via: "phone" };
  }
  return null;
}

function alreadyLogged(companyId: string, dateKey: string): boolean {
  const r = sqlite
    .prepare(`SELECT 1 FROM activity_feed WHERE event_type = ? AND entity_id = ? AND data LIKE ? LIMIT 1`)
    .get(MARKER, companyId, `%"key":"${VENDOR}:${dateKey}"%`);
  return !!r;
}

function companyOrgId(companyId: string): number | null {
  const r = sqlite.prepare("SELECT pipedrive_org_id FROM companies WHERE id = ?").get(companyId) as { pipedrive_org_id: number | null } | undefined;
  return r?.pipedrive_org_id ?? null;
}
function openDealId(companyId: string): number | null {
  const r = sqlite
    .prepare("SELECT pipedrive_deal_id FROM pipedrive_deals WHERE company_id = ? AND is_open = 1 AND pipedrive_deal_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
    .get(companyId) as { pipedrive_deal_id: number | null } | undefined;
  return r?.pipedrive_deal_id ?? null;
}

export async function GET() {
  const raw = getSetting(RUN_KEY);
  return NextResponse.json(raw ? JSON.parse(raw) : { state: "idle" });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") !== "false"; // default true
  const pushUnsynced = url.searchParams.get("pushUnsynced") !== "false"; // default true
  const mailedDate = url.searchParams.get("mailedDate") || new Date().toISOString().slice(0, 10);

  // Body may be raw CSV or JSON { csv }.
  const bodyText = await req.text();
  let csvText = bodyText;
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { csvText = (JSON.parse(bodyText) as { csv?: string }).csv || ""; } catch { csvText = ""; }
  }
  const parsed = parseCsv(csvText);
  if (!parsed.length) return NextResponse.json({ error: "no CSV rows parsed (need a header row + data)" }, { status: 400 });

  const rows = parsed.map(toMailRow).filter((r) => r.company || r.email || r.phone);

  // Match every row; dedupe to one entry per company.
  const matchedCompanies = new Map<string, { via: string; row: MailRow }>();
  const unmatched: string[] = [];
  let dupRows = 0;
  for (const r of rows) {
    const m = matchCompany(r);
    if (!m) { unmatched.push(r.company || r.email || r.phone); continue; }
    if (matchedCompanies.has(m.id)) { dupRows++; continue; }
    matchedCompanies.set(m.id, { via: m.via, row: r });
  }

  const companyIds = [...matchedCompanies.keys()];
  const syncedCount = companyIds.filter((id) => companyOrgId(id) != null).length;

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      mailedDate,
      totalRows: rows.length,
      matchedCompanies: companyIds.length,
      duplicateRows: dupRows,
      alreadySyncedToPipedrive: syncedCount,
      notYetInPipedrive: companyIds.length - syncedCount,
      unmatched: unmatched.length,
      unmatchedSample: unmatched.slice(0, 40),
      pushUnsyncedOnApply: pushUnsynced,
    });
  }

  // ── Real run: fire-and-forget background processing with progress. ──
  const pdReady = getPipedriveConnectionStatus().connected && isSyncEnabled();
  if (!pdReady) return NextResponse.json({ error: "Pipedrive not connected / sync disabled" }, { status: 409 });

  const total = companyIds.length;
  setSetting(RUN_KEY, JSON.stringify({ state: "running", total, done: 0, logged: 0, pushed: 0, skipped: 0, errors: 0, startedAt: new Date().toISOString(), mailedDate }));

  const owner = getPipedriveOwner()?.id;
  const entries = [...matchedCompanies.entries()];

  // Not awaited — the Node process keeps running after the response on Railway.
  void (async () => {
    let done = 0, logged = 0, pushed = 0, skipped = 0, errors = 0;
    for (const [companyId, { row }] of entries) {
      done++;
      try {
        if (alreadyLogged(companyId, mailedDate)) { skipped++; continue; }
        let orgId = companyOrgId(companyId);
        if (!orgId && pushUnsynced) {
          try {
            orgId = await resolveOrg(companyId, owner);
            await resolvePerson(companyId, orgId, owner);
            pushed++;
          } catch (e) {
            console.error("[catalog-mailing] push failed", companyId, e);
          }
        }
        if (!orgId) { skipped++; continue; } // unsynced and not pushing

        const addr = [row.addr1, row.addr2, [row.city, row.state, row.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
        const dealId = openDealId(companyId);
        await createActivity({
          subject: "📬 Physical catalog mailed (Uprinting)",
          type: "task",
          done: 1,
          due_date: mailedDate,
          org_id: orgId,
          deal_id: dealId ?? undefined,
          owner_id: owner,
          note: `Summer catalog mailed via ${VENDOR} on ${mailedDate}.${addr ? `<br>Mailed to: ${addr}` : ""}`,
        });
        logged++;

        // Frame-side timeline + idempotency marker.
        sqlite
          .prepare(
            `INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data, user_id, created_at)
             VALUES (?, ?, 'sales', 'company', ?, ?, NULL, datetime('now'))`,
          )
          .run(crypto.randomUUID(), MARKER, companyId, JSON.stringify({ key: `${VENDOR}:${mailedDate}`, vendor: VENDOR, date: mailedDate, address: addr }));
      } catch (e) {
        errors++;
        console.error("[catalog-mailing] log failed", companyId, e);
      }
      if (done % 10 === 0 || done === total) {
        setSetting(RUN_KEY, JSON.stringify({ state: done === total ? "done" : "running", total, done, logged, pushed, skipped, errors, mailedDate, updatedAt: new Date().toISOString() }));
      }
    }
    setSetting(RUN_KEY, JSON.stringify({ state: "done", total, done, logged, pushed, skipped, errors, mailedDate, finishedAt: new Date().toISOString() }));
  })();

  return NextResponse.json({ ok: true, started: true, total, alreadySyncedToPipedrive: syncedCount, note: "Running in background — poll GET on this route for progress." });
}
