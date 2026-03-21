"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Plus, ChevronLeft, Package, Truck, Factory, CheckCircle2,
  Clock, FileText, Ship, ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";

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

type FactoryOption = {
  id: string;
  code: string;
  name: string;
};

type SkuOption = {
  id: string;
  sku: string;
  product_name: string;
  color_name: string;
  cost_price: number;
};

type LineItemDraft = {
  skuId: string;
  sku: string;
  productName: string;
  quantity: number;
  unitCost: number;
};

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
  draft: "Draft",
  submitted: "Submitted",
  confirmed: "Confirmed",
  in_production: "In Production",
  shipped: "Shipped",
  in_transit: "In Transit",
  received: "Received",
  complete: "Complete",
};

function StatusTimeline({ current }: { current: string }) {
  const idx = STATUS_PIPELINE.indexOf(current);
  return (
    <div className="flex items-center gap-1">
      {STATUS_PIPELINE.map((step, i) => (
        <div key={step} className="flex items-center">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              i <= idx ? "bg-blue-600" : "bg-gray-200"
            }`}
            title={STATUS_LABELS[step]}
          />
          {i < STATUS_PIPELINE.length - 1 && (
            <div className={`w-4 h-0.5 ${i < idx ? "bg-blue-600" : "bg-gray-200"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function PurchaseOrdersPage() {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);

  // Create PO state
  const [factories, setFactories] = useState<FactoryOption[]>([]);
  const [selectedFactory, setSelectedFactory] = useState("");
  const [skuOptions, setSkuOptions] = useState<SkuOption[]>([]);
  const [lineItems, setLineItems] = useState<LineItemDraft[]>([]);
  const [selectedSku, setSelectedSku] = useState("");
  const [newQty, setNewQty] = useState(300);
  const [poNotes, setPoNotes] = useState("");

  useEffect(() => {
    loadPOs();
    loadFactories();
  }, []);

  function loadPOs() {
    fetch("/api/v1/inventory/purchase-orders")
      .then((r) => r.json())
      .then((data) => {
        setPos(data.purchaseOrders || []);
        setLoading(false);
      });
  }

  function loadFactories() {
    // Load from inventory API
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
            id: item.sku_id,
            sku: item.sku,
            product_name: item.product_name,
            color_name: item.color_name,
            cost_price: item.cost_price || 7,
          }))
        );
      });
  }

  function addLineItem() {
    const sku = skuOptions.find((s) => s.id === selectedSku);
    if (!sku) return;
    if (lineItems.find((li) => li.skuId === sku.id)) return;
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
    if (expandedId === poId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
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
            <p className="text-muted-foreground text-sm">Manage factory orders and shipments</p>
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
                      <Input
                        type="number"
                        value={newQty}
                        onChange={(e) => setNewQty(parseInt(e.target.value) || 0)}
                      />
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
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setLineItems(lineItems.filter((_, j) => j !== i))}
                              >
                                ✕
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow>
                          <TableCell colSpan={2} className="font-medium">Total</TableCell>
                          <TableCell className="text-right font-medium">
                            {lineItems.reduce((s, li) => s + li.quantity, 0)}
                          </TableCell>
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
              <Button onClick={createPO} disabled={!selectedFactory || lineItems.length === 0}>
                Create PO
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
                  <>
                    <TableRow
                      key={po.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => loadDetail(po.id)}
                    >
                      <TableCell className="font-mono font-medium">{po.po_number}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{po.factory_code} · {po.factory_name}</Badge>
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
                        {po.status !== "complete" && po.status !== "received" && (
                          <Select
                            value=""
                            onValueChange={(v) => {
                              // Prevent row click
                              if (v) updateStatus(po.id, v);
                            }}
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
                        <TableCell colSpan={9} className="bg-muted/30 p-4">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {/* Line Items */}
                            <div className="md:col-span-2">
                              <h4 className="font-medium mb-2">Line Items</h4>
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>SKU</TableHead>
                                    <TableHead>Product</TableHead>
                                    <TableHead className="text-right">Qty</TableHead>
                                    <TableHead className="text-right">Unit Cost</TableHead>
                                    <TableHead className="text-right">Total</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {((detail as Record<string, unknown>).lineItems as Array<Record<string, unknown>> || []).map((li) => (
                                    <TableRow key={li.id as string}>
                                      <TableCell className="font-mono text-sm">{li.sku as string}</TableCell>
                                      <TableCell>{li.product_name as string} — {li.color_name as string}</TableCell>
                                      <TableCell className="text-right">{(li.quantity as number).toLocaleString()}</TableCell>
                                      <TableCell className="text-right">${(li.unit_cost as number)?.toFixed(2)}</TableCell>
                                      <TableCell className="text-right">${(li.total_cost as number)?.toFixed(2)}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                            {/* Factory Contact */}
                            <div>
                              <h4 className="font-medium mb-2">Factory Contact</h4>
                              <div className="text-sm space-y-1">
                                <p><span className="text-muted-foreground">Name:</span> {po.contact_name}</p>
                                <p><span className="text-muted-foreground">Email:</span> {po.contact_email}</p>
                                <p><span className="text-muted-foreground">Phone:</span> {po.contact_phone}</p>
                              </div>
                              {po.tracking_number && (
                                <div className="mt-3">
                                  <h4 className="font-medium mb-1">Tracking</h4>
                                  <p className="text-sm">{po.tracking_number}</p>
                                </div>
                              )}
                              {po.notes && (
                                <div className="mt-3">
                                  <h4 className="font-medium mb-1">Notes</h4>
                                  <p className="text-sm text-muted-foreground">{po.notes}</p>
                                </div>
                              )}
                            </div>
                          </div>
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
