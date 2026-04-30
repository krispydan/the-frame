"use client";

import { useEffect, useState, useCallback } from "react";
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
  Hash,
  User,
  Mail,
  Building2,
  CalendarDays,
  ExternalLink,
} from "lucide-react";

// ── Types ──

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
  trackingNumber: string | null;
  trackingCarrier: string | null;
  placedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string } | null;
  items: Array<{
    id: string;
    sku: string | null;
    productName: string;
    colorName: string | null;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
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

const carriers = ["UPS", "FedEx", "USPS", "DHL", "Other"];

const returnReasons = [
  "Defective / Damaged",
  "Wrong item received",
  "Customer changed mind",
  "Does not fit",
  "Not as described",
  "Other",
];

const nextStatus: Record<string, string> = {
  pending: "confirmed",
  confirmed: "picking",
  picking: "packed",
  packed: "shipped",
  shipped: "delivered",
};

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

// ── Page ──

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { setOverride } = useBreadcrumbOverride();
  const [orderId, setOrderId] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fulfillment state
  const [showShipForm, setShowShipForm] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingCarrier, setTrackingCarrier] = useState("");
  const [updating, setUpdating] = useState(false);

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
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { fetchOrder(); }, [fetchOrder]);
  useEffect(() => {
    if (order) setOverride(order.orderNumber);
    return () => setOverride(null);
  }, [order, setOverride]);

  const updateStatus = async (status: string, extra?: Record<string, string>) => {
    if (!order) return;
    setUpdating(true);
    await fetch(`/api/v1/orders/${order.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, ...extra }),
    });
    setShowShipForm(false);
    setTrackingNumber("");
    setTrackingCarrier("");
    await fetchOrder();
    setUpdating(false);
  };

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
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-64 bg-muted rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="p-6">
        <button onClick={() => router.push("/orders")} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to Orders
        </button>
        <div className="text-center py-12">
          <p className="text-lg text-muted-foreground">{error || "Order not found"}</p>
        </div>
      </div>
    );
  }

  const canAdvance = !!nextStatus[order.status];
  const canReturn = ["delivered", "shipped"].includes(order.status);
  const canCancel = !["cancelled", "delivered", "returned"].includes(order.status);

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Back nav */}
      <button onClick={() => router.push("/orders")} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Orders
      </button>

      {/* ── Order Header ── */}
      <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{order.orderNumber}</h1>
              <StatusBadge status={order.status} size="lg" />
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-muted-foreground">
              <ChannelBadge channel={order.channel} />
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3.5 w-3.5" />
                {order.placedAt ? new Date(order.placedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
              </span>
              {order.externalId && order.externalUrl && (
                <a
                  href={order.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-background hover:bg-muted text-xs font-medium"
                >
                  <ExternalLink className="h-3 w-3" />
                  {order.channel === "faire" ? "View in Faire" : "View in Shopify"}
                </a>
              )}
              {order.externalId && !order.externalUrl && (
                <span className="inline-flex items-center gap-1 font-mono text-xs">
                  <ExternalLink className="h-3 w-3" />
                  {order.externalId}
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold">${order.total.toFixed(2)}</p>
            <p className="text-sm text-muted-foreground">{order.currency}</p>
          </div>
        </div>

        {/* Customer info */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6 pt-4 border-t text-sm">
          <div className="flex items-start gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-muted-foreground">Company</p>
              <p className="font-medium">{order.company?.name || "—"}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <User className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-muted-foreground">Contact</p>
              <p className="font-medium">{order.contact?.name || "—"}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Mail className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div>
              <p className="text-muted-foreground">Email</p>
              <p className="font-medium">{order.contact?.email || "—"}</p>
            </div>
          </div>
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
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-6 py-3 font-medium">Product</th>
                  <th className="text-left px-4 py-3 font-medium">SKU</th>
                  <th className="text-center px-4 py-3 font-medium">Qty</th>
                  <th className="text-right px-4 py-3 font-medium">Unit Price</th>
                  <th className="text-right px-6 py-3 font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {order.items.map((item) => (
                  <tr key={item.id} className="hover:bg-muted/30">
                    <td className="px-6 py-3">
                      <p className="font-medium">{item.productName}</p>
                      {item.colorName && <p className="text-muted-foreground text-xs">{item.colorName}</p>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{item.sku || "—"}</td>
                    <td className="px-4 py-3 text-center">{item.quantity}</td>
                    <td className="px-4 py-3 text-right">${item.unitPrice.toFixed(2)}</td>
                    <td className="px-6 py-3 text-right font-medium">${item.totalPrice.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div className="border-t px-6 py-4 space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>${order.subtotal.toFixed(2)}</span></div>
              {order.discount > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="text-red-600">-${order.discount.toFixed(2)}</span></div>}
              {order.shipping > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Shipping</span><span>${order.shipping.toFixed(2)}</span></div>}
              {order.tax > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span>${order.tax.toFixed(2)}</span></div>}
              <div className="flex justify-between font-bold text-base border-t pt-2">
                <span>Total</span>
                <span>${order.total.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Fulfillment Section — read-only.
              Status changes happen in Shopify / ShipHero and sync down via
              webhooks or the Sync Shopify button on /orders. */}
          {(order.trackingNumber || order.shippedAt || order.deliveredAt) && (
            <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
              <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                <Truck className="h-5 w-5" />
                Fulfillment
              </h2>

              <div className="bg-muted/30 rounded-lg p-4 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  {order.trackingCarrier && (
                    <div>
                      <p className="text-muted-foreground">Carrier</p>
                      <p className="font-medium">{order.trackingCarrier}</p>
                    </div>
                  )}
                  {order.trackingNumber && (
                    <div>
                      <p className="text-muted-foreground">Tracking Number</p>
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
              </div>

              {order.externalUrl && (
                <p className="text-xs text-muted-foreground mt-3">
                  Manage fulfillment in <a href={order.externalUrl} target="_blank" rel="noopener noreferrer" className="underline">{order.channel === "faire" ? "Faire" : "Shopify"}</a> — the-frame syncs status updates automatically.
                </p>
              )}
            </div>
          )}

          {/* Returns Section */}
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

            {/* Existing returns */}
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

            {/* Create return form */}
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
          {/* Status Timeline */}
          <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Status</h2>
            <ol className="relative border-l border-gray-200 dark:border-gray-700 ml-3">
              {statusPipeline.map((s, i) => {
                const reached = statusPipeline.indexOf(order.status) >= i;
                const isCurrent = order.status === s;
                return (
                  <li key={s} className="mb-6 ml-6 last:mb-0">
                    <span className={`absolute flex items-center justify-center w-6 h-6 rounded-full -left-3 ring-4 ring-white dark:ring-gray-800 ${
                      isCurrent ? "bg-primary text-primary-foreground" : reached ? "bg-green-500 text-white" : "bg-gray-200 dark:bg-gray-600"
                    }`}>
                      {reached && !isCurrent ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <span className="text-xs font-bold">{i + 1}</span>
                      )}
                    </span>
                    <h3 className={`text-sm font-medium ${isCurrent ? "text-foreground" : reached ? "text-green-600" : "text-muted-foreground"}`}>
                      {statusConfig[s]?.label || s}
                    </h3>
                    {s === "shipped" && order.shippedAt && (
                      <time className="text-xs text-muted-foreground">{new Date(order.shippedAt).toLocaleDateString()}</time>
                    )}
                    {s === "delivered" && order.deliveredAt && (
                      <time className="text-xs text-muted-foreground">{new Date(order.deliveredAt).toLocaleDateString()}</time>
                    )}
                    {s === "pending" && order.placedAt && (
                      <time className="text-xs text-muted-foreground">{new Date(order.placedAt).toLocaleDateString()}</time>
                    )}
                  </li>
                );
              })}
              {["cancelled", "returned"].includes(order.status) && (
                <li className="mb-0 ml-6">
                  <span className="absolute flex items-center justify-center w-6 h-6 rounded-full -left-3 ring-4 ring-white dark:ring-gray-800 bg-red-500 text-white">
                    <XCircle className="h-3.5 w-3.5" />
                  </span>
                  <h3 className="text-sm font-medium text-red-600">{statusConfig[order.status]?.label}</h3>
                </li>
              )}
            </ol>
          </div>

          {/* Faire Details */}
          {order.channel === "faire" && (
            <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <span className="text-green-600">●</span> Faire Details
              </h2>
              <div className="space-y-3 text-sm">
                {order.externalId && (
                  <div>
                    <p className="text-muted-foreground">Faire Order ID</p>
                    <p className="font-mono text-xs font-medium">{order.externalId}</p>
                  </div>
                )}
                {order.notes && (
                  <>
                    {order.notes.includes("Net ") && (
                      <div>
                        <p className="text-muted-foreground">Payment Terms</p>
                        <p className="font-medium">
                          {order.notes.match(/Net \d+/)?.[0] || (order.notes.includes("Prepaid") ? "Prepaid" : "—")}
                        </p>
                      </div>
                    )}
                    {order.notes.includes("Prepaid") && !order.notes.includes("Net ") && (
                      <div>
                        <p className="text-muted-foreground">Payment Terms</p>
                        <p className="font-medium">Prepaid</p>
                      </div>
                    )}
                    {order.notes.includes("Opening Order") && (
                      <div>
                        <p className="text-muted-foreground">Order Type</p>
                        <p className="font-medium">🆕 Opening Order</p>
                      </div>
                    )}
                    {order.notes.includes("Ship by:") && (
                      <div>
                        <p className="text-muted-foreground">Ship By</p>
                        <p className="font-medium">{order.notes.match(/Ship by: (.+?)(?:\s*\||$)/)?.[1] || "—"}</p>
                      </div>
                    )}
                  </>
                )}
                {order.discount > 0 && (
                  <div>
                    <p className="text-muted-foreground">Faire Commission</p>
                    <p className="font-medium text-red-600">-${order.discount.toFixed(2)}</p>
                  </div>
                )}
                <div className="pt-2 border-t">
                  <a
                    href={`https://www.faire.com/brand-portal/orders/${order.externalId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> View on Faire
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Notes */}
          {order.notes && (
            <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
              <h2 className="text-lg font-semibold mb-2">Notes</h2>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{order.notes}</p>
            </div>
          )}

          {/* Activity Timeline */}
          {order.timeline.length > 0 && (
            <div className="bg-white dark:bg-gray-800 border rounded-lg p-6">
              <h2 className="text-lg font-semibold mb-4">Activity</h2>
              <ol className="relative border-l border-gray-200 dark:border-gray-700 ml-3">
                {order.timeline.map((event) => {
                  const info = timelineLabel(event.eventType);
                  const Icon = info.icon;
                  return (
                    <li key={event.id} className="mb-4 ml-6 last:mb-0">
                      <span className={`absolute flex items-center justify-center w-5 h-5 rounded-full -left-2.5 ring-4 ring-white dark:ring-gray-800 bg-white dark:bg-gray-800 ${info.color}`}>
                        <Icon className="h-3 w-3" />
                      </span>
                      <p className="text-sm font-medium">{info.label}</p>
                      <time className="text-xs text-muted-foreground">
                        {new Date(event.createdAt).toLocaleString()}
                      </time>
                      {event.data?.trackingNumber && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Tracking: {String(event.data.trackingNumber)}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
