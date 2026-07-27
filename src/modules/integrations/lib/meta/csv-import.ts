/**
 * Meta Lead Ads CSV import.
 *
 * Ads Manager → Forms Library → Download leads produces a file that is
 * *not* what the .csv extension suggests:
 *   - UTF-16 LE with a BOM (occasionally UTF-8)
 *   - TAB delimited, not comma
 *   - ids carry type prefixes: l: lead, f: form, c: campaign, ag: ad,
 *     as: ad set, p: phone
 *   - values containing spaces are wrapped in double quotes
 *   - the custom form questions become their own columns (store,
 *     store_website_or_instagram, …)
 *
 * We normalise all of that into the same MetaLeadDetail shape the Graph API
 * returns, so an imported lead flows through exactly the same pipeline as a
 * webhook one — company dedupe, Pipedrive deal, Slack alert, CAPI events.
 * Because the real Meta lead id survives the import, CAPI events still match
 * on lead_id rather than falling back to hashed contact details.
 *
 * Re-uploading an overlapping export is safe: ingestion is keyed on the lead
 * id, so only genuinely new rows are processed. That makes "download today's
 * file and upload it" a workable daily routine.
 */

import type { MetaLeadDetail, MetaLeadField } from "./client";
import { recordLeadgenEvent, processMetaLead } from "./lead-ingest";

/** Decode a Meta export buffer, honouring the UTF-16/UTF-8 BOM. */
export function decodeExport(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le", 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE — swap byte pairs, then decode as LE.
    const swapped = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = t;
    }
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString("utf8", 3);
  return buf.toString("utf8");
}

/** Split one delimited line, respecting double-quoted values. */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Strip Meta's type prefix from an id ("l:123" → "123", "p:+1555" → "+1555"). */
function unprefix(v: string): string {
  return v.replace(/^(?:l|f|c|ag|as|p|a):/, "");
}

/** Columns that are metadata rather than answers to form questions. */
const META_COLUMNS = new Set([
  "id", "created_time", "ad_id", "ad_name", "adset_id", "adset_name",
  "campaign_id", "campaign_name", "form_id", "form_name", "is_organic",
  "platform", "lead_status",
]);

export interface CsvParseResult {
  leads: MetaLeadDetail[];
  /** Rows that couldn't be used (no lead id), with the reason. */
  skipped: Array<{ row: number; reason: string }>;
  /** Column headers found, for diagnostics. */
  columns: string[];
  delimiter: "tab" | "comma";
}

/**
 * Parse a Meta lead export into Graph-API-shaped leads.
 * Unknown columns are preserved as form fields rather than dropped, so a form
 * with different custom questions still imports without a code change.
 */
export function parseMetaLeadCsv(input: Buffer | string): CsvParseResult {
  const text = typeof input === "string" ? input : decodeExport(input);
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return { leads: [], skipped: [], columns: [], delimiter: "tab" };
  }

  // Meta exports are tab-delimited; fall back to comma for hand-made files.
  const tabs = (lines[0].match(/\t/g) || []).length;
  const commas = (lines[0].match(/,/g) || []).length;
  const delim = tabs >= commas ? "\t" : ",";

  const headers = splitLine(lines[0], delim).map((h) => h.replace(/^﻿/, "").trim().toLowerCase());
  const leads: MetaLeadDetail[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (cells[idx] ?? "").trim(); });

    const leadId = unprefix(row.id || "");
    if (!leadId) {
      skipped.push({ row: i + 1, reason: "no lead id" });
      continue;
    }

    // Every non-metadata column is an answer to a form question.
    const field_data: MetaLeadField[] = [];
    for (const h of headers) {
      if (META_COLUMNS.has(h)) continue;
      const value = h === "phone_number" ? unprefix(row[h] || "") : row[h];
      if (value) field_data.push({ name: h, values: [value] });
    }

    leads.push({
      id: leadId,
      created_time: row.created_time || undefined,
      field_data,
      form_id: unprefix(row.form_id || "") || undefined,
      campaign_name: row.campaign_name || undefined,
      ad_name: row.ad_name || undefined,
      ad_id: unprefix(row.ad_id || "") || undefined,
      ...(row.adset_name ? { adset_name: row.adset_name } : {}),
    } as MetaLeadDetail);
  }

  return { leads, skipped, columns: headers, delimiter: delim === "\t" ? "tab" : "comma" };
}

export interface CsvImportResult extends Omit<CsvParseResult, "leads"> {
  /** Rows found in the file. */
  rows: number;
  /** Leads we hadn't seen before (the rest were already ingested). */
  newLeads: number;
  /** Leads fully processed on this run (company + Pipedrive + CAPI + Slack). */
  processed: number;
  /** Leads that were already processed by a previous upload or the webhook. */
  duplicates: number;
  errors: Array<{ leadgenId: string; reason: string }>;
  /** Companies created vs matched onto an existing prospect/customer. */
  companiesCreated: number;
  companiesMatched: number;
}

/**
 * Parse and ingest a Meta lead export.
 *
 * `dryRun` parses and reports without writing anything, so the UI can show what
 * a file contains before committing to it.
 *
 * Every row goes through recordLeadgenEvent → processMetaLead with the parsed
 * detail supplied directly, so no Graph API call (and therefore no
 * leads_retrieval permission) is needed. That's the whole point of this path:
 * it works while App Review is pending.
 */
export async function importMetaLeadCsv(
  input: Buffer | string,
  opts: { dryRun?: boolean } = {},
): Promise<CsvImportResult> {
  const parsed = parseMetaLeadCsv(input);
  const result: CsvImportResult = {
    rows: parsed.leads.length + parsed.skipped.length,
    newLeads: 0,
    processed: 0,
    duplicates: 0,
    errors: [],
    companiesCreated: 0,
    companiesMatched: 0,
    skipped: parsed.skipped,
    columns: parsed.columns,
    delimiter: parsed.delimiter,
  };
  if (opts.dryRun) {
    result.newLeads = parsed.leads.length;
    return result;
  }

  for (const lead of parsed.leads) {
    const isNew = recordLeadgenEvent({
      leadgenId: lead.id,
      formId: lead.form_id ?? null,
      createdTime: lead.created_time ?? null,
    });
    if (isNew) result.newLeads++;

    const res = await processMetaLead(lead.id, lead);
    if (res.status === "processed") {
      result.processed++;
      if (res.companyCreated) result.companiesCreated++;
      else result.companiesMatched++;
    } else if (res.status === "already") {
      result.duplicates++;
    } else if (res.status === "error") {
      result.errors.push({ leadgenId: lead.id, reason: res.reason ?? "unknown error" });
    }
  }

  return result;
}
