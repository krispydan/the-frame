"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { X, Plus, Trash2, Search, Loader2 } from "lucide-react";

interface Company {
  id: string;
  name: string;
}

interface Product {
  id: string;
  name: string;
  skus: Array<{
    id: string;
    sku: string;
    color_name: string | null;
    wholesale_price: number;
  }>;
}

interface LineItem {
  key: string;
  productId?: string;
  skuId?: string;
  productName: string;
  sku: string;
  colorName: string;
  quantity: number;
  unitPrice: number;
}

const CHANNELS = [
  { value: "direct", label: "Direct" },
  { value: "phone", label: "Phone" },
  { value: "shopify_dtc", label: "Shopify DTC" },
  { value: "shopify_wholesale", label: "Shopify B2B" },
  { value: "faire", label: "Faire" },
];

const PAYMENT_TERMS = [
  { value: "", label: "None" },
  { value: "net_30", label: "Net 30" },
  { value: "net_60", label: "Net 60" },
  { value: "cod", label: "COD" },
  { value: "prepaid", label: "Prepaid" },
];

export function CreateOrderDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [channel, setChannel] = useState("direct");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Company search
  const [companySearch, setCompanySearch] = useState("");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);
  const [showCompanyDropdown, setShowCompanyDropdown] = useState(false);
  const companyRef = useRef<HTMLDivElement>(null);

  // Product search for adding items
  const [productSearch, setProductSearch] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [showProductDropdown, setShowProductDropdown] = useState(false);
  const productRef = useRef<HTMLDivElement>(null);

  // Search companies
  useEffect(() => {
    if (!companySearch || companySearch.length < 2) {
      setCompanies([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/search?q=${encodeURIComponent(companySearch)}&limit=10`);
        const data = await res.json();
        setCompanies(
          (data.results || [])
            .filter((r: any) => r.type === "prospect")
            .map((r: any) => ({ id: r.id, name: r.title }))
        );
      } catch {
        setCompanies([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [companySearch]);

  // Search products
  useEffect(() => {
    if (!productSearch || productSearch.length < 2) {
      setProducts([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/catalog/products?search=${encodeURIComponent(productSearch)}&limit=10`);
        const data = await res.json();
        const prods = data.data || data.products || data || [];
        // For each product, fetch SKUs
        const enriched: Product[] = [];
        for (const p of prods.slice(0, 8)) {
          try {
            const skuRes = await fetch(`/api/v1/catalog/products/${p.id}`);
            const skuData = await skuRes.json();
            enriched.push({
              id: p.id,
              name: p.name,
              skus: (skuData.skus || []).map((s: any) => ({
                id: s.id,
                sku: s.sku,
                color_name: s.colorName || s.color_name || null,
                wholesale_price: s.wholesalePrice || s.wholesale_price || 0,
              })),
            });
          } catch {
            enriched.push({ id: p.id, name: p.name, skus: [] });
          }
        }
        setProducts(enriched);
      } catch {
        setProducts([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [productSearch]);

  // Click outside to close dropdowns
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (companyRef.current && !companyRef.current.contains(e.target as Node)) setShowCompanyDropdown(false);
      if (productRef.current && !productRef.current.contains(e.target as Node)) setShowProductDropdown(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const addItem = (product: Product, sku: Product["skus"][0]) => {
    setItems((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        productId: product.id,
        skuId: sku.id,
        productName: product.name,
        sku: sku.sku,
        colorName: sku.color_name || "",
        quantity: 1,
        unitPrice: sku.wholesale_price,
      },
    ]);
    setProductSearch("");
    setShowProductDropdown(false);
  };

  const updateItem = (key: string, field: keyof LineItem, value: string | number) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, [field]: value } : i)));
  };

  const removeItem = (key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
  };

  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const total = subtotal;

  const handleSubmit = async () => {
    if (items.length === 0) {
      setError("Add at least one line item");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: selectedCompany?.id || undefined,
          channel,
          paymentTerms: paymentTerms || undefined,
          notes: notes || undefined,
          items: items.map((i) => ({
            productId: i.productId,
            skuId: i.skuId,
            productName: i.productName,
            sku: i.sku || undefined,
            colorName: i.colorName || undefined,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
          })),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create order");
      }
      onCreated();
      onClose();
      // Reset
      setItems([]);
      setSelectedCompany(null);
      setCompanySearch("");
      setChannel("direct");
      setPaymentTerms("");
      setNotes("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[5vh] overflow-y-auto">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-3xl bg-white rounded-xl shadow-2xl mb-10">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-bold">Create Order</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5 max-h-[75vh] overflow-y-auto">
          {/* Company Search */}
          <div ref={companyRef} className="relative">
            <label className="block text-sm font-medium text-gray-700 mb-1">Customer / Company</label>
            {selectedCompany ? (
              <div className="flex items-center gap-2 px-3 py-2 border rounded-lg bg-gray-50">
                <span className="font-medium">{selectedCompany.name}</span>
                <button onClick={() => { setSelectedCompany(null); setCompanySearch(""); }} className="ml-auto text-gray-400 hover:text-gray-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={companySearch}
                    onChange={(e) => { setCompanySearch(e.target.value); setShowCompanyDropdown(true); }}
                    onFocus={() => setShowCompanyDropdown(true)}
                    placeholder="Search companies..."
                    className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm"
                  />
                </div>
                {showCompanyDropdown && companies.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {companies.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => { setSelectedCompany(c); setShowCompanyDropdown(false); setCompanySearch(c.name); }}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50"
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Channel & Payment Terms */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Channel</label>
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm">
                {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Terms</label>
              <select value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm">
                {PAYMENT_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>

          {/* Line Items */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Line Items</label>

            {items.length > 0 && (
              <table className="w-full text-sm mb-3 border rounded-lg">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left px-3 py-2">Product</th>
                    <th className="text-left px-3 py-2">SKU</th>
                    <th className="text-center px-3 py-2 w-20">Qty</th>
                    <th className="text-right px-3 py-2 w-28">Price</th>
                    <th className="text-right px-3 py-2 w-28">Total</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item) => (
                    <tr key={item.key}>
                      <td className="px-3 py-2">
                        {item.productName}
                        {item.colorName && <span className="text-gray-400 ml-1">/ {item.colorName}</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{item.sku || "—"}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={1}
                          value={item.quantity}
                          onChange={(e) => updateItem(item.key, "quantity", parseInt(e.target.value) || 1)}
                          className="w-16 text-center border rounded px-2 py-1 text-sm"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={item.unitPrice}
                          onChange={(e) => updateItem(item.key, "unitPrice", parseFloat(e.target.value) || 0)}
                          className="w-24 text-right border rounded px-2 py-1 text-sm"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-medium">${(item.quantity * item.unitPrice).toFixed(2)}</td>
                      <td className="px-3 py-2">
                        <button onClick={() => removeItem(item.key)} className="text-red-400 hover:text-red-600">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Product Search to Add */}
            <div ref={productRef} className="relative">
              <div className="relative">
                <Plus className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  value={productSearch}
                  onChange={(e) => { setProductSearch(e.target.value); setShowProductDropdown(true); }}
                  onFocus={() => setShowProductDropdown(true)}
                  placeholder="Search products to add..."
                  className="w-full pl-10 pr-4 py-2 border border-dashed rounded-lg text-sm"
                />
              </div>
              {showProductDropdown && products.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-64 overflow-y-auto">
                  {products.map((p) => (
                    <div key={p.id}>
                      <div className="px-4 py-2 text-xs font-semibold text-gray-500 bg-gray-50">{p.name}</div>
                      {p.skus.length > 0 ? (
                        p.skus.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => addItem(p, s)}
                            className="w-full text-left px-6 py-2 text-sm hover:bg-blue-50 flex justify-between"
                          >
                            <span>
                              {s.sku}
                              {s.color_name && <span className="text-gray-400 ml-1">— {s.color_name}</span>}
                            </span>
                            <span className="text-gray-500">${s.wholesale_price.toFixed(2)}</span>
                          </button>
                        ))
                      ) : (
                        <button
                          onClick={() => addItem(p, { id: "", sku: "", color_name: null, wholesale_price: 0 })}
                          className="w-full text-left px-6 py-2 text-sm hover:bg-blue-50 text-gray-400"
                        >
                          No SKUs — add manually
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Totals */}
          {items.length > 0 && (
            <div className="border-t pt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Subtotal</span>
                <span className="font-medium">${subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-bold text-base border-t pt-2">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              placeholder="Order notes..."
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t bg-gray-50 rounded-b-xl">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-100">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || items.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Create Order
          </button>
        </div>
      </div>
    </div>
  );
}
