/**
 * Verify the Xero side is ready for the accrual revenue-recognition flow
 * we shipped on 2026-05-13. Specifically: does the chart of accounts have
 * the two new shared accounts we need?
 *
 *   1100  Receivables Holding (CURRENT_ASSET)
 *           — parks the NET payout before BankTransaction sweeps to 101x
 *   2200  Deferred Revenue (CURRENT_LIABILITY)
 *           — holds GROSS revenue until shipment under ASC 606
 *
 * If either is missing, the script prints precise Xero UI instructions
 * for creating them and exits non-zero so cron callers don't try to post.
 *
 * Run after deploy:
 *   npx tsx scripts/verify-xero-accrual-setup.ts
 */
import { getChartOfAccounts } from "@/modules/finance/lib/xero-client";

interface RequiredAccount {
  code: string;
  name: string;
  type: "CURRENT" | "CURRLIAB";
  description: string;
}

const REQUIRED: RequiredAccount[] = [
  {
    code: "1100",
    name: "Receivables Holding",
    type: "CURRENT",
    description: "Non-bank clearing account for net Shopify payouts before BankTransaction sweeps to 101x clearing.",
  },
  {
    code: "2200",
    name: "Deferred Revenue",
    type: "CURRLIAB",
    description: "Liability for paid-but-unshipped orders. Cleared into Sales Revenue at shipment under accrual / ASC 606.",
  },
];

async function main() {
  console.log("Checking Xero chart of accounts for accrual-flow prerequisites...\n");
  const coa = await getChartOfAccounts();
  if (!coa.success || !coa.accounts) {
    console.error(`✗ Couldn't fetch chart of accounts: ${coa.error}`);
    process.exit(1);
  }

  const missing: RequiredAccount[] = [];
  for (const req of REQUIRED) {
    const found = coa.accounts.find((a) => a.code === req.code);
    if (!found) {
      missing.push(req);
      console.log(`✗ ${req.code} ${req.name} — NOT FOUND in Xero`);
    } else if (found.status !== "ACTIVE") {
      console.log(`⚠ ${req.code} ${req.name} — exists but status=${found.status} (need ACTIVE)`);
      missing.push(req);
    } else {
      console.log(`✓ ${req.code} ${req.name} — type=${found.type}, status=${found.status}`);
    }
  }

  if (missing.length > 0) {
    console.log("\n");
    console.log("════════════════════════════════════════════════════════════════════");
    console.log("  ACTION REQUIRED — create these accounts in Xero before deploying");
    console.log("════════════════════════════════════════════════════════════════════");
    console.log("\nXero → Accounting → Chart of accounts → + Add Account, then:\n");
    for (const m of missing) {
      console.log(`  Code:        ${m.code}`);
      console.log(`  Name:        ${m.name}`);
      console.log(`  Type:        ${m.type === "CURRENT" ? "Current Asset" : "Current Liability"}`);
      console.log(`  Tax type:    No Tax`);
      console.log(`  Description: ${m.description}`);
      console.log("");
    }
    console.log("After creating both, re-run this script to verify, then deploy.\n");
    process.exit(2);
  }

  console.log("\n✓ All required accounts present and active. Safe to deploy accrual flow.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Verification threw:", e);
  process.exit(1);
});
