"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import {
  ArrowLeft,
  Package,
  Truck,
  CheckCircle2,
  XCircle,
  ShoppingCart,
  RotateCcw,
  Clock,
  User,
  Mail,
  Building2,
  CalendarDays,
  ExternalLink,
} from "lucide-react";

// ── Types ──

interface Shipment {
  shiphero_shipment_id?: string | null;
  tracking_number?: string | null;
  tracking_carrier?: string | null;
  shipping_method?: string | null;
  shipping_method_label?: string | null;
  shipped_off_warehouse_at?: string | null;
  delivered_at?: string | null;
  created_date?: string | null;
}

interface FulfillmentCost {
  invoice_date?: string | null;
  description?: string | null;
  amount?: number | null;
  currency?: string | null;
}

interface OrderDetail {
  id: string;
  orderNumber: string;
  companyId: string | null;
  channel: string;
  status: string;
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
  currency: string;
  notes: string | null;
  externalId: string | null;
  externalUrl: string | null;
  shipheroUrl: string | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  placedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string } | null;
  profit: {
    itemsRevenue: number;
    totalCost: number | null;
    grossProfit: number | null;
    grossMargin: number | null;
    hasFullCostData: boolean;
  } | null;
  items: Array<{
    id: string;
    sku: string | null;
    productName: string;
    unitCost: number | null;
    lineCost: number | null;
    lineProfit: number | null;
    colorName: string | null;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  shipments: Shipment[];
  fulfillmentCosts: FulfillmentCost[];
  returns: Array<{
    id: string;
    reason: string | null;
    status: string;
    refundAmount: number | null;
    items: Array<{ orderItemId: string; quantity: number; reason?: string }> | null;
    createdAt: string;
  }>;
  timeline: Array<{
    id: string;
    eventType: string;
    data: Record<string, unknown>;
    createdAt: string;
  }>;
}

// ── Config ──

const channelConfig: Record<string, { label: string; color: string }> = {
  shopify_dtc: { label: "Shopify DTC", color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300" },
  shopify_wholesale: { label: "Shopify Wholesale", color: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" },
  faire: { label: "Faire", color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300" },
  amazon: { label: "Amazon", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300" },
  direct: { label: "Direct", color: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300" },
  phone: { label: "Phone", color: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300" },
};

const statusConfig: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  pending: { label: "Pending", color: "bg-yellow-100 text-yellow-800", icon: ShoppingCart },
  confirmed: { label: "Confirmed", color: "bg-blue-100 text-blue-800", icon: CheckCircle2 },
  picking: { label: "Picking", color: "bg-purple-100 text-purple-800", icon: Package },
  packed: { label: "Packed", color: "bg-indigo-100 text-indigo-800", icon: Package },
  shipped: { label: "Shipped", color: "bg-cyan-100 text-cyan-800", icon: Truck },
  delivered: { label: "Delivered", color: "bg-green-100 text-green-800", icon: CheckCircle2 },
  returned: { label: "Returned", color: "bg-red-100 text-red-800", icon: XCircle },
  cancelled: { label: "Cancelled", color: "bg-gray-100 text-gray-500", icon: XCircle },
};

const statusPipeline = ["pending", "confirmed", "picking", "packed", "shipped", "delivered"];

const returnReasons = [
  "Defective / Damaged",
  "Wrong item received",
  "Customer changed mind",
  "Does not fit",
  "Not as described",
  "Other",
];

// ── Badges ──

function ChannelBadge({ channel }: { channel: string }) {
  const cfg = channelConfig[channel] || { label: channel, color: "bg-gray-100 text-gray-600" };
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>{cfg.label}</span>;
}

function StatusBadge({ status, size = "sm" }: { status: string; size?: "sm" | "lg" }) {
  const cfg = statusConfig[status] || { label: status, color: "bg-gray-100 text-gray-600", icon: ShoppingCart };
  const Icon = cfg.icon;
  const sizeClass = size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-medium ${cfg.color} ${sizeClass}`}>
      <Icon className={size === "lg" ? "h-4 w-4" : "h-3 w-3"} />
      {cfg.label}
    </span>
  );
}

// ── Timeline Event Display ──

function timelineLabel(eventType: string): { label: string; icon: React.ElementType; color: string } {
  const map: Record<string, { label: string; icon: React.ElementType; color: string }> = {
    "order.pending": { label: "Order placed", icon: ShoppingCart, color: "text-yellow-500" },
    "order.confirmed": { label: "Order confirmed", icon: CheckCircle2, color: "text-blue-500" },
    "order.picking": { label: "Picking started", icon: Package, color: "text-purple-500" },
    "order.packed": { label: "Order packed", icon: Package, color: "text-indigo-500" },
    "order.shipped": { label: "Order shipped", icon: Truck, color: "text-cyan-500" },
    "order.delivered": { label: "Order delivered", icon: CheckCircle2, color: "text-green-500" },
    "order.returned": { label: "Order returned", icon: RotateCcw, color: "text-red-500" },
    "order.cancelled": { label: "Order cancelled", icon: XCircle, color: "text-gray-500" },
    "return.requested": { label: "Return requested", icon: RotateCcw, color: "text-orange-500" },
    "return.approved": { label: "Return approved", icon: CheckCircle2, color: "text-green-500" },
    "return.received": { label: "Return received", icon: Package, color: "text-blue-500" },
    "return.refunded": { label: "Refund issued", icon: CheckCircle2, color: "text-green-600" },
  };
  return map[eventType] || { label: eventType, icon: Clock, color: "text-gray-400" };
}

// ── KPI Tile ──

function KpiTile({
  label, value, sub, accent,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: "default" | "positive" | "negative" | "muted";
}) {
  const accentClass = {
    default: "",
    positive: "text-green-600 dark:text-green-500",
    negative: "text-red-600 dark:text-red-500",
    muted: "text-muted-foreground",
  }[accent || "default"];
  return (
    <div className="px-5 py-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
      <p className={`text-2xl font-semibold mt-1 ${accentClass}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Page ──

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { setOverride } = useBreadcrumbOverride();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Return state
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [returnItems, setReturnItems] = useState<Record<string, number>>({});
  const [submittingReturn, setSubmittingReturn] = useState(false);

  // Unwrap params
  useEffect(() => {
    params.then((p) => setOrderId(p.id));
  }, [params]);

  const fetchOrder = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/orders/${orderId}`);
      if (!res.ok) throw new Error("Order not found");
      const data = await res.json();
      setOrder(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { fetchOrder(); }, [fetchOrder]);
  useEffect(() => {
    if (order) setOverride(order.orderNumber);
    return () => setOverride(null);
  }, [order, setOverride]);

  const submitReturn = async () => {
    if (!order) return;
    const items = Object.entries(returnItems)
      .filter(([, qty]) => qty > 0)
      .map(([orderItemId, quantity]) => ({ orderItemId, quantity, reason: returnReason }));
    if (items.length === 0) return;

    setSubmittingReturn(true);
    await fetch(`/api/v1/orders/${order.id}/returns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: returnReason, items }),
    });
    setShowReturnForm(false);
    setReturnReason("");
    setReturnItems({});
    await fetchOrder();
    setSubmittingReturn(false);
  };

  if (loading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-32 bg-muted rounded-lg" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 h-64 bg-muted rounded-lg" />
            <div className="h-64 bg-muted rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <button onClick={() => router.push("/orders")} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to Orders
        </button>
        <div className="text-center py-12">
          <p className="text-lg text-muted-foreground">{error || "Order not found"}</p>
        </div>
      </div>
    );
  }

  const canReturn = ["delivered", "shipped"].includes(order.status);
  const itemCount = order.items.reduce((sum, it) => sum + it.quantity, 0);
  const hasFulfillmentBlock =
    order.trackingNumber ||
    order.shippedAt ||
    order.deliveredAt ||
    (order.shipments && order.shipments.length > 0) ||
    (order.fulfillmentCosts && order.fulfillmentCosts.length > 0);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Back nav */}
      <button onClick={() => router.push("/orders")} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Orders
      </button>

      {/* ── Hero ── */}
      <div className="bg-white dark:bg-gray-800 border rounded-lg overflow-hidden">
        {/* Top row: order metadata (left) + Total / Gross Profit big numbers (right) */}
        <div className="p-6 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
          {/* Order info + external links */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold">{order.orderNumber}</h1>
              <StatusBadge status={order.status} size="lg" />
              <ChannelBadge channel={order.channel} />
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3.5 w-3.5" />
                Placed {order.placedAt ? new Date(order.placedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
              </span>
              {order.externalId && !order.externalUrl && (
                <span className="inline-flex items-center gap-1 font-mono text-xs">
                  <ExternalLink className="h-3 w-3" />
                  {order.externalId}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              {order.externalUrl && (
                <a
                  href={order.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-background hover:bg-muted text-sm font-medium"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {order.channel === "faire" ? "View in Faire" : "View in Shopify"}
                </a>
              )}
              {order.shipheroUrl && (
                <a
                  href={order.shipheroUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-background hover:bg-muted text-sm font-medium"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  View in ShipHero
                </a>
              )}
            </div>
          </div>

          {/* Hero numbers — Total + Gross Profit are the headliners */}
          <div className="flex items-stretch gap-4 sm:gap-6 lg:border-l lg:pl-6 shrink-0">
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Revenue</p>
              <p className="text-3xl sm:text-4xl font-bold tabular-nums mt-1">
                ${order.total.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{order.currency}</p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide font-medium text-emerald-700 dark:text-emerald-400">
                Gross Profit
              </p>
              <p className={`text-3xl sm:text-4xl font-bold tabular-nums mt-1 ${
                order.profit?.grossProfit == null
                  ? "text-muted-foreground"
                  : order.profit.grossProfit >= 0
                    ? "text-emerald-600 dark:text-emerald-500"
                    : "text-red-600 dark:text-red-500"
              }`}>
                {order.profit?.grossProfit != null ? `$${order.profit.grossProfit.toFixed(2)}` : "—"}
              </p>
              <p className="text-xs mt-0.5">
                {order.profit?.grossMargin != null ? (
                  <span className={`font-medium ${
                    order.profit.grossProfit != null && order.profit.grossProfit >= 0
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-red-700 dark:text-red-400"
                  }`}>
                    {(order.profit.grossMargin * 100).toFixed(1)}% margin
                  </span>
                ) : !order.profit?.hasFullCostData ? (
                  <span className="text-muted-foreground">Cost data missing</span>
                ) : null}
                {order.profit?.grossMargin != null && !order.profit.hasFullCostData && (
                  <span className="text-yellow-600 ml-1">(partial)</span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Secondary metrics strip — smaller, supporting info */}
        <div className="grid grid-cols-2 sm:grid-cols-3 border-t divide-x">
          <KpiTile
            label="COGS"
            value={
              order.profit?.totalCost != null
                ? `$${order.profit.totalCost.toFixed(2)}`
                : "—"
            }
            sub={order.profit?.hasFullCostData ? undefined : "Partial — see line items"}
            accent="muted"
          />
          <KpiTile
            label="Items"
            value={itemCount}
            sub={`${order.items.length} line${order.items.length === 1 ? "" : "s"}`}
            accent="muted"
          />
          <KpiTile
            label="Customer"
            value={
              <span className="text-base font-semibold leading-tight block truncate">
                {order.contact?.name || order.company?.name || "—"}
              </span>
            }
            sub={
              order.company?.name && order.contact?.name
                ? order.company.name
                : order.contact?.email || undefined
            }
            accent="muted"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Main Content (Left 2 cols) ── */}
        <div className="lg:col-span-2 space-y-6">
          {/* Line Items */}
          <div className="bg-white dark:bg-gray-800 border rounded-lg overflow-hidden">
            <div className="px-6 py-4 border-b">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Package className="h-5 w-5" />
                Line Items
                <span className="text-sm font-normal text-muted-foreground">({order.items.length})</span>
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-6 py-3 font-medium">Product</th>
                    <th className="text-left px-3 py-3 font-medium">SKU</th>
                    <th className="text-center px-3 py-3 font-medium">Qty</th>
                    <th className="text-right px-3 py-3 font-medium">Price</th>
                    <th className="text-right px-3 py-3 font-medium">Cost</th>
                    <th className="text-right px-3 py-3 font-medium">Profit</th>
                    <th className="text-right px-6 py-3 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {order.items.map((item) => {
                    const skuPrefix = item.sku ? item.sku.split("-")[0] : null;
                    return (
                      <tr key={item.id} className="hover:bg-muted/30">
                        <td className="px-6 py-3">
                          {skuPrefix ? (
                            <Link href={`/catalog/${skuPrefix}`} className="font-medium hover:underline">
                              {item.productName}
                            </Link>
                          ) : (
                            <span className="font-medium">{item.productName}</span>
                          )}
                          {item.colorName && <p className="text-muted-foreground text-xs">{item.colorName}</p>}
                        </td>
                        <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                          {item.sku ? (
                            skuPrefix ? (
                              <Link href={`/catalog/${skuPrefix}`} className="hover:underline hover:text-foreground">
                                {item.sku}
                              </Link>
                            ) : item.sku
                          ) : "—"}
                        </td>
                        <td className="px-3 py-3 text-center">{item.quantity}</td>
                        <td className="px-3 py-3 text-right">${item.unitPrice.toFixed(2)}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">
                          {item.unitCost != null ? `$${item.unitCost.toFixed(2)}` : "—"}
                        </td>
                        <td className={`px-3 py-3 text-right font-medium ${item.lineProfit != null ? (item.lineProfit >= 0 ? "text-green-600" : "text-red-600") : "text-muted-foreground"}`}>
                          {item.lineProfit != null ? `$${item.lineProfit.toFixed(2)}` : "—"}
                        </td>
                        <td className="px-6 py-3 text-right font-medium">${item.totalPrice.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="border-t px-6 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
              <div className="space-y-1.5">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>${order.subtotal.toFixed(2)}</span></div>
                {order.discount > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="text-red-600">-${order.discount.toFixed(2)}</span></div>}
                {order.shipping > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Shipping</span><span>${order.shipping.toFixed(2)}</span></div>}
                {order.tax > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span>${order.tax.toFixed(2)}</span></div>}
                <div className="flex justify-between font-bold text-base border-t pt-2">
                  <span>Total</span>
                  <span>${order.total.toFixed(2)}</span>
                </div>
              </div>
              {order.profit && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-muted-foreground">
                    <span>COGS{!order.profit.hasFullCostData && <span title="Some line items have no cost on file" className="ml-1 text-yellow-600">*</span>}</span>
                    <span>{order.profit.totalCost != null ? `$${order.profit.totalCost.toFixed(2)}` : "—"}</span>
                  </div>
                  <div className="flex justify-between font-semibold text-base border-t pt-2">
                    <span>Gross Profit</span>
                    <span className={order.profit.grossProfit != null ? (order.profit.grossProfit >= 0 ? "text-green-600" : "text-red-600") : ""}>
                      {order.profit.grossProfit != null ? `$${order.profit.grossProfit.toFixed(2)}` : "—"}
                      {order.profit.grossMargin != null && (
                        <span className="text-muted-foreground font-normal ml-2">
                          ({(order.profit.grossMargin * 100).toFixed(1)}%)
                        </span>
                      )}
                    </span>
                  </div>
                  {!order.profit.hasFullCostData && (
                    <p className="text-xs text-yellow-700 dark:text-yellow-500">
                      * Some line items have no cost — add SKU costs in the catalog for full profit.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Fulfillment — read-only.
              Status changes happen in Shopify / ShipHero and sync down via
              webhooks or Sync Shopify on /orders. */}
          {hasFulfillmentBlock && (
            <div className="bg-white dark:bg-gray-800 border rounded-lg p-6 space-y-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Truck className="h-5 w-5" />
                Fulfillment
              </h2>

              {/* Top-level tracking from order record */}
              {(order.trackingNumber || order.shippedAt || order.deliveredAt) && (
                <div className="bg-muted/30 rounded-lg p-4 text-sm grid grid-cols-2 gap-3">
                  {order.trackingCarrier && (
                    <div>
                      <p className="text-muted-foreground">Carrier</p>
                      <p className="font-medium">{order.trackingCarrier}</p>
                    </div>
                  )}
                  {order.trackingNumber && (
                    <div>
                      <p className="text-muted-foreground">Tracking #</p>
                      <p className="font-medium font-mono">{order.trackingNumber}</p>
                    </div>
                  )}
                  {order.shippedAt && (
                    <div>
                      <p className="text-muted-foreground">Shipped</p>
                      <p className="font-medium">{new Date(order.shippedAt).toLocaleDateString()}</p>
                    </div>
                  )}
                  {order.deliveredAt && (
                    <div>
                      <p className="text-muted-foreground">Delivered</p>
                      <p className="font-medium">{new Date(order.deliveredAt).toLocaleDateString()}</p>
                    </div>
                  )}
                </div>
              )}

              {/* ShipHero shipments */}
              {order.shipments?.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground mb-2">ShipHero Shipments</h3>
                  <div className="border rounded-lg divide-y">
                    {order.shipments.map((s, i) => (
                      <div key={s.shiphero_shipment_id || i} className="p-3 text-sm flex items-center justify-between gap-3 flex-wrap">
                        <div>
                          <p className="font-medium">
                            {s.shipping_method_label || s.shipping_method || "Shipment"}
                          </p>
                          {s.tracking_number && (
                            <p className="font-mono text-xs text-muted-foreground">
                              {s.tracking_carrier ? `${s.tracking_carrier} · ` : ""}{s.tracking_number}
                            </p>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground text-right">
                          {s.shipped_off_warehouse_at && <p>Shipped {new Date(s.shipped_off_warehouse_at).toLocaleDateString()}</p>}
                          {s.delivered_at && <p>Delivered {new Date(s.delivered_at).toLocaleDateString()}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Fulfillment costs */}
              {order.fulfillmentCosts?.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground mb-2">Fulfillment Costs</h3>
                  <div className="border rounded-lg divide-y">
                    {order.fulfillmentCosts.map((c, i) => (
                      <div key={i} className="p-3 text-sm flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">{c.description || "Fulfillment charge"}</p>
                          {c.invoice_date && (
                            <p className="text-xs text-muted-foreground">{new Date(c.invoice_date).toLocaleDateString()}</p>
                          )}
                        </div>
                        <span className="font-mono">
                          {c.amount != null ? `${c.currency || "$"}${Number(c.amount).toFixed(2)}` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Fulfillment is managed in {order.shipheroUrl ? "ShipHero" : order.channel === "faire" ? "Faire" : "Shopify"}
                {" "}— the-frame syncs status updates automatically.
              </p>
            </div>
          )}

          {/* Returns */}
          <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <RotateCcw className="h-5 w-5" />
                Returns
                {order.returns.length > 0 && (
                  <span className="text-sm font-normal text-muted-foreground">({order.returns.length})</span>
                )}
              </h2>
              {canReturn && !showReturnForm && (
                <button
                  onClick={() => setShowReturnForm(true)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm hover:bg-muted"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Create Return
                </button>
              )}
            </div>

            {order.returns.length > 0 ? (
              <div className="space-y-3 mb-4">
                {order.returns.map((ret) => (
                  <div key={ret.id} className="border rounded-lg p-4 text-sm space-y-2">
                    <div className="flex items-center justify-between">
                      <StatusBadge status={ret.status} />
                      <span className="text-muted-foreground">{new Date(ret.createdAt).toLocaleDateString()}</span>
                    </div>
                    {ret.reason && <p><span className="text-muted-foreground">Reason:</span> {ret.reason}</p>}
                    {ret.refundAmount != null && <p><span className="text-muted-foreground">Refund:</span> <span className="font-medium">${ret.refundAmount.toFixed(2)}</span></p>}
                    {ret.items && ret.items.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        {ret.items.length} item{ret.items.length > 1 ? "s" : ""} returned
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : !showReturnForm ? (
              <p className="text-sm text-muted-foreground">No returns for this order.</p>
            ) : null}

            {showReturnForm && (
              <div className="border rounded-lg p-4 space-y-4">
                <h3 className="font-medium">New Return</h3>
                <div>
                  <label className="block text-sm font-medium mb-1">Reason</label>
                  <select value={returnReason} onChange={(e) => setReturnReason(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm">
                    <option value="">Select reason...</option>
                    {returnReasons.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Items to Return</label>
                  <div className="space-y-2">
                    {order.items.map((item) => (
                      <div key={item.id} className="flex items-center justify-between border rounded p-3">
                        <div>
                          <p className="text-sm font-medium">{item.productName}</p>
                          {item.colorName && <p className="text-xs text-muted-foreground">{item.colorName}</p>}
                          <p className="text-xs text-muted-foreground">Ordered: {item.quantity}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-muted-foreground">Return qty:</label>
                          <input
                            type="number"
                            min={0}
                            max={item.quantity}
                            value={returnItems[item.id] || 0}
                            onChange={(e) => setReturnItems({ ...returnItems, [item.id]: parseInt(e.target.value) || 0 })}
                            className="w-16 px-2 py-1 border rounded text-sm text-center"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={submitReturn}
                    disabled={submittingReturn || !returnReason || Object.values(returnItems).every((q) => q === 0)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                  >
                    {submittingReturn ? "Submitting..." : "Submit Return"}
                  </button>
                  <button onClick={() => { setShowReturnForm(false); setReturnItems({}); setReturnReason(""); }} className="px-4 py-2 border rounded-lg text-sm hover:bg-muted">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Sidebar (Right col) ── */}
        <div className="space-y-6">
          {/* Status Timeline (compact) */}
          <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
            <h2 className="text-base font-semibold mb-3">Status</h2>
            <ol className="relative border-l border-gray-200 dark:border-gray-700 ml-2.5">
              {statusPipeline.map((s, i) => {
                const reached = statusPipeline.indexOf(order.status) >= i;
                const isCurrent = order.status === s;
                const isLast = i === statusPipeline.length - 1;
                return (
                  <li key={s} className={`ml-5 ${isLast ? "" : "mb-3"}`}>
                    <span className={`absolute flex items-center justify-center w-5 h-5 rounded-full -left-2.5 ring-4 ring-white dark:ring-gray-800 ${
                      isCurrent ? "bg-primary text-primary-foreground" : reached ? "bg-green-500 text-white" : "bg-gray-200 dark:bg-gray-600"
                    }`}>
                      {reached && !isCurrent ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <span className="text-[10px] font-bold">{i + 1}</span>
                      )}
                    </span>
                    <p className={`text-xs font-medium ${isCurrent ? "text-foreground" : reached ? "text-green-600" : "text-muted-foreground"}`}>
                      {statusConfig[s]?.label || s}
                    </p>
                    {s === "shipped" && order.shippedAt && (
                      <time className="text-[11px] text-muted-foreground">{new Date(order.shippedAt).toLocaleDateString()}</time>
                    )}
                    {s === "delivered" && order.deliveredAt && (
                      <time className="text-[11px] text-muted-foreground">{new Date(order.deliveredAt).toLocaleDateString()}</time>
                    )}
                    {s === "pending" && order.placedAt && (
                      <time className="text-[11px] text-muted-foreground">{new Date(order.placedAt).toLocaleDateString()}</time>
                    )}
                  </li>
                );
              })}
              {["cancelled", "returned"].includes(order.status) && (
                <li className="ml-5">
                  <span className="absolute flex items-center justify-center w-5 h-5 rounded-full -left-2.5 ring-4 ring-white dark:ring-gray-800 bg-red-500 text-white">
                    <XCircle className="h-3 w-3" />
                  </span>
                  <p className="text-xs font-medium text-red-600">{statusConfig[order.status]?.label}</p>
                </li>
              )}
            </ol>
          </div>

          {/* Customer */}
          <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
            <h2 className="text-base font-semibold mb-3">Customer</h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Company</p>
                  <p className="font-medium truncate">{order.company?.name || "—"}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <User className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Contact</p>
                  <p className="font-medium truncate">{order.contact?.name || "—"}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Mail className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="font-medium truncate">{order.contact?.email || "—"}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Faire details (channel-specific) */}
          {order.channel === "faire" && (
            <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
              <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
                <span className="text-green-600">●</span> Faire Details
              </h2>
              <div className="space-y-2 text-sm">
                {order.externalId && (
                  <div>
                    <p className="text-xs text-muted-foreground">Faire Order ID</p>
                    <p className="font-mono text-xs font-medium break-all">{order.externalId}</p>
                  </div>
                )}
                {order.notes?.includes("Net ") && (
                  <div>
                    <p className="text-xs text-muted-foreground">Payment Terms</p>
                    <p className="font-medium">{order.notes.match(/Net \d+/)?.[0]}</p>
                  </div>
                )}
                {order.notes?.includes("Prepaid") && !order.notes.includes("Net ") && (
                  <div>
                    <p className="text-xs text-muted-foreground">Payment Terms</p>
                    <p className="font-medium">Prepaid</p>
                  </div>
                )}
                {order.notes?.includes("Opening Order") && (
                  <div>
                    <p className="text-xs text-muted-foreground">Order Type</p>
                    <p className="font-medium">Opening Order</p>
                  </div>
                )}
                {order.notes?.includes("Ship by:") && (
                  <div>
                    <p className="text-xs text-muted-foreground">Ship By</p>
                    <p className="font-medium">{order.notes.match(/Ship by: (.+?)(?:\s*\||$)/)?.[1] || "—"}</p>
                  </div>
                )}
                {order.discount > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground">Faire Commission</p>
                    <p className="font-medium text-red-600">-${order.discount.toFixed(2)}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Notes */}
          {order.notes && (
            <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
              <h2 className="text-base font-semibold mb-2">Notes</h2>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{order.notes}</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Activity (full-width below grid) ── */}
      {order.timeline.length > 0 && (
        <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">Activity</h2>
          <ol className="relative border-l border-gray-200 dark:border-gray-700 ml-3">
            {order.timeline.map((event) => {
              const info = timelineLabel(event.eventType);
              const Icon = info.icon;
              const tracking = event.data?.trackingNumber;
              return (
                <li key={event.id} className="mb-4 ml-6 last:mb-0">
                  <span className={`absolute flex items-center justify-center w-5 h-5 rounded-full -left-2.5 ring-4 ring-white dark:ring-gray-800 bg-white dark:bg-gray-800 ${info.color}`}>
                    <Icon className="h-3 w-3" />
                  </span>
                  <p className="text-sm font-medium">{info.label}</p>
                  <time className="text-xs text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()}
                  </time>
                  {tracking != null && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Tracking: {String(tracking)}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
