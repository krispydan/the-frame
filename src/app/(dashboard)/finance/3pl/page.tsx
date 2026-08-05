"use client";

/**
 * 3PL Billing dashboard (/finance/3pl)
 *
 * - Upload Big Sky's monthly invoice xlsx (re-upload replaces the period)
 * - Invoice history with category totals + audit findings (discrepancy queue)
 * - Shipping P&L by channel: customer-paid shipping vs postage + fulfillment
 * - Contract rate card (drives the audit engine) with inline editing
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  ArrowLeft, Truck, Upload, Loader2, AlertTriangle, CheckCircle2, Trash2, Scale, ReceiptText,
} from "lucide-react";
import Link from "next/link";

interface InvoiceRow {
  id: string; periodStart: string; periodEnd: string; filename: string | null;
  totalAmount: number; detailOrders: number; matchedOrders: number; unmatchedOrders: number;
  auditFlags: number; importedAt: string;
  summary: Array<{ charge: string; amount: number; count: number }>;
}
interface AuditFinding {
  check: string; severity: "error" | "warning" | "info"; chargeType: string;
  orderNumber?: string | null; message: string; delta?: number;
}
interface MarginRow {
  channel: string; month?: string; orders: number; shippingRevenue: number;
  postage: number; fulfillment: number; postageMargin: number; netAfterFulfillment?: number;
}
interface RateRow {
  id: string; serviceKey: string; label: string; rate: Record<string, number | string>;
  effectiveFrom: string; notes: string | null;
}

function money(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}
const monthLabel = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

const SEV_BADGE: Record<string, string> = {
  error: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
  info: "bg-blue-100 text-blue-700",
};

export default function ThreePlPage() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [margin, setMargin] = useState<{ byMonth: MarginRow[]; byChannel: MarginRow[] } | null>(null);
  const [rates, setRates] = useState<RateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  // Rate card is read-only unless explicitly unlocked — it drives every audit,
  // it's rarely edited, and a stray keystroke would silently skew findings.
  const [editingRates, setEditingRates] = useState(false);
  const [audit, setAudit] = useState<Record<string, { findings: AuditFinding[]; totals: { overcharged: number; undercharged: number; checkedLines: number } } | null>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [inv, mar, rc] = await Promise.all([
        fetch("/api/v1/operations/three-pl/invoices").then((r) => r.json()),
        fetch("/api/v1/operations/three-pl/margin").then((r) => r.json()),
        fetch("/api/v1/operations/three-pl/rate-card").then((r) => r.json()),
      ]);
      setInvoices(inv.invoices ?? []);
      setMargin(mar);
      setRates(rc.rates ?? []);
    } catch {
      toast.error("Failed to load 3PL data");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const upload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/v1/operations/three-pl/invoices", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      toast.success(
        `Imported ${monthLabel(d.periodStart)} — ${money(d.totalAmount)}, ${d.matchedOrders} orders matched` +
        (d.replacedExisting ? " (replaced previous import)" : "") +
        (d.audit?.findings?.length ? ` · ${d.audit.findings.length} audit finding(s)` : " · audit clean"),
      );
      await load();
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    if (openInvoice === id) { setOpenInvoice(null); return; }
    setOpenInvoice(id);
    if (!audit[id]) {
      const d = await fetch(`/api/v1/operations/three-pl/invoices/${id}`).then((r) => r.json());
      setAudit((a) => ({ ...a, [id]: d.audit }));
    }
  }, [openInvoice, audit]);

  const removeInvoice = useCallback(async (id: string, label: string) => {
    if (!window.confirm(`Delete the ${label} import? The xlsx can be re-uploaded any time.`)) return;
    await fetch(`/api/v1/operations/three-pl/invoices/${id}`, { method: "DELETE" });
    toast.success("Invoice removed");
    await load();
  }, [load]);

  const saveRate = useCallback(async (row: RateRow, field: string, value: number) => {
    const rate = { ...row.rate, [field]: value };
    const res = await fetch("/api/v1/operations/three-pl/rate-card", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceKey: row.serviceKey, rate, effectiveFrom: row.effectiveFrom }),
    });
    if (res.ok) { toast.success(`${row.label} updated`); await load(); }
    else toast.error("Rate update failed");
  }, [load]);

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link href="/finance" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-5 w-5" /></Link>
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><Truck className="h-7 w-7" /> 3PL Billing</h1>
          <p className="text-muted-foreground">Big Sky invoices, audited against the contract — postage, fulfillment, storage, and shipping margin</p>
        </div>
        <div>
          <input
            ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
            {uploading ? "Importing…" : "Upload invoice (.xlsx)"}
          </Button>
        </div>
      </div>

      {/* Shipping P&L by channel */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Scale className="h-4 w-4" /> Shipping P&amp;L — what customers paid vs what Big Sky charged</CardTitle></CardHeader>
        <CardContent>
          {!margin || margin.byMonth.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Upload an invoice to see shipping margin by channel.</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Month</TableHead><TableHead>Channel</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">Shipping charged</TableHead>
                <TableHead className="text-right">Postage paid</TableHead>
                <TableHead className="text-right">Postage margin</TableHead>
                <TableHead className="text-right">Fulfillment labor</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {margin.byMonth.map((m) => (
                  <TableRow key={`${m.month}-${m.channel}`}>
                    <TableCell>{m.month}</TableCell>
                    <TableCell className="font-medium">{m.channel.replace("shopify_", "")}</TableCell>
                    <TableCell className="text-right">{m.orders}</TableCell>
                    <TableCell className="text-right">{money(m.shippingRevenue)}</TableCell>
                    <TableCell className="text-right">{money(m.postage)}</TableCell>
                    <TableCell className={`text-right font-semibold ${m.postageMargin >= 0 ? "text-green-600" : "text-red-600"}`}>{money(m.postageMargin)}</TableCell>
                    <TableCell className="text-right">{money(m.fulfillment)}</TableCell>
                    <TableCell className={`text-right font-semibold ${(m.netAfterFulfillment ?? 0) >= 0 ? "text-green-600" : "text-red-600"}`}>{money(m.netAfterFulfillment ?? 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="text-xs text-muted-foreground mt-2">
            &quot;Net&quot; = shipping charged to customers − postage − fulfillment labor. Faire orders where Faire funds the label can net positive; flat-rate retail shipping usually runs negative by design.
          </p>
        </CardContent>
      </Card>

      {/* Invoices + discrepancy queue */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><ReceiptText className="h-4 w-4" /> Monthly Invoices</CardTitle></CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No invoices imported yet — upload Big Sky&apos;s monthly xlsx above.</p>
          ) : (
            <div className="space-y-3">
              {invoices.map((inv) => (
                <div key={inv.id} className="rounded-lg border">
                  <button className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/40" onClick={() => loadDetail(inv.id)}>
                    <div className="text-left">
                      <span className="font-semibold">{monthLabel(inv.periodStart)}</span>
                      <span className="ml-3 text-sm text-muted-foreground">{inv.detailOrders} orders · {inv.matchedOrders} matched{inv.unmatchedOrders > 0 ? ` · ${inv.unmatchedOrders} unmatched` : ""}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {inv.auditFlags > 0 ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded"><AlertTriangle className="h-3.5 w-3.5" /> {inv.auditFlags} finding{inv.auditFlags === 1 ? "" : "s"}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded"><CheckCircle2 className="h-3.5 w-3.5" /> audit clean</span>
                      )}
                      <span className="font-bold tabular-nums">{money(inv.totalAmount)}</span>
                    </div>
                  </button>
                  {openInvoice === inv.id && (
                    <div className="border-t px-4 py-3 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        {inv.summary.map((s) => (
                          <div key={s.charge} className="rounded border px-2.5 py-1.5 text-sm">
                            <div className="text-xs text-muted-foreground">{s.charge}</div>
                            <div className="font-semibold">{money(s.amount)}</div>
                          </div>
                        ))}
                      </div>
                      {audit[inv.id]?.findings?.length ? (
                        <div>
                          <p className="text-sm font-medium mb-1">Audit findings</p>
                          <div className="space-y-1">
                            {audit[inv.id]!.findings.map((f, i) => (
                              <div key={i} className="flex items-start gap-2 text-sm">
                                <span className={`shrink-0 px-1.5 py-0.5 rounded text-xs font-medium ${SEV_BADGE[f.severity]}`}>{f.severity}</span>
                                <span>{f.orderNumber ? <span className="font-mono text-xs mr-1">{f.orderNumber}</span> : null}{f.message}</span>
                              </div>
                            ))}
                          </div>
                          {audit[inv.id]!.totals.overcharged > 0 && (
                            <p className="text-sm mt-2 font-medium text-red-600">Potential overbilling this invoice: {money(audit[inv.id]!.totals.overcharged)}</p>
                          )}
                        </div>
                      ) : audit[inv.id] ? (
                        <p className="text-sm text-green-700">Every checked line matches the contract rate card.</p>
                      ) : (
                        <p className="text-sm text-muted-foreground">Loading audit…</p>
                      )}
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" className="text-red-600" onClick={() => removeInvoice(inv.id, monthLabel(inv.periodStart))}>
                          <Trash2 className="h-4 w-4 mr-1" /> Remove import
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Rate card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Contract Rate Card</CardTitle>
          <Button size="sm" variant={editingRates ? "default" : "outline"} onClick={() => setEditingRates((v) => !v)}>
            {editingRates ? "Done editing" : "Edit rates"}
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            The audit engine recomputes every invoice line from these rates (Big Sky contract, Exhibit A).
            {editingRates
              ? " Editing is live — a changed value applies to future imports and re-audits."
              : " Locked to prevent accidental changes — click Edit rates to update after a contract change."}
          </p>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Service</TableHead><TableHead>Rates</TableHead><TableHead>Effective</TableHead><TableHead>Notes</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rates.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(r.rate).map(([k, v]) => (
                        typeof v === "number" ? (
                          editingRates ? (
                            <label key={k} className="flex items-center gap-1 text-xs">
                              <span className="text-muted-foreground">{k}</span>
                              <input
                                type="number" step="0.01" defaultValue={v}
                                className="w-20 rounded border px-1.5 py-0.5 text-sm tabular-nums"
                                onBlur={(e) => {
                                  const nv = parseFloat(e.target.value);
                                  if (Number.isFinite(nv) && nv !== v) saveRate(r, k, nv);
                                }}
                              />
                            </label>
                          ) : (
                            <span key={k} className="text-xs self-center">
                              <span className="text-muted-foreground">{k}</span>{" "}
                              <span className="font-medium tabular-nums">${v.toFixed(2)}</span>
                            </span>
                          )
                        ) : (
                          <span key={k} className="text-xs text-muted-foreground self-center">{k}: {String(v)}</span>
                        )
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{r.effectiveFrom}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[260px]">{r.notes}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
