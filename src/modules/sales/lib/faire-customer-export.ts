/**
 * Weekly Faire customer-upload export.
 *
 * Faire has no public API to add contacts / subscribe them to emails — that's a
 * brand-portal feature (Customers bulk upload + Faire Direct + Campaigns). So
 * we email a Faire-ready CSV of interested leads each week; the rep uploads it
 * in the portal, which adds them as customers and lets Campaigns email them.
 *
 * "Interested leads" = companies at status interested / catalog_sent that have
 * a real (non-relay) email and haven't been exported yet. After a successful
 * send they're stamped (companies.faire_exported_at) so the next week's export
 * only carries the new ones. The first run therefore carries the whole current
 * interested backlog.
 */
import { sqlite } from "@/lib/db";
import { sendFaireCustomerExportEmail } from "@/lib/email";

export interface FaireExportRow {
  companyId: string;
  storeName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  source: string;
}

interface CompanyRow {
  id: string;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  source: string | null;
  tags: string | null;
}

/** A concise "where this lead came from" label for the CSV Source column. */
function sourceLabel(c: CompanyRow): string {
  const src = (c.source || "").toLowerCase();
  let tags: string[] = [];
  try {
    tags = c.tags ? (JSON.parse(c.tags) as string[]).map((t) => String(t).toLowerCase()) : [];
  } catch {
    /* ignore */
  }
  const has = (s: string) => src.includes(s) || tags.some((t) => t.includes(s));
  if (has("instantly")) return "Instantly (email)";
  if (has("phoneburner")) return "Cold call (PhoneBurner)";
  if (has("ajm")) return "AJM reactivation";
  if (has("faire")) return "Faire";
  return c.source || "The Frame";
}

function csvField(v: string | null | undefined): string {
  const s = (v ?? "").toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADERS = ["Store Name", "First Name", "Last Name", "Email", "Phone", "Address", "City", "State", "Zip", "Source"];

function toCsv(rows: FaireExportRow[]): string {
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [r.storeName, r.firstName, r.lastName, r.email, r.phone, r.address, r.city, r.state, r.zip, r.source]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

/**
 * Build the export set. Does NOT stamp — call stampExported(ids) only after the
 * email is confirmed sent, so a send failure doesn't silently drop leads.
 */
export function buildFaireExport(opts: { limit?: number } = {}): {
  rows: FaireExportRow[];
  csv: string;
  count: number;
  withoutEmail: number;
  companyIds: string[];
} {
  const companies = sqlite
    .prepare(
      `SELECT id, name, address, city, state, zip, source, tags
         FROM companies
        WHERE status IN ('interested', 'catalog_sent')
          AND faire_exported_at IS NULL
        ORDER BY updated_at DESC
        ${opts.limit ? `LIMIT ${Math.max(1, Math.floor(opts.limit))}` : ""}`,
    )
    .all() as CompanyRow[];

  const contactStmt = sqlite.prepare(
    `SELECT first_name, last_name, email FROM contacts
       WHERE company_id = ? AND TRIM(COALESCE(email,'')) <> ''
         AND lower(email) NOT LIKE '%@relay.faire.com%'
       ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
  );
  const phoneStmt = sqlite.prepare(
    `SELECT phone FROM company_phones WHERE company_id = ?
       ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
  );

  const rows: FaireExportRow[] = [];
  const companyIds: string[] = [];
  let withoutEmail = 0;
  for (const c of companies) {
    const contact = contactStmt.get(c.id) as { first_name: string | null; last_name: string | null; email: string | null } | undefined;
    if (!contact?.email) {
      withoutEmail++;
      continue;
    }
    const phone = (phoneStmt.get(c.id) as { phone: string | null } | undefined)?.phone ?? "";
    rows.push({
      companyId: c.id,
      storeName: c.name ?? "",
      firstName: contact.first_name ?? "",
      lastName: contact.last_name ?? "",
      email: contact.email,
      phone,
      address: c.address ?? "",
      city: c.city ?? "",
      state: c.state ?? "",
      zip: c.zip ?? "",
      source: sourceLabel(c),
    });
    companyIds.push(c.id);
  }

  return { rows, csv: toCsv(rows), count: rows.length, withoutEmail, companyIds };
}

export function stampExported(companyIds: string[]): void {
  if (!companyIds.length) return;
  const stmt = sqlite.prepare("UPDATE companies SET faire_exported_at = datetime('now') WHERE id = ?");
  const txn = sqlite.transaction((ids: string[]) => ids.forEach((id) => stmt.run(id)));
  txn(companyIds);
}

/** Cron handler: build, email the CSV, and stamp on success. */
export async function runWeeklyFaireExport(): Promise<Record<string, unknown>> {
  const recipient = process.env.FAIRE_EXPORT_EMAIL || "daniel@getjaxy.com";
  const weekLabel = new Date().toISOString().slice(0, 10);
  const { csv, count, withoutEmail, companyIds } = buildFaireExport();

  const r = await sendFaireCustomerExportEmail(recipient, {
    count,
    withoutEmail,
    csv,
    filename: `faire-interested-${weekLabel}.csv`,
    weekLabel,
  });

  // Only stamp when the email actually went out, so a Resend failure doesn't
  // lose this batch — it'll be retried in next week's run.
  if (r.ok && count > 0) stampExported(companyIds);

  return { ok: r.ok, sent: r.ok, count, withoutEmail, recipient, stamped: r.ok ? count : 0 };
}
