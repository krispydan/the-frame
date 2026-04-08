"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft, Download, AlertCircle, CheckCircle, AlertTriangle, FileSpreadsheet, FileText,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

type Validation = {
  productId: string;
  productName: string;
  skuPrefix: string;
  status: "ready" | "blocked" | "warning";
  issues: { field: string; message: string; severity: string }[];
};

type ExportRecord = {
  id: string;
  platform: string;
  productCount: number;
  createdAt: string;
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  ready: <CheckCircle className="h-4 w-4 text-green-600" />,
  blocked: <AlertCircle className="h-4 w-4 text-red-600" />,
  warning: <AlertTriangle className="h-4 w-4 text-yellow-600" />,
};

export default function ExportPage() {
  const [platform, setPlatform] = useState<string>("shopify");
  const [channel, setChannel] = useState<string>("retail");
  const [validations, setValidations] = useState<Validation[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportHistory, setExportHistory] = useState<ExportRecord[]>([]);

  // PDF settings
  const [pdfSeason, setPdfSeason] = useState("Spring 2026");
  const [showPreorder, setShowPreorder] = useState(true);
  const [showOrderForm, setShowOrderForm] = useState(true);
  const [showTerms, setShowTerms] = useState(true);

  // Get pre-selected IDs from URL
  const [selectedIds, setSelectedIds] = useState<string>("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSelectedIds(params.get("ids") || "");
  }, []);

  const handleValidate = async () => {
    setLoading(true);
    const idsParam = selectedIds ? `&ids=${selectedIds}` : "";
    const channelParam = platform === "shopify" ? `&channel=${channel}` : "";
    const res = await fetch(`/api/v1/catalog/export/${platform}?validate=true${idsParam}${channelParam}`);
    const data = await res.json();
    setValidations(data.validations || []);
    setLoading(false);
  };

  const handleExport = async () => {
    const idsParam = selectedIds ? `?ids=${selectedIds}` : "?";
    const channelParam = platform === "shopify" ? `&channel=${channel}` : "";
    window.open(`/api/v1/catalog/export/${platform}${idsParam}${channelParam}`, "_blank");
  };

  const handlePdfExport = () => {
    const params = new URLSearchParams();
    if (selectedIds) params.set("ids", selectedIds);
    params.set("season", pdfSeason);
    params.set("preorder", String(showPreorder));
    params.set("orderForm", String(showOrderForm));
    params.set("terms", String(showTerms));
    window.open(`/api/v1/catalog/export/pdf?${params}`, "_blank");
  };

  const stats = {
    total: validations.length,
    ready: validations.filter((v) => v.status === "ready").length,
    blocked: validations.filter((v) => v.status === "blocked").length,
    warning: validations.filter((v) => v.status === "warning").length,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/catalog" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Export Catalog</h1>
          <p className="text-muted-foreground">
            {selectedIds ? `${selectedIds.split(",").length} products selected` : "All products"}
          </p>
        </div>
      </div>

      {/* CSV/TSV Export */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" /> Platform Export (CSV / TSV)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Select value={platform} onValueChange={(v) => v && setPlatform(v)}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="shopify">Shopify</SelectItem>
                <SelectItem value="faire">Faire</SelectItem>
                <SelectItem value="amazon">Amazon</SelectItem>
              </SelectContent>
            </Select>
            {platform === "shopify" && (
              <Select value={channel} onValueChange={(v) => v && setChannel(v)}>
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="retail">Retail (DTC)</SelectItem>
                  <SelectItem value="wholesale">Wholesale</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Button onClick={handleValidate} disabled={loading}>
              {loading ? "Validating..." : "Validate Products"}
            </Button>
            <Button variant="outline" onClick={handleExport}>
              <FileSpreadsheet className="h-4 w-4 mr-1" /> Export {platform === "amazon" ? "TSV" : "CSV"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* PDF Catalog Generator */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" /> Wholesale PDF Catalog
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Season</label>
              <Input value={pdfSeason} onChange={(e) => setPdfSeason(e.target.value)} className="w-[180px]" />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={showPreorder} onCheckedChange={(v) => setShowPreorder(!!v)} />
                Pre-Order Page
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={showOrderForm} onCheckedChange={(v) => setShowOrderForm(!!v)} />
                Order Form
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={showTerms} onCheckedChange={(v) => setShowTerms(!!v)} />
                Terms Page
              </label>
            </div>
            <Button onClick={handlePdfExport}>
              <Download className="h-4 w-4 mr-1" /> Generate PDF
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Validation Results */}
      {validations.length > 0 && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold">{stats.total}</p><p className="text-xs text-muted-foreground">Total</p></CardContent></Card>
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-green-600">{stats.ready}</p><p className="text-xs text-muted-foreground">Ready</p></CardContent></Card>
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-red-600">{stats.blocked}</p><p className="text-xs text-muted-foreground">Blocked</p></CardContent></Card>
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-yellow-600">{stats.warning}</p><p className="text-xs text-muted-foreground">Warnings</p></CardContent></Card>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">Status</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Issues</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {validations.map((v) => (
                    <TableRow key={v.productId}>
                      <TableCell>{STATUS_ICONS[v.status]}</TableCell>
                      <TableCell className="font-mono text-sm">
                        <Link href={`/catalog/${v.skuPrefix}`} className="hover:underline">{v.skuPrefix}</Link>
                      </TableCell>
                      <TableCell>{v.productName || "—"}</TableCell>
                      <TableCell>
                        {v.issues.length === 0 ? (
                          <span className="text-green-600 text-sm">Ready to export</span>
                        ) : (
                          <div className="space-y-1">
                            {v.issues.map((issue, i) => (
                              <div key={i} className="flex items-center gap-1 text-xs">
                                {issue.severity === "blocked" ? (
                                  <AlertCircle className="h-3 w-3 text-red-500 shrink-0" />
                                ) : (
                                  <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0" />
                                )}
                                <span>{issue.message}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
