/**
 * Seed one realistic company for visual QA of the company page.
 *
 * Mirrors the exact record that produced the iPhone screenshot behind the
 * redesign — long email, UK address, a nameless primary contact, AJM history
 * whose line items are raw style codes, and a Google Maps match for a
 * completely different business in another country. It also leaves Pipedrive,
 * campaigns, notes and activity empty, because five near-empty cards are a
 * large part of what makes the mobile page 5,172px tall.
 *
 * Run: DATABASE_PATH=data/qa.db npx tsx scripts/qa/seed-company-page-fixture.ts
 */
import { sqlite } from "@/lib/db";
import bcrypt from "bcryptjs";

const COMPANY_ID = "qa-village-pharmacy";
const QA_EMAIL = "qa@theframe.local";
const QA_PASSWORD = "qa-password";

function exec(sql: string, ...args: unknown[]) {
  try { return sqlite.prepare(sql).run(...args); } catch (e) { console.error("  !", (e as Error).message.slice(0, 120)); }
}

const cols = (t: string) => new Set(
  (sqlite.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));

/**
 * Insert only the columns this database actually has. A dev database is often
 * a partial copy, and a fixture that hard-codes a column list dies on the
 * first mismatch instead of seeding what it can.
 */
function insertRow(table: string, row: Record<string, unknown>) {
  const have = cols(table);
  const keys = Object.keys(row).filter((k) => have.has(k));
  if (!keys.length) { console.error(`  ! ${table}: no matching columns`); return; }
  exec(
    `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ...keys.map((k) => row[k]),
  );
}

// ── A user we can actually log in as ──
// A fresh QA database has no users table until something creates it.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT,
    role TEXT DEFAULT 'owner', is_active INTEGER DEFAULT 1, password_hash TEXT,
    last_login_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`);
  sqlite.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
} catch { /* already present */ }
const existing = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(QA_EMAIL) as { id: string } | undefined;
const userId = existing?.id ?? "qa-user";
if (!existing) {
  exec(
    "INSERT INTO users (id, email, name, role, is_active) VALUES (?,?,?,'owner',1)",
    userId, QA_EMAIL, "QA User",
  );
}
try {
  sqlite.prepare("UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?")
    .run(bcrypt.hashSync(QA_PASSWORD, 8), userId);
} catch { /* column may not exist on an old schema */ }

// A partial dev database may be missing tables the real app creates
// elsewhere; the fixture only needs the columns it writes.
for (const ddl of [
  `CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, company_id TEXT, name TEXT, address TEXT,
     city TEXT, state TEXT, zip TEXT, phone TEXT, email TEXT, manager_name TEXT, is_primary INTEGER DEFAULT 1,
     status TEXT DEFAULT 'active', notes TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, store_id TEXT, company_id TEXT, first_name TEXT,
     last_name TEXT, email TEXT, phone TEXT, title TEXT, is_primary INTEGER DEFAULT 1, owner_id TEXT,
     source TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`,
]) { try { sqlite.exec(ddl); } catch { /* exists */ } }

// ── The company ──
// Children first: a re-run otherwise trips the foreign key on companies.
exec("DELETE FROM ajm_order_items WHERE order_id IN (SELECT id FROM ajm_orders WHERE company_id = ?)", COMPANY_ID);
for (const t of ["ajm_orders", "orders", "contacts", "stores", "gmaps_listings", "company_phones"]) {
  exec(`DELETE FROM ${t} WHERE company_id = ?`, COMPANY_ID);
}
exec("DELETE FROM companies WHERE id = ?", COMPANY_ID);
insertRow("companies", {
  id: COMPANY_ID, name: "The Village Pharmacy", type: "independent", website: "", domain: "",
  address: "Wetherby, LS22 5AW", city: "Wetherby", state: "", zip: "LS22 5AW", country: "GB",
  status: "qualified_lead", source: "storemapper", icp_tier: "B", icp_score: 65,
  segment: "Pharmacy", category: "Pharmacy", created_at: "2025-02-01",
});

// A store with a fuller address than the company — the duplication is real.
exec("DELETE FROM stores WHERE company_id = ?", COMPANY_ID);
insertRow("stores", {
  id: "qa-store-1", company_id: COMPANY_ID, name: "The Village Pharmacy",
  address: "5 Hastings Court, Collingham", city: "Wetherby", state: "", zip: "LS22 5AW",
  is_primary: 1, status: "active",
});

// A contact with NO name — the page renders this as "Unknown".
exec("DELETE FROM contacts WHERE company_id = ?", COMPANY_ID);
insertRow("contacts", {
  id: "qa-contact-1", company_id: COMPANY_ID, store_id: "qa-store-1",
  first_name: null, last_name: null,
  email: "village.pharmacy@hotmail.co.uk", phone: "01937572388", is_primary: 1,
});
try {
  exec("DELETE FROM company_phones WHERE company_id = ?", COMPANY_ID);
  sqlite.prepare(
    "INSERT INTO company_phones (id, company_id, phone, source, is_primary) VALUES ('qa-phone-1', ?, '01937572388', 'qa', 1)",
  ).run(COMPANY_ID);
} catch { /* table shape differs */ }

// ── AJM history: 38 orders, line items that are bare style codes ──
exec("DELETE FROM ajm_order_items WHERE order_id IN (SELECT id FROM ajm_orders WHERE company_id = ?)", COMPANY_ID);
exec("DELETE FROM ajm_orders WHERE company_id = ?", COMPANY_ID);
const styles = ["324803", "299444", "311473", "326667", "308383", "320615", "323349", "297143"];
const totals = [2557, 1895, 1686, 1646, 1633, 1479, 1423, 1321];
const realProducts: Array<[string, number, number]> = [
  ["Alameda Tortoise", 12, 32], ["Bondi Matte Black", 8, 34],
  ["Cassis Crystal", 6, 30], ["Delray Havana", 10, 33],
];
for (let i = 0; i < 38; i++) {
  const id = `qa-ajm-${i}`;
  const month = String((i % 12) + 1).padStart(2, "0");
  const year = 2022 + Math.floor(i / 13);
  const total = Math.round((38531 / 38) * (0.6 + (i % 5) * 0.2));
  exec(
    `INSERT INTO ajm_orders (id, source, order_number, order_date, customer_name, city, state, country, total, status, cancelled, units, company_id)
     VALUES (?, 'shopify_wholesale', ?, ?, 'THE VILLAGE PHARMACY', 'Wetherby', '', 'GB', ?, 'fulfilled', 0, ?, ?)`,
    id, `AJM-${1000 + i}`, `${year}-${month}-15`, total, 3, COMPANY_ID,
  );
  // Production has both kinds of line and the page must tell them apart:
  // legacy lump-sum invoices (no SKU, qty 1, name is an invoice number,
  // categorised no_detail) and real products with names.
  if (i < styles.length) {
    exec(
      `INSERT INTO ajm_order_items (id, order_id, sku, product_name, quantity, unit_price, line_total, category)
       VALUES (?, ?, NULL, ?, 1, ?, ?, 'no_detail')`,
      `qa-ajmi-${i}`, id, styles[i], totals[i], totals[i],
    );
  } else if (i < styles.length + realProducts.length) {
    const [name, qty, price] = realProducts[i - styles.length];
    exec(
      `INSERT INTO ajm_order_items (id, order_id, sku, product_name, quantity, unit_price, line_total, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'sun')`,
      `qa-ajmi-${i}`, id, `AJM-${name}`.replace(/\s+/g, "-"), name,
      qty, price, (qty as number) * (price as number),
    );
  }
}

// ── A Google Maps match for a DIFFERENT business, in another country ──
try {
  exec("DELETE FROM gmaps_listings WHERE company_id = ?", COMPANY_ID);
  sqlite.prepare(
    `INSERT INTO gmaps_listings (id, company_id, place_id, title, category_name, categories, sub_types,
       rating, review_count, website, has_website, phone, address, city, state, postal_code,
       permanently_closed, temporarily_closed, maps_url, image_count, scraped_at)
     VALUES ('qa-gmaps-1', ?, 'qa-place-wrong', 'Village Pharmacy', 'Pharmacy', '["Pharmacy"]', '["Pharmacy"]',
       4.9, 67, 'https://www.villagerx.net/', 1, '(760) 645-3021',
       '587 E Elder St Ste C, Fallbrook, CA 92028', 'Fallbrook', 'CA', '92028',
       0, 0, 'https://maps.google.com/?cid=qa', 0, datetime('now'))`,
  ).run(COMPANY_ID);
} catch (e) { console.error("gmaps seed:", (e as Error).message.slice(0, 120)); }

console.log(`seeded company ${COMPANY_ID}`);
console.log(`login: ${QA_EMAIL} / ${QA_PASSWORD}`);
console.log(`page:  /prospects/${COMPANY_ID}`);
