"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  ArrowLeft, Globe, Mail, Send, Loader2, CheckCircle, Clock, Package, ExternalLink,
} from "lucide-react";
import Link from "next/link";

interface IntlRequest {
  id: string;
  order_number: string;
  external_id: string | null;
  shiphero_order_id: string | null;
  ship_to_country: string | null;
  source_name: string | null;
  status: string;
  email_sent_at: string | null;
  packaged_length_in: number | null;
  packaged_width_in: number | null;
  packaged_height_in: number | null;
  packaged_weight_lb: number | null;
  box_count: number | null;
  dims_received_at: string | null;
  notes: string | null;
  created_at: string;
}

interface Settings {
  enabled: boolean;
  autoSend: boolean;
  warehouseEmail: string;
  ccEmail: string;
}

const STATUS_META: Record<string, { label: string; cls: string; icon: typeof Clock }> = {
  awaiting_dims: { label: "Awaiting dims", cls: "bg-amber-100 text-amber-700", icon: Clock },
  awaiting_label: { label: "Ready to label", cls: "bg-sky-100 text-sky-700", icon: Package },
  label_uploaded: { label: "Label uploaded", cls: "bg-indigo-100 text-indigo-700", icon: CheckCircle },
  shipped: { label: "Shipped", cls: "bg-green-100 text-green-700", icon: CheckCircle },
  cancelled: { label: "Cancelled", cls: "bg-gray-100 text-gray-500", icon: Clock },
};

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function InternationalShippingPage() {
  const [requests, setRequests] = useState<IntlRequest[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const [dimsDraft, setDimsDraft] = useState<Record<string, { l: string; w: string; h: string; wt: string; boxes: string }>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/orders/international-shipping?status=all");
      const data = await res.json();
      setRequests(data.requests || []);
      setSettings(data.settings || null);
    } catch {
      toast.error("Failed to load international shipping requests");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const post = async (bodyObj: Record<string, unknown>) => {
    const res = await fetch("/api/v1/orders/international-shipping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
    });
    return res.json();
  };

  const toggleFlag = async (key: "enabled" | "autoSend", value: boolean) => {
    const data = await post({ action: "set-flag", key, value });
    if (data.ok) {
      setSettings((s) => (s ? { ...s, [key]: value } : s));
      toast.success(`${key === "enabled" ? "Integration" : "Auto-send"} ${value ? "enabled" : "disabled"}`);
    } else {
      toast.error(data.error || "Failed to update");
    }
  };

  const sendEmail = async (id: string) => {
    setSending(id);
    try {
      const data = await post({ action: "send-email", id });
      if (data.ok) { toast.success("Email sent to warehouse"); load(); }
      else toast.error(data.error || "Failed to send");
    } finally {
      setSending(null);
    }
  };

  const saveDims = async (id: string) => {
    const d = dimsDraft[id];
    if (!d) return;
    const data = await post({
      action: "save-dims",
      id,
      length: parseFloat(d.l) || null,
      width: parseFloat(d.w) || null,
      height: parseFloat(d.h) || null,
      weight: parseFloat(d.wt) || null,
      boxCount: parseInt(d.boxes, 10) || 1,
    });
    if (data.ok) { toast.success("Dims saved — ready to create label"); load(); }
    else toast.error(data.error || "Failed to save");
  };

  const setStatus = async (id: string, status: string) => {
    const data = await post({ action: "set-status", id, status });
    if (data.ok) { toast.success("Status updated"); load(); }
    else toast.error(data.error || "Failed");
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  const awaitingDims = requests.filter((r) => r.status === "awaiting_dims").length;
  const readyToLabel = requests.filter((r) => r.status === "awaiting_label").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/orders" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Globe className="h-7 w-7" /> International Shipping
          </h1>
          <p className="text-muted-foreground">
            Non-US Faire orders — request dims from the warehouse, create the Faire label, upload to ShipHero
          </p>
        </div>
      </div>

      {/* How it works / background */}
      <Card className="bg-muted/40">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" /> How this works
          </CardTitle>
          <CardDescription>Background &amp; the manual steps involved</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Why this exists:</strong> Faire requires us to create the
            shipping label for any international (non-US) order through Faire&apos;s own system — we
            can&apos;t let the 3PL generate its own label like they do for US orders. To make the Faire
            label we need the packaged dimensions and weight, which only the warehouse knows once the
            order is picked and packed.
          </p>
          <div>
            <strong className="text-foreground">What triggers a request:</strong>
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li>Order syncs in from the Shopify wholesale store</li>
              <li>Ship-to country is <em>not</em> the US (territories like Puerto Rico count as international)</li>
              <li>The Shopify sales channel is <em>Faire</em> (shown as the &quot;Faire&quot; badge below). Orders where we can&apos;t confirm the channel still queue but are flagged amber.</li>
            </ul>
          </div>
          <div>
            <strong className="text-foreground">The flow, step by step:</strong>
            <ol className="list-decimal pl-5 mt-1 space-y-0.5">
              <li><strong>Awaiting dims</strong> — we email <code>team@bigskyfulfillment.com</code> (cc <code>wholesale@getjaxy.com</code>) asking for L×W×H and weight. Replies come back to wholesale@.</li>
              <li><strong>Ready to label</strong> — once you enter the dims here, create the shipping label inside Faire, then upload it to ShipHero.</li>
              <li><strong>Label uploaded → Shipped</strong> — mark it labeled after uploading to ShipHero, then shipped once the warehouse sends it.</li>
            </ol>
          </div>
          <p>
            <strong className="text-foreground">Safety:</strong> the email tells the warehouse
            <em> not to ship yet</em>. Nothing sends automatically until both toggles below are on — start
            with the integration enabled but auto-send off so you review the first orders by hand.
          </p>
        </CardContent>
      </Card>

      {/* Settings / feature flags */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Automation Settings</CardTitle>
          <CardDescription>
            Emails to {settings?.warehouseEmail} (cc {settings?.ccEmail}). Start with the integration on but
            auto-send off, so you review the first few before they go out automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between max-w-md">
            <div>
              <p className="font-medium text-sm">Integration enabled</p>
              <p className="text-xs text-muted-foreground">Detect non-US Faire orders and create requests</p>
            </div>
            <Switch checked={settings?.enabled ?? false} onCheckedChange={(v) => toggleFlag("enabled", v)} />
          </div>
          <div className="flex items-center justify-between max-w-md">
            <div>
              <p className="font-medium text-sm">Auto-send dims email</p>
              <p className="text-xs text-muted-foreground">
                {settings?.autoSend
                  ? "Emails fire automatically when a qualifying order arrives"
                  : "Requests queue for manual review — you click Send"}
              </p>
            </div>
            <Switch
              checked={settings?.autoSend ?? false}
              onCheckedChange={(v) => toggleFlag("autoSend", v)}
              disabled={!settings?.enabled}
            />
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card><CardContent className="pt-6">
          <p className="text-sm text-muted-foreground flex items-center gap-1"><Clock className="h-4 w-4" /> Awaiting dims</p>
          <p className="text-2xl font-bold">{awaitingDims}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-6">
          <p className="text-sm text-muted-foreground flex items-center gap-1"><Package className="h-4 w-4" /> Ready to label</p>
          <p className="text-2xl font-bold">{readyToLabel}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-6">
          <p className="text-sm text-muted-foreground flex items-center gap-1"><Globe className="h-4 w-4" /> Total</p>
          <p className="text-2xl font-bold">{requests.length}</p>
        </CardContent></Card>
      </div>

      {/* Request queue */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Requests</CardTitle>
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No international shipping requests yet. They appear here automatically when a non-US Faire order arrives.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Dims / Weight</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r) => {
                  const meta = STATUS_META[r.status] || STATUS_META.awaiting_dims;
                  const d = dimsDraft[r.id] || { l: "", w: "", h: "", wt: "", boxes: "1" };
                  const hasDims = r.packaged_weight_lb != null;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-sm">{r.order_number}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.ship_to_country || "?"}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.source_name && /faire/i.test(r.source_name)
                          ? <Badge variant="secondary">Faire</Badge>
                          : <span className="text-amber-600 text-xs">{r.source_name || "unknown"}</span>}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${meta.cls}`}>
                          <meta.icon className="h-3 w-3" /> {meta.label}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.email_sent_at ? `Sent ${fmtDate(r.email_sent_at)}` : "Not sent"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {hasDims ? (
                          <span className="text-muted-foreground">
                            {r.packaged_length_in}×{r.packaged_width_in}×{r.packaged_height_in} in · {r.packaged_weight_lb} lb
                            {(r.box_count ?? 1) > 1 ? ` · ${r.box_count} boxes` : ""}
                          </span>
                        ) : (
                          <div className="flex items-center gap-1">
                            {(["l", "w", "h", "wt"] as const).map((f) => (
                              <Input
                                key={f}
                                placeholder={f === "wt" ? "lb" : f.toUpperCase()}
                                value={d[f]}
                                onChange={(e) => setDimsDraft((m) => ({ ...m, [r.id]: { ...d, [f]: e.target.value } }))}
                                className="w-14 h-7 text-xs"
                              />
                            ))}
                            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => saveDims(r.id)}>
                              Save
                            </Button>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-1 whitespace-nowrap">
                        <a
                          href={`https://www.faire.com/messages/orders/${r.order_number.replace(/^#/, "")}`}
                          target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center text-xs text-blue-600 hover:underline mr-2"
                        >
                          Faire <ExternalLink className="h-3 w-3 ml-0.5" />
                        </a>
                        {r.shiphero_order_id && (
                          <a
                            href={`https://app.shiphero.com/dashboard/orders/detail/${r.shiphero_order_id}`}
                            target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center text-xs text-blue-600 hover:underline mr-2"
                          >
                            ShipHero <ExternalLink className="h-3 w-3 ml-0.5" />
                          </a>
                        )}
                        {r.status === "awaiting_dims" && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => sendEmail(r.id)} disabled={sending === r.id}>
                            {sending === r.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                            {r.email_sent_at ? "Re-send" : "Send email"}
                          </Button>
                        )}
                        {r.status === "awaiting_label" && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setStatus(r.id, "label_uploaded")}>
                            Mark labeled
                          </Button>
                        )}
                        {r.status === "label_uploaded" && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setStatus(r.id, "shipped")}>
                            Mark shipped
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
