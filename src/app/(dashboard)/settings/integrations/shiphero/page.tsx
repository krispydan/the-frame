/**
 * ShipHero Integration settings page.
 *
 * Surfaces the operational checklist from
 * docs/shiphero-webhooks-and-faire-slips.md: connection status, registered
 * webhook subscriptions, recent inbound webhook events (incl. HMAC + handler
 * status), and the Faire-packing-slip attachment audit log.
 *
 * Server component (read-only queries against sqlite). The single client
 * island is the "Register webhooks" button at the top of the subscriptions
 * card — wired to POST /api/v1/integrations/shiphero/register-webhooks
 * (implemented in Phase 4; today the button surfaces a "not yet
 * implemented" toast).
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */

import { CheckCircle, AlertCircle, XCircle } from "lucide-react";
import { sqlite } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isConfigured } from "@/modules/operations/lib/shiphero/api-client";
import { RegisterWebhooksButton } from "./register-button";
import { BackfillFaireSlipsButtons } from "./backfill-button";

export const dynamic = "force-dynamic";

type SubscriptionRow = {
  id: string;
  topic: string;
  url: string;
  created_at: string | null;
};

type EventRow = {
  id: string;
  received_at: string | null;
  topic: string | null;
  hmac_valid: number | null;
  handler_ok: number | null;
  handler_message: string | null;
  payload_size: number | null;
};

type AttachmentRow = {
  id: string;
  attached_at: string | null;
  shiphero_order_id: string;
  faire_order_id: string | null;
  filename: string;
  status: string;
  error_message: string | null;
};

function tryAll<T>(sql: string): T[] {
  try {
    return sqlite.prepare(sql).all() as T[];
  } catch {
    return [];
  }
}

function tryGet<T>(sql: string): T | undefined {
  try {
    return sqlite.prepare(sql).get() as T | undefined;
  } catch {
    return undefined;
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  const ms = Date.now() - then.getTime();
  if (Number.isNaN(ms)) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(then.getTime())) return iso;
  return then.toLocaleString();
}

function boolBadge(value: number | null, labels: { yes: string; no: string }) {
  if (value === null || value === undefined) {
    return <Badge variant="secondary" className="bg-gray-200 text-gray-700">—</Badge>;
  }
  if (value) {
    return (
      <Badge className="bg-green-600 hover:bg-green-700">
        <CheckCircle className="h-3 w-3 mr-1" />
        {labels.yes}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <XCircle className="h-3 w-3 mr-1" />
      {labels.no}
    </Badge>
  );
}

function attachmentStatusBadge(status: string) {
  switch (status) {
    case "success":
      return (
        <Badge className="bg-green-600 hover:bg-green-700">
          <CheckCircle className="h-3 w-3 mr-1" />
          success
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive">
          <XCircle className="h-3 w-3 mr-1" />
          error
        </Badge>
      );
    case "skipped_not_faire":
    case "skipped_no_slip":
      return <Badge variant="secondary">{status}</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function ShipHeroIntegrationPage() {
  const configured = isConfigured();

  const lastOkRow = tryGet<{ received_at: string | null }>(
    `SELECT MAX(received_at) AS received_at FROM shiphero_webhook_events WHERE handler_ok = 1`,
  );
  const lastOkAt = lastOkRow?.received_at ?? null;

  const subscriptions = tryAll<SubscriptionRow>(
    `SELECT id, topic, url, created_at
       FROM shiphero_webhook_subscriptions
       WHERE deactivated_at IS NULL
       ORDER BY created_at DESC`,
  );

  const events = tryAll<EventRow>(
    `SELECT id, received_at, topic, hmac_valid, handler_ok, handler_message, payload_size
       FROM shiphero_webhook_events
       ORDER BY received_at DESC
       LIMIT 50`,
  );

  const attachments = tryAll<AttachmentRow>(
    `SELECT id, attached_at, shiphero_order_id, faire_order_id, filename, status, error_message
       FROM shiphero_attachment_logs
       ORDER BY attached_at DESC
       LIMIT 25`,
  );

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">ShipHero Integration</h1>
        <p className="text-muted-foreground mt-2">
          ShipHero is our 3PL. We listen for <code>Order Allocated</code> and{" "}
          <code>Shipment Update</code> webhooks — the first triggers Faire packing-slip
          attachment, the second updates local order status and tracking.
        </p>
      </div>

      {/* Connection status */}
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Bearer token comes from <code>SHIPHERO_ACCESS_TOKEN</code> in the Railway env.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground w-40">API token</span>
            {configured ? (
              <Badge className="bg-green-600 hover:bg-green-700">
                <CheckCircle className="h-3 w-3 mr-1" />
                Configured
              </Badge>
            ) : (
              <Badge variant="destructive">
                <AlertCircle className="h-3 w-3 mr-1" />
                Missing SHIPHERO_ACCESS_TOKEN
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground w-40">Last successful webhook</span>
            {lastOkAt ? (
              <span className="text-sm">
                <span className="font-medium">{formatRelative(lastOkAt)}</span>
                <span className="text-muted-foreground ml-2">({formatAbsolute(lastOkAt)})</span>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">No successful webhooks recorded yet.</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Subscriptions */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Webhook subscriptions</CardTitle>
              <CardDescription>Topics we&apos;ve registered with ShipHero via <code>webhook_create</code>.</CardDescription>
            </div>
            <RegisterWebhooksButton />
          </div>
        </CardHeader>
        <CardContent>
          {subscriptions.length === 0 ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No webhooks registered</AlertTitle>
              <AlertDescription>
                Run <code>npm run shiphero:register-webhooks</code> locally, or use the
                button above (Phase 4).
              </AlertDescription>
            </Alert>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Topic</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.topic}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground break-all">{s.url}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{s.id}</TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={formatAbsolute(s.created_at)}>
                      {formatRelative(s.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent events */}
      <Card>
        <CardHeader>
          <CardTitle>Recent events</CardTitle>
          <CardDescription>Last 50 inbound webhooks. Failed HMAC = a misconfigured shared secret; failed handler = check the message column.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No webhook events recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Topic</TableHead>
                  <TableHead>HMAC</TableHead>
                  <TableHead>Handler</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap" title={formatAbsolute(e.received_at)}>
                      {formatRelative(e.received_at)}
                    </TableCell>
                    <TableCell className="text-sm">{e.topic ?? "—"}</TableCell>
                    <TableCell>{boolBadge(e.hmac_valid, { yes: "valid", no: "invalid" })}</TableCell>
                    <TableCell>{boolBadge(e.handler_ok, { yes: "ok", no: "error" })}</TableCell>
                    <TableCell className="text-xs max-w-md truncate" title={e.handler_message ?? ""}>
                      {e.handler_message ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {e.payload_size ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Attachment audit */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Packing-slip attachment audit</CardTitle>
              <CardDescription>
                Last 25 attempts to attach a Faire packing slip to a ShipHero order. Run a backfill to scan unfulfilled orders from the last 90 days — idempotent, already-attached orders skip safely.
              </CardDescription>
            </div>
            <BackfillFaireSlipsButtons />
          </div>
        </CardHeader>
        <CardContent>
          {attachments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No attachment attempts recorded yet. Click <em>Run backfill</em> above to process existing Faire orders.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Attached</TableHead>
                  <TableHead>ShipHero order</TableHead>
                  <TableHead>Faire order</TableHead>
                  <TableHead>Filename</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attachments.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap" title={formatAbsolute(a.attached_at)}>
                      {formatRelative(a.attached_at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{a.shiphero_order_id}</TableCell>
                    <TableCell className="font-mono text-xs">{a.faire_order_id ?? "—"}</TableCell>
                    <TableCell className="text-xs">{a.filename}</TableCell>
                    <TableCell>{attachmentStatusBadge(a.status)}</TableCell>
                    <TableCell className="text-xs max-w-sm truncate" title={a.error_message ?? ""}>
                      {a.error_message ?? "—"}
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
