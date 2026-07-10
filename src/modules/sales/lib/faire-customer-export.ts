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

// Matches Faire's Customers bulk-upload template exactly:
//   Contact Name, Store Name, Email Address, Street Address, Custom Tags (comma-sep)
export interface FaireExportRow {
  companyId: string;
  contactName: string;
  storeName: string;
  email: string;
  streetAddress: string;
  tags: string; // comma-separated tags inside one CSV field
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

/** Comma-separated Faire tags: always "interested" plus a source tag (no commas
 *  inside a tag, since Faire splits the field on commas). */
function sourceTags(c: CompanyRow): string {
  const src = (c.source || "").toLowerCase();
  let tags: string[] = [];
  try {
    tags = c.tags ? (JSON.parse(c.tags) as string[]).map((t) => String(t).toLowerCase()) : [];
  } catch {
    /* ignore */
  }
  const has = (s: string) => src.includes(s) || tags.some((t) => t.includes(s));
  const out = ["interested"];
  if (has("instantly")) out.push("instantly");
  else if (has("phoneburner")) out.push("cold-call");
  else if (has("ajm")) out.push("ajm");
  else if (has("faire")) out.push("faire");
  else if (c.source) out.push(c.source.replace(/,/g, " ").trim());
  return out.join(",");
}

function csvField(v: string | null | undefined): string {
  const s = (v ?? "").toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADERS = ["Contact Name", "Store Name", "Email Address", "Street Address", "Custom Tags (separate with commas)"];

function toCsv(rows: FaireExportRow[]): string {
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push([r.contactName, r.storeName, r.email, r.streetAddress, r.tags].map(csvField).join(","));
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

  const rows: FaireExportRow[] = [];
  const companyIds: string[] = [];
  let withoutEmail = 0;
  for (const c of companies) {
    const contact = contactStmt.get(c.id) as { first_name: string | null; last_name: string | null; email: string | null } | undefined;
    if (!contact?.email) {
      withoutEmail++;
      continue;
    }
    const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || (c.name ?? "");
    // Faire's Street Address is one field: "street, city, state zip".
    const streetAddress = [c.address, c.city, [c.state, c.zip].filter(Boolean).join(" ").trim()]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join(", ");
    rows.push({
      companyId: c.id,
      contactName,
      storeName: c.name ?? "",
      email: contact.email,
      streetAddress,
      tags: sourceTags(c),
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
