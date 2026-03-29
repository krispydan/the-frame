"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, ExternalLink, Globe, Building, Mail, Phone, MapPin,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface BrandDetail {
  id: string;
  external_id: string;
  name: string;
  website: string | null;
  sector: string | null;
  relevance: string;
  brand_type: string;
  us_locations: number;
  total_locations: number;
  top_country: string | null;
  match_count: number;
}

interface LinkedCompany {
  id: string;
  name: string;
  status: string;
  icp_score: number | null;
  icp_tier: string | null;
  city: string | null;
  state: string | null;
  email: string | null;
  website: string | null;
  phone: string | null;
  disqualify_reason: string | null;
}

const relevanceColors: Record<string, string> = {
  relevant: "bg-green-100 text-green-800",
  irrelevant: "bg-red-100 text-red-800",
  needs_review: "bg-yellow-100 text-yellow-800",
};

const statusColors: Record<string, string> = {
  new: "bg-blue-100 text-blue-800",
  contacted: "bg-purple-100 text-purple-800",
  qualified: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  customer: "bg-emerald-100 text-emerald-800",
};

const statusLabels: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  rejected: "Not Qualified",
  customer: "Customer",
};

export default function BrandDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [brand, setBrand] = useState<BrandDetail | null>(null);
  const [companies, setCompanies] = useState<LinkedCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/brands/${id}`);
      const data = await res.json();
      if (data.error) return;
      setBrand(data.brand);
      setCompanies(data.companies);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const updateRelevance = async (relevance: string) => {
    await fetch(`/api/v1/brands/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relevance }),
    });
    setBrand(prev => prev ? { ...prev, relevance } : null);
  };

  const toggleSelect = (companyId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(companyId)) next.delete(companyId); else next.add(companyId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectAll) {
      setSelected(new Set());
      setSelectAll(false);
    } else {
      setSelected(new Set(companies.map(c => c.id)));
      setSelectAll(true);
    }
  };

  const bulkCompanyAction = async (action: string) => {
    if (selected.size === 0) return;
    setBulkLoading(true);
    try {
      const body: Record<string, unknown> = { action, ids: Array.from(selected) };
      if (action === "reject") {
        body.params = { reason: `Brand DQ: ${brand?.name}` };
      }
      await fetch("/api/v1/sales/prospects/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setSelected(new Set());
      setSelectAll(false);
      fetchData();
    } catch {
      // silently fail
    } finally {
      setBulkLoading(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading brand...</div>;
  }

  if (!brand) {
    return <div className="p-6 text-muted-foreground">Brand not found</div>;
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.push("/brands")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Building className="h-6 w-6" />
              {brand.name}
            </h1>
            <p className="text-sm text-muted-foreground">ID: {brand.external_id}</p>
          </div>
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Relevance</CardTitle>
          </CardHeader>
          <CardContent>
            <Select value={brand.relevance} onValueChange={updateRelevance}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="relevant">Relevant</SelectItem>
                <SelectItem value="irrelevant">Irrelevant</SelectItem>
                <SelectItem value="needs_review">Needs Review</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {brand.website && (
              <a href={brand.website.startsWith("http") ? brand.website : `https://${brand.website}`} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
                <Globe className="h-3 w-3" /> {brand.website.replace(/^https?:\/\//, "").slice(0, 30)}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {brand.sector && <p className="text-sm"><Badge variant="secondary">{brand.sector}</Badge></p>}
            <p className="text-sm text-muted-foreground">Type: {brand.brand_type}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Locations</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{brand.us_locations.toLocaleString()}</p>
            <p className="text-sm text-muted-foreground">US locations / {brand.total_locations.toLocaleString()} total</p>
            {brand.top_country && <p className="text-xs text-muted-foreground">Top: {brand.top_country}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">DB Matches</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{brand.match_count}</p>
            <p className="text-sm text-muted-foreground">linked companies in DB</p>
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* Linked Companies */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Linked Companies ({companies.length})</h2>
        </div>

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 p-2 mb-3 bg-muted rounded-md">
            <span className="text-sm font-medium">{selected.size} selected</span>
            <Button size="sm" variant="outline" onClick={() => bulkCompanyAction("approve")} disabled={bulkLoading}>
              Approve
            </Button>
            <Button size="sm" variant="destructive" onClick={() => bulkCompanyAction("reject")} disabled={bulkLoading}>
              DQ
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()); setSelectAll(false); }}>
              Cancel
            </Button>
          </div>
        )}

        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input type="checkbox" checked={selectAll} onChange={toggleSelectAll} className="rounded" />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>ICP</TableHead>
                <TableHead>City</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Website</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No linked companies found
                  </TableCell>
                </TableRow>
              ) : (
                companies.map(company => (
                  <TableRow key={company.id}>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(company.id)}
                        onChange={() => toggleSelect(company.id)}
                        className="rounded"
                      />
                    </TableCell>
                    <TableCell>
                      <Link href={`/prospects/${company.id}`} className="font-medium hover:underline">
                        {company.name}
                      </Link>
                      {company.disqualify_reason && (
                        <p className="text-xs text-red-500">{company.disqualify_reason}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${statusColors[company.status] || ""}`}>
                        {statusLabels[company.status] || company.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {company.icp_score != null ? (
                        <span className="font-mono text-sm">{company.icp_score}</span>
                      ) : <span className="text-muted-foreground text-sm">—</span>}
                      {company.icp_tier && (
                        <Badge variant="outline" className="ml-1 text-xs">{company.icp_tier}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{company.city || "—"}</TableCell>
                    <TableCell className="text-sm">{company.state || "—"}</TableCell>
                    <TableCell>
                      {company.email ? (
                        <a href={`mailto:${company.email}`} className="text-sm text-blue-600 hover:underline flex items-center gap-1">
                          <Mail className="h-3 w-3" /> {company.email.slice(0, 25)}
                        </a>
                      ) : <span className="text-muted-foreground text-sm">—</span>}
                    </TableCell>
                    <TableCell>
                      {company.website ? (
                        <a href={company.website.startsWith("http") ? company.website : `https://${company.website}`} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline flex items-center gap-1" onClick={e => e.stopPropagation()}>
                          <Globe className="h-3 w-3" />
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : <span className="text-muted-foreground text-sm">—</span>}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
