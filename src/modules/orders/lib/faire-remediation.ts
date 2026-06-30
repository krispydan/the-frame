/**
 * Faire mis-attribution remediation.
 *
 * Before the relay.faire.com fix, every Faire order's domain-match resolved to
 * the *first* company auto-created with domain='relay.faire.com', collapsing
 * many retailers into one (e.g. ~50 orders under "Briars & Brambles Co"). This
 * splits them back out:
 *
 *  - Find the "magnet" companies (domain = relay.faire.com).
 *  - For each of their orders, the real retailer name is on orders.ship_to_name
 *    (Faire sets shipping_address.company, which deriveShipToName stores). Orders
 *    whose ship_to_name differs from the magnet's name are re-attributed to a
 *    find-or-create company of that name.
 *  - The bogus domain is cleared off the magnet so it stops attracting orders.
 *  - When connected, the order's Pipedrive deal is moved to the correct org
 *    (org_id + title updated) so the board matches.
 *
 * Idempotent and dry-run-able. ship_to_name is the identity key — orders
 * without one can't be split and are reported as unresolved.
 */

import crypto from "crypto";
import { sqlite } from "@/lib/db";

const RELAY_DOMAIN = "relay.faire.com";

function norm(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}

interface MagnetRow {
  id: string;
  name: string | null;
}
interface OrderRow {
  id: string;
  order_number: string | null;
  ship_to_name: string | null;
  company_id: string | null;
  pipedrive_deal_id: number | null;
}

export interface FaireRemediationResult {
  magnets: number;
  ordersScanned: number;
  reassigned: number;
  companiesCreated: number;
  kept: number;
  unresolved: number;
  pipedriveDealsMoved: number;
  pipedriveErrors: number;
  dryRun: boolean;
  sample: Array<{ order: string; from: string; to: string }>;
}

/** Find (case-insensitive) or create a company by exact store name. */
function findOrCreateCompanyByName(name: string, dryRun: boolean, createdCounter: { n: number }): string | null {
  const existing = sqlite
    .prepare("SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1")
    .get(name) as { id: string } | undefined;
  if (existing) return existing.id;
  createdCounter.n++;
  if (dryRun) return null; // can't know the id without inserting
  const id = crypto.randomUUID();
  sqlite
    .prepare(
      `INSERT INTO companies (id, name, source, created_at, updated_at)
       VALUES (?, ?, 'faire', datetime('now'), datetime('now'))`,
    )
    .run(id, name.trim());
  return id;
}

export async function remediateFaireOrders(
  opts: { dryRun?: boolean; fixPipedrive?: boolean } = {},
): Promise<FaireRemediationResult> {
  const dryRun = opts.dryRun ?? true;
  const fixPipedrive = opts.fixPipedrive ?? true;

  const result: FaireRemediationResult = {
    magnets: 0,
    ordersScanned: 0,
    reassigned: 0,
    companiesCreated: 0,
    kept: 0,
    unresolved: 0,
    pipedriveDealsMoved: 0,
    pipedriveErrors: 0,
    dryRun,
    sample: [],
  };

  // Lazy Pipedrive wiring — avoids a static orders↔sales import cycle, and
  // lets remediation run frame-only when Pipedrive isn't connected.
  let pd: typeof import("@/modules/sales/lib/pipedrive-sync") | null = null;
  let pdClient: typeof import("@/modules/sales/lib/pipedrive-client") | null = null;
  if (fixPipedrive) {
    try {
      pdClient = await import("@/modules/sales/lib/pipedrive-client");
      if (pdClient.getPipedriveConnectionStatus().connected) {
        pd = await import("@/modules/sales/lib/pipedrive-sync");
      } else {
        pdClient = null;
      }
    } catch {
      pd = null;
      pdClient = null;
    }
  }

  const magnets = sqlite
    .prepare("SELECT id, name FROM companies WHERE LOWER(COALESCE(domain,'')) = ?")
    .all(RELAY_DOMAIN) as MagnetRow[];
  result.magnets = magnets.length;
  const createdCounter = { n: 0 };

  for (const magnet of magnets) {
    const orders = sqlite
      .prepare(
        `SELECT id, order_number, ship_to_name, company_id, pipedrive_deal_id
           FROM orders WHERE company_id = ?`,
      )
      .all(magnet.id) as OrderRow[];

    for (const o of orders) {
      result.ordersScanned++;
      const storeName = (o.ship_to_name || "").trim();
      if (!storeName) {
        result.unresolved++;
        continue;
      }
      if (norm(storeName) === norm(magnet.name)) {
        result.kept++;
        continue; // genuinely the magnet's own order
      }

      const targetId = findOrCreateCompanyByName(storeName, dryRun, createdCounter);
      if (result.sample.length < 30) {
        result.sample.push({ order: o.order_number || o.id, from: magnet.name || magnet.id, to: storeName });
      }
      if (dryRun || !targetId) {
        result.reassigned++;
        continue;
      }

      sqlite.prepare("UPDATE orders SET company_id = ?, updated_at = datetime('now') WHERE id = ?").run(targetId, o.id);
      result.reassigned++;

      // Move the Pipedrive deal to the correct org (org_id + title).
      if (pd && pdClient && o.pipedrive_deal_id) {
        try {
          const orgId = await pd.resolveOrg(targetId);
          await pdClient.updateDeal(o.pipedrive_deal_id, {
            org_id: orgId,
            title: `${storeName} — order ${o.order_number || ""}`.trim(),
          });
          sqlite
            .prepare("UPDATE pipedrive_deals SET company_id = ? WHERE pipedrive_deal_id = ?")
            .run(targetId, o.pipedrive_deal_id);
          result.pipedriveDealsMoved++;
        } catch {
          result.pipedriveErrors++;
        }
      }
    }

    // Clear the bogus domain so this company never attracts Faire orders again.
    if (!dryRun) {
      sqlite.prepare("UPDATE companies SET domain = NULL WHERE id = ?").run(magnet.id);
    }
  }

  result.companiesCreated = createdCounter.n;
  return result;
}
