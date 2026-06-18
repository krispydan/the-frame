/**
 * Display layer for companies.status — labels + Tailwind classes for the
 * new lead-gen pipeline enum.
 *
 * Mirrors the palette used by DEAL_STAGE_COLORS so the kanban and the
 * prospect detail page feel consistent.
 *
 * Companion to src/modules/sales/lib/status-progression.ts — that file
 * owns the transition rules; this file owns the display layer.
 */
import type { CompanyStatus } from "./status-progression";

export const COMPANY_STATUS_LABELS: Record<CompanyStatus, string> = {
  prospect: "Prospect",
  not_qualified: "Not Qualified",
  qualified_lead: "Qualified Lead",
  interested: "Interested",
  catalog_sent: "Catalog Sent",
  revisit_later: "Revisit Later",
  not_interested: "Not Interested",
  ghosted: "Ghosted",
  customer: "Customer",
};

export const COMPANY_STATUS_COLORS: Record<CompanyStatus, string> = {
  prospect: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  not_qualified: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  qualified_lead: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  interested: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  catalog_sent: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  revisit_later: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  not_interested: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  ghosted: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500",
  customer: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
};

/**
 * Status values selectable from the prospect page status dropdown. We
 * deliberately omit `ghosted` from the manual picker — it's set
 * automatically by the Instantly `campaign_completed` event handler.
 * Christina shouldn't be marking people ghosted by hand.
 */
export const MANUAL_STATUS_OPTIONS: CompanyStatus[] = [
  "prospect",
  "not_qualified",
  "qualified_lead",
  "interested",
  "catalog_sent",
  "revisit_later",
  "not_interested",
  "customer",
];

export function getCompanyStatusBadge(status: string): {
  label: string;
  color: string;
} {
  const known = status in COMPANY_STATUS_LABELS;
  if (known) {
    const s = status as CompanyStatus;
    return { label: COMPANY_STATUS_LABELS[s], color: COMPANY_STATUS_COLORS[s] };
  }
  // Legacy / unknown — fall back to a neutral pill with the raw string
  return {
    label: status || "Unknown",
    color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  };
}
