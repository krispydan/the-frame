"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft, Download, AlertCircle, CheckCircle, AlertTriangle, FileSpreadsheet, FileText,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    const idsParam = selectedIds ? `?ids=${selectedIds}` : "";
    window.open(`/api/v1/catalog/export/pdf${idsParam}`, "_blank");
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

      {/* Platform Selection */}
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
        <Button variant="outline" onClick={handlePdfExport}>
          <FileText className="h-4 w-4 mr-1" /> PDF Catalog
        </Button>
      </div>

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
