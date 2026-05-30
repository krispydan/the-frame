/**
 * StoreLeads Integration settings page.
 *
 * Server component. Three cards:
 *   - Connection status (configured? last sync? counts)
 *   - Test connection + CSV upload (client island for the buttons)
 *   - Recent StoreLeads-sourced companies (last 25)
 *
 * Reads sqlite directly for the counts so the dashboard load is one
 * round-trip; the active API ping lives behind the "Test connection"
 * button to keep page loads cheap and offline-resilient.
 */
import { CheckCircle, XCircle } from "lucide-react";
import Link from "next/link";
import { sqlite } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isConfigured } from "@/modules/sales/lib/storeleads/client";
import { StoreLeadsActions } from "./actions";
import { LookalikeCard } from "./lookalike-card";
import { InstantlyPushCard } from "./instantly-push-card";

export const dynamic = "force-dynamic";

interface CompanyRow {
  id: string;
  name: string | null;
  domain: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  category: string | null;
  estimated_yearly_sales_cents: number | null;
  ecom_platform: string | null;
  storeleads_last_synced_at: string | null;
  icp_tier: string | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatCurrency(cents: number | null): string {
  if (cents == null) return "—";
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${dollars.toFixed(0)}`;
}

export default function StoreLeadsSettingsPage() {
  const configured = isConfigured();

  const sourcedCount = (sqlite
    .prepare(`SELECT COUNT(*) AS c FROM companies WHERE source_type = 'storeleads'`)
    .get() as { c: number }).c;

  const enrichedCount = (sqlite
    .prepare(`SELECT COUNT(*) AS c FROM companies WHERE storeleads_id IS NOT NULL`)
    .get() as { c: number }).c;

  const lastSync = (sqlite
    .prepare(
      `SELECT MAX(storeleads_last_synced_at) AS t FROM companies WHERE storeleads_last_synced_at IS NOT NULL`,
    )
    .get() as { t: string | null }).t;

  const recent = sqlite
    .prepare(
      `SELECT id, name, domain, city, state, country, category,
              estimated_yearly_sales_cents, ecom_platform,
              storeleads_last_synced_at, icp_tier
       FROM companies
       WHERE source_type = 'storeleads'
       ORDER BY storeleads_last_synced_at DESC
       LIMIT 25`,
    )
    .all() as CompanyRow[];

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div>
        <Link
          href="/settings/integrations"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Integrations
        </Link>
        <h1 className="text-3xl font-bold tracking-tight mt-2">StoreLeads</h1>
        <p className="text-muted-foreground mt-1">
          Ecommerce-store firmographic data. We use it to enrich existing CRM
          companies, import new lead lists from StoreLeads searches, and seed
          lookalike audiences based on our own customers.
        </p>
      </div>

      {/* Connection status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>Connection</span>
            {configured ? (
              <Badge className="bg-green-600 hover:bg-green-700">
                <CheckCircle className="h-3 w-3 mr-1" /> Configured
              </Badge>
            ) : (
              <Badge variant="destructive">
                <XCircle className="h-3 w-3 mr-1" /> Not configured
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            API key comes from <code>STORELEADS_API_KEY</code> in the Railway env.
            Issued under your StoreLeads account → API tab.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Last sync</dt>
              <dd className="font-medium mt-1">{timeAgo(lastSync)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sourced from StoreLeads</dt>
              <dd className="font-medium mt-1">{sourcedCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Enriched with StoreLeads</dt>
              <dd className="font-medium mt-1">{enrichedCount.toLocaleString()}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Actions */}
      <StoreLeadsActions />

      {/* Customer lookalike pipeline */}
      <LookalikeCard />

      {/* Score + push to Instantly */}
      <InstantlyPushCard />

      {/* Recent rows */}
      <Card>
        <CardHeader>
          <CardTitle>Recent StoreLeads-sourced companies</CardTitle>
          <CardDescription>
            Last 25 rows sorted by last sync. {sourcedCount === 0 && "Upload a CSV above to import the first batch."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No imports yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Yearly sales</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>ICP</TableHead>
                  <TableHead>Synced</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        href={`/prospects/${r.id}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {r.domain || r.name || r.id}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs">
                      {[r.city, r.state, r.country].filter(Boolean).join(", ") || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.category || "—"}
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {formatCurrency(r.estimated_yearly_sales_cents)}
                    </TableCell>
                    <TableCell className="text-xs">{r.ecom_platform || "—"}</TableCell>
                    <TableCell>
                      {r.icp_tier ? (
                        <Badge variant="outline" className="text-xs">{r.icp_tier}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {timeAgo(r.storeleads_last_synced_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
