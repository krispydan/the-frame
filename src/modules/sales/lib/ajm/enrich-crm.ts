/**
 * Enrich existing companies from A.J. Morgan's OMS wholesale customer file.
 *
 * The AJM order exports carry a trading name, a city and a state — no email,
 * no phone, no street address. So an account like "Gestions Mistral" shows
 * $19k of history and no way to contact anyone. The OMS customer file has all
 * of it: contact name, email, phone, and the billing address.
 *
 * Two hard rules, both from Daniel:
 *
 *   1. NEVER create a company. The file holds 4,518 accounts going back to
 *      1996 and most of them are dead; importing them would bury the live book
 *      under twenty years of history. Rows that don't match an existing
 *      company are counted and dropped.
 *   2. NEVER overwrite. Only blank fields are filled, so anything a human
 *      or a newer sync has already set wins.
 *
 * Matching runs strongest-first and stops at the first hit. A row whose name
 * matches several companies is only used when a city, state or zip
 * disambiguates it — otherwise it is reported as ambiguous and skipped, for
 * the same reason the merge tool refuses same-name-only groups: shop names
 * repeat constantly and enriching the wrong "Revival" is worse than leaving it
 * blank.
 */
import { sqlite } from "@/lib/db";
import { normalizeCompanyName, normalizeState } from "@/modules/sales/lib/company-merge";

export interface CrmEnrichResult {
  dryRun: boolean;
  rowsInFile: number;
  matched: number;
  /** Rows with no existing company — deliberately NOT imported. */
  unmatched: number;
  /** Name matched several companies and nothing disambiguated it. */
  ambiguous: number;
  matchedBy: Record<string, number>;
  /** Company fields that were blank and got filled, by column. */
  fieldsFilled: Record<string, number>;
  contactsCreated: number;
  phonesAdded: number;
  /** A sample, so the effect is reviewable before applying. */
  examples: Array<{ company: string; filled: string[]; email?: string; phone?: string }>;
  unmatchedSample: string[];
  ambiguousSample: string[];
}

const clean = (v: string | undefined) => (v ?? "").trim();

/** First address in a cell that may hold several, lowercased. */
function firstEmail(raw: string): string {
  const first = clean(raw).split(/[,;/\s]+/).find((p) => p.includes("@"));
  return (first ?? "").toLowerCase().replace(/[.,;]+$/, "");
}

/** US/CA 10-digit numbers are formatted; anything else is passed through. */
function normalizePhone(raw: string): string {
  const d = clean(raw).replace(/\D/g, "");
  if (!d || /^0+$/.test(d)) return "";           // "0000000000" placeholder
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return clean(raw);
}

/** "FLORA CHEUNG / DIANA" → first contact only, title-cased. */
function contactName(raw: string): { first: string; last: string } | null {
  const who = clean(raw).split(/\s*[/&]\s*|\s+AND\s+/i)[0].trim();
  if (!who || who.length < 2) return null;
  const parts = who.split(/\s+/).map((p) =>
    p.length <= 3 && p === p.toUpperCase() && !/[a-z]/.test(p)
      ? p.charAt(0) + p.slice(1).toLowerCase()
      : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Name variants worth trying. OMS packs several trading names into one field
 * ("GESTIONS MISTRAL/ BOUTIQUE SERAPHIN"), and The Frame usually holds just
 * one of them, so each side is tried separately.
 */
function nameKeys(raw: string): string[] {
  const keys = new Set<string>();
  const push = (s: string) => { const k = normalizeCompanyName(s); if (k.length >= 3) keys.add(k); };
  push(raw);
  for (const part of raw.split(/\s*[/|]\s*|\s+DBA:?\s+/i)) push(part);
  return [...keys];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Company columns we will fill when blank, and the CSV column feeding each. */
const FILLABLE = ["email", "phone", "address", "city", "state", "zip", "country"] as const;

export function enrichFromOmsCrm(csvText: string, opts?: { apply?: boolean }): CrmEnrichResult {
  const apply = opts?.apply === true;
  const rows = parseCsv(csvText);
  // Row 0 is a title banner ("OMS - LIST OF WHOLESALE CUSTOMERS - AS OF ..."),
  // the real header is row 1.
  const headerIdx = rows.findIndex((r) => r.map((c) => c.trim()).includes("CUS_NM"));
  if (headerIdx < 0) throw new Error("No CUS_NM header row found — is this the OMS customer file?");
  const header = rows[headerIdx].map((c) => c.trim());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    name: col("CUS_NM"), omsId: col("CUS_ID"), email: col("EMAIL_ADR"), attn: col("ATTN"),
    address: col("ADDRESS"), address2: col("ADDRESS2"), city: col("CITY"), state: col("STATE"),
    zip: col("ZIP"), country: col("COUNTRY"), phone: col("PHONE"), title: col("TITLE"),
  };
  const data = rows.slice(headerIdx + 1).filter((r) => clean(r[idx.name]));

  // ── Indexes over EXISTING data. Nothing here creates anything. ──
  const companies = sqlite.prepare(`
    SELECT id, name, LOWER(TRIM(COALESCE(city,''))) AS city, TRIM(COALESCE(state,'')) AS state,
           TRIM(COALESCE(zip,'')) AS zip
    FROM companies
  `).all() as Array<{ id: string; name: string; city: string; state: string; zip: string }>;

  const byName = new Map<string, string[]>();
  for (const c of companies) {
    for (const k of nameKeys(c.name)) (byName.get(k) ?? byName.set(k, []).get(k)!).push(c.id);
  }
  const companyById = new Map(companies.map((c) => [c.id, c]));

  const byContactEmail = new Map<string, string>();
  for (const r of sqlite.prepare(
    "SELECT company_id, LOWER(TRIM(email)) AS email FROM contacts WHERE company_id IS NOT NULL AND TRIM(COALESCE(email,'')) != ''",
  ).all() as Array<{ company_id: string; email: string }>) {
    if (!byContactEmail.has(r.email)) byContactEmail.set(r.email, r.company_id);
  }

  // AJM's own order rows already carry the OMS trading name and are matched to
  // a company, which is the most direct link the file has to The Frame.
  const byAjmName = new Map<string, string>();
  for (const r of sqlite.prepare(
    "SELECT DISTINCT customer_name, company_id FROM ajm_orders WHERE company_id IS NOT NULL AND customer_name IS NOT NULL",
  ).all() as Array<{ customer_name: string; company_id: string }>) {
    for (const k of nameKeys(r.customer_name)) if (!byAjmName.has(k)) byAjmName.set(k, r.company_id);
  }

  const hasOmsCol = (sqlite.prepare("PRAGMA table_info(companies)").all() as Array<{ name: string }>)
    .some((c) => c.name === "oms_customer_id");
  const byOmsId = new Map<string, string>();
  if (hasOmsCol) {
    for (const r of sqlite.prepare(
      "SELECT id, oms_customer_id FROM companies WHERE TRIM(COALESCE(oms_customer_id,'')) != ''",
    ).all() as Array<{ id: string; oms_customer_id: string }>) byOmsId.set(r.oms_customer_id, r.id);
  }

  const res: CrmEnrichResult = {
    dryRun: !apply, rowsInFile: data.length, matched: 0, unmatched: 0, ambiguous: 0,
    matchedBy: {}, fieldsFilled: {}, contactsCreated: 0, phonesAdded: 0,
    examples: [], unmatchedSample: [], ambiguousSample: [],
  };

  const setCol = new Map<string, (value: string, companyId: string) => number>();
  for (const c of FILLABLE) {
    const stmt = sqlite.prepare(
      `UPDATE companies SET ${c} = ? WHERE id = ? AND (${c} IS NULL OR TRIM(${c}) = '')`,
    );
    setCol.set(c, (value, companyId) => stmt.run(value, companyId).changes);
  }
  const insContact = sqlite.prepare(
    `INSERT INTO contacts (id, company_id, first_name, last_name, email, phone, title, is_primary, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ajm_oms_crm', datetime('now'))`,
  );
  const contactCount = sqlite.prepare(
    "SELECT COUNT(*) AS n FROM contacts WHERE company_id = ? AND TRIM(COALESCE(email,'')) != ''",
  );
  const hasPhonesTable = !!sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_phones'",
  ).get();

  const run = () => {
    for (const r of data) {
      const rawName = clean(r[idx.name]);
      const omsId = clean(r[idx.omsId]);
      const email = firstEmail(r[idx.email] ?? "");
      const city = clean(r[idx.city]).toLowerCase();
      const state = normalizeState(clean(r[idx.state]));
      const zip = clean(r[idx.zip]).slice(0, 5);

      // ── Match, strongest signal first ──
      let companyId: string | null = null, how = "";
      if (omsId && byOmsId.has(omsId)) { companyId = byOmsId.get(omsId)!; how = "oms_id"; }
      if (!companyId && email && byContactEmail.has(email)) { companyId = byContactEmail.get(email)!; how = "contact_email"; }
      if (!companyId) {
        for (const k of nameKeys(rawName)) {
          const hit = byAjmName.get(k);
          if (hit) { companyId = hit; how = "ajm_order_name"; break; }
        }
      }
      if (!companyId) {
        for (const k of nameKeys(rawName)) {
          const hits = byName.get(k);
          if (!hits?.length) continue;
          if (hits.length === 1) { companyId = hits[0]; how = "company_name"; break; }
          // Several companies share this name — only proceed if the OMS
          // address singles one out. Otherwise this could be any of them.
          const narrowed = hits.filter((id) => {
            const c = companyById.get(id)!;
            if (zip && c.zip.slice(0, 5) === zip) return true;
            if (city && state && c.city === city && normalizeState(c.state) === state) return true;
            return false;
          });
          if (narrowed.length === 1) { companyId = narrowed[0]; how = "name_and_location"; break; }
          res.ambiguous++;
          if (res.ambiguousSample.length < 25) res.ambiguousSample.push(`${rawName} (${hits.length} candidates)`);
          break;
        }
      }
      if (!companyId) {
        res.unmatched++;
        if (res.unmatchedSample.length < 25) res.unmatchedSample.push(rawName);
        continue;
      }

      res.matched++;
      res.matchedBy[how] = (res.matchedBy[how] ?? 0) + 1;

      const phone = normalizePhone(r[idx.phone] ?? "");
      const street = [clean(r[idx.address]), clean(r[idx.address2])].filter(Boolean).join(", ");
      const values: Record<string, string> = {
        email, phone, address: street,
        city: clean(r[idx.city]), state: clean(r[idx.state]),
        zip: clean(r[idx.zip]), country: clean(r[idx.country]),
      };

      const filled: string[] = [];
      for (const c of FILLABLE) {
        const v = values[c];
        if (!v) continue;
        if (apply) {
          if (setCol.get(c)!(v, companyId) > 0) filled.push(c);
        } else {
          // Dry run: report what IS blank today.
          const cur = sqlite.prepare(`SELECT ${c} AS v FROM companies WHERE id = ?`).get(companyId) as { v: string | null };
          if (cur && (cur.v === null || String(cur.v).trim() === "")) filled.push(c);
        }
      }
      for (const c of filled) res.fieldsFilled[c] = (res.fieldsFilled[c] ?? 0) + 1;

      // A contact, but only if this company has none with an email — we are
      // adding a way to reach them, not a second opinion on who to call.
      const who = contactName(r[idx.attn] ?? "");
      const needsContact = email && (contactCount.get(companyId) as { n: number }).n === 0;
      if (needsContact) {
        if (apply) {
          insContact.run(crypto.randomUUID(), companyId, who?.first ?? null, who?.last ?? null,
            email, phone || null, clean(r[idx.title]) || null, 1);
          byContactEmail.set(email, companyId);
        }
        res.contactsCreated++;
      }

      if (hasPhonesTable && phone && apply) {
        try {
          const r2 = sqlite.prepare(
            "INSERT OR IGNORE INTO company_phones (id, company_id, phone) VALUES (?, ?, ?)",
          ).run(crypto.randomUUID(), companyId, phone);
          if (r2.changes) res.phonesAdded++;
        } catch { /* schema differs — the companies.phone fill still landed */ }
      }

      if (hasOmsCol && omsId && apply) {
        sqlite.prepare(
          "UPDATE companies SET oms_customer_id = ? WHERE id = ? AND TRIM(COALESCE(oms_customer_id,'')) = ''",
        ).run(omsId, companyId);
      }

      if (filled.length && res.examples.length < 40) {
        res.examples.push({
          company: companyById.get(companyId)?.name ?? rawName,
          filled, email: email || undefined, phone: phone || undefined,
        });
      }
    }
  };

  if (apply) sqlite.transaction(run)(); else run();
  return res;
}
