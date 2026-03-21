"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Upload, Plus, FileSpreadsheet, AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type IntakeResult = {
  created: number;
  errors: number;
  details: {
    created: string[];
    errors: { skuPrefix: string; error: string }[];
  };
};

export default function IntakePage() {
  const [mode, setMode] = useState<"manual" | "csv">("manual");
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Manual entry state
  const [skuPrefix, setSkuPrefix] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("sunglasses");
  const [factoryName, setFactoryName] = useState("");
  const [wholesalePrice, setWholesalePrice] = useState("");
  const [retailPrice, setRetailPrice] = useState("");
  const [poId, setPoId] = useState("");

  // CSV state
  const [csvData, setCsvData] = useState("");

  const handleManualSubmit = async () => {
    if (!skuPrefix) return;
    setLoading(true);
    const res = await fetch("/api/v1/catalog/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "manual",
        purchaseOrderId: poId || undefined,
        items: [{
          skuPrefix,
          name: name || undefined,
          category,
          factoryName: factoryName || undefined,
          wholesalePrice: wholesalePrice ? Number(wholesalePrice) : undefined,
          retailPrice: retailPrice ? Number(retailPrice) : undefined,
        }],
      }),
    });
    setResult(await res.json());
    setLoading(false);
    if (res.ok) {
      setSkuPrefix(""); setName(""); setFactoryName(""); setWholesalePrice(""); setRetailPrice("");
    }
  };

  const handleCsvSubmit = async () => {
    if (!csvData.trim()) return;
    setLoading(true);

    // Parse simple CSV: skuPrefix,name,category,factoryName,wholesalePrice,retailPrice
    const lines = csvData.trim().split("\n");
    const items = lines.slice(1).map((line) => {
      const [skuPrefix, name, category, factoryName, wp, rp] = line.split(",").map((s) => s.trim());
      return {
        skuPrefix,
        name: name || undefined,
        category: category || "sunglasses",
        factoryName: factoryName || undefined,
        wholesalePrice: wp ? Number(wp) : undefined,
        retailPrice: rp ? Number(rp) : undefined,
      };
    }).filter((i) => i.skuPrefix);

    const res = await fetch("/api/v1/catalog/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "csv", purchaseOrderId: poId || undefined, items }),
    });
    setResult(await res.json());
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/catalog" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Product Intake</h1>
          <p className="text-muted-foreground">Add new products to the catalog</p>
        </div>
      </div>

      {/* Purchase Order Association */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Purchase Order (Optional)</CardTitle></CardHeader>
        <CardContent>
          <Input placeholder="PO Number or ID" value={poId} onChange={(e) => setPoId(e.target.value)} className="max-w-xs" />
        </CardContent>
      </Card>

      <Tabs defaultValue="manual">
        <TabsList>
          <TabsTrigger value="manual"><Plus className="h-3 w-3 mr-1" /> Manual Entry</TabsTrigger>
          <TabsTrigger value="csv"><FileSpreadsheet className="h-3 w-3 mr-1" /> CSV Upload</TabsTrigger>
        </TabsList>

        <TabsContent value="manual">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>SKU Prefix *</Label>
                  <Input placeholder="e.g. JX1-001" value={skuPrefix} onChange={(e) => setSkuPrefix(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Product Name</Label>
                  <Input placeholder="e.g. The Malibu" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Category</Label>
                  <Select value={category} onValueChange={(v) => v && setCategory(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sunglasses">Sunglasses</SelectItem>
                      <SelectItem value="optical">Optical</SelectItem>
                      <SelectItem value="reading">Reading</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Factory</Label>
                  <Input placeholder="e.g. JX1 TAGA" value={factoryName} onChange={(e) => setFactoryName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Wholesale Price</Label>
                  <Input type="number" placeholder="8.00" value={wholesalePrice} onChange={(e) => setWholesalePrice(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Retail Price</Label>
                  <Input type="number" placeholder="24.00" value={retailPrice} onChange={(e) => setRetailPrice(e.target.value)} />
                </div>
              </div>
              <Button onClick={handleManualSubmit} disabled={loading || !skuPrefix}>
                {loading ? "Creating..." : "Create Product"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="csv">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="space-y-1">
                <Label>CSV Data</Label>
                <p className="text-xs text-muted-foreground">Header: skuPrefix,name,category,factoryName,wholesalePrice,retailPrice</p>
                <Textarea
                  rows={10}
                  placeholder="skuPrefix,name,category,factoryName,wholesalePrice,retailPrice&#10;JX1-NEW,The New Style,sunglasses,JX1 TAGA,8.00,24.00"
                  value={csvData}
                  onChange={(e) => setCsvData(e.target.value)}
                />
              </div>
              <Button onClick={handleCsvSubmit} disabled={loading || !csvData.trim()}>
                <Upload className="h-3 w-3 mr-1" /> {loading ? "Importing..." : "Import CSV"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Results */}
      {result && (
        <Card className={result.errors > 0 ? "border-yellow-300" : "border-green-300"}>
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center gap-2">
              {result.errors === 0 ? (
                <CheckCircle className="h-5 w-5 text-green-600" />
              ) : (
                <AlertCircle className="h-5 w-5 text-yellow-600" />
              )}
              <span className="font-medium">
                {result.created} created, {result.errors} errors
              </span>
            </div>
            {result.details.created.length > 0 && (
              <p className="text-sm text-green-700">Created: {result.details.created.join(", ")}</p>
            )}
            {result.details.errors.length > 0 && (
              <div className="text-sm text-red-700">
                {result.details.errors.map((e, i) => (
                  <p key={i}>{e.skuPrefix}: {e.error}</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
