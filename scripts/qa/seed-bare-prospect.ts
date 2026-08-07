/**
 * The sparse prospect — the other half of the QA matrix.
 *
 * A name, a city, and nothing else. This is the case the old page handled
 * worst: six cards each spending a full screenful announcing their own
 * emptiness. Every section should now be absent.
 *
 * Run: DATABASE_PATH=data/qa.db npx tsx scripts/qa/seed-bare-prospect.ts
 */
import { sqlite } from "@/lib/db";

const ID = "qa-bare-prospect";
for (const t of ["ajm_orders", "orders", "contacts", "stores", "gmaps_listings", "company_phones"]) {
  try { sqlite.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(ID); } catch { /* absent */ }
}
sqlite.prepare("DELETE FROM companies WHERE id = ?").run(ID);
sqlite.prepare(
  `INSERT INTO companies (id, name, city, state, status, created_at)
   VALUES (?, 'Corner Optical', 'Boise', 'ID', 'prospect', '2026-08-01')`,
).run(ID);
console.log(`page: /prospects/${ID}`);
