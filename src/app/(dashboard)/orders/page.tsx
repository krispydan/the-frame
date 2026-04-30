"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ListFilter,
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  ShoppingCart,
  X,
  Package,
  Truck,
  CheckCircle2,
  XCircle,
  ArrowUpDown,
  RefreshCw,
} from "lucide-react";
// CreateOrderDialog removed — orders are created in Shopify/Faire and synced here

// ── Types ──

interface Order {
  id: string;
  orderNumber: string;
  companyId: string | null;
  companyName: string | null;
  channel: string;
  status: string;
  subtotal: number;
  total: number;
  itemCount: number;
  placedAt: string;
  shippedAt: string | null;
  externalId: string | null;
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
    createdAt: string;
  }>;
  timeline: Array<{
    id: string;
    eventType: string;
    data: Record<string, unknown>;
    createdAt: string;
  }>;
}

// ── Channel Badge ──

const channelConfig: Record<string, { label: string; color: string }> = {
  shopify_dtc: { label: "Shopify DTC", color: "bg-blue-100 text-blue-800" },
  shopify_wholesale: { label: "Shopify Wholesale", color: "bg-blue-100 text-blue-700" },
  faire: { label: "Faire", color: "bg-green-100 text-green-800" },
  amazon: { label: "Amazon", color: "bg-yellow-100 text-yellow-800" },
  direct: { label: "Direct", color: "bg-gray-100 text-gray-700" },
  phone: { label: "Phone", color: "bg-orange-100 text-orange-800" },
};

function ChannelBadge({ channel }: { channel: string }) {
  const cfg = channelConfig[channel] || { label: channel, color: "bg-gray-100 text-gray-600" };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>{cfg.label}</span>;
}

// ── Status Badge ──

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

function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] || { label: status, color: "bg-gray-100 text-gray-600", icon: ShoppingCart };
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

// ── Page ──

export default function OrdersPageWrapper() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-400">Loading orders...</div>}>
      <OrdersPage />
    </Suspense>
  );
}

function OrdersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // showCreateDialog removed — orders are created in Shopify/Faire only
  const [syncingFaire, setSyncingFaire] = useState(false);
  const [syncingShopify, setSyncingShopify] = useState(false);

  // Filters
  const page = parseInt(searchParams.get("page") || "1");
  const search = searchParams.get("search") || "";
  const channelFilter = searchParams.get("channel") || "";
  const statusFilter = searchParams.get("status") || "";
  const dateFrom = searchParams.get("date_from") || "";
  const dateTo = searchParams.get("date_to") || "";

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", "25");
    if (search) params.set("search", search);
    if (channelFilter) params.set("channel", channelFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);

    const res = await fetch(`/api/v1/orders?${params}`);
    const data = await res.json();
    setOrders(data.data || []);
    setTotal(data.total || 0);
    setTotalPages(data.totalPages || 0);
    setLoading(false);
  }, [page, search, channelFilter, statusFilter, dateFrom, dateTo]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  const updateParams = (updates: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v); else params.delete(k);
    }
    if (!updates.page) params.set("page", "1");
    router.push(`/orders?${params}`);
  };

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    const res = await fetch(`/api/v1/orders/${id}`);
    const data = await res.json();
    setSelectedOrder(data);
    setDetailLoading(false);
  };

  const updateOrderStatus = async (id: string, status: string, extra?: Record<string, string>) => {
    await fetch(`/api/v1/orders/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, ...extra }),
    });
    openDetail(id);
    fetchOrders();
  };

  const nextStatus: Record<string, string> = {
    pending: "confirmed",
    confirmed: "picking",
    picking: "packed",
    packed: "shipped",
    shipped: "delivered",
  };

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Orders</h1>
          <p className="text-sm text-muted-foreground">{total} orders total</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setSyncingShopify(true);
              try {
                const res = await fetch("/api/v1/orders/shopify-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
                const data = await res.json();
                if (data.ok) {
                  alert(data.message);
                  fetchOrders();
                } else {
                  alert(`Shopify sync error: ${data.error || "Unknown error"}`);
                }
              } catch (e) {
                alert("Shopify sync failed");
              } finally {
                setSyncingShopify(false);
              }
            }}
            disabled={syncingShopify}
            className="inline-flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${syncingShopify ? "animate-spin" : ""}`} />
            {syncingShopify ? "Syncing..." : "Sync Shopify"}
          </button>
          <button
            onClick={async () => {
              setSyncingFaire(true);
              try {
                const res = await fetch("/api/v1/orders/faire-sync", { method: "POST" });
                const data = await res.json();
                if (data.ok) {
                  alert(`${data.message}`);
                  fetchOrders();
                } else {
                  alert(`Faire sync error: ${data.error || "Unknown error"}`);
                }
              } catch (e) {
                alert("Faire sync failed");
              } finally {
                setSyncingFaire(false);
              }
            }}
            disabled={syncingFaire}
            className="inline-flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${syncingFaire ? "animate-spin" : ""}`} />
            {syncingFaire ? "Syncing..." : "Sync Faire"}
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by order # or customer..."
            defaultValue={search}
            onKeyDown={(e) => e.key === "Enter" && updateParams({ search: (e.target as HTMLInputElement).value })}
            className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm"
          />
        </div>

        <button onClick={() => setShowFilters(!showFilters)} className="inline-flex items-center gap-2 px-3 py-2 border rounded-lg text-sm hover:bg-muted">
          <ListFilter className="h-4 w-4" />
          Filters
        </button>
      </div>

      {/* Filter Bar */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-3 p-3 bg-muted/50 rounded-lg">
          <select value={channelFilter} onChange={(e) => updateParams({ channel: e.target.value })} className="px-3 py-1.5 border rounded text-sm">
            <option value="">All Channels</option>
            {Object.entries(channelConfig).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => updateParams({ status: e.target.value })} className="px-3 py-1.5 border rounded text-sm">
            <option value="">All Statuses</option>
            {Object.keys(statusConfig).map((s) => <option key={s} value={s}>{statusConfig[s].label}</option>)}
          </select>
          <input type="date" value={dateFrom} onChange={(e) => updateParams({ date_from: e.target.value })} className="px-3 py-1.5 border rounded text-sm" placeholder="From" />
          <input type="date" value={dateTo} onChange={(e) => updateParams({ date_to: e.target.value })} className="px-3 py-1.5 border rounded text-sm" placeholder="To" />
          {(channelFilter || statusFilter || dateFrom || dateTo) && (
            <button onClick={() => updateParams({ channel: "", status: "", date_from: "", date_to: "" })} className="text-sm text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Order #</th>
              <th className="text-left px-4 py-3 font-medium">Customer</th>
              <th className="text-left px-4 py-3 font-medium">Channel</th>
              <th className="text-center px-4 py-3 font-medium">Items</th>
              <th className="text-right px-4 py-3 font-medium">Total</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center">
                <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                <p className="text-sm text-muted-foreground mt-2">Loading orders...</p>
              </td></tr>
            ) : orders.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-16 text-center">
                <ShoppingCart className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
                <p className="font-medium text-muted-foreground">No orders yet</p>
                <p className="text-sm text-muted-foreground/70 mt-1">Sync from Shopify or Faire to pull orders into the-frame.</p>
              </td></tr>
            ) : (
              orders.map((o) => (
                <tr key={o.id} onClick={() => router.push(`/orders/${o.id}`)} className="hover:bg-muted/30 cursor-pointer">
                  <td className="px-4 py-3 font-medium">{o.orderNumber}</td>
                  <td className="px-4 py-3 text-muted-foreground">{o.companyName || "—"}</td>
                  <td className="px-4 py-3"><ChannelBadge channel={o.channel} /></td>
                  <td className="px-4 py-3 text-center">{o.itemCount}</td>
                  <td className="px-4 py-3 text-right font-medium">${o.total.toFixed(2)}</td>
                  <td className="px-4 py-3"><StatusBadge status={o.status} /></td>
                  <td className="px-4 py-3 text-muted-foreground">{o.placedAt ? new Date(o.placedAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => updateParams({ page: String(page - 1) })} className="px-3 py-1.5 border rounded text-sm disabled:opacity-50">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button disabled={page >= totalPages} onClick={() => updateParams({ page: String(page + 1) })} className="px-3 py-1.5 border rounded text-sm disabled:opacity-50">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Order Detail Slide-over */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSelectedOrder(null)} />
          <div className="relative w-full max-w-2xl bg-background shadow-xl overflow-y-auto">
            <div className="p-6 space-y-6">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold">{selectedOrder.orderNumber}</h2>
                  <div className="flex items-center gap-2 mt-1">
                    <ChannelBadge channel={selectedOrder.channel} />
                    <StatusBadge status={selectedOrder.status} />
                  </div>
                </div>
                <button onClick={() => setSelectedOrder(null)} className="p-2 hover:bg-muted rounded">
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Info */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Customer</p>
                  <p className="font-medium">{selectedOrder.company?.name || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Contact</p>
                  <p className="font-medium">{selectedOrder.contact?.name || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Placed</p>
                  <p className="font-medium">{selectedOrder.placedAt ? new Date(selectedOrder.placedAt).toLocaleString() : "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">External ID</p>
                  <p className="font-medium font-mono text-xs">{selectedOrder.externalId || "—"}</p>
                </div>
                {selectedOrder.trackingNumber && (
                  <div className="col-span-2">
                    <p className="text-muted-foreground">Tracking</p>
                    <p className="font-medium">{selectedOrder.trackingCarrier}: {selectedOrder.trackingNumber}</p>
                  </div>
                )}
              </div>

              {/* Line Items */}
              <div>
                <h3 className="font-semibold mb-2">Line Items</h3>
                <table className="w-full text-sm border rounded">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-3 py-2">Product</th>
                      <th className="text-left px-3 py-2">SKU</th>
                      <th className="text-center px-3 py-2">Qty</th>
                      <th className="text-right px-3 py-2">Price</th>
                      <th className="text-right px-3 py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {selectedOrder.items.map((item) => (
                      <tr key={item.id}>
                        <td className="px-3 py-2">
                          {item.productName}
                          {item.colorName && <span className="text-muted-foreground ml-1">/ {item.colorName}</span>}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{item.sku || "—"}</td>
                        <td className="px-3 py-2 text-center">{item.quantity}</td>
                        <td className="px-3 py-2 text-right">${item.unitPrice.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right font-medium">${item.totalPrice.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="border-t pt-4 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>${selectedOrder.subtotal.toFixed(2)}</span></div>
                {selectedOrder.discount > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="text-red-600">-${selectedOrder.discount.toFixed(2)}</span></div>}
                {selectedOrder.shipping > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Shipping</span><span>${selectedOrder.shipping.toFixed(2)}</span></div>}
                {selectedOrder.tax > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span>${selectedOrder.tax.toFixed(2)}</span></div>}
                <div className="flex justify-between font-bold text-base border-t pt-2"><span>Total</span><span>${selectedOrder.total.toFixed(2)}</span></div>
              </div>

              {/* Notes */}
              {selectedOrder.notes && (
                <div>
                  <h3 className="font-semibold mb-1">Notes</h3>
                  <p className="text-sm text-muted-foreground bg-muted/30 p-3 rounded">{selectedOrder.notes}</p>
                </div>
              )}

              {/* Actions */}
              {nextStatus[selectedOrder.status] && (
                <div className="flex gap-2">
                  {selectedOrder.status === "packed" ? (
                    <TrackingPrompt
                      onSubmit={(tracking, carrier) => updateOrderStatus(selectedOrder.id, "shipped", { trackingNumber: tracking, trackingCarrier: carrier })}
                    />
                  ) : (
                    <button
                      onClick={() => updateOrderStatus(selectedOrder.id, nextStatus[selectedOrder.status])}
                      className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90"
                    >
                      Mark as {statusConfig[nextStatus[selectedOrder.status]]?.label}
                    </button>
                  )}
                  {selectedOrder.status !== "cancelled" && (
                    <button
                      onClick={() => updateOrderStatus(selectedOrder.id, "cancelled")}
                      className="px-4 py-2 border border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}

              {/* Returns */}
              {selectedOrder.returns.length > 0 && (
                <div>
                  <h3 className="font-semibold mb-2">Returns</h3>
                  {selectedOrder.returns.map((ret) => (
                    <div key={ret.id} className="border rounded p-3 text-sm space-y-1">
                      <div className="flex justify-between">
                        <StatusBadge status={ret.status} />
                        <span className="text-muted-foreground">{new Date(ret.createdAt).toLocaleDateString()}</span>
                      </div>
                      {ret.reason && <p>{ret.reason}</p>}
                      {ret.refundAmount && <p className="font-medium">Refund: ${ret.refundAmount.toFixed(2)}</p>}
                    </div>
                  ))}
                </div>
              )}

              {/* Timeline */}
              {selectedOrder.timeline.length > 0 && (
                <div>
                  <h3 className="font-semibold mb-2">Activity</h3>
                  <div className="space-y-2">
                    {selectedOrder.timeline.map((event) => (
                      <div key={event.id} className="flex items-start gap-2 text-sm">
                        <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
                        <div>
                          <span className="font-medium">{event.eventType}</span>
                          <span className="text-muted-foreground ml-2">{new Date(event.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tracking Number Prompt ──

function TrackingPrompt({ onSubmit }: { onSubmit: (tracking: string, carrier: string) => void }) {
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [show, setShow] = useState(false);

  if (!show) {
    return (
      <button onClick={() => setShow(true)} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90">
        Mark as Shipped
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Carrier" className="px-3 py-2 border rounded text-sm w-24" />
      <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Tracking #" className="px-3 py-2 border rounded text-sm flex-1" />
      <button onClick={() => onSubmit(tracking, carrier)} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium">
        Ship
      </button>
    </div>
  );
}
