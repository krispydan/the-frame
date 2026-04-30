/**
 * Xero Integration
 * 
 * OAuth2 flow and accounting sync for settlements, invoices, and chart of accounts.
 * Supports both env-based config and DB-stored OAuth tokens.
 */

import { db } from "@/lib/db";
import { settlements } from "@/modules/finance/schema";
import { settings } from "@/modules/core/schema";
import { eq } from "drizzle-orm";

interface XeroConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface XeroTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tenantId?: string;
  tenantName?: string;
}

function getConfig(): XeroConfig | null {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  // Default to the new /api/auth/xero/callback route (matches the Shopify
  // pattern). Override via XERO_REDIRECT_URI when running locally without
  // SHOPIFY_APP_URL set.
  const appUrl = process.env.SHOPIFY_APP_URL || process.env.XERO_APP_URL || "http://localhost:3000";
  const redirectUri = process.env.XERO_REDIRECT_URI || `${appUrl.replace(/\/$/, "")}/api/auth/xero/callback`;

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isXeroConfigured(): boolean {
  return getConfig() !== null;
}

/**
 * Check if Xero is connected (has valid tokens in DB).
 */
export function getXeroConnectionStatus(): {
  connected: boolean;
  tenantName?: string;
  connectedAt?: string;
} {
  const token = db.select().from(settings).where(eq(settings.key, "xero_access_token")).get();
  const tenantName = db.select().from(settings).where(eq(settings.key, "xero_tenant_name")).get();
  const connectedAt = db.select().from(settings).where(eq(settings.key, "xero_connected_at")).get();

  return {
    connected: !!token?.value,
    tenantName: tenantName?.value || undefined,
    connectedAt: connectedAt?.value || undefined,
  };
}

export function getXeroSetupInstructions(): string {
  return `## Xero Integration Setup

1. Go to https://developer.xero.com/app/manage
2. Create a new app (Web App type)
3. Set redirect URI to: \`http://localhost:3000/api/v1/auth/xero/callback\`
4. Add these env vars to your .env:
   \`\`\`
   XERO_CLIENT_ID=your_client_id
   XERO_CLIENT_SECRET=your_client_secret
   \`\`\`
5. Restart the app and click "Connect to Xero" on the Settings page

Required scopes: accounting.transactions, accounting.contacts, accounting.settings`;
}

/**
 * Generate OAuth2 authorization URL
 */
export function getXeroAuthUrl(): string | null {
  const config = getConfig();
  if (!config) return null;

  // Granular scopes (post-2-Mar-2026 apps). Verified working set:
  //   openid / profile / email   - identity
  //   offline_access              - refresh tokens
  //   accounting.manualjournals   - read + write manual journals (Phase 2)
  //   accounting.settings.read    - chart of accounts (Phase 1 mapping UI)
  //   files                       - attach payout CSVs to journals
  // Override via XERO_SCOPES env var if Xero adds or renames scopes.
  const scopes = process.env.XERO_SCOPES ||
    "openid profile email offline_access accounting.manualjournals accounting.settings.read files";
  const state = crypto.randomUUID();

  return `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${config.clientId}&redirect_uri=${encodeURIComponent(config.redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
}

/**
 * Exchange authorization code for tokens. Returns tokens for storage.
 */
export async function exchangeXeroCode(code: string): Promise<{
  success: boolean;
  tokens?: XeroTokens;
  error?: string;
}> {
  const config = getConfig();
  if (!config) return { success: false, error: "Xero not configured" };

  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { success: false, error: `Token exchange failed: ${err}` };
  }

  const data = await res.json();
  const tokens: XeroTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  // Fetch tenant info
  try {
    const connectionsRes = await fetch("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (connectionsRes.ok) {
      const connections = await connectionsRes.json();
      if (connections.length > 0) {
        tokens.tenantId = connections[0].tenantId;
        tokens.tenantName = connections[0].tenantName;
      }
    }
  } catch {
    // Non-fatal: tenant info can be fetched later
  }

  return { success: true, tokens };
}

/**
 * Load tokens from the settings DB and auto-refresh if needed.
 */
async function getAccessToken(): Promise<{ token: string; tenantId: string } | null> {
  const accessTokenRow = db.select().from(settings).where(eq(settings.key, "xero_access_token")).get();
  const refreshTokenRow = db.select().from(settings).where(eq(settings.key, "xero_refresh_token")).get();
  const expiresAtRow = db.select().from(settings).where(eq(settings.key, "xero_token_expires_at")).get();
  const tenantIdRow = db.select().from(settings).where(eq(settings.key, "xero_tenant_id")).get();

  if (!accessTokenRow?.value || !refreshTokenRow?.value || !tenantIdRow?.value) return null;

  const expiresAt = parseInt(expiresAtRow?.value || "0");

  // Auto-refresh if expiring within 60 seconds
  if (Date.now() >= expiresAt - 60000) {
    const config = getConfig();
    if (!config) return null;

    const res = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshTokenRow.value,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const now = new Date().toISOString();

    // Update tokens in DB
    const updates = [
      { key: "xero_access_token", value: data.access_token },
      { key: "xero_refresh_token", value: data.refresh_token },
      { key: "xero_token_expires_at", value: String(Date.now() + data.expires_in * 1000) },
    ];
    for (const u of updates) {
      db.insert(settings)
        .values({ key: u.key, value: u.value, type: "string", module: "finance" })
        .onConflictDoUpdate({ target: settings.key, set: { value: u.value, updatedAt: now } })
        .run();
    }

    return { token: data.access_token, tenantId: tenantIdRow.value };
  }

  return { token: accessTokenRow.value, tenantId: tenantIdRow.value };
}

/**
 * Disconnect Xero — remove all stored tokens.
 */
export function disconnectXero(): void {
  const keys = [
    "xero_access_token", "xero_refresh_token", "xero_token_expires_at",
    "xero_tenant_id", "xero_tenant_name", "xero_connected_at",
  ];
  for (const key of keys) {
    db.delete(settings).where(eq(settings.key, key)).run();
  }
}

/**
 * Push a settlement to Xero as a bank transaction.
 */
export async function syncSettlementToXero(settlementId: string): Promise<{ success: boolean; error?: string }> {
  const auth = await getAccessToken();
  if (!auth) return { success: false, error: "Not authenticated with Xero. Please connect first." };

  const settlement = db.select().from(settlements).where(eq(settlements.id, settlementId)).get();
  if (!settlement) return { success: false, error: "Settlement not found" };
  if (settlement.xeroTransactionId) return { success: false, error: "Already synced to Xero" };

  const channelLabels: Record<string, string> = {
    shopify_dtc: "Shopify DTC",
    shopify_wholesale: "Shopify Wholesale",
    faire: "Faire",
    amazon: "Amazon",
  };

  const bankTransaction = {
    Type: "RECEIVE",
    Contact: { Name: channelLabels[settlement.channel] || settlement.channel },
    Date: settlement.receivedAt || settlement.periodEnd,
    LineItems: [
      {
        Description: `${channelLabels[settlement.channel]} settlement ${settlement.periodStart} to ${settlement.periodEnd}`,
        Quantity: 1,
        UnitAmount: settlement.grossAmount,
        AccountCode: "200",
      },
      {
        Description: `${channelLabels[settlement.channel]} fees`,
        Quantity: 1,
        UnitAmount: -settlement.fees,
        AccountCode: "404",
      },
    ] as Array<{ Description: string; Quantity: number; UnitAmount: number; AccountCode: string }>,
    BankAccount: { Code: "090" },
    Reference: settlement.externalId || settlementId,
  };

  if (settlement.adjustments !== 0) {
    bankTransaction.LineItems.push({
      Description: "Adjustments",
      Quantity: 1,
      UnitAmount: settlement.adjustments,
      AccountCode: "200",
    });
  }

  const res = await fetch("https://api.xero.com/api.xro/2.0/BankTransactions", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "xero-tenant-id": auth.tenantId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ BankTransactions: [bankTransaction] }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { success: false, error: `Xero API error: ${res.status} ${err}` };
  }

  const result = await res.json();
  const xeroId = result?.BankTransactions?.[0]?.BankTransactionID;

  db.update(settlements)
    .set({
      status: "synced_to_xero",
      xeroTransactionId: xeroId || "synced",
      xeroSyncedAt: new Date().toISOString(),
    })
    .where(eq(settlements.id, settlementId))
    .run();

  return { success: true };
}

/**
 * Create an invoice in Xero from an order.
 */
export async function pushInvoiceToXero(order: {
  id: string;
  customerName: string;
  customerEmail: string;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number; accountCode?: string }>;
  dueDate?: string;
  reference?: string;
}): Promise<{ success: boolean; invoiceId?: string; error?: string }> {
  const auth = await getAccessToken();
  if (!auth) return { success: false, error: "Not authenticated with Xero" };

  const invoice = {
    Type: "ACCREC",
    Contact: { Name: order.customerName, EmailAddress: order.customerEmail },
    Date: new Date().toISOString().split("T")[0],
    DueDate: order.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
    LineItems: order.lineItems.map((li) => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unitPrice,
      AccountCode: li.accountCode || "200",
    })),
    Reference: order.reference || order.id,
    Status: "AUTHORISED",
  };

  const res = await fetch("https://api.xero.com/api.xro/2.0/Invoices", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "xero-tenant-id": auth.tenantId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ Invoices: [invoice] }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { success: false, error: `Xero API error: ${res.status} ${err}` };
  }

  const result = await res.json();
  const invoiceId = result?.Invoices?.[0]?.InvoiceID;
  return { success: true, invoiceId };
}

/**
 * Pull chart of accounts from Xero.
 */
export async function getChartOfAccounts(): Promise<{
  success: boolean;
  accounts?: Array<{ code: string; name: string; type: string; status: string }>;
  error?: string;
}> {
  try {
    const auth = await getAccessToken();
    if (!auth) return { success: false, error: "Not authenticated with Xero" };

    const res = await fetch("https://api.xero.com/api.xro/2.0/Accounts", {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Xero-tenant-id": auth.tenantId,
        // Xero defaults to XML — explicitly ask for JSON.
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const err = await res.text();
      return { success: false, error: `Xero API ${res.status}: ${err.slice(0, 300)}` };
    }

    const result = await res.json();
    const accounts = (result?.Accounts || []).map((a: Record<string, string>) => ({
      code: a.Code,
      name: a.Name,
      type: a.Type,
      status: a.Status,
    }));

    return { success: true, accounts };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[Xero] getChartOfAccounts error:", e);
    return { success: false, error: `Chart of accounts fetch failed: ${msg}` };
  }
}

/**
 * Map an expense category to a Xero account code (stored in settings).
 */
export function mapExpenseCategoryToXero(categoryId: string, xeroAccountCode: string): void {
  const key = `xero_category_map_${categoryId}`;
  db.insert(settings)
    .values({ key, value: xeroAccountCode, type: "string", module: "finance" })
    .onConflictDoUpdate({ target: settings.key, set: { value: xeroAccountCode, updatedAt: new Date().toISOString() } })
    .run();
}

/**
 * Get the Xero account code mapped to an expense category.
 */
export function getXeroCategoryMapping(categoryId: string): string | null {
  const key = `xero_category_map_${categoryId}`;
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value || null;
}

// ── COGS Manual Journal Posting ──

interface CogsJournalInput {
  weekStart: string;
  weekEnd: string;
  productCost: number;
  freightCost: number;
  dutiesCost: number;
  totalCogs: number;
  unitCount: number;
  channelBreakdown?: Record<string, { units: number; productCost: number; freightCost: number; dutiesCost: number; totalCogs: number }>;
  asDraft?: boolean;
}

/**
 * Xero account codes for COGS posting. These should match the user's actual
 * chart of accounts in Xero. Configurable via settings.
 */
function getCogsAccountCodes() {
  const productCogs = db.select().from(settings).where(eq(settings.key, "xero_cogs_product_account")).get()?.value || "500";
  const freightCogs = db.select().from(settings).where(eq(settings.key, "xero_cogs_freight_account")).get()?.value || "501";
  const dutiesCogs = db.select().from(settings).where(eq(settings.key, "xero_cogs_duties_account")).get()?.value || "502";
  const inventoryAsset = db.select().from(settings).where(eq(settings.key, "xero_inventory_asset_account")).get()?.value || "630";
  return { productCogs, freightCogs, dutiesCogs, inventoryAsset };
}

/**
 * Post a weekly COGS journal to Xero as a Manual Journal.
 *
 * The journal debits COGS accounts (product / freight / duties) and credits
 * the Inventory Asset account. Lines net to zero.
 *
 * Returns the Xero ManualJournalID on success.
 */
export async function postCogsJournalToXero(
  input: CogsJournalInput,
): Promise<{ success: boolean; journalId?: string; error?: string }> {
  const auth = await getAccessToken();
  if (!auth) return { success: false, error: "Not authenticated with Xero" };

  const codes = getCogsAccountCodes();
  const status = input.asDraft ? "DRAFT" : "POSTED";
  const narration = `Weekly COGS — ${input.weekStart} to ${input.weekEnd} (${input.unitCount} units)`;

  const journalLines: Array<{
    LineAmount: number;
    AccountCode: string;
    Description: string;
    Tracking?: Array<{ Name: string; Option: string }>;
  }> = [];

  // Debit lines — split by cost component
  if (input.productCost > 0) {
    journalLines.push({
      LineAmount: Math.round(input.productCost * 100) / 100,
      AccountCode: codes.productCogs,
      Description: `COGS — Product cost (${input.unitCount} units)`,
    });
  }
  if (input.freightCost > 0) {
    journalLines.push({
      LineAmount: Math.round(input.freightCost * 100) / 100,
      AccountCode: codes.freightCogs,
      Description: `COGS — Freight/shipping allocation`,
    });
  }
  if (input.dutiesCost > 0) {
    journalLines.push({
      LineAmount: Math.round(input.dutiesCost * 100) / 100,
      AccountCode: codes.dutiesCogs,
      Description: `COGS — Duties/tariffs allocation`,
    });
  }

  // Credit line — inventory asset (must equal the sum of debits, negative)
  const totalDebit = journalLines.reduce((sum, l) => sum + l.LineAmount, 0);
  journalLines.push({
    LineAmount: -Math.round(totalDebit * 100) / 100,
    AccountCode: codes.inventoryAsset,
    Description: `Inventory consumed — ${input.weekStart} to ${input.weekEnd}`,
  });

  const payload = {
    ManualJournals: [{
      Narration: narration,
      Date: input.weekEnd,
      Status: status,
      LineAmountTypes: "NoTax",
      JournalLines: journalLines,
    }],
  };

  try {
    const res = await fetch("https://api.xero.com/api.xro/2.0/ManualJournals", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "xero-tenant-id": auth.tenantId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { success: false, error: `Xero ${res.status}: ${errText.slice(0, 500)}` };
    }

    const data = await res.json();
    const journalId = data?.ManualJournals?.[0]?.ManualJournalID;
    return { success: true, journalId };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
