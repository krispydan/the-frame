/**
 * ShipHero Purchase Order CSV.
 *
 * Ported from the Claude.ai skill `shiphero-purchase-order`. 20 columns in the
 * exact order specified by ShipHero; comma-delimited, standard quoting, LF OK.
 */

import { buildCsvFromRecords, todayIso } from "./csv-utils";
import { consolidateDuplicates, detectVendor } from "./sku-parsing";

export const SHIPHERO_PO_HEADERS = [
  "PO Number", "Vendor", "Ship Date", "PO Date", "Status",
  "Shipping Carrier", "Shipping Method", "Shipping Price", "Discount", "Tax",
  "Tracking Number", "Payment Method", "Payment Due By", "PO Note", "Packer Note",
  "Sku", "Vendor Sku", "Quantity", "Sell Ahead", "Price",
] as const;

type Header = (typeof SHIPHERO_PO_HEADERS)[number];

export type PoLineItem = {
  sku: string;
  quantity: number;
  /** Optional per-line unit price (FOB, NOT including freight/duties). */
  unitPrice?: number | null;
  vendorSku?: string | null;
};

export type BuildPoInput = {
  poNumber: string;
  /** Factory code, e.g. "JX3". If omitted, detected from SKUs. */
  vendor?: string;
  /** Optional override: ship date (defaults to today, ISO YYYY-MM-DD). */
  shipDate?: string;
  /** Optional override: PO date (defaults to today, ISO YYYY-MM-DD). */
  poDate?: string;
  /** "air" -> Shipping Method "DHL"; "ocean" -> blank. */
  freightType?: "air" | "ocean";
  /** Fallback price applied to any line item that has no unitPrice. */
  defaultUnitPrice?: number | null;
  lineItems: PoLineItem[];
};

export type BuildPoWarnings = {
  skippedZeroQty: string[];
  consolidatedDuplicates: string[];
  unmatchedVendorSkus: string[];
  emitted: number;
};

function formatPrice(price: number | null | undefined, fallback: number | null | undefined): string | number {
  const v = price ?? fallback;
  if (v == null) return 0;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  return typeof v === "number" ? Number(v.toFixed(2)) : v;
}

export function buildPurchaseOrderCsv(input: BuildPoInput): {
  csv: string;
  vendor: string;
  warnings: BuildPoWarnings;
} {
  // Drop zero/negative qty rows.
  const skippedZeroQty: string[] = [];
  let workingItems = input.lineItems.filter((li) => {
    if (!Number.isFinite(li.quantity) || li.quantity <= 0) {
      skippedZeroQty.push(li.sku);
      return false;
    }
    return true;
  });

  if (workingItems.length === 0) {
    throw new Error("No valid line items (all had zero/negative quantity).");
  }

  // Consolidate duplicate SKUs.
  const { rows: consolidated, duplicates } = consolidateDuplicates(workingItems);
  workingItems = consolidated;

  // Detect vendor if not supplied.
  let vendor = input.vendor?.toUpperCase();
  const unmatched: string[] = [];
  if (!vendor) {
    const detected = detectVendor(workingItems.map((li) => li.sku));
    vendor = detected.vendor;
    unmatched.push(...detected.unmatched);
  }

  const shipDate = input.shipDate ?? todayIso();
  const poDate = input.poDate ?? todayIso();
  const shippingMethod = input.freightType === "ocean" ? "" : "DHL";

  const rows: Record<Header, string | number>[] = workingItems.map((li) => ({
    "PO Number": input.poNumber,
    "Vendor": vendor!,
    "Ship Date": shipDate,
    "PO Date": poDate,
    "Status": "pending",
    "Shipping Carrier": "",
    "Shipping Method": shippingMethod,
    "Shipping Price": 0,
    "Discount": 0,
    "Tax": 0,
    "Tracking Number": "",
    "Payment Method": "",
    "Payment Due By": "unlimited",
    "PO Note": "",
    "Packer Note": "",
    "Sku": li.sku,
    "Vendor Sku": li.vendorSku ?? "",
    "Quantity": li.quantity,
    "Sell Ahead": 1,
    "Price": formatPrice(li.unitPrice, input.defaultUnitPrice),
  }));

  const csv = buildCsvFromRecords(SHIPHERO_PO_HEADERS, rows);

  return {
    csv,
    vendor: vendor!,
    warnings: {
      skippedZeroQty,
      consolidatedDuplicates: duplicates,
      unmatchedVendorSkus: unmatched,
      emitted: rows.length,
    },
  };
}
