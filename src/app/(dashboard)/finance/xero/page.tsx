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
 *
 * v2 (July 2026): rewritten for the settlement-date invoice model. The old
 * three-stage deferred-revenue flow (2050/1100 journals + clearing sweeps)
 * is retired — see "Legacy" notes inline. SOP §5 (Google Drive) matches.
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
            looks off. Settlement-date invoice model. Last updated 2026-07-16.
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
          <li className="flex gap-2"><span className="text-green-600">✓</span> <span><strong>Daily 15:00 UTC</strong> — each Shopify payout posts <strong>one ACCREC sales invoice</strong> to Xero: gross sales + fees broken out, invoice total = the exact net deposit. Reference carries a deep link to the payout in Shopify admin.</span></li>
          <li className="flex gap-2"><span className="text-green-600">✓</span> <span><strong>Daily 16:15 UTC</strong> — Faire per-order payouts post the same way (one invoice per payout, contact Faire). The same run detects <strong>issue-report clawbacks</strong> and auto-creates an ACCPAY bill (<code>FAIRE-IC-…</code>) for each.</span></li>
          <li className="flex gap-2"><span className="text-green-600">✓</span> <span><strong>Daily 16:45 UTC</strong> — the FIFO COGS job posts one consolidated landed-cost journal for yesterday&apos;s shipments (DR 5000/5010/5020, CR 1400)</span></li>
          <li className="flex gap-2"><span className="text-green-600">✓</span> <span><strong>Real-time</strong> — Shopify order webhooks update fulfillment status + post Slack alerts</span></li>
        </ul>
        <div className="mt-4 rounded-md border bg-amber-50 dark:bg-amber-950/20 p-3 text-sm">
          <p className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" /> <strong>Still manual (but one click each):</strong></p>
          <ul className="ml-6 mt-1 list-disc text-muted-foreground">
            <li>Bank reconciliation in Xero: <strong>Match</strong> each Mercury deposit to its payout invoice (amounts are identical by construction)</li>
            <li><strong>Match</strong> each <code>FAIRE WHOLESALE</code> debit to its <code>FAIRE-IC-…</code> bill (Faire issue credits)</li>
            <li>Expense categorisation, supplier bills, payroll coding, sales tax filings</li>
            <li>Direct-wire wholesale orders (bill.com etc.) — code straight to 4030, they never appear in payout feeds</li>
          </ul>
        </div>
      </Section>

      {/* ── Money flow diagram ── */}
      <Section title="Money flow — how a sale becomes revenue" icon={<ArrowRight className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          Revenue is recognized <strong>when the payout settles</strong> (A2X-style settlement-date model, per the Channel Payout Mapping Guide). COGS is recognized separately at shipment by the daily FIFO job. No deferred revenue, no clearing sweeps.
        </p>
        <div className="rounded-md border bg-muted/30 p-4 text-xs font-mono whitespace-pre overflow-x-auto">
{`Day 0  ─  Customer places order on Shopify / Faire
            ⤷ nothing posted to Xero yet (auto)

Day 1  ─  Order ships
            ⤷ Daily FIFO COGS journal (auto, 16:45 UTC):
                DR  COGS Product/Freight/Duty (5000/5010/5020)
                CR  Inventory (1400)          ← landed cost released

Day 2  ─  Faire/Shopify initiates the payout
            ⤷ ACCREC Invoice posted (auto):
                +  Gross sales     → 4000 / 4030 / 4040  (Sales-Channel tracked)
                −  Fees            → 5400 / 5450 / 5455
                −  Refunds         → 4300
                ±  Deltas          → 4060 / 5900
                =  TOTAL = the exact net deposit  → Accounts Receivable

Day 3-5 ─ The deposit lands in Mercury
            ⤷ Bank feed shows it (auto via Xero feed)
            ⤷ YOU click Match against the invoice        ← MANUAL (1 click)

Weeks later (sometimes) ─ Retailer files a Faire issue report
            ⤷ the-frame detects the payout revision, creates an
              ACCPAY bill FAIRE-IC-<ORDER> coded to 5900 (auto)
            ⤷ Faire debits Mercury for the clawback
            ⤷ YOU click Match against the FAIRE-IC bill  ← MANUAL (1 click)`}
        </div>
      </Section>

      {/* ── Accounts reference ── */}
      <Section title="Accounts reference" icon={<Wallet className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          Which Xero account does what in our automation. The clearing accounts, 1100 and 2050 are <strong>legacy</strong> — used by the pre-July-2026 deferred flow only. They should flatline at ~$0 and see no new automated activity.
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
              <AccountRow code="—" name="Mercury Checking ••6744" type="BANK" role="Real operating bank. Payout deposits + clawback debits land here; every line Matches a the-frame document." healthy="Whatever your actual cash position is." />
              <AccountRow code="1200" name="Accounts Receivable" type="CURRENT_ASSET" role="Payout invoices sit here between posting and the deposit Match." healthy="Sum of paid-out-but-not-yet-deposited payouts (a few days' worth)." />
              <AccountRow code="4000" name="Sales — Shopify Retail (DTC)" type="REVENUE" role="Gross DTC sales, recognized at settlement." healthy="Grows with retail volume." />
              <AccountRow code="4030" name="Sales — Shopify Wholesale (B2B)" type="REVENUE" role="Gross wholesale sales at settlement + direct-wire orders coded manually." healthy="Grows monthly." />
              <AccountRow code="4040" name="Sales — Faire Wholesale" type="REVENUE" role="Gross Faire order totals at settlement." healthy="Grows monthly." />
              <AccountRow code="4060" name="Shipping Income" type="REVENUE" role="Positive Faire payout deltas (buyer-paid shipping / overpayments) + balance adjustments." healthy="Small positive." />
              <AccountRow code="4300" name="Sales Returns & Allowances" type="REVENUE" role="Refund lines inside payout invoices (contra-revenue)." healthy="Small negative relative to sales." />
              <AccountRow code="5400" name="Merchant Fees — Shopify Payments" type="EXPENSE" role="Fee lines on Shopify payout invoices." healthy="≈ 2.4–2.9% of Shopify GMV." />
              <AccountRow code="5450" name="Faire Fees — Commission" type="EXPENSE" role="Faire commission lines. $0 on Faire Direct orders." healthy="≈ 0–25% of Faire GMV by order source." />
              <AccountRow code="5455" name="Faire Fees — Payment Processing" type="EXPENSE" role="Faire processing fee lines." healthy="≈ 2.4–3.5% of Faire GMV." />
              <AccountRow code="5900" name="Inventory Adjustments & Shrinkage" type="EXPENSE" role="Negative payout deltas + FAIRE-IC issue-credit bills (under-shipments, damaged/missing)." healthy="Small; each entry traceable to an order #." />
              <AccountRow code="5000" name="COGS — Product" type="EXPENSE" role="Daily FIFO job at shipment (product component of landed cost)." healthy="Roughly proportional to recognized Sales." />
              <AccountRow code="5010/5020" name="COGS — Freight / Customs & Duties" type="EXPENSE" role="Freight + duty components of landed cost, released at shipment." healthy="Proportional to units shipped." />
              <AccountRow code="1400" name="Inventory" type="CURRENT_ASSET" role="FIFO landed cost on hand; credited by the daily COGS journal." healthy="Ties to the FIFO subledger on /finance/cogs (± $50)." />
              <AccountRow code="1010/1015/1020" name="Clearing accounts (LEGACY)" type="BANK" role="Pre-cutover deferred-flow sweeps only. New payouts never touch them." healthy="~$0 once the last pre-July deposits are matched. Growth = investigate." warn />
              <AccountRow code="1100" name="Receivables Holding (LEGACY)" type="CURRENT_ASSET" role="Old journal↔sweep transit account. Retired." healthy="$0." warn />
              <AccountRow code="2050" name="Deferred Revenue (LEGACY)" type="CURRENT_LIABILITY" role="Retired from automation. Holds only the pre-cutover residual pending CPA reversal (~$25k) + genuine prepaid-unshipped wholesale." healthy="Flat at the residual until the CPA entry posts; then ~$0." warn />
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── Monthly checklist ── */}
      <Section title="Monthly close checklist" icon={<Calendar className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          Do this once a month, ideally on the 1st-3rd business day. Allow ~20 minutes.
        </p>
        <ChecklistItem
          step={1}
          title="Match Mercury deposits to payout invoices"
          minutes="~5 min"
        >
          <p>Open Xero → Bank Accounts → <strong>Mercury Checking</strong> → Reconcile.</p>
          <p>Every Shopify/Faire deposit has an open ACCREC invoice with the <strong>identical amount</strong> — Xero usually suggests it automatically. Click <strong>Match → OK</strong>. That&apos;s it.</p>
          <ul className="list-disc ml-5 mt-1 text-xs space-y-0.5">
            <li>Shopify invoice numbers: <code>SHOP-WS-…</code> / <code>SHOP-DTC-…</code>; the Reference deep-links to the payout in Shopify admin</li>
            <li>Faire invoice numbers: <code>FAIRE-…</code> (one per order payout)</li>
            <li><code>FAIRE WHOLESALE</code> <strong>debits</strong> → Match to the <code>FAIRE-IC-…</code> bill (issue credit). If no bill exists, check Slack #jaxy-finance-bot / see Health checks below</li>
          </ul>
        </ChecklistItem>

        <ChecklistItem
          step={2}
          title="Check for unmatched payout invoices in AR"
          minutes="~2 min"
        >
          <p>Business → Invoices → Awaiting Payment, filter contacts Faire / Shopify.</p>
          <p>Anything older than ~7 days means a deposit never arrived (Faire hold, reserve, or a net-negative payout that needs a credit note) — investigate before closing.</p>
        </ChecklistItem>

        <ChecklistItem
          step={3}
          title="Verify legacy accounts stay flat"
          minutes="~2 min"
        >
          <p>Quick balance check: <strong>1010 / 1015 / 1020</strong> clearing, <strong>1100</strong> Receivables Holding → all ~$0. <strong>2050</strong> Deferred Revenue → unchanged at the pre-cutover residual (until the CPA reversal posts).</p>
          <p className="text-muted-foreground">Any NEW activity in these accounts means something posted through the legacy path — flag it to Daniel.</p>
        </ChecklistItem>

        <ChecklistItem
          step={4}
          title="Cross-check fee accounts against platform statements"
          minutes="~5 min"
        >
          <ul className="list-disc ml-5 text-xs space-y-0.5">
            <li><strong>5400 Shopify Payments fees</strong> — should match Shopify Payments monthly statement</li>
            <li><strong>5450/5455 Faire fees</strong> — should match Faire&apos;s monthly Brand Statement PDF</li>
            <li><strong>5900 entries</strong> — each should trace to an order # (payout delta or FAIRE-IC bill); recategorize any &quot;review&quot; delta lines that turn out to be something specific</li>
          </ul>
        </ChecklistItem>

        <ChecklistItem
          step={5}
          title="Reconcile inventory: FIFO subledger ↔ 1400 ↔ ShipHero"
          minutes="~3 min"
        >
          <p>Compare the cost-layer total on <Link href="/finance/cogs" className="text-blue-600 underline">/finance/cogs</Link> against the 1400 balance and ShipHero&apos;s valuation. Investigate variance &gt; $50. Fold known Faire issue-report orders (under-shipments) into the monthly shrinkage true-up.</p>
        </ChecklistItem>

        <ChecklistItem
          step={6}
          title="Review the P&L for the month"
          minutes="~3 min"
        >
          <p>Reports → Profit and Loss → Custom dates for the month. Compare against the-frame Finance &gt; P&amp;L tab — numbers should match within rounding. If anything&apos;s materially off, investigate before you close.</p>
        </ChecklistItem>

        <ChecklistItem
          step={7}
          title="Lock the period in Xero"
          minutes="~30 sec"
        >
          <p>Settings → Advanced → Financial Settings → Lock dates. Set the &quot;Stop all users from posting&quot; date to the last day of the closed month. the-frame&apos;s correction tooling is locked-period aware (posts reversals in the open period).</p>
        </ChecklistItem>
      </Section>

      {/* ── Bank reconciliation deep-dive ── */}
      <Section title="Bank reconciliation deep-dive" icon={<Banknote className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          Under the invoice model, reconciliation is document-matching — every Mercury line has a the-frame document with the identical amount waiting for it.
        </p>

        <h4 className="font-medium mt-3 mb-1 text-sm">Deposits (money in)</h4>
        <ol className="list-decimal ml-5 text-xs space-y-0.5">
          <li>Xero → Bank Accounts → Mercury Checking → Reconcile</li>
          <li>Xero auto-suggests the matching payout invoice (same amount) → <strong>OK</strong></li>
          <li>If it doesn&apos;t suggest: Find &amp; Match → search the payout # from the bank description (e.g. <code>Faire #9HZEUWQS8D</code> → invoice <code>FAIRE-9HZEUWQS8D</code>)</li>
        </ol>

        <h4 className="font-medium mt-4 mb-1 text-sm">Faire clawback debits (money out)</h4>
        <ol className="list-decimal ml-5 text-xs space-y-0.5">
          <li>Description reads <code>FAIRE WHOLESALE; Faire #&lt;ORDER&gt;; … ORDER</code> as a <strong>Debit</strong></li>
          <li>Find &amp; Match → bill <code>FAIRE-IC-&lt;ORDER&gt;</code> (auto-created by the-frame when it detected the payout revision) → Match</li>
          <li>No bill? Check whether 5900 already carries that order&apos;s delta (search the order # in Xero). If yes → it&apos;s a legacy case: reconcile as a <strong>Transfer to 1020 Faire Payments Clearing</strong>. If no → create the bill manually (Spend Money → 5900, contact Faire) and tell Daniel the detector missed it.</li>
        </ol>

        <h4 className="font-medium mt-4 mb-1 text-sm">Legacy deposits (pre-July-2026 payouts only)</h4>
        <p className="text-xs text-muted-foreground">
          Deposits for payouts synced before the cutover were booked through clearing accounts. Reconcile those as <strong>Transfers</strong> from the matching clearing account (1010 retail / 1015 wholesale / 1020 Faire). Once the backlog is drained, this section is history.
        </p>
      </Section>

      {/* ── Health checks ── */}
      <Section title="Health checks — when to investigate" icon={<AlertTriangle className="h-5 w-5 text-amber-600" />} anchor="health-checks">
        <p className="text-sm text-muted-foreground mb-3">
          Things that should always be true. If they&apos;re not, the automation broke and needs a look.
        </p>

        <HealthRow
          condition="Xero sync failed alerts in Slack — 401 AuthorizationUnsuccessful"
          meaning="The Xero token lost a scope (usually after a scope change without re-consent) or expired beyond refresh."
          fix={
            <>
              <p>Re-authorize at <Link href="/settings/integrations/xero" className="text-blue-600 underline">Settings → Integrations → Xero</Link>. Tokens don&apos;t gain new scopes on refresh — every scope change needs a fresh Reconnect. Failed payouts are idempotent and re-post on the next daily run automatically.</p>
            </>
          }
        />
        <HealthRow
          condition="A payout invoice total doesn't match the deposit"
          meaning="Faire revised the payout between our sync and the wire (issue report), or a reserve/hold split the deposit."
          fix={
            <>
              <p>Check Slack #jaxy-finance-bot for a <code>Faire issue credit</code> alert on that order — the alert names the expected amounts. The FAIRE-IC bill covers the difference; Match deposit + bill together via Find &amp; Match if the wire came net.</p>
            </>
          }
        />
        <HealthRow
          condition="Net-negative payout (refunds exceeded sales)"
          meaning="Can't post as an ACCREC invoice — the sync flags it and skips."
          fix={
            <>
              <p>Create a manual ACCRECCREDIT credit note (contact = the platform, same account mapping, total = the negative amount) and Match the bank debit against it. Rare — a couple per quarter.</p>
            </>
          }
        />
        <HealthRow
          condition="New activity in legacy accounts (2050 / 1100 / 101x clearing)"
          meaning="Something posted through the old deferred path — the revenue-model flag may have been flipped back, or a manual entry landed there."
          fix={
            <>
              <p>Check <code>finance.set_payout_revenue_model</code> (MCP) reads <code>invoice</code>, and trace the journal&apos;s narration — the-frame stamps everything it posts.</p>
            </>
          }
        />
        <HealthRow
          condition="Daily COGS exceptions in Slack (shortfall / zero-cost / unmapped SKU)"
          meaning="An order line couldn't be costed and was excluded from the day's COGS journal."
          fix={
            <>
              <p>See the COGS health card on <Link href="/finance/cogs" className="text-blue-600 underline">/finance/cogs</Link>. Fix the cause (seed layers, add a SKU alias, set a cost), then the line auto-recovers on the next run or via <code>finance.correct_cogs_date</code>.</p>
            </>
          }
        />
      </Section>

      {/* ── When automation breaks ── */}
      <Section title="Recovery tools — when automation breaks" icon={<Wrench className="h-5 w-5" />}>
        <p className="text-sm text-muted-foreground mb-3">
          All idempotent (running them multiple times is safe).
        </p>
        <div className="space-y-3">
          <RecoveryTool
            command="POST /api/v1/integrations/xero/sync-payouts"
            purpose="Re-run the Shopify payout sync now. Already-synced payouts skip; failed ones re-post."
          />
          <RecoveryTool
            command="POST /api/v1/cron/tick?now=YYYY-MM-DDTHH:MM:00Z"
            purpose="Force-trigger the centralized scheduler at a specific UTC time (e.g. re-run the 16:15 Faire sync after fixing config)."
            note="Public endpoint (called by the Railway cron service)."
          />
          <RecoveryTool
            command="MCP: finance.preview_settlement_invoices"
            purpose="Read-only dry run — renders the invoice for every settlement and the revenue by account. Use to verify amounts before/after any fix."
          />
          <RecoveryTool
            command="MCP: finance.set_payout_revenue_model"
            purpose='Read or flip the revenue model. "invoice" = current settlement-date model; "deferred" = legacy fallback (emergency only — flips the whole flow back).'
          />
          <RecoveryTool
            command="MCP: finance.correct_cogs_date { date }"
            purpose="Reverse-and-repost one day's COGS journal from current cost layers (after seeding a SKU, adding an alias, or a landed-cost true-up)."
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
          <li><code>accounting.invoices</code> — <strong>payout invoices + clawback bills + credit notes (the core of the model)</strong></li>
          <li><code>accounting.manualjournals</code> — daily COGS journal + corrections/restatements</li>
          <li><code>accounting.banktransactions</code> — legacy sweeps (retired) + occasional Receive/Spend Money</li>
          <li><code>accounting.contacts</code> — auto-create the Faire / Shopify contacts</li>
          <li><code>accounting.settings.read</code> — read Chart of Accounts</li>
          <li><code>files</code> — attach per-order detail CSVs to COGS journals</li>
        </ul>

        <h4 className="font-medium mt-4 mb-1 text-sm">Adding a new channel (Amazon, TikTok, etc.)</h4>
        <ol className="list-decimal ml-5 text-xs space-y-0.5">
          <li>Add mappings under <Link href="/settings/integrations/xero" className="text-blue-600 underline">Settings → Integrations → Xero</Link>: sales / refunds / fees / adjustments for the platform (no clearing account needed under the invoice model)</li>
          <li>Add a tracking option (Sales Channel = Amazon) under Tracking mappings</li>
          <li>Wire a fetcher in <code>src/modules/integrations/lib/&lt;channel&gt;/payouts.ts</code> mirroring the Faire pattern, mapping to the settlement-invoice builder</li>
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
              <tr className="border-b bg-blue-50/40 dark:bg-blue-950/10"><td className="p-2"><code>15:00</code></td><td className="p-2">8am</td><td className="p-2">xero-payout-sync</td><td className="p-2"><strong>Shopify payouts → ACCREC invoices in Xero</strong></td></tr>
              <tr className="border-b bg-blue-50/40 dark:bg-blue-950/10"><td className="p-2"><code>16:00</code></td><td className="p-2">9am</td><td className="p-2">shopify-settlements-sync</td><td className="p-2">Pull Shopify settlements into the local Settlements UI</td></tr>
              <tr className="border-b bg-blue-50/40 dark:bg-blue-950/10"><td className="p-2"><code>16:15</code></td><td className="p-2">9:15am</td><td className="p-2">faire-payout-sync</td><td className="p-2"><strong>Faire payouts → invoices + issue-credit detection → FAIRE-IC bills</strong></td></tr>
              <tr className="border-b"><td className="p-2"><code>16:30</code></td><td className="p-2">9:30am</td><td className="p-2">shopify-shipment-revenue-recognition</td><td className="p-2">Legacy Stage-2 job — <strong>no-ops</strong> under the invoice model (kept as a safety net)</td></tr>
              <tr className="border-b bg-green-50/40 dark:bg-green-950/10"><td className="p-2"><code>16:45</code></td><td className="p-2">9:45am</td><td className="p-2">daily-cogs-posting</td><td className="p-2"><strong>FIFO landed-cost COGS journal for yesterday&apos;s shipments</strong></td></tr>
              <tr className="border-b"><td className="p-2"><code>16:00</code></td><td className="p-2">9am</td><td className="p-2">slack-stuck-orders</td><td className="p-2">Alert on orders confirmed but unshipped &gt; 48h</td></tr>
              <tr><td className="p-2"><code>*/15</code></td><td className="p-2">all day</td><td className="p-2">shopify-health-probe + shiphero syncs</td><td className="p-2">Health probes + ShipHero shipment + inventory sync</td></tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Revenue posts at payout sync (blue); COGS posts at 16:45 (green) for yesterday&apos;s shipments. The two are decoupled by design — revenue at settlement, COGS at shipment — with the small timing gap trued up at year-end by the CPA.
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
