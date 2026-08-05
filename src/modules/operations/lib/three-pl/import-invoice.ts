/**
 * Import a parsed Big Sky invoice into three_pl_* tables.
 *
 * - Idempotent per period: re-uploading the same period (e.g. a "corrected"
 *   file) deletes and replaces that invoice's rows.
 * - Order matching: invoice order numbers ("#SW1378", "#E3TCASXWXT") match
 *   orders.order_number with/without the leading "#". Ambiguity is impossible
 *   in practice (Shopify order names are unique per shop; the channel hint
 *   column disambiguates when present).
 * - After import, the audit engine runs and its findings are stored on the
 *   invoice row (audit_json) so the dashboard can show discrepancies.
 */
import { sqlite } from "@/lib/db";
import { parseBigSkyInvoice, type ParsedInvoice } from "./parse-invoice";
import { auditInvoice, type AuditReport } from "./audit";

export interface ImportResult {
  invoiceId: string;
  periodStart: string;
  periodEnd: string;
  replacedExisting: boolean;
  totalAmount: number;
  chargeRows: number;
  storageDayRows: number;
  detailOrders: number;
  matchedOrders: number;
  unmatchedOrders: number;
  unmatchedSamples: string[];
  warnings: string[];
  audit: AuditReport;
}

export async function importBigSkyInvoice(buf: Buffer, filename?: string): Promise<ImportResult> {
  const parsed = parseBigSkyInvoice(buf, filename);
  return importParsed(parsed, filename);
}

function importParsed(parsed: ParsedInvoice, filename?: string): ImportResult {
  // ── Order lookup: order_number (with and without '#') → id ──
  const orderIdByNumber = new Map<string, string>();
  for (const r of sqlite.prepare("SELECT id, order_number FROM orders").all() as Array<{ id: string; order_number: string }>) {
    const n = r.order_number.trim();
    orderIdByNumber.set(n.toLowerCase(), r.id);
    orderIdByNumber.set(n.replace(/^#/, "").toLowerCase(), r.id);
  }

  const existing = sqlite.prepare(
    "SELECT id FROM three_pl_invoices WHERE provider = 'big_sky' AND period_start = ? AND period_end = ?",
  ).get(parsed.periodStart, parsed.periodEnd) as { id: string } | undefined;

  const invoiceId = existing?.id ?? crypto.randomUUID();

  const run = sqlite.transaction(() => {
    if (existing) {
      sqlite.prepare("DELETE FROM three_pl_charges WHERE invoice_id = ?").run(invoiceId);
      sqlite.prepare("DELETE FROM three_pl_storage_days WHERE invoice_id = ?").run(invoiceId);
      sqlite.prepare("DELETE FROM three_pl_invoices WHERE id = ?").run(invoiceId);
    }

    sqlite.prepare(
      `INSERT INTO three_pl_invoices
         (id, period_start, period_end, filename, provider, summary_json, total_amount, detail_orders)
       VALUES (?, ?, ?, ?, 'big_sky', ?, ?, ?)`,
    ).run(invoiceId, parsed.periodStart, parsed.periodEnd, filename ?? null,
      JSON.stringify(parsed.summary), parsed.totalAmount, parsed.detailOrderCount);

    const insCharge = sqlite.prepare(
      `INSERT INTO three_pl_charges
         (id, invoice_id, charge_type, amount, quantity, occurred_at, order_id, order_number_raw,
          po_number, carrier, service_level, tracking_number, package_type,
          package_length, package_width, package_height, weight_value, weight_unit,
          ship_country, ship_state, channel_hint, match_status, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const matched = new Set<string>();
    const unmatched = new Set<string>();
    for (const c of parsed.charges) {
      let orderId: string | null = null;
      let matchStatus = "no_order"; // charges that don't reference an order (storage, receiving, account mgmt)
      if (c.orderNumberRaw) {
        orderId = orderIdByNumber.get(c.orderNumberRaw.trim().toLowerCase())
          ?? orderIdByNumber.get(c.orderNumberRaw.trim().replace(/^#/, "").toLowerCase())
          ?? null;
        matchStatus = orderId ? "matched" : "unmatched";
        (orderId ? matched : unmatched).add(c.orderNumberRaw);
      }
      insCharge.run(
        crypto.randomUUID(), invoiceId, c.chargeType, c.amount, c.quantity, c.occurredAt,
        orderId, c.orderNumberRaw, c.poNumber, c.carrier, c.serviceLevel, c.trackingNumber,
        c.packageType, c.packageLength, c.packageWidth, c.packageHeight,
        c.weightValue, c.weightUnit, c.shipCountry, c.shipState, c.channelHint,
        matchStatus, JSON.stringify(c.raw),
      );
    }

    const insStorage = sqlite.prepare(
      `INSERT INTO three_pl_storage_days (id, invoice_id, date, storage_type, location_count, quantity, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of parsed.storageDays) {
      insStorage.run(crypto.randomUUID(), invoiceId, s.date, s.storageType, s.locationCount, s.quantity, s.amount);
    }

    return { matched, unmatched };
  });

  const { matched, unmatched } = run();

  // ── Audit + stamp results on the invoice ──
  const audit = auditInvoice(invoiceId);
  sqlite.prepare(
    "UPDATE three_pl_invoices SET matched_orders = ?, unmatched_orders = ?, audit_json = ?, audit_flags = ? WHERE id = ?",
  ).run(matched.size, unmatched.size, JSON.stringify(audit), audit.findings.length, invoiceId);

  return {
    invoiceId,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    replacedExisting: !!existing,
    totalAmount: Math.round(parsed.totalAmount * 100) / 100,
    chargeRows: parsed.charges.length,
    storageDayRows: parsed.storageDays.length,
    detailOrders: parsed.detailOrderCount,
    matchedOrders: matched.size,
    unmatchedOrders: unmatched.size,
    unmatchedSamples: [...unmatched].slice(0, 10),
    warnings: parsed.warnings,
    audit,
  };
}
