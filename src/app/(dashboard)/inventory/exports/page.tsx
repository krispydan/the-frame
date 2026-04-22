"use client";

import { useEffect, useState } from "react";
import { Download, AlertCircle, CheckCircle, Info, Truck, Factory } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type PreviewResponse = {
  rowCount: number;
  files?: number;
  warnings?: {
    skippedNoInnerPackSku?: string[];
    skippedNoUpc?: string[];
    skippedBadQty?: string[];
    deduped?: string[];
    skippedZeroQty?: string[];
    consolidatedDuplicates?: string[];
    missingEachUpc?: string[];
    missingInnerPackUpc?: string[];
    missingInnerPackSku?: string[];
    emitted?: number;
  };
  sample?: Record<string, string | number | null>[];
  poNumber?: string;
  vendor?: string;
};

type Po = {
  id: string;
  poNumber: string | null;
  vendor: string | null;
  orderDate: string | null;
  freightType: string | null;
  rowCount: number;
  unitCount: number;
};

function downloadFromResponse(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getFilenameFromHeaders(headers: Headers, fallback: string): string {
  const disp = headers.get("Content-Disposition") || "";
  const m = /filename="?([^";]+)"?/i.exec(disp);
  return m ? m[1] : fallback;
}

export default function InventoryExportsPage() {
  const [factory, setFactory] = useState<string>("all");
  const [scope, setScope] = useState<string>("new");
  const [preview, setPreview] = useState<Record<string, PreviewResponse | null>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  // PO tab state
  const [pos, setPos] = useState<Po[]>([]);
  const [selectedPoId, setSelectedPoId] = useState<string>("");
  const [pastedList, setPastedList] = useState<string>("");
  const [poNumber, setPoNumber] = useState<string>("");
  const [freightType, setFreightType] = useState<"air" | "ocean">("air");
  const [defaultPrice, setDefaultPrice] = useState<string>("");
  const [poPreview, setPoPreview] = useState<PreviewResponse | null>(null);

  // Factory sheet state
  const [factorySheetFactory, setFactorySheetFactory] = useState<string>("JX1");
  const [factorySheetSkus, setFactorySheetSkus] = useState<string>("");

  useEffect(() => {
    fetch("/api/v1/operations/purchase-orders")
      .then((r) => r.json())
      .then((d) => setPos(d.pos || []))
      .catch(() => {});
  }, []);

  async function loadPreview(key: string, url: string) {
    setLoading((l) => ({ ...l, [key]: true }));
    try {
      const res = await fetch(url);
      const data = await res.json();
      setPreview((p) => ({ ...p, [key]: data }));
    } finally {
      setLoading((l) => ({ ...l, [key]: false }));
    }
  }

  async function downloadCsv(key: string, url: string, fallbackName: string) {
    setLoading((l) => ({ ...l, [key]: true }));
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Export failed: ${err.error || res.statusText}`);
        return;
      }
      const blob = await res.blob();
      downloadFromResponse(blob, getFilenameFromHeaders(res.headers, fallbackName));
    } finally {
      setLoading((l) => ({ ...l, [key]: false }));
    }
  }

  function parsePastedList(text: string): { sku: string; quantity: number; unitPrice?: number | null }[] {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out: { sku: string; quantity: number; unitPrice?: number | null }[] = [];
    for (const line of lines) {
      const parts = line.split(/[\t,\s]+/).filter(Boolean);
      if (parts.length < 2) continue;
      const sku = parts[0];
      if (/^sku$/i.test(sku)) continue; // header
      const qty = Number(parts[1]);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const unitPrice = parts[2] != null ? Number(parts[2]) : null;
      out.push({ sku, quantity: qty, unitPrice: Number.isFinite(unitPrice as number) ? (unitPrice as number) : null });
    }
    return out;
  }

  async function previewPo() {
    const body: Record<string, unknown> = {
      freightType,
      defaultUnitPrice: defaultPrice === "" ? null : Number(defaultPrice),
    };
    if (poNumber.trim()) body.poNumber = poNumber.trim();

    if (selectedPoId) {
      body.purchaseOrderId = selectedPoId;
    } else {
      const lineItems = parsePastedList(pastedList);
      if (lineItems.length === 0) {
        alert("Paste a SKU + Qty list first.");
        return;
      }
      body.lineItems = lineItems;
    }
    setLoading((l) => ({ ...l, po: true }));
    try {
      const res = await fetch("/api/v1/operations/exports/shiphero/po?preview=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Preview failed: ${data.error || res.statusText}`);
        return;
      }
      setPoPreview(data);
    } finally {
      setLoading((l) => ({ ...l, po: false }));
    }
  }

  async function downloadPo() {
    const body: Record<string, unknown> = {
      freightType,
      defaultUnitPrice: defaultPrice === "" ? null : Number(defaultPrice),
    };
    if (poNumber.trim()) body.poNumber = poNumber.trim();
    if (selectedPoId) {
      body.purchaseOrderId = selectedPoId;
    } else {
      const lineItems = parsePastedList(pastedList);
      if (lineItems.length === 0) {
        alert("Paste a SKU + Qty list first.");
        return;
      }
      body.lineItems = lineItems;
    }

    setLoading((l) => ({ ...l, po: true }));
    try {
      const res = await fetch("/api/v1/operations/exports/shiphero/po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Export failed: ${err.error || res.statusText}`);
        return;
      }
      const blob = await res.blob();
      downloadFromResponse(blob, getFilenameFromHeaders(res.headers, "shiphero_po.csv"));
      // refresh PO list
      fetch("/api/v1/operations/purchase-orders")
        .then((r) => r.json())
        .then((d) => setPos(d.pos || []))
        .catch(() => {});
    } finally {
      setLoading((l) => ({ ...l, po: false }));
    }
  }

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Warehouse Exports</h1>
        <p className="text-muted-foreground mt-2">
          Generate CSV files for ShipHero uploads and factory communication.
        </p>
      </div>

      <Tabs defaultValue="shiphero" className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md mb-6">
          <TabsTrigger value="shiphero"><Truck className="h-4 w-4 mr-2" />ShipHero</TabsTrigger>
          <TabsTrigger value="factory"><Factory className="h-4 w-4 mr-2" />Factory</TabsTrigger>
        </TabsList>

        {/* ShipHero Tab */}
        <TabsContent value="shiphero" className="space-y-6">
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>Upload order matters</AlertTitle>
            <AlertDescription>
              Run these in order: (1) Product Bulk Edit creates the Inner Pack SKUs.
              (2) UOM Mapping links them to Each SKUs (requires step 1 complete in ShipHero).
              (3) Purchase Order uses the Each SKUs to receive factory shipments.
            </AlertDescription>
          </Alert>

          {/* Shared filters for Products + UOM */}
          <Card>
            <CardHeader>
              <CardTitle>Filters (Products + UOM)</CardTitle>
              <CardDescription>Applied to both the Product Bulk Edit and UOM Mapping exports below.</CardDescription>
            </CardHeader>
            <CardContent className="flex gap-4 flex-wrap">
              <div className="space-y-2">
                <Label>Factory</Label>
                <Select value={factory} onValueChange={(v) => setFactory(v ?? "all")}>
                  <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All factories</SelectItem>
                    <SelectItem value="JX1">JX1 — TAGA</SelectItem>
                    <SelectItem value="JX2">JX2 — HUIDE</SelectItem>
                    <SelectItem value="JX3">JX3 — GEYA</SelectItem>
                    <SelectItem value="JX4">JX4 — BRILLIANT</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Scope</Label>
                <Select value={scope} onValueChange={(v) => setScope(v ?? "new")}>
                  <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">New since last ShipHero sync</SelectItem>
                    <SelectItem value="all">All SKUs with Inner Packs</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* 1. Product Bulk Edit */}
          <Card>
            <CardHeader>
              <CardTitle>1. Product Bulk Edit</CardTitle>
              <CardDescription>
                Creates new Inner Pack (12-pack) product records in ShipHero. Each SKUs sync automatically from Shopify.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => loadPreview("products", `/api/v1/operations/exports/shiphero/products?factory=${factory}&scope=${scope}&preview=true`)}
                  disabled={loading.products}
                >
                  {loading.products ? "Loading..." : "Preview"}
                </Button>
                <Button
                  onClick={() => downloadCsv("products", `/api/v1/operations/exports/shiphero/products?factory=${factory}&scope=${scope}`, "shiphero_products.csv")}
                  disabled={loading.products}
                >
                  <Download className="h-4 w-4 mr-2" />Download CSV
                </Button>
              </div>
              {preview.products && <PreviewDisplay data={preview.products} />}
            </CardContent>
          </Card>

          {/* 2. UOM Mapping */}
          <Card>
            <CardHeader>
              <CardTitle>2. UOM Mapping</CardTitle>
              <CardDescription>
                Links each Inner Pack SKU to its Each SKU (1 unit of JX1001-BLK-12PK contains 12 units of JX1001-BLK).
                CRLF + QUOTE_ALL format, strictly per ShipHero's template.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => loadPreview("uom", `/api/v1/operations/exports/shiphero/uom?factory=${factory}&scope=${scope}&preview=true`)}
                  disabled={loading.uom}
                >
                  {loading.uom ? "Loading..." : "Preview"}
                </Button>
                <Button
                  onClick={() => downloadCsv("uom", `/api/v1/operations/exports/shiphero/uom?factory=${factory}&scope=${scope}`, "shiphero_uom.csv")}
                  disabled={loading.uom}
                >
                  <Download className="h-4 w-4 mr-2" />Download CSV
                </Button>
              </div>
              {preview.uom && <PreviewDisplay data={preview.uom} />}
            </CardContent>
          </Card>

          {/* 3. Purchase Order */}
          <Card>
            <CardHeader>
              <CardTitle>3. Purchase Order</CardTitle>
              <CardDescription>
                Generate a ShipHero PO CSV from an existing PO or a pasted shipment list.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Existing PO</Label>
                <Select value={selectedPoId} onValueChange={(v) => setSelectedPoId(v ?? "")}>
                  <SelectTrigger><SelectValue placeholder="Select an existing PO, or leave blank to paste a list" /></SelectTrigger>
                  <SelectContent>
                    {pos.map((po) => (
                      <SelectItem key={po.id} value={po.id}>
                        {po.poNumber ?? "(no #)"} — {po.vendor ?? "?"} — {po.rowCount} lines / {po.unitCount} units
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Or paste a SKU / Qty list (tab or comma separated, optional price column)</Label>
                <Textarea
                  placeholder="SKU\tQuantity\tPrice\nJX3004-BLK\t500\t2.10\nJX3004-SND\t300\t2.10"
                  value={pastedList}
                  onChange={(e) => setPastedList(e.target.value)}
                  rows={6}
                  className="font-mono text-sm"
                  disabled={!!selectedPoId}
                />
              </div>

              <div className="flex gap-4 flex-wrap">
                <div className="space-y-2">
                  <Label>PO Number (blank to autogenerate)</Label>
                  <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="JX3-20260421" className="w-[240px]" />
                </div>
                <div className="space-y-2">
                  <Label>Freight</Label>
                  <Select value={freightType} onValueChange={(v) => setFreightType((v ?? "air") as "air" | "ocean")}>
                    <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="air">Air (DHL)</SelectItem>
                      <SelectItem value="ocean">Ocean</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Default unit price ($)</Label>
                  <Input type="number" step="0.01" value={defaultPrice} onChange={(e) => setDefaultPrice(e.target.value)} className="w-[140px]" placeholder="0.00" />
                </div>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={previewPo} disabled={loading.po}>
                  {loading.po ? "Loading..." : "Preview"}
                </Button>
                <Button onClick={downloadPo} disabled={loading.po}>
                  <Download className="h-4 w-4 mr-2" />Generate &amp; Download
                </Button>
              </div>

              {poPreview && (
                <div className="border rounded p-4 space-y-2 text-sm bg-muted/30">
                  <div className="flex gap-4 flex-wrap">
                    <Badge variant="outline">PO: {poPreview.poNumber}</Badge>
                    <Badge variant="outline">Vendor: {poPreview.vendor}</Badge>
                    <Badge>{poPreview.rowCount} line items</Badge>
                  </div>
                  <WarningsDisplay warnings={poPreview.warnings} />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Factory Tab */}
        <TabsContent value="factory" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Factory SKU Sheet</CardTitle>
              <CardDescription>
                Send this to factories when onboarding new styles or running a new production batch.
                Contains: Style, Color, Individual SKU + Barcode, 12-Pack SKU + Barcode. UTF-8 with BOM for Excel on Windows.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-4 flex-wrap">
                <div className="space-y-2">
                  <Label>Factory (required)</Label>
                  <Select value={factorySheetFactory} onValueChange={(v) => setFactorySheetFactory(v ?? "JX1")}>
                    <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="JX1">JX1 — TAGA</SelectItem>
                      <SelectItem value="JX2">JX2 — HUIDE</SelectItem>
                      <SelectItem value="JX3">JX3 — GEYA</SelectItem>
                      <SelectItem value="JX4">JX4 — BRILLIANT</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Specific SKUs (optional, comma-separated)</Label>
                <Input value={factorySheetSkus} onChange={(e) => setFactorySheetSkus(e.target.value)} placeholder="JX1001-BLK, JX1001-TOR (leave blank for all)" />
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => loadPreview("factory", `/api/v1/operations/exports/factory/sku-sheet?factory=${factorySheetFactory}${factorySheetSkus ? `&skus=${encodeURIComponent(factorySheetSkus)}` : ""}&preview=true`)}
                  disabled={loading.factory}
                >
                  {loading.factory ? "Loading..." : "Preview"}
                </Button>
                <Button
                  onClick={() => downloadCsv("factory", `/api/v1/operations/exports/factory/sku-sheet?factory=${factorySheetFactory}${factorySheetSkus ? `&skus=${encodeURIComponent(factorySheetSkus)}` : ""}`, `jaxy_skus_${factorySheetFactory}.csv`)}
                  disabled={loading.factory}
                >
                  <Download className="h-4 w-4 mr-2" />Download CSV
                </Button>
              </div>
              {preview.factory && <PreviewDisplay data={preview.factory} />}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PreviewDisplay({ data }: { data: PreviewResponse }) {
  return (
    <div className="mt-4 border rounded p-4 space-y-3 bg-muted/30 text-sm">
      <div className="flex gap-4 flex-wrap items-center">
        <Badge variant={data.rowCount > 0 ? "default" : "secondary"} className="gap-1">
          {data.rowCount > 0 ? <CheckCircle className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          {data.rowCount} rows
        </Badge>
        {data.files && data.files > 1 && <Badge variant="outline">{data.files} files (800-row chunks)</Badge>}
      </div>
      <WarningsDisplay warnings={data.warnings} />
      {data.sample && data.sample.length > 0 && (
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {Object.keys(data.sample[0]).map((k) => (
                  <TableHead key={k} className="text-xs">{k}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.sample.map((row, i) => (
                <TableRow key={i}>
                  {Object.values(row).map((v, j) => (
                    <TableCell key={j} className="text-xs font-mono">{v == null ? <span className="text-muted-foreground">—</span> : String(v)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function WarningsDisplay({ warnings }: { warnings?: PreviewResponse["warnings"] }) {
  if (!warnings) return null;
  const items: { label: string; values: string[] }[] = [];
  if (warnings.skippedNoInnerPackSku?.length) items.push({ label: "Skipped (no Inner Pack SKU)", values: warnings.skippedNoInnerPackSku });
  if (warnings.skippedNoUpc?.length) items.push({ label: "Skipped (no UPC)", values: warnings.skippedNoUpc });
  if (warnings.skippedBadQty?.length) items.push({ label: "Skipped (bad quantity)", values: warnings.skippedBadQty });
  if (warnings.skippedZeroQty?.length) items.push({ label: "Skipped (zero/negative qty)", values: warnings.skippedZeroQty });
  if (warnings.deduped?.length) items.push({ label: "Deduped", values: warnings.deduped });
  if (warnings.consolidatedDuplicates?.length) items.push({ label: "Consolidated duplicates", values: warnings.consolidatedDuplicates });
  if (warnings.missingEachUpc?.length) items.push({ label: "Missing Each UPC", values: warnings.missingEachUpc });
  if (warnings.missingInnerPackUpc?.length) items.push({ label: "Missing Inner Pack UPC", values: warnings.missingInnerPackUpc });
  if (warnings.missingInnerPackSku?.length) items.push({ label: "Missing Inner Pack SKU", values: warnings.missingInnerPackSku });

  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.label} className="text-xs">
          <span className="font-semibold">{it.label} ({it.values.length}):</span>{" "}
          <span className="text-muted-foreground font-mono">{it.values.slice(0, 10).join(", ")}{it.values.length > 10 ? "..." : ""}</span>
        </div>
      ))}
    </div>
  );
}
