"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  ArrowLeft, Calculator, Upload, Layers, DollarSign, TrendingUp,
  Loader2, CheckCircle, Clock, AlertTriangle, RefreshCw,
} from "lucide-react";
import Link from "next/link";

interface CostLayerSummary {
  skuId: string;
  sku: string | null;
  productName: string | null;
  colorName: string | null;
  totalUnits: number;
  remainingUnits: number;
  avgLandedCost: number;
  oldestLayerDate: string | null;
  layerCount: number;
}

interface CogsJournal {
  id: string;
  weekStart: string;
  weekEnd: string;
  productCost: number;
  freightCost: number;
  dutiesCost: number;
  totalCogs: number;
  unitCount: number;
  channelBreakdown: string | null;
  status: string;
  xeroJournalId: string | null;
  xeroPostedAt: string | null;
  notes: string | null;
  createdAt: string;
}

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function getMonday(d: Date): string {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d);
  mon.setDate(diff);
  return mon.toISOString().split("T")[0];
}

function getSunday(monday: string): string {
  const d = new Date(monday);
  d.setDate(d.getDate() + 6);
  return d.toISOString().split("T")[0];
}

export default function CogsPage() {
  const [layers, setLayers] = useState<CostLayerSummary[]>([]);
  const [journals, setJournals] = useState<CogsJournal[]>([]);
  const [loading, setLoading] = useState(true);

  // Week picker — defaults to current week
  const today = new Date();
  const defaultMonday = getMonday(today);
  const [weekStart, setWeekStart] = useState(defaultMonday);
  const [weekEnd, setWeekEnd] = useState(getSunday(defaultMonday));

  // Calculation state
  const [calculating, setCalculating] = useState(false);
  const [calcResult, setCalcResult] = useState<{
    productCost: number; freightCost: number; dutiesCost: number;
    totalCogs: number; unitCount: number; journalId: string;
    channelBreakdown: Record<string, { units: number; totalCogs: number }>;
  } | null>(null);

  const [depleting, setDepleting] = useState(false);
  const [posting, setPosting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [layerRes, journalRes] = await Promise.all([
        fetch("/api/v1/finance/cost-layers?summary=true"),
        fetch("/api/v1/finance/cogs?journals=true"),
      ]);
      if (layerRes.ok) setLayers(await layerRes.json());
      if (journalRes.ok) setJournals(await journalRes.json());
    } catch {
      toast.error("Failed to load COGS data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleWeekStartChange = (val: string) => {
    setWeekStart(val);
    setWeekEnd(getSunday(val));
    setCalcResult(null);
  };

  const handleDepleteOrders = async () => {
    setDepleting(true);
    try {
      const res = await fetch("/api/v1/finance/cogs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deplete-orders", since: weekStart }),
      });
      const data = await res.json();
      if (data.processed > 0) {
        toast.success(`Processed ${data.processed} orders, depleted ${data.depleted} units`);
        if (data.shortfalls.length > 0) {
          toast.warning(`${data.shortfalls.length} SKU(s) had insufficient cost layers`);
        }
      } else {
        toast.info("No uncosted orders found");
      }
      load();
    } catch {
      toast.error("Failed to deplete orders");
    } finally {
      setDepleting(false);
    }
  };

  const handleCalculate = async () => {
    setCalculating(true);
    setCalcResult(null);
    try {
      const res = await fetch("/api/v1/finance/cogs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "calculate", weekStart, weekEnd }),
      });
      const data = await res.json();
      setCalcResult(data);
      if (data.totalCogs > 0) {
        toast.success(`COGS calculated: ${formatCurrency(data.totalCogs)} (${data.unitCount} units)`);
      } else {
        toast.info("No COGS for this period (no depletions found)");
      }
      load();
    } catch {
      toast.error("Calculation failed");
    } finally {
      setCalculating(false);
    }
  };

  const handlePostToXero = async (journalId: string) => {
    setPosting(journalId);
    try {
      const res = await fetch("/api/v1/finance/cogs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "post-to-xero", journalId, asDraft: true }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Posted to Xero as Draft — review in your Xero account");
        load();
      } else {
        toast.error(data.error || "Failed to post to Xero");
      }
    } catch {
      toast.error("Failed to post to Xero");
    } finally {
      setPosting(null);
    }
  };

  // Stats
  const totalLayerUnits = layers.reduce((sum, l) => sum + l.remainingUnits, 0);
  const totalLayerValue = layers.reduce((sum, l) => sum + l.remainingUnits * l.avgLandedCost, 0);
  const totalPosted = journals.filter((j) => j.status === "posted").length;
  const totalDraftCogs = journals
    .filter((j) => j.status === "draft")
    .reduce((sum, j) => sum + j.totalCogs, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link href="/finance" className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <h1 className="text-3xl font-bold tracking-tight">FIFO Inventory Costing</h1>
          </div>
          <p className="text-muted-foreground ml-8">
            Lot-based FIFO costing with weekly COGS journal posting to Xero
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Layers className="h-4 w-4" /> Inventory on Hand
            </div>
            <p className="text-2xl font-bold">{totalLayerUnits.toLocaleString()} units</p>
            <p className="text-sm text-muted-foreground">{layers.length} SKUs with active layers</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <DollarSign className="h-4 w-4" /> Inventory Value
            </div>
            <p className="text-2xl font-bold">{formatCurrency(totalLayerValue)}</p>
            <p className="text-sm text-muted-foreground">At landed cost (FIFO)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <CheckCircle className="h-4 w-4" /> Journals Posted
            </div>
            <p className="text-2xl font-bold">{totalPosted}</p>
            <p className="text-sm text-muted-foreground">{journals.length} total journals</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Clock className="h-4 w-4" /> Pending COGS
            </div>
            <p className="text-2xl font-bold">{formatCurrency(totalDraftCogs)}</p>
            <p className="text-sm text-muted-foreground">In draft journals</p>
          </CardContent>
        </Card>
      </div>

      {/* Weekly COGS Calculator */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5" /> Weekly COGS Calculator
          </CardTitle>
          <CardDescription>
            Select a week, deplete uncosted orders via FIFO, calculate COGS, and post to Xero
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-4 flex-wrap">
            <div className="grid gap-2">
              <Label htmlFor="week-start">Week Starting (Monday)</Label>
              <Input
                id="week-start"
                type="date"
                value={weekStart}
                onChange={(e) => handleWeekStartChange(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="week-end">Week Ending (Sunday)</Label>
              <Input
                id="week-end"
                type="date"
                value={weekEnd}
                readOnly
                className="w-44 bg-muted"
              />
            </div>

            <Button variant="outline" onClick={handleDepleteOrders} disabled={depleting}>
              {depleting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              1. Deplete Orders
            </Button>

            <Button onClick={handleCalculate} disabled={calculating}>
              {calculating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Calculator className="h-4 w-4 mr-2" />}
              2. Calculate COGS
            </Button>
          </div>

          {/* Calculation Result */}
          {calcResult && (
            <Card className="bg-muted/50">
              <CardContent className="pt-4">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Product Cost</p>
                    <p className="font-semibold">{formatCurrency(calcResult.productCost)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Freight</p>
                    <p className="font-semibold">{formatCurrency(calcResult.freightCost)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Duties/Tariffs</p>
                    <p className="font-semibold">{formatCurrency(calcResult.dutiesCost)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Total COGS</p>
                    <p className="font-bold text-lg">{formatCurrency(calcResult.totalCogs)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Units</p>
                    <p className="font-semibold">{calcResult.unitCount}</p>
                  </div>
                </div>
                {calcResult.channelBreakdown && Object.keys(calcResult.channelBreakdown).length > 0 && (
                  <div className="mt-3 pt-3 border-t">
                    <p className="text-xs text-muted-foreground mb-2">By Channel</p>
                    <div className="flex gap-3 flex-wrap">
                      {Object.entries(calcResult.channelBreakdown).map(([ch, data]) => (
                        <Badge key={ch} variant="secondary" className="text-xs">
                          {ch}: {(data as { units: number; totalCogs: number }).units} units / {formatCurrency((data as { totalCogs: number }).totalCogs)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      {/* COGS Journal History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" /> COGS Journals
          </CardTitle>
          <CardDescription>
            Weekly COGS calculations and their Xero sync status
          </CardDescription>
        </CardHeader>
        <CardContent>
          {journals.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No COGS journals yet. Use the calculator above to create your first one.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Product</TableHead>
                  <TableHead className="text-right">Freight</TableHead>
                  <TableHead className="text-right">Duties</TableHead>
                  <TableHead className="text-right">Total COGS</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {journals.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="text-sm">
                      {formatDate(j.weekStart)} — {formatDate(j.weekEnd)}
                    </TableCell>
                    <TableCell className="text-right text-sm">{formatCurrency(j.productCost)}</TableCell>
                    <TableCell className="text-right text-sm">{formatCurrency(j.freightCost)}</TableCell>
                    <TableCell className="text-right text-sm">{formatCurrency(j.dutiesCost)}</TableCell>
                    <TableCell className="text-right font-semibold">{formatCurrency(j.totalCogs)}</TableCell>
                    <TableCell className="text-right text-sm">{j.unitCount}</TableCell>
                    <TableCell>
                      {j.status === "posted" ? (
                        <Badge variant="default" className="bg-green-600">
                          <CheckCircle className="h-3 w-3 mr-1" /> Posted
                        </Badge>
                      ) : j.status === "reconciled" ? (
                        <Badge variant="default" className="bg-blue-600">Reconciled</Badge>
                      ) : (
                        <Badge variant="secondary">
                          <Clock className="h-3 w-3 mr-1" /> Draft
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {j.status === "draft" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handlePostToXero(j.id)}
                          disabled={posting === j.id}
                        >
                          {posting === j.id ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                          ) : (
                            <Upload className="h-3.5 w-3.5 mr-1" />
                          )}
                          Post to Xero
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Cost Layers by SKU */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" /> Inventory Cost Layers
          </CardTitle>
          <CardDescription>
            Current FIFO inventory stack — oldest layers consumed first on sale
          </CardDescription>
        </CardHeader>
        <CardContent>
          {layers.length === 0 ? (
            <div className="text-center py-8">
              <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No cost layers yet. Create them from a received PO or add manually.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product / Color</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead className="text-right">Avg Landed Cost</TableHead>
                  <TableHead className="text-right">Layer Value</TableHead>
                  <TableHead className="text-right">Layers</TableHead>
                  <TableHead>Oldest</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {layers.map((l) => (
                  <TableRow key={l.skuId}>
                    <TableCell className="font-mono text-sm">{l.sku || l.skuId.slice(0, 8)}</TableCell>
                    <TableCell className="text-sm">
                      {l.productName} {l.colorName ? `— ${l.colorName}` : ""}
                    </TableCell>
                    <TableCell className="text-right font-semibold">{l.remainingUnits}</TableCell>
                    <TableCell className="text-right text-sm">{formatCurrency(l.avgLandedCost)}</TableCell>
                    <TableCell className="text-right text-sm font-medium">
                      {formatCurrency(l.remainingUnits * l.avgLandedCost)}
                    </TableCell>
                    <TableCell className="text-right text-sm">{l.layerCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(l.oldestLayerDate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
