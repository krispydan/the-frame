"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Plus, ChevronLeft, Package, ClipboardCheck, AlertTriangle,
  FileText, ExternalLink, X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ── Types ──

type PurchaseOrder = {
  id: string;
  po_number: string;
  factory_id: string;
  factory_code: string;
  factory_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  status: string;
  total_units: number;
  total_cost: number;
  order_date: string | null;
  expected_ship_date: string | null;
  expected_arrival_date: string | null;
  actual_arrival_date: string | null;
  tracking_number: string | null;
  notes: string | null;
};

type FactoryOption = { id: string; code: string; name: string };
type SkuOption = { id: string; sku: string; product_name: string; color_name: string; cost_price: number };
type LineItemDraft = { skuId: string; sku: string; productName: string; quantity: number; unitCost: number };

type LineItem = {
  id: string; po_id: string; sku_id: string; sku: string;
  product_name: string; color_name: string;
  quantity: number; unit_cost: number; total_cost: number;
  received_quantity: number;
};

type QCInspection = {
  id: string; po_id: string; inspector: string; inspection_date: string;
  total_units: number; defect_count: number; defect_rate: number;
  status: string; notes: string | null; created_at: string;
};

type ReceiptRecord = {
  id: string; sku_id: string; sku: string; product_name: string;
  color_name: string; quantity: number; created_at: string;
};

type PODetail = PurchaseOrder & {
  lineItems: LineItem[];
  qcInspections: QCInspection[];
  receiptHistory: ReceiptRecord[];
};

// ── Constants ──

const STATUS_PIPELINE = ["draft", "submitted", "confirmed", "in_production", "shipped", "in_transit", "received", "complete"];

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  submitted: "bg-blue-100 text-blue-700",
  confirmed: "bg-indigo-100 text-indigo-700",
  in_production: "bg-purple-100 text-purple-700",
  shipped: "bg-orange-100 text-orange-700",
  in_transit: "bg-yellow-100 text-yellow-700",
  received: "bg-green-100 text-green-700",
  complete: "bg-emerald-100 text-emerald-700",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", submitted: "Sent", confirmed: "Confirmed",
  in_production: "In Production", shipped: "Shipped", in_transit: "In Transit",
  received: "Received", complete: "Complete",
};

const QC_COLORS: Record<string, string> = {
  passed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  conditional: "bg-yellow-100 text-yellow-700",
  pending: "bg-gray-100 text-gray-700",
};

// ── Status Timeline ──

function StatusTimeline({ current }: { current: string }) {
  const idx = STATUS_PIPELINE.indexOf(current);
  return (
    <div className="flex items-center gap-0.5">
      {STATUS_PIPELINE.map((step, i) => (
        <div key={step} className="flex items-center" title={STATUS_LABELS[step]}>
          <div className={`w-2.5 h-2.5 rounded-full ${i <= idx ? "bg-blue-600" : "bg-gray-200"}`} />
          {i < STATUS_PIPELINE.length - 1 && (
            <div className={`w-3 h-0.5 ${i < idx ? "bg-blue-600" : "bg-gray-200"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Receive Modal ──

function ReceiveModal({
  po,
  lineItems,
  onClose,
  onReceived,
}: {
  po: PurchaseOrder;
  lineItems: LineItem[];
  onClose: () => void;
  onReceived: () => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);

  const receivable = lineItems.filter((li) => li.received_quantity < li.quantity);

  async function handleSubmit() {
    const items = Object.entries(quantities)
      .filter(([, qty]) => qty > 0)
      .map(([lineItemId, receivedQty]) => ({ lineItemId, receivedQty }));

    if (items.length === 0) return;
    setSubmitting(true);

    const res = await fetch(`/api/v1/inventory/purchase-orders/${po.id}/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });

    if (res.ok) {
      onReceived();
      onClose();
    }
    setSubmitting(false);
  }

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Receive Shipment — {po.po_number}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3 max-h-[50vh] overflow-y-auto">
        {receivable.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">All items fully received.</p>
        ) : (
          receivable.map((li) => {
            const remaining = li.quantity - li.received_quantity;
            return (
              <div key={li.id} className="flex items-center gap-3 py-2 border-b last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-sm">{li.sku}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {li.product_name} — {li.color_name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Ordered: {li.quantity} · Received: {li.received_quantity} · Remaining: {remaining}
                  </p>
                </div>
                <div className="w-24">
                  <Input
                    type="number"
                    min={0}
                    max={remaining}
                    placeholder="0"
                    value={quantities[li.id] || ""}
                    onChange={(e) =>
                      setQuantities({
                        ...quantities,
                        [li.id]: Math.min(parseInt(e.target.value) || 0, remaining),
                      })
                    }
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          onClick={handleSubmit}
          disabled={submitting || receivable.length === 0 || Object.values(quantities).every((v) => !v)}
        >
          {submitting ? "Receiving…" : "Receive Items"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ── QC Inspection Modal ──

function QCModal({
  po,
  onClose,
  onCreated,
}: {
  po: PurchaseOrder;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [inspector, setInspector] = useState("");
  const [totalUnits, setTotalUnits] = useState(po.total_units);
  const [defectCount, setDefectCount] = useState(0);
  const [result, setResult] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [alert, setAlert] = useState<{ message: string; severity: string } | null>(null);

  const defectRate = totalUnits > 0 ? Math.round((defectCount / totalUnits) * 10000) / 100 : 0;

  async function handleSubmit() {
    if (totalUnits <= 0) return;
    setSubmitting(true);

    const res = await fetch(`/api/v1/inventory/purchase-orders/${po.id}/qc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inspector: inspector || "QC Team",
        totalUnits,
        defectCount,
        result: result || undefined,
        notes,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.alert) {
        setAlert(data.alert);
      } else {
        onCreated();
        onClose();
      }
    }
    setSubmitting(false);
  }

  if (alert) {
    return (
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="h-5 w-5" /> QC Alert
          </DialogTitle>
        </DialogHeader>
        <div className={`p-4 rounded-lg ${alert.severity === "critical" ? "bg-red-50 border border-red-200" : "bg-yellow-50 border border-yellow-200"}`}>
          <p className="text-sm font-medium">{alert.message}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Defect rate: {defectRate.toFixed(1)}% — Threshold: 5%
          </p>
        </div>
        <DialogFooter>
          <Button onClick={() => { onCreated(); onClose(); }}>Acknowledge</Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>QC Inspection — {po.po_number}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div>
          <Label>Inspector</Label>
          <Input value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="Inspector name" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Total Units Inspected</Label>
            <Input type="number" value={totalUnits} onChange={(e) => setTotalUnits(parseInt(e.target.value) || 0)} />
          </div>
          <div>
            <Label>Defect Count</Label>
            <Input type="number" min={0} value={defectCount} onChange={(e) => setDefectCount(parseInt(e.target.value) || 0)} />
          </div>
        </div>
        <div className={`text-sm font-medium p-2 rounded ${defectRate > 5 ? "bg-red-50 text-red-700" : defectRate > 2 ? "bg-yellow-50 text-yellow-700" : "bg-green-50 text-green-700"}`}>
          Defect Rate: {defectRate.toFixed(2)}%
          {defectRate > 5 && " ⚠️ HIGH — will generate alert"}
        </div>
        <div>
          <Label>Result</Label>
          <Select value={result} onValueChange={(v) => setResult(v || "")}>
            <SelectTrigger><SelectValue placeholder="Auto-determine from defect rate" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="passed">Pass</SelectItem>
              <SelectItem value="conditional">Conditional</SelectItem>
              <SelectItem value="failed">Fail</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Inspection observations, defect types…" rows={3} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={submitting || totalUnits <= 0}>
          {submitting ? "Submitting…" : "Submit Inspection"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ── PO Detail Panel ──

function PODetailPanel({
  detail,
  onUpdateStatus,
  onRefresh,
}: {
  detail: PODetail;
  onUpdateStatus: (status: string) => void;
  onRefresh: () => void;
}) {
  const [showReceive, setShowReceive] = useState(false);
  const [showQC, setShowQC] = useState(false);

  const canReceive = ["submitted", "confirmed", "in_production", "shipped", "in_transit", "received"].includes(detail.status);
  const canQC = ["received", "complete"].includes(detail.status);

  return (
    <div className="bg-muted/30 border-t p-4 space-y-4">
      {/* Action Bar */}
      <div className="flex items-center gap-2 flex-wrap">
        {detail.status === "draft" && (
          <>
            <Button size="sm" onClick={() => onUpdateStatus("submitted")} className="gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Mark as Sent
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href={`/api/v1/inventory/purchase-orders/${detail.id}/pdf`} target="_blank" className="gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" /> View PDF
              </a>
            </Button>
          </>
        )}
        {canReceive && (
          <Dialog open={showReceive} onOpenChange={setShowReceive}>
            <DialogTrigger render={
              <Button size="sm" variant="outline" className="gap-1.5">
                <Package className="h-3.5 w-3.5" /> Receive Shipment
              </Button>
            } />
            <ReceiveModal
              po={detail}
              lineItems={detail.lineItems}
              onClose={() => setShowReceive(false)}
              onReceived={onRefresh}
            />
          </Dialog>
        )}
        {canQC && (
          <Dialog open={showQC} onOpenChange={setShowQC}>
            <DialogTrigger render={
              <Button size="sm" variant="outline" className="gap-1.5">
                <ClipboardCheck className="h-3.5 w-3.5" /> QC Inspection
              </Button>
            } />
            <QCModal
              po={detail}
              onClose={() => setShowQC(false)}
              onCreated={onRefresh}
            />
          </Dialog>
        )}
        {detail.status !== "draft" && (
          <Button size="sm" variant="ghost" asChild>
            <a href={`/api/v1/inventory/purchase-orders/${detail.id}/pdf`} target="_blank" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" /> PDF
            </a>
          </Button>
        )}
      </div>

      {/* Tabbed Detail */}
      <Tabs defaultValue="items">
        <TabsList>
          <TabsTrigger value="items">Line Items ({detail.lineItems.length})</TabsTrigger>
          <TabsTrigger value="receipts">Receipts ({detail.receiptHistory?.length || 0})</TabsTrigger>
          <TabsTrigger value="qc">
            QC ({detail.qcInspections?.length || 0})
            {detail.qcInspections?.some((q) => q.status === "failed") && (
              <AlertTriangle className="h-3 w-3 ml-1 text-red-500" />
            )}
          </TabsTrigger>
          <TabsTrigger value="info">Info</TabsTrigger>
        </TabsList>

        {/* Line Items Tab */}
        <TabsContent value="items">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.lineItems.map((li) => (
                <TableRow key={li.id}>
                  <TableCell className="font-mono text-sm">{li.sku}</TableCell>
                  <TableCell className="text-sm">{li.product_name} — {li.color_name}</TableCell>
                  <TableCell className="text-right">{li.quantity.toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <span className={li.received_quantity >= li.quantity ? "text-green-600 font-medium" : li.received_quantity > 0 ? "text-yellow-600" : ""}>
                      {li.received_quantity.toLocaleString()}
                    </span>
                    {li.received_quantity > 0 && li.received_quantity < li.quantity && (
                      <span className="text-xs text-muted-foreground ml-1">
                        ({Math.round((li.received_quantity / li.quantity) * 100)}%)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">${li.unit_cost.toFixed(2)}</TableCell>
                  <TableCell className="text-right">${li.total_cost.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        {/* Receipt History Tab */}
        <TabsContent value="receipts">
          {!detail.receiptHistory?.length ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No receipts yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.receiptHistory.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">{r.created_at?.split("T")[0] || r.created_at?.split(" ")[0] || "—"}</TableCell>
                    <TableCell className="font-mono text-sm">{r.sku}</TableCell>
                    <TableCell className="text-sm">{r.product_name} — {r.color_name}</TableCell>
                    <TableCell className="text-right font-medium">{r.quantity.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        {/* QC Tab */}
        <TabsContent value="qc">
          {!detail.qcInspections?.length ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No inspections yet.</p>
          ) : (
            <div className="space-y-3">
              {detail.qcInspections.map((qc) => (
                <div key={qc.id} className="border rounded-lg p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge className={`${QC_COLORS[qc.status] || ""} border-0 text-xs`}>
                        {qc.status === "conditional" ? "Conditional" : qc.status === "passed" ? "Pass" : qc.status === "failed" ? "Fail" : qc.status}
                      </Badge>
                      <span className="text-sm font-medium">{qc.inspector}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{qc.inspection_date}</span>
                  </div>
                  <div className="flex gap-4 text-sm">
                    <span>Units: {qc.total_units.toLocaleString()}</span>
                    <span>Defects: {qc.defect_count}</span>
                    <span className={qc.defect_rate > 5 ? "text-red-600 font-medium" : qc.defect_rate > 2 ? "text-yellow-600" : "text-green-600"}>
                      Rate: {qc.defect_rate.toFixed(2)}%
                      {qc.defect_rate > 5 && " ⚠️"}
                    </span>
                  </div>
                  {qc.notes && (
                    <p className="text-xs text-muted-foreground">{qc.notes}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Info Tab */}
        <TabsContent value="info">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Factory</p>
              <p className="font-medium">{detail.factory_code} — {detail.factory_name}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Contact</p>
              <p>{detail.contact_name || "—"}</p>
              <p className="text-xs">{detail.contact_email || ""}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Order Date</p>
              <p>{detail.order_date || "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Expected Ship</p>
              <p>{detail.expected_ship_date || "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Expected Arrival</p>
              <p>{detail.expected_arrival_date || "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Actual Arrival</p>
              <p>{detail.actual_arrival_date || "—"}</p>
            </div>
            {detail.tracking_number && (
              <div>
                <p className="text-muted-foreground text-xs">Tracking</p>
                <p className="font-mono">{detail.tracking_number}</p>
                <p className="text-xs">{detail.tracking_carrier || ""}</p>
              </div>
            )}
            {detail.notes && (
              <div className="col-span-full">
                <p className="text-muted-foreground text-xs">Notes</p>
                <p>{detail.notes}</p>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Main Page ──

export default function PurchaseOrdersPage() {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PODetail | null>(null);

  // Create PO state
  const [factories, setFactories] = useState<FactoryOption[]>([]);
  const [selectedFactory, setSelectedFactory] = useState("");
  const [skuOptions, setSkuOptions] = useState<SkuOption[]>([]);
  const [lineItems, setLineItems] = useState<LineItemDraft[]>([]);
  const [selectedSku, setSelectedSku] = useState("");
  const [newQty, setNewQty] = useState(300);
  const [poNotes, setPoNotes] = useState("");

  const loadPOs = useCallback(() => {
    fetch("/api/v1/inventory/purchase-orders")
      .then((r) => r.json())
      .then((data) => { setPos(data.purchaseOrders || []); setLoading(false); });
  }, []);

  useEffect(() => { loadPOs(); loadFactories(); }, [loadPOs]);

  function loadFactories() {
    fetch("/api/v1/inventory/factories")
      .then((r) => r.json())
      .then((data) => setFactories(data.factories || []))
      .catch(() => {});
  }

  function loadSkus(factoryCode: string) {
    fetch(`/api/v1/inventory?factory=${factoryCode}`)
      .then((r) => r.json())
      .then((data) => {
        setSkuOptions(
          (data.items || []).map((item: Record<string, unknown>) => ({
            id: item.sku_id, sku: item.sku,
            product_name: item.product_name, color_name: item.color_name,
            cost_price: item.cost_price || 7,
          }))
        );
      });
  }

  function addLineItem() {
    const sku = skuOptions.find((s) => s.id === selectedSku);
    if (!sku || lineItems.find((li) => li.skuId === sku.id)) return;
    setLineItems([
      ...lineItems,
      { skuId: sku.id, sku: sku.sku, productName: `${sku.product_name} - ${sku.color_name}`, quantity: newQty, unitCost: sku.cost_price || 7 },
    ]);
    setSelectedSku("");
    setNewQty(300);
  }

  async function createPO() {
    if (!selectedFactory || lineItems.length === 0) return;
    const factoryObj = factories.find((f) => f.code === selectedFactory);
    if (!factoryObj) return;

    await fetch("/api/v1/inventory/purchase-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factoryId: factoryObj.id,
        lineItems: lineItems.map((li) => ({ skuId: li.skuId, quantity: li.quantity, unitCost: li.unitCost })),
        notes: poNotes,
      }),
    });

    setShowCreate(false);
    setLineItems([]);
    setSelectedFactory("");
    setPoNotes("");
    loadPOs();
  }

  async function loadDetail(poId: string) {
    if (expandedId === poId) { setExpandedId(null); setDetail(null); return; }
    const res = await fetch(`/api/v1/inventory/purchase-orders/${poId}`);
    const data = await res.json();
    setDetail(data);
    setExpandedId(poId);
  }

  async function updateStatus(poId: string, newStatus: string) {
    await fetch(`/api/v1/inventory/purchase-orders/${poId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    loadPOs();
    if (expandedId === poId) loadDetail(poId);
  }

  function refreshDetail() {
    if (expandedId) {
      loadDetail(expandedId);
      // Reset expandedId to force reload
      const id = expandedId;
      setExpandedId(null);
      setTimeout(() => loadDetail(id), 100);
    }
    loadPOs();
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/inventory">
            <Button variant="ghost" size="icon"><ChevronLeft className="h-5 w-5" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Purchase Orders</h1>
            <p className="text-muted-foreground text-sm">Manage factory orders, receiving, and QC</p>
          </div>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger render={<Button className="gap-2"><Plus className="h-4 w-4" /> New PO</Button>} />
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Purchase Order</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Factory</Label>
                <Select
                  value={selectedFactory}
                  onValueChange={(v) => {
                    setSelectedFactory(v || "");
                    if (v) loadSkus(v);
                    setLineItems([]);
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="Select factory" /></SelectTrigger>
                  <SelectContent>
                    {factories.map((f) => (
                      <SelectItem key={f.code} value={f.code}>{f.code} — {f.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedFactory && (
                <>
                  <div className="flex gap-2 items-end">
                    <div className="flex-1">
                      <Label>Add SKU</Label>
                      <Select value={selectedSku} onValueChange={(v) => setSelectedSku(v || "")}>
                        <SelectTrigger><SelectValue placeholder="Select SKU" /></SelectTrigger>
                        <SelectContent>
                          {skuOptions.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.sku} — {s.product_name} ({s.color_name})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="w-24">
                      <Label>Qty</Label>
                      <Input type="number" value={newQty} onChange={(e) => setNewQty(parseInt(e.target.value) || 0)} />
                    </div>
                    <Button onClick={addLineItem} size="sm">Add</Button>
                  </div>

                  {lineItems.length > 0 && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>SKU</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Unit Cost</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                          <TableHead></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {lineItems.map((li, i) => (
                          <TableRow key={li.skuId}>
                            <TableCell className="font-mono text-sm">{li.sku}</TableCell>
                            <TableCell>{li.productName}</TableCell>
                            <TableCell className="text-right">{li.quantity}</TableCell>
                            <TableCell className="text-right">${li.unitCost.toFixed(2)}</TableCell>
                            <TableCell className="text-right">${(li.quantity * li.unitCost).toFixed(2)}</TableCell>
                            <TableCell>
                              <Button variant="ghost" size="sm" onClick={() => setLineItems(lineItems.filter((_, j) => j !== i))}>
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow>
                          <TableCell colSpan={2} className="font-medium">Total</TableCell>
                          <TableCell className="text-right font-medium">{lineItems.reduce((s, li) => s + li.quantity, 0)}</TableCell>
                          <TableCell></TableCell>
                          <TableCell className="text-right font-medium">
                            ${lineItems.reduce((s, li) => s + li.quantity * li.unitCost, 0).toFixed(2)}
                          </TableCell>
                          <TableCell></TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  )}

                  <div>
                    <Label>Notes</Label>
                    <Input value={poNotes} onChange={(e) => setPoNotes(e.target.value)} placeholder="Optional notes..." />
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={createPO} disabled={!selectedFactory || lineItems.length === 0}>Create PO</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total POs", value: pos.length },
          { label: "Draft", value: pos.filter((p) => p.status === "draft").length },
          { label: "In Transit", value: pos.filter((p) => ["shipped", "in_transit"].includes(p.status)).length },
          { label: "Awaiting QC", value: pos.filter((p) => p.status === "received").length },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              <p className="text-2xl font-bold">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* PO List */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PO #</TableHead>
                <TableHead>Factory</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Pipeline</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Order Date</TableHead>
                <TableHead>ETA</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Loading...</TableCell>
                </TableRow>
              ) : pos.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">No purchase orders yet</TableCell>
                </TableRow>
              ) : (
                pos.map((po) => (
                  <><TableRow
                      key={po.id}
                      className={`cursor-pointer hover:bg-muted/50 ${expandedId === po.id ? "bg-muted/30" : ""}`}
                      onClick={() => loadDetail(po.id)}
                    >
                      <TableCell className="font-mono font-medium">{po.po_number}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{po.factory_code}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={`${STATUS_COLORS[po.status] || ""} border-0 text-xs`}>
                          {STATUS_LABELS[po.status] || po.status}
                        </Badge>
                      </TableCell>
                      <TableCell><StatusTimeline current={po.status} /></TableCell>
                      <TableCell className="text-right">{po.total_units.toLocaleString()}</TableCell>
                      <TableCell className="text-right">${po.total_cost.toLocaleString()}</TableCell>
                      <TableCell className="text-sm">{po.order_date || "—"}</TableCell>
                      <TableCell className="text-sm">{po.expected_arrival_date || "—"}</TableCell>
                      <TableCell>
                        {!["complete"].includes(po.status) && (
                          <Select
                            value=""
                            onValueChange={(v) => { if (v) updateStatus(po.id, v); }}
                          >
                            <SelectTrigger className="w-[110px] h-7 text-xs" onClick={(e) => e.stopPropagation()}>
                              <SelectValue placeholder="Advance →" />
                            </SelectTrigger>
                            <SelectContent>
                              {STATUS_PIPELINE.slice(STATUS_PIPELINE.indexOf(po.status) + 1).map((s) => (
                                <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                    </TableRow>
                    {expandedId === po.id && detail && (
                      <TableRow key={`${po.id}-detail`}>
                        <TableCell colSpan={9} className="p-0">
                          <PODetailPanel
                            detail={detail}
                            onUpdateStatus={(s) => updateStatus(po.id, s)}
                            onRefresh={refreshDetail}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
