/**
 * Xero Operations Playbook
 *
 * One-page reference for the bookkeeper covering:
 *   - what the-frame's automation handles for them (and when)
 *   - what's still manual (and how to do it)
 *   - month-end close checklist
 *   - bank reconciliation step-by-step
 *   - red flags to investigate
 *
 * Server-rendered. No interactivity — pure docs. Edit this file when the
 * automation changes; this is the source of truth for "what the user does
 * vs. what we do."
 */

import Link from "next/link";
import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  Wallet,
  ArrowRight,
  ExternalLink,
  Banknote,
  Calendar,
  Wrench,
  Settings,
} from "lucide-react";

export const metadata = {
  title: "Xero Playbook · the-frame",
};

export default function XeroPlaybookPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Xero Operations Playbook</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            What the-frame books to Xero automatically, what you still need to
            do manually each month, and how to investigate when something
            looks off. Last updated 2026-05-15.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Link
            href="/settings/integrations/xero"
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
          >
            <Settings className="h-4 w-4" /> Connection settings
          </Link>
          <a
            href="https://go.xero.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
          >
            <ExternalLink className="h-4 w-4" /> Open Xero
          </a>
        </div>
      </div>

      {/* ── TL;DR ── */}
      <Section title="TL;DR — what runs automatically" icon={<CheckCircle2 className="h-5 w-5 text-green-600" />}>
        <ul className="space-y-2 text-sm">
          <li className="flex gap-2"><span className="text-green-600">✓</span> <span><strong>Daily 15:00 UTC</strong> — Shopify Payments wholesale payouts post to Xero as deferred-revenue journals + bank receive into <code>1015 Shopify Wholesale Clearing</code></span></li>
          <li className="flex gap-2"><span className="text-green-600">✓</span> <span><strong>Daily 16:15 UTC</strong> — Faire per-order payouts post the same way, into <code>1020 Faire Payments Clearing</code></span></li>
          <li className="flex gap-2"><span className="text-green-600">✓</span> <span><strong>Daily 16:30 UTC</strong> — Shipped orders get their revenue + COGS recognized (moved out of Deferred Revenue 2050 into Sales 4030/4040)</span></li>
          <li className="flex gap-2"><span className="text-green-600">✓</span> <span><strong>Real-time</strong> — Shopify order webhooks update fulfillment status + post Slack alerts</span></li>
        </ul>
        <div className="mt-4 rounded-md border bg-amber-50 dark:bg-amber-950/20 p-3 text-sm">
          <p className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" /> <strong>Still manual:</strong></p>
          <ul className="ml-6 mt-1 list-disc text-muted-foreground">
            <li>Bank reconciliation in Xero (matching BoA deposits to clearing accounts)</li>
            <li>Expense categorisation and supplier bills</li>
            <li>Sales tax filings</li>
            <li>Reviewing the Deferred Revenue + Receivables Holding balances each month</li>
          </ul>
        </div>
      </Section>

      {/* ── Money flow diagram ── */}
      <Section title="Money flow — how a sale becomes revenue" icon={<ArrowRight className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          We follow the ASC 606 accrual model: revenue is recognized when control transfers to the customer (= shipment), not when the cash arrives. So one sale touches Xero in three stages.
        </p>
        <div className="rounded-md border bg-muted/30 p-4 text-xs font-mono whitespace-pre overflow-x-auto">
{`Day 0  ─  Customer places order on Shopify / Faire
            ⤷ nothing posted to Xero yet (auto)

Day 2  ─  Faire/Shopify pays us out
            ⤷ ManualJournal posted (auto):
                DR  Fees (5400/5450/5455)
                DR  Receivables Holding (1100)   ← gross net
                CR  Deferred Revenue (2050)      ← liability
                CR  Shipping Labels (5460)       ← reimbursement (Faire only)
            ⤷ BankTransaction posted (auto):
                DR  <Channel> Clearing (101x)    ← actual bank-clearing
                CR  Receivables Holding (1100)

Day 3  ─  Our actual BoA deposit lands ($X from Shopify Inc / Faire Inc)
            ⤷ Bank feed shows it on 1000 BoA Checking (auto via Xero feed)
            ⤷ YOU manually post Bank Transfer (1015→1000 or 1020→1000)   ← MANUAL
            ⤷ Reconcile the BoA bank feed line                            ← MANUAL

Day 5  ─  Order ships
            ⤷ ManualJournal posted (auto):
                DR  Deferred Revenue (2050)      ← clears liability
                CR  Sales (4030/4040)            ← finally earned
                DR  COGS (5000)                  ← matching principle
                CR  Inventory (1400)`}
        </div>
      </Section>

      {/* ── Accounts reference ── */}
      <Section title="Accounts reference" icon={<Wallet className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          Which Xero account does what in our automation. The clearing accounts (101x) are <strong>BANK</strong>-typed but virtual — they each hold an unreconciled balance until you transfer it into the real BoA Checking 1000.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="border-b">
                <th className="text-left p-2 font-medium">Code</th>
                <th className="text-left p-2 font-medium">Account</th>
                <th className="text-left p-2 font-medium">Type</th>
                <th className="text-left p-2 font-medium">Role</th>
                <th className="text-left p-2 font-medium">Healthy balance</th>
              </tr>
            </thead>
            <tbody className="text-xs">
              <AccountRow code="1000" name="Bank of America Checking" type="BANK" role="Real operating bank. Deposits land here." healthy="Whatever your actual cash position is." />
              <AccountRow code="1010" name="Shopify Payments Clearing" type="BANK" role="Holds Shopify Retail (DTC) payouts until you transfer them to BoA." healthy="Sum of un-transferred retail payouts. Should drain to ~$0 weekly." />
              <AccountRow code="1015" name="Shopify Wholesale Clearing" type="BANK" role="Holds Shopify Wholesale payouts until you transfer them to BoA." healthy="Sum of un-transferred wholesale payouts. Drains weekly." />
              <AccountRow code="1020" name="Faire Payments Clearing" type="BANK" role="Holds Faire per-order payouts until you transfer them to BoA." healthy="Sum of un-transferred Faire payouts." />
              <AccountRow code="1030" name="Amazon Clearing" type="BANK" role="Reserved for future Amazon channel." healthy="$0 (not yet wired)." />
              <AccountRow code="1040" name="TikTok Shop Clearing" type="BANK" role="Reserved for future TikTok channel." healthy="$0 (not yet wired)." />
              <AccountRow code="1100" name="Receivables Holding" type="CURRENT_ASSET" role="Transit account between ManualJournal and BankTransaction. Within-the-second clearing." healthy="$0. Anything non-zero means a BankTransaction failed — investigate." warn />
              <AccountRow code="2050" name="Deferred Revenue" type="CURRENT_LIABILITY" role="Holds gross revenue between payout and shipment." healthy="Roughly equal to the sum of all paid-but-unshipped order totals." />
              <AccountRow code="4030" name="Sales — Shopify Wholesale (B2B)" type="REVENUE" role="Recognized at shipment of wholesale orders." healthy="Grows monthly." />
              <AccountRow code="4040" name="Sales — Faire Wholesale" type="REVENUE" role="Recognized at shipment of Faire orders." healthy="Grows monthly." />
              <AccountRow code="5400" name="Merchant Fees — Shopify Payments" type="EXPENSE" role="Per-payout processing fees from Shopify." healthy="≈ 2.4–2.9% of Shopify GMV." />
              <AccountRow code="5450" name="Faire Fees — Commission" type="EXPENSE" role="Faire's commission cut per order. $0 on Faire Direct orders." healthy="≈ 0–25% of Faire GMV depending on order source." />
              <AccountRow code="5455" name="Faire Fees — Payment Processing" type="EXPENSE" role="3.5% + $0.30 per Faire order." healthy="≈ 3.5% of Faire GMV." />
              <AccountRow code="5460" name="Faire Fees — Shipping Labels" type="EXPENSE" role="Net shipping cost: actual UPS label cost minus Faire's reimbursement." healthy="Should be small or near-zero when we ship-on-your-own (Faire reimburses)." />
              <AccountRow code="5000" name="COGS — Product" type="EXPENSE" role="Recognized at shipment via FIFO unit cost × quantity." healthy="Roughly proportional to recognized Sales." />
              <AccountRow code="1400" name="Inventory" type="CURRENT_ASSET" role="Reduced at shipment matching COGS." healthy="Tracks on-hand inventory dollar value (single account — all product types)." />
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── Monthly checklist ── */}
      <Section title="Monthly close checklist" icon={<Calendar className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          Do this once a month, ideally on the 1st-3rd business day. Allow ~30 minutes.
        </p>
        <ChecklistItem
          step={1}
          title="Reconcile bank deposits (clearing → BoA Checking)"
          minutes="~10 min"
        >
          <p>Open Xero → Bank Accounts → <strong>Bank of America Checking (1000)</strong> → Reconcile.</p>
          <p>For each unreconciled deposit:</p>
          <ol className="list-decimal ml-5 mt-1 space-y-0.5 text-xs">
            <li>Click <strong>Transfer money</strong> tab on the deposit line</li>
            <li>Pick the source clearing account based on the deposit description:
              <ul className="list-disc ml-4 mt-0.5">
                <li><code>SHOPIFY</code> (smaller, more frequent) → <code>1010 Shopify Payments Clearing</code> (retail)</li>
                <li><code>SHOPIFY</code> (larger, weekly) → <code>1015 Shopify Wholesale Clearing</code></li>
                <li><code>FAIRE</code> → <code>1020 Faire Payments Clearing</code></li>
              </ul>
            </li>
            <li>Confirm the date + amount → save. Xero posts the Bank Transfer and both sides reconcile.</li>
          </ol>
          <p className="mt-2 text-muted-foreground">
            <strong>Tip:</strong> set up <a href="https://central.xero.com/s/article/Bank-rules-overview" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Xero Bank Rules</a> in BoA's settings — match by description (<code>SHOPIFY</code> / <code>FAIRE</code>) and Xero will pre-fill the transfer form, dropping reconciliation to a single click per deposit.
          </p>
        </ChecklistItem>

        <ChecklistItem
          step={2}
          title="Verify Receivables Holding (1100) is ~$0"
          minutes="~1 min"
        >
          <p>Reports → Account Transactions → pick <strong>1100 Receivables Holding</strong>.</p>
          <p>Balance should be $0 (or within $1 of zero from rounding). Anything material non-zero means a BankTransaction sweep failed silently. <a href="#health-checks" className="text-blue-600 underline">See &quot;Receivables Holding ≠ 0&quot; below.</a></p>
        </ChecklistItem>

        <ChecklistItem
          step={3}
          title="Sanity-check Deferred Revenue (2050) balance"
          minutes="~5 min"
        >
          <p>Reports → Account Transactions → pick <strong>2050 Deferred Revenue</strong>.</p>
          <p>Balance should roughly equal the sum of <strong>paid orders that haven&apos;t shipped yet</strong>. To cross-check:</p>
          <ol className="list-decimal ml-5 mt-1 space-y-0.5 text-xs">
            <li>Open the-frame &gt; Finance &gt; Settlements</li>
            <li>For each settlement marked &quot;received&quot;, sum the gross amount of orders whose shipped_at is empty</li>
            <li>Compare against Deferred Revenue balance — should match within rounding</li>
          </ol>
          <p className="mt-2 text-muted-foreground"><strong>Growing balance?</strong> ShipHero might be lagging on fulfillment. Orders ship but the shipment webhook isn&apos;t firing, so Stage 2 never recognizes the revenue.</p>
        </ChecklistItem>

        <ChecklistItem
          step={4}
          title="Cross-check fee accounts against platform statements"
          minutes="~5 min"
        >
          <p>For the month:</p>
          <ul className="list-disc ml-5 text-xs space-y-0.5">
            <li><strong>5400 Shopify Payments fees</strong> — should match Shopify Payments monthly statement</li>
            <li><strong>5450/5455 Faire fees</strong> — should match Faire&apos;s monthly Brand Statement PDF</li>
            <li><strong>5460 Shipping Labels</strong> — net of reimbursements; should be close to your ShipStation / UPS bill minus what Faire credited back</li>
          </ul>
        </ChecklistItem>

        <ChecklistItem
          step={5}
          title="Categorise any uncategorised expenses"
          minutes="~5 min"
        >
          <p>Reports → Account Transactions → filter <strong>Account = Suspense / Uncategorised</strong>. Move any leftovers to the right expense account.</p>
        </ChecklistItem>

        <ChecklistItem
          step={6}
          title="Review the P&amp;L for the month"
          minutes="~3 min"
        >
          <p>Reports → Profit and Loss → Custom dates for the month. Compare against the-frame Finance &gt; P&amp;L tab — numbers should match within rounding. If anything&apos;s materially off, investigate before you close.</p>
        </ChecklistItem>

        <ChecklistItem
          step={7}
          title="Lock the period in Xero"
          minutes="~30 sec"
        >
          <p>Settings → Advanced → Financial Settings → Lock dates. Set the &quot;Stop all users from posting&quot; date to the last day of the closed month. This prevents accidental backdated entries from breaking last month&apos;s numbers.</p>
        </ChecklistItem>
      </Section>

      {/* ── Bank reconciliation deep-dive ── */}
      <Section title="Bank reconciliation deep-dive" icon={<Banknote className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          The crux of monthly close. Our automation parks money in per-channel <strong>BANK</strong>-typed clearing accounts (1010-1050). Each one needs to be drained into <strong>1000 BoA Checking</strong> when the actual deposit lands.
        </p>

        <h4 className="font-medium mt-3 mb-1 text-sm">Why this two-step exists</h4>
        <p className="text-xs text-muted-foreground">
          Shopify Payments and Faire each deposit a single net amount per payout cycle, but our journals book the underlying revenue + fees per-order or per-payout. The clearing accounts give us a place to hold the &quot;expected cash&quot; until the real wire shows up, so we can reconcile cleanly when it does.
        </p>

        <h4 className="font-medium mt-4 mb-1 text-sm">Option A — Standard Xero workflow (5 clicks per deposit)</h4>
        <ol className="list-decimal ml-5 text-xs space-y-0.5">
          <li>Xero → Bank Accounts → BoA Checking → Reconcile</li>
          <li>On the unreconciled deposit line, click <strong>Transfer money</strong></li>
          <li>Source bank account: pick the matching clearing (101x)</li>
          <li>Date: confirm (defaults to today; change to deposit date for cleaner records)</li>
          <li>Save → both sides reconcile in one shot</li>
        </ol>

        <h4 className="font-medium mt-4 mb-1 text-sm">Option B — Xero Bank Rules (one-time setup, then 1 click per deposit)</h4>
        <p className="text-xs">
          In BoA Checking 1000 → Bank Rules → Add Rule. Recommended set:
        </p>
        <div className="rounded-md border bg-muted/30 p-3 text-xs font-mono mt-1 overflow-x-auto">
{`Rule 1 "Shopify Retail payout"
  Description contains  SHOPIFY
  Amount range          $50 – $5000
  Action                Transfer from 1010 Shopify Payments Clearing

Rule 2 "Shopify Wholesale payout"
  Description contains  SHOPIFY
  Amount range          $500 – $50000
  Action                Transfer from 1015 Shopify Wholesale Clearing

Rule 3 "Faire payout"
  Description contains  FAIRE
  Action                Transfer from 1020 Faire Payments Clearing`}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          If retail + wholesale ranges overlap, Xero will surface ambiguity and you pick. Adjust amount thresholds based on your actual payout sizes.
        </p>

        <h4 className="font-medium mt-4 mb-1 text-sm">Option C (planned) — One-click in the-frame</h4>
        <p className="text-xs text-muted-foreground">
          A &quot;Pending Reconciliations&quot; tab is planned for /finance. It will:
        </p>
        <ul className="list-disc ml-5 text-xs space-y-0.5 text-muted-foreground">
          <li>Read unreconciled bank-feed lines from BoA via Xero API</li>
          <li>Match each one to its clearing-account balance by amount + description</li>
          <li>POST the Bank Transfer with one click per deposit</li>
        </ul>
        <p className="text-xs text-muted-foreground">Not built yet. Ask Daniel when this becomes a priority.</p>
      </Section>

      {/* ── Health checks ── */}
      <Section title="Health checks — when to investigate" icon={<AlertTriangle className="h-5 w-5 text-amber-600" />} anchor="health-checks">
        <p className="text-sm text-muted-foreground mb-3">
          Things that should always be true. If they&apos;re not, the automation broke and needs a look.
        </p>

        <HealthRow
          condition="Receivables Holding (1100) balance ≠ $0"
          meaning="A BankTransaction sweep failed silently. Money is parked in 1100 but didn't make it to the clearing account."
          fix={
            <>
              <p>From Railway SSH:</p>
              <code className="block bg-muted/50 rounded p-1 mt-1">npx tsx scripts/retry-failed-bank-sweeps.ts</code>
              <p className="mt-1">Reads <code>xero_journal_log</code> for failed bank_transaction rows and re-posts each. Idempotent.</p>
            </>
          }
        />
        <HealthRow
          condition="Deferred Revenue (2050) growing month over month without shipments catching up"
          meaning="Either orders are accumulating without shipping (real backlog) or the shipment-recognition cron isn't firing."
          fix={
            <>
              <p>Check the-frame &gt; ShipHero integration health, and the <code>shopify-shipment-revenue-recognition</code> cron status in Settings &gt; Crons.</p>
            </>
          }
        />
        <HealthRow
          condition="Daily cron alerts in Slack (#jaxy-finance-bot)"
          meaning="A scheduled job failed. Most common: Xero token expired, OAuth scope dropped, or a Faire rate-limit during a busy day."
          fix={
            <>
              <p>Check the <code>xero_journal_log</code> table for the latest <code>status = 'failed'</code> rows. If it&apos;s a rate-limit, the next day&apos;s cron picks up the leftovers automatically (idempotent).</p>
              <p>If it&apos;s an auth issue: re-authorize Xero at <Link href="/settings/integrations/xero" className="text-blue-600 underline">Settings → Integrations → Xero</Link>.</p>
            </>
          }
        />
        <HealthRow
          condition="Sales accounts (4030/4040) growing but COGS (5000) not"
          meaning="Inventory cost data is missing on the SKUs being recognized. Stage 2 posts revenue but skips COGS lines when cost_price is null."
          fix={
            <>
              <p>Check the-frame &gt; Catalog &gt; Inventory for any SKUs without a cost_price. Setting them lets future recognitions include COGS. Already-recognized orders without COGS need a manual catch-up journal in Xero.</p>
            </>
          }
        />
        <HealthRow
          condition="Clearing account balances growing without bank deposits draining them"
          meaning="You haven't reconciled in a while — the manual transfer step is overdue."
          fix={
            <>
              <p>Do the monthly bank-rec checklist above. Use Bank Rules to speed up next time.</p>
            </>
          }
        />
      </Section>

      {/* ── When automation breaks ── */}
      <Section title="Recovery tools — when automation breaks" icon={<Wrench className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          Scripts that re-run pieces of the automation. All are idempotent (running them multiple times is safe).
        </p>
        <div className="space-y-3">
          <RecoveryTool
            command="scripts/verify-xero-accrual-setup.ts"
            purpose="Confirm Xero has both 1100 Receivables Holding and 2050 Deferred Revenue active. Run after any Xero CoA change."
          />
          <RecoveryTool
            command="scripts/retry-failed-bank-sweeps.ts"
            purpose="Re-post BankTransactions that failed (e.g. after a 401 from missing scope, or transient network issues). Reads from xero_journal_log."
          />
          <RecoveryTool
            command="POST /api/v1/cron/tick?now=YYYY-MM-DDTHH:MM:00Z"
            purpose="Force-trigger the centralized scheduler at a specific UTC time. Useful for re-running today's jobs after fixing a config."
            note="Public endpoint (called by the Railway cron service)."
          />
          <RecoveryTool
            command="POST /api/v1/finance/settlements/sync"
            purpose="Force a Shopify Payments settlements pull. Idempotent — already-pulled payouts skip."
          />
        </div>
      </Section>

      {/* ── Setup reference ── */}
      <Section title="Setup reference — for future channels or re-auth" icon={<Settings className="h-5 w-5" />}>
        <h4 className="font-medium mt-2 mb-1 text-sm">If Xero shows an auth error</h4>
        <p className="text-xs">Re-authorize at <Link href="/settings/integrations/xero" className="text-blue-600 underline">Settings → Integrations → Xero</Link>. Pre-existing tokens don&apos;t pick up new OAuth scopes — every scope change requires a fresh Reconnect.</p>

        <h4 className="font-medium mt-4 mb-1 text-sm">Current Xero scopes the-frame requests</h4>
        <ul className="list-disc ml-5 text-xs space-y-0.5">
          <li><code>openid profile email offline_access</code> — identity + refresh tokens</li>
          <li><code>accounting.manualjournals</code> — post Manual Journals</li>
          <li><code>accounting.banktransactions</code> — post BankTransactions (Receive Money)</li>
          <li><code>accounting.contacts</code> — auto-create payout contacts</li>
          <li><code>accounting.settings.read</code> — read Chart of Accounts</li>
          <li><code>files</code> — attach payout CSVs to journals (legacy, mostly unused)</li>
        </ul>

        <h4 className="font-medium mt-4 mb-1 text-sm">Adding a new channel (Amazon, TikTok, etc.)</h4>
        <ol className="list-decimal ml-5 text-xs space-y-0.5">
          <li>Create the BANK-type clearing account in Xero (e.g. <code>1030 Amazon Clearing</code>) — already done for Amazon (1030), TikTok (1040), Afterpay (1050)</li>
          <li>Add mappings under <Link href="/settings/integrations/xero" className="text-blue-600 underline">Settings → Integrations → Xero</Link>: sales/fees/clearing</li>
          <li>Add a tracking option (Sales Channel = Amazon) under Tracking mappings</li>
          <li>Wire a fetcher in <code>src/modules/integrations/lib/&lt;channel&gt;/payouts.ts</code> mirroring the Faire pattern</li>
          <li>Register a cron in <code>src/modules/integrations/lib/cron/registry.ts</code></li>
        </ol>
      </Section>

      {/* ── Schedule summary ── */}
      <Section title="Schedule at a glance" icon={<Clock className="h-5 w-5" />}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr className="border-b">
                <th className="text-left p-2 font-medium">When (UTC)</th>
                <th className="text-left p-2 font-medium">When (PT)</th>
                <th className="text-left p-2 font-medium">Job</th>
                <th className="text-left p-2 font-medium">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b"><td className="p-2"><code>03:00</code></td><td className="p-2">8pm prior</td><td className="p-2">shopify-metafield-sync</td><td className="p-2">Push product metafields to Shopify (catalog-only, not finance)</td></tr>
              <tr className="border-b"><td className="p-2"><code>14:00</code></td><td className="p-2">7am</td><td className="p-2">shopify-orders-sync</td><td className="p-2">Pull recent orders from both Shopify stores</td></tr>
              <tr className="border-b bg-blue-50/40 dark:bg-blue-950/10"><td className="p-2"><code>15:00</code></td><td className="p-2">8am</td><td className="p-2">xero-payout-sync</td><td className="p-2"><strong>Shopify payouts → Xero (deferred)</strong></td></tr>
              <tr className="border-b bg-blue-50/40 dark:bg-blue-950/10"><td className="p-2"><code>16:00</code></td><td className="p-2">9am</td><td className="p-2">shopify-settlements-sync</td><td className="p-2">Pull Shopify settlements into the local Settlements UI</td></tr>
              <tr className="border-b bg-blue-50/40 dark:bg-blue-950/10"><td className="p-2"><code>16:15</code></td><td className="p-2">9:15am</td><td className="p-2">faire-payout-sync</td><td className="p-2"><strong>Faire per-order payouts → Xero (deferred)</strong></td></tr>
              <tr className="border-b bg-green-50/40 dark:bg-green-950/10"><td className="p-2"><code>16:30</code></td><td className="p-2">9:30am</td><td className="p-2">shopify-shipment-revenue-recognition</td><td className="p-2"><strong>Move shipped-order revenue from Deferred → Sales + book COGS</strong></td></tr>
              <tr className="border-b"><td className="p-2"><code>16:00</code></td><td className="p-2">9am</td><td className="p-2">slack-stuck-orders</td><td className="p-2">Alert on orders confirmed but unshipped &gt; 48h</td></tr>
              <tr><td className="p-2"><code>*/15</code></td><td className="p-2">all day</td><td className="p-2">shopify-health-probe + shiphero syncs</td><td className="p-2">Health probes + ShipHero shipment + inventory sync</td></tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          The accrual-flow jobs (highlighted blue/green) all run inside a 30-minute window so today&apos;s payouts get deferred and today&apos;s shipments get recognized in one pass.
        </p>
      </Section>
    </div>
  );
}

// ── Building blocks ──

function Section({
  title,
  icon,
  anchor,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  anchor?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={anchor} className="rounded-lg border bg-card">
      <div className="border-b p-4 flex items-center gap-2">
        {icon}
        <h2 className="font-semibold">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function AccountRow({
  code, name, type, role, healthy, warn,
}: {
  code: string;
  name: string;
  type: string;
  role: string;
  healthy: string;
  warn?: boolean;
}) {
  return (
    <tr className={`border-b ${warn ? "bg-amber-50/50 dark:bg-amber-950/10" : ""}`}>
      <td className="p-2 font-mono">{code}</td>
      <td className="p-2">{name}</td>
      <td className="p-2 text-muted-foreground">{type}</td>
      <td className="p-2">{role}</td>
      <td className="p-2 text-muted-foreground">{healthy}</td>
    </tr>
  );
}

function ChecklistItem({
  step, title, minutes, children,
}: {
  step: number;
  title: string;
  minutes?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b last:border-0 py-3 first:pt-0">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
          {step}
        </div>
        <div className="flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="font-medium text-sm">{title}</h3>
            {minutes && <span className="text-xs text-muted-foreground shrink-0">{minutes}</span>}
          </div>
          <div className="text-xs space-y-1 mt-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

function HealthRow({
  condition, meaning, fix,
}: {
  condition: string;
  meaning: string;
  fix: React.ReactNode;
}) {
  return (
    <div className="border-b last:border-0 py-3 first:pt-0">
      <div className="text-sm font-medium text-amber-700 dark:text-amber-400">⚠ {condition}</div>
      <p className="text-xs text-muted-foreground mt-1">{meaning}</p>
      <div className="text-xs mt-2 bg-muted/30 rounded p-2">{fix}</div>
    </div>
  );
}

function RecoveryTool({
  command, purpose, note,
}: {
  command: string;
  purpose: string;
  note?: string;
}) {
  return (
    <div className="border rounded-md p-3">
      <code className="text-xs bg-muted px-2 py-1 rounded">{command}</code>
      <p className="text-xs text-muted-foreground mt-2">{purpose}</p>
      {note && <p className="text-xs text-muted-foreground italic mt-1">{note}</p>}
    </div>
  );
}
