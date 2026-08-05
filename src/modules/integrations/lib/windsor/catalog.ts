/**
 * Windsor field-catalog probe.
 *
 * Every report definition in this codebase was verified against the live
 * catalog rather than Amazon's own docs, which use different field names
 * again. That verification was done by hand once; this makes it repeatable,
 * so the next connector (Amazon Ads, TikTok Shop, Meta) can be scoped from
 * what the account can actually serve instead of from what the docs promise.
 *
 * Read-only. The API key travels in the query string, so every path here
 * routes its error text through `redact()` before it can reach a log, a
 * response body, or a Slack alert.
 */

import { redact, WindsorError } from "./client";

const CATALOG_BASE = "https://connectors.windsor.ai";

export interface CatalogReport {
  report: string;
  fieldCount: number;
  /** A 12-field sample by default, so the shape is readable without dumping
   *  899 rows; every field when `allFields` is set. */
  sampleFields: string[];
}

export interface CatalogResult {
  connector: string;
  ok: boolean;
  reportCount: number;
  fieldCount: number;
  reports: CatalogReport[];
  error?: string;
}

/**
 * List the reports a connector exposes for THIS account.
 *
 * Each field carries its report in a trailing parenthesis, which is what lets
 * one catalog call answer "does this account have ad spend?" without guessing
 * a report name and getting an ambiguous `bad_fields` back.
 *
 * `allFields` returns every field rather than a 12-field sample — enough to
 * actually scope a new report, rather than only confirm one exists.
 */
export async function fetchWindsorCatalog(
  connector: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; allFields?: boolean } = {},
): Promise<CatalogResult> {
  const key = process.env.WINDSOR_API_KEY;
  if (!key) {
    return { connector, ok: false, reportCount: 0, fieldCount: 0, reports: [], error: "WINDSOR_API_KEY is not configured." };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

  try {
    const res = await doFetch(
      `${CATALOG_BASE}/${encodeURIComponent(connector)}/fields?api_key=${encodeURIComponent(key)}`,
      { signal: controller.signal },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        connector, ok: false, reportCount: 0, fieldCount: 0, reports: [],
        error: redact(`HTTP ${res.status}: ${body.slice(0, 300)}`),
      };
    }

    const json = await res.json();
    const rows: unknown[] = Array.isArray(json) ? json
      : Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.fields) ? json.fields
      : [];

    const names = rows
      .map((r) => (typeof r === "string" ? r : (r as Record<string, unknown>)?.name ?? (r as Record<string, unknown>)?.field))
      .filter((n): n is string => typeof n === "string");

    // Windsor qualifies a field with its report in a trailing parenthesis —
    // `seller-sku (get_afn_inventory_data_by_country)` — not with a dot
    // prefix. Grouping on a dot instead lumped 898 of 899 fields into one
    // bucket and hid every report name, which is the only thing this probe
    // exists to surface.
    //
    // Fields with no qualifier are connector-level (Account ID, Account Name)
    // and grouped under "(account)" rather than dropped — a silently missing
    // field is how a report gets scoped wrong.
    const byReport = new Map<string, string[]>();
    for (const n of names) {
      const m = n.match(/^(.*?)\s*\(([a-z0-9_]+)\)\s*$/i);
      const report = m ? m[2] : "(account)";
      const field = m ? m[1].trim() : n;
      const list = byReport.get(report) ?? [];
      list.push(field);
      byReport.set(report, list);
    }

    const reports: CatalogReport[] = [...byReport.entries()]
      .map(([report, fields]) => ({
        report, fieldCount: fields.length,
        sampleFields: opts.allFields ? fields : fields.slice(0, 12),
      }))
      .sort((a, b) => a.report.localeCompare(b.report));

    return { connector, ok: true, reportCount: reports.length, fieldCount: names.length, reports };
  } catch (e) {
    const msg = e instanceof WindsorError ? e.message
      : e instanceof Error ? e.message : String(e);
    return { connector, ok: false, reportCount: 0, fieldCount: 0, reports: [], error: redact(msg) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Connector slugs worth probing when scoping the next channel.
 *
 * Windsor names these inconsistently across its docs, so the only reliable
 * way to find the right one is to try each and see which answers.
 */
export const CANDIDATE_CONNECTORS = [
  "amazon_sp",
  "amazon_ads",
  "amazon",
  "amazon_dsp",
  "tiktok_shop",
  "tiktok",
  "facebook",
  "google_ads",
] as const;
