/**
 * Xero Integration (Stub)
 * 
 * OAuth2 flow and bank transaction push for settlement sync.
 * Requires XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_TENANT_ID env vars.
 * Until credentials are configured, all methods return setup instructions.
 */

import { db } from "@/lib/db";
import { settlements } from "@/modules/finance/schema";
import { eq } from "drizzle-orm";

interface XeroConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
}

interface XeroTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// In-memory token store (would persist in production)
let cachedTokens: XeroTokens | null = null;

function getConfig(): XeroConfig | null {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const tenantId = process.env.XERO_TENANT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI || "http://localhost:3000/api/v1/finance/xero/callback";

  if (!clientId || !clientSecret || !tenantId) return null;
  return { clientId, clientSecret, tenantId, redirectUri };
}

export function isXeroConfigured(): boolean {
  return getConfig() !== null;
}

export function getXeroSetupInstructions(): string {
  return `## Xero Integration Setup

1. Go to https://developer.xero.com/app/manage
2. Create a new app (Web App type)
3. Set redirect URI to: \`http://localhost:3000/api/v1/finance/xero/callback\`
4. Add these env vars to your .env:
   \`\`\`
   XERO_CLIENT_ID=your_client_id
   XERO_CLIENT_SECRET=your_client_secret
   XERO_TENANT_ID=your_tenant_id
   \`\`\`
5. Restart the app and click "Connect to Xero" on the Finance page

Required scopes: accounting.transactions, accounting.contacts`;
}

/**
 * Generate OAuth2 authorization URL
 */
export function getXeroAuthUrl(): string | null {
  const config = getConfig();
  if (!config) return null;

  const scopes = "openid profile email accounting.transactions accounting.contacts offline_access";
  const state = crypto.randomUUID();

  return `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${config.clientId}&redirect_uri=${encodeURIComponent(config.redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeXeroCode(code: string): Promise<boolean> {
  const config = getConfig();
  if (!config) return false;

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

  if (!res.ok) return false;

  const data = await res.json();
  cachedTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return true;
}

/**
 * Refresh access token
 */
async function refreshTokens(): Promise<boolean> {
  const config = getConfig();
  if (!config || !cachedTokens?.refreshToken) return false;

  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cachedTokens.refreshToken,
    }),
  });

  if (!res.ok) return false;

  const data = await res.json();
  cachedTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return true;
}

async function getAccessToken(): Promise<string | null> {
  if (!cachedTokens) return null;
  if (Date.now() >= cachedTokens.expiresAt - 60000) {
    const ok = await refreshTokens();
    if (!ok) return null;
  }
  return cachedTokens!.accessToken;
}

/**
 * Push a settlement to Xero as a bank transaction.
 */
export async function syncSettlementToXero(settlementId: string): Promise<{ success: boolean; error?: string }> {
  const config = getConfig();
  if (!config) return { success: false, error: "Xero not configured. " + getXeroSetupInstructions() };

  const token = await getAccessToken();
  if (!token) return { success: false, error: "Not authenticated with Xero. Please connect first." };

  const settlement = db.select().from(settlements).where(eq(settlements.id, settlementId)).get();
  if (!settlement) return { success: false, error: "Settlement not found" };
  if (settlement.xeroTransactionId) return { success: false, error: "Already synced to Xero" };

  const channelLabels: Record<string, string> = {
    shopify_dtc: "Shopify DTC",
    shopify_wholesale: "Shopify Wholesale",
    faire: "Faire",
    amazon: "Amazon",
  };

  // Create bank transaction in Xero
  const bankTransaction = {
    Type: "RECEIVE",
    Contact: { Name: channelLabels[settlement.channel] || settlement.channel },
    Date: settlement.receivedAt || settlement.periodEnd,
    LineItems: [
      {
        Description: `${channelLabels[settlement.channel]} settlement ${settlement.periodStart} to ${settlement.periodEnd}`,
        Quantity: 1,
        UnitAmount: settlement.grossAmount,
        AccountCode: "200", // Sales revenue account
      },
      {
        Description: `${channelLabels[settlement.channel]} fees`,
        Quantity: 1,
        UnitAmount: -settlement.fees,
        AccountCode: "404", // Processing fees account
      },
    ],
    BankAccount: { Code: "090" }, // Default bank account
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
      Authorization: `Bearer ${token}`,
      "xero-tenant-id": config.tenantId,
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

  // Update settlement status
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
