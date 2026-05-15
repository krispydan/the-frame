/**
 * /settings/integrations/faire
 *
 * Single home for Faire-specific configuration that lives in the-frame
 * (Faire itself has no admin UI we control). Two cards today:
 *
 *   1. Postage tiers — the table of order-total → postage values used
 *      when we mark US Faire orders shipped via Faire's API. Editable
 *      from this page; persisted in the settings table.
 *   2. Recent shipment-mark attempts — last 25 rows from
 *      faire_shipment_marks for auditing what happened on the
 *      ShipHero→Faire pipeline (success, skip reasons, errors).
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */

export const dynamic = "force-dynamic";

import { sqlite } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PostageTierEditor } from "./postage-tier-editor";

interface MarkRow {
  id: string;
  faire_order_id: string | null;
  order_number: string | null;
  country_code: string | null;
  carrier: string | null;
  tracking_code: string | null;
  maker_cost_cents: number | null;
  status: string;
  response_status: number | null;
  error_message: string | null;
  marked_at: string | null;
}

function tryAll<T>(sql: string, params: unknown[] = []): T[] {
  try {
    return sqlite.prepare(sql).all(...params) as T[];
  } catch (e) {
    console.error("[settings/integrations/faire] query failed:", e);
    return [];
  }
}

function markStatusBadge(status: string) {
  if (status === "success") return <Badge className="bg-green-600 hover:bg-green-700">success</Badge>;
  if (status === "error") return <Badge variant="destructive">error</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return d.toLocaleString();
}

function formatCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export default function FaireIntegrationPage() {
  const marks = tryAll<MarkRow>(
    `SELECT id, faire_order_id, order_number, country_code, carrier, tracking_code,
            maker_cost_cents, status, response_status, error_message, marked_at
     FROM faire_shipment_marks
     ORDER BY marked_at DESC LIMIT 25`,
  );

  const configured = !!process.env.FAIRE_API_TOKEN;

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Faire Integration</h1>
        <p className="text-muted-foreground mt-2">
          Faire wholesale marketplace. Auto-marks US Faire orders shipped when ShipHero fulfills them; alerts Slack for non-US orders that need a manual mark in the Faire brand portal.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>API token comes from the <code>FAIRE_API_TOKEN</code> environment variable on Railway.</CardDescription>
        </CardHeader>
        <CardContent>
          {configured ? (
            <Badge className="bg-green-600 hover:bg-green-700">Configured</Badge>
          ) : (
            <Badge variant="destructive">Not configured</Badge>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Postage tiers</CardTitle>
          <CardDescription>
            Postage we declare to Faire on each US shipment. The tier is selected based on the order&apos;s subtotal — Faire uses this value to reconcile our shipping reimbursement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PostageTierEditor />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent shipment marks</CardTitle>
          <CardDescription>Last 25 attempts to mark a Faire order shipped — both US auto-marks and non-US skip reasons.</CardDescription>
        </CardHeader>
        <CardContent>
          {marks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shipment marks recorded yet. Once a Faire order ships through ShipHero, an entry will appear here.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Marked</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Tracking</TableHead>
                  <TableHead>Postage</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {marks.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-nowrap">{formatAbsolute(m.marked_at)}</TableCell>
                    <TableCell className="font-mono text-xs">{m.order_number || "—"}</TableCell>
                    <TableCell>{m.country_code || "—"}</TableCell>
                    <TableCell>{m.carrier || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{m.tracking_code || "—"}</TableCell>
                    <TableCell>{formatCents(m.maker_cost_cents)}</TableCell>
                    <TableCell>{markStatusBadge(m.status)}</TableCell>
                    <TableCell className="max-w-md text-xs text-muted-foreground">
                      {m.error_message ?? (m.response_status ? `HTTP ${m.response_status}` : "—")}
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
