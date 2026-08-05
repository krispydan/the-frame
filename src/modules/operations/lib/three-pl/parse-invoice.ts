/**
 * Big Sky Fulfillment monthly invoice parser (.xlsx).
 *
 * The workbook shape drifts month to month, so nothing is read by position:
 *   - Sheets: Summary, Invoice Level, Detail, Storage, Inbound Shipments are
 *     always present; Returns only appears in months that had returns.
 *   - Detail columns are DYNAMIC: each charge type that occurred that month
 *     adds a "<Charge Name> - Amount ($)" / "<Charge Name> - Quantity" pair
 *     (e.g. "Shipping - Fedex - Amount ($)"). May has 26 cols, June 28,
 *     July 31 (July adds Channel ID / Warehouse Profile / Order Tags).
 *   - Datetimes vary: "2026-07-29" vs "2026-05-20 08:04:18 PM" vs Excel
 *     serial dates.
 *
 * Output is a normalized structure the importer writes to three_pl_* tables.
 */
import * as XLSX from "xlsx";

export interface ParsedCharge {
  chargeType: string;          // canonical key, e.g. "fulfillment_dtc", "shipping_ups"
  amount: number;
  quantity: number;
  occurredAt: string | null;   // ISO date
  orderNumberRaw: string | null;
  poNumber: string | null;
  carrier: string | null;
  serviceLevel: string | null;
  trackingNumber: string | null;
  packageType: string | null;
  packageLength: number | null;
  packageWidth: number | null;
  packageHeight: number | null;
  weightValue: number | null;
  weightUnit: string | null;
  shipCountry: string | null;
  shipState: string | null;
  channelHint: string | null;  // Channel ID column when present (July+)
  raw: Record<string, unknown>;
}

export interface ParsedStorageDay {
  date: string;
  storageType: string;
  locationCount: number;
  quantity: number;
  amount: number;
}

export interface ParsedInvoice {
  periodStart: string;
  periodEnd: string;
  summary: Array<{ charge: string; amount: number; count: number }>;
  charges: ParsedCharge[];
  storageDays: ParsedStorageDay[];
  totalAmount: number;
  detailOrderCount: number;
  warnings: string[];
}

// ── Charge-name canonicalization ──
// "Fulfillment Fee - Wholesale" → fulfillment_wholesale, "Shipping - UPS" →
// shipping_ups, etc. Keeps summary keys and detail-column keys aligned.
export function canonicalChargeType(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === "fulfillment fee") return "fulfillment_dtc";
  if (n.startsWith("fulfillment fee - wholesale")) return "fulfillment_wholesale";
  if (n.startsWith("shipping - ")) return "shipping_" + n.slice("shipping - ".length).replace(/\W+/g, "");
  if (n === "return fee") return "return_fee";
  if (n === "receiving fee") return "receiving";
  if (n === "account management") return "account_management";
  if (n === "storage fee") return "storage";
  return n.replace(/\W+/g, "_").replace(/^_+|_+$/g, "");
}

const num = (v: unknown): number => {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : num(v));
const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};

/** Excel serials, "2026-05-20 08:04:18 PM", "2026-07-29", Date objects → ISO date. */
function toIsoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    // Excel serial date (days since 1899-12-30)
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function sheetRows(wb: XLSX.WorkBook, name: string): Record<string, unknown>[] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
}

/** Find a column by fuzzy prefix — headers get truncated/renamed between months. */
function col(row: Record<string, unknown>, ...prefixes: string[]): unknown {
  for (const p of prefixes) {
    for (const k of Object.keys(row)) {
      if (k.toLowerCase().startsWith(p.toLowerCase())) return row[k];
    }
  }
  return null;
}

export function parseBigSkyInvoice(buf: Buffer, filename?: string): ParsedInvoice {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const warnings: string[] = [];

  // ── Summary ──
  const summary = sheetRows(wb, "Summary")
    .map((r) => ({
      charge: String(col(r, "Charge On Invoice") ?? "").trim(),
      amount: num(col(r, "Amount Total")),
      count: num(col(r, "Count Total")),
    }))
    .filter((s) => s.charge);
  const totalAmount = summary.reduce((a, s) => a + s.amount, 0);
  if (!summary.length) warnings.push("Summary sheet missing or empty");

  const charges: ParsedCharge[] = [];

  // ── Detail: one row per shipped order, dynamic charge column pairs ──
  const detail = sheetRows(wb, "Detail");
  const chargeCols: Array<{ name: string; amountKey: string; qtyKey: string }> = [];
  if (detail.length) {
    const keys = Object.keys(detail[0]);
    for (const k of keys) {
      const m = /^(.*?)\s*-\s*Amount \(\$\)/.exec(k);
      if (!m) continue;
      const base = m[1].trim();
      const qtyKey = keys.find((q) => q.toLowerCase().startsWith(`${base.toLowerCase()} - quantity`));
      if (qtyKey) chargeCols.push({ name: base, amountKey: k, qtyKey });
    }
    if (!chargeCols.length) warnings.push("Detail sheet: no charge columns recognized");
  }

  const dates: string[] = [];
  for (const r of detail) {
    const orderNumber = str(col(r, "Order Number"));
    if (!orderNumber) continue;
    const shipDate = toIsoDate(col(r, "Ship Datetime")) ?? toIsoDate(col(r, "Order Datetime"));
    if (shipDate) dates.push(shipDate);
    const common = {
      occurredAt: shipDate,
      orderNumberRaw: orderNumber,
      poNumber: null,
      carrier: str(col(r, "Carrier Name")),
      serviceLevel: str(col(r, "Service Level Name")),
      trackingNumber: str(col(r, "Tracking Number")),
      packageType: str(col(r, "Package Type Name")),
      packageLength: numOrNull(col(r, "Package Length")),
      packageWidth: numOrNull(col(r, "Package Width")),
      packageHeight: numOrNull(col(r, "Package Height")),
      weightValue: numOrNull(col(r, "Weight Value")),
      weightUnit: str(col(r, "Weight Unit")),
      shipCountry: str(col(r, "Ship Recipient Address Count")),
      shipState: str(col(r, "Ship Recipient Address State")),
      channelHint: str(col(r, "Channel ID")),
      raw: r,
    };
    for (const cc of chargeCols) {
      const amount = num(r[cc.amountKey]);
      const quantity = num(r[cc.qtyKey]);
      if (amount === 0 && quantity === 0) continue;
      charges.push({ chargeType: canonicalChargeType(cc.name), amount, quantity, ...common });
    }
  }

  // ── Returns (sheet absent in months without returns) ──
  for (const r of sheetRows(wb, "Returns")) {
    const orderNumber = str(col(r, "Order Number"));
    if (!orderNumber) continue;
    const d = toIsoDate(col(r, "Return Date"));
    if (d) dates.push(d);
    charges.push({
      chargeType: "return_fee",
      amount: num(col(r, "Return Fee - Amount")),
      quantity: num(col(r, "Return Fee - Quantity")),
      occurredAt: d,
      orderNumberRaw: orderNumber,
      poNumber: null,
      carrier: null, serviceLevel: null, trackingNumber: null, packageType: null,
      packageLength: null, packageWidth: null, packageHeight: null,
      weightValue: null, weightUnit: null, shipCountry: null, shipState: null,
      channelHint: null,
      raw: r,
    });
  }

  // ── Inbound Shipments (receiving fees, keyed to PO) ──
  for (const r of sheetRows(wb, "Inbound Shipments")) {
    const po = str(col(r, "Po Number"));
    if (!po) continue;
    const d = toIsoDate(col(r, "Close Date"));
    if (d) dates.push(d);
    charges.push({
      chargeType: canonicalChargeType(String(col(r, "Charge Type") ?? "Receiving Fee")),
      amount: num(col(r, "Total Charge Amount")),
      quantity: num(col(r, "Received Quantity")),
      occurredAt: d,
      orderNumberRaw: null,
      poNumber: po,
      carrier: null, serviceLevel: null, trackingNumber: null, packageType: null,
      packageLength: null, packageWidth: null, packageHeight: null,
      weightValue: null, weightUnit: null, shipCountry: null, shipState: null,
      channelHint: null,
      raw: r,
    });
  }

  // ── Invoice Level (account management etc.) ──
  for (const r of sheetRows(wb, "Invoice Level")) {
    const charge = str(col(r, "Charge On Invoice"));
    if (!charge) continue;
    charges.push({
      chargeType: canonicalChargeType(charge),
      amount: num(col(r, "Amount")),
      quantity: num(col(r, "Quantity")),
      occurredAt: toIsoDate(col(r, "Occurred At")),
      orderNumberRaw: null,
      poNumber: str(col(r, "Reference Number")),
      carrier: null, serviceLevel: null, trackingNumber: null, packageType: null,
      packageLength: null, packageWidth: null, packageHeight: null,
      weightValue: null, weightUnit: null, shipCountry: null, shipState: null,
      channelHint: null,
      raw: r,
    });
  }

  // ── Storage: thousands of per-location-per-day rows → per day+type ──
  const storageAgg = new Map<string, ParsedStorageDay>();
  for (const r of sheetRows(wb, "Storage")) {
    const date = toIsoDate(col(r, "Date"));
    const type = str(col(r, "Storage Type"));
    if (!date || !type) continue;
    dates.push(date);
    const key = `${date}|${type}`;
    const agg = storageAgg.get(key) ?? { date, storageType: type, locationCount: 0, quantity: 0, amount: 0 };
    agg.locationCount += 1;
    agg.quantity += num(col(r, "Quantity"));
    agg.amount += num(col(r, "Charge Amount"));
    storageAgg.set(key, agg);
  }
  const storageDays = [...storageAgg.values()].sort((a, b) => a.date.localeCompare(b.date));

  // ── Period: prefer the filename range, fall back to observed dates ──
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  if (filename) {
    const range = /(\d{8})_to_(\d{8})/.exec(filename);
    const month = /_(\d{4})(\d{2})(?:\.|_|$)/.exec(filename);
    if (range) {
      periodStart = `${range[1].slice(0, 4)}-${range[1].slice(4, 6)}-${range[1].slice(6, 8)}`;
      periodEnd = `${range[2].slice(0, 4)}-${range[2].slice(4, 6)}-${range[2].slice(6, 8)}`;
    } else if (month) {
      const y = Number(month[1]), m = Number(month[2]);
      periodStart = `${month[1]}-${month[2]}-01`;
      periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    }
  }
  if (!periodStart || !periodEnd) {
    dates.sort();
    periodStart = periodStart ?? dates[0] ?? new Date().toISOString().slice(0, 10);
    periodEnd = periodEnd ?? dates[dates.length - 1] ?? periodStart;
    warnings.push("Period inferred from row dates (filename had no recognizable range)");
  }

  const detailOrderCount = new Set(detail.map((r) => str(col(r, "Order Number"))).filter(Boolean)).size;

  return { periodStart, periodEnd, summary, charges, storageDays, totalAmount, detailOrderCount, warnings };
}
