"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Pencil, Trash2, TrendingUp, DollarSign, MousePointer, Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type AdCampaign = {
  id: string;
  platform: string;
  campaignName: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  startDate: string | null;
  endDate: string | null;
  monthlyBudget: number | null;
  notes: string | null;
};

type Summary = { totalSpend: number; totalBudget: number; totalRevenue: number; roas: number };

const statusColors: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-yellow-100 text-yellow-800",
  completed: "bg-gray-100 text-gray-800",
};

const platformBadge: Record<string, string> = {
  google: "bg-blue-50 text-blue-700 border-blue-200",
  meta: "bg-indigo-50 text-indigo-700 border-indigo-200",
  tiktok: "bg-gray-100 text-gray-900 border-gray-300",
};

const PLATFORMS = ["google", "meta", "tiktok"] as const;
const STATUSES = ["active", "paused", "completed"] as const;

const emptyForm = { campaignName: "", platform: "meta", status: "active", spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, startDate: "", endDate: "", monthlyBudget: 0, notes: "" };

export function AdsTab() {
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [summary, setSummary] = useState<Summary>({ totalSpend: 0, totalBudget: 0, totalRevenue: 0, roas: 0 });
  const [loading, setLoading] = useState(true);
  const [platformFilter, setPlatformFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<AdCampaign | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const fetchData = useCallback(async () => {
    const params = new URLSearchParams();
    if (platformFilter !== "all") params.set("platform", platformFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    const res = await fetch(`/api/v1/marketing/ads?${params}`);
    const json = await res.json();
    setCampaigns(json.data || []);
    setSummary(json.summary || { totalSpend: 0, totalBudget: 0, totalRevenue: 0, roas: 0 });
    setLoading(false);
  }, [platformFilter, statusFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openCreate = () => { setEditingItem(null); setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (c: AdCampaign) => {
    setEditingItem(c);
    setForm({
      campaignName: c.campaignName, platform: c.platform, status: c.status,
      spend: c.spend, impressions: c.impressions, clicks: c.clicks,
      conversions: c.conversions, revenue: c.revenue,
      startDate: c.startDate || "", endDate: c.endDate || "",
      monthlyBudget: c.monthlyBudget || 0, notes: c.notes || "",
    });
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    const url = editingItem ? `/api/v1/marketing/ads/${editingItem.id}` : "/api/v1/marketing/ads";
    await fetch(url, {
      method: editingItem ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setDialogOpen(false); setEditingItem(null); setForm(emptyForm); fetchData();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/v1/marketing/ads/${id}`, { method: "DELETE" });
    setDeleteConfirm(null); fetchData();
  };

  const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
  const cpc = (c: AdCampaign) => c.clicks > 0 ? (c.spend / c.clicks).toFixed(2) : "—";
  const roas = (c: AdCampaign) => c.spend > 0 ? (c.revenue / c.spend).toFixed(1) : "—";

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-50"><DollarSign className="h-5 w-5 text-red-600" /></div>
            <div><div className="text-sm text-muted-foreground">Total Spend</div><div className="text-xl font-bold">{fmt(summary.totalSpend)}</div></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-50"><TrendingUp className="h-5 w-5 text-green-600" /></div>
            <div><div className="text-sm text-muted-foreground">Total Revenue</div><div className="text-xl font-bold">{fmt(summary.totalRevenue)}</div></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-50"><TrendingUp className="h-5 w-5 text-purple-600" /></div>
            <div><div className="text-sm text-muted-foreground">ROAS</div><div className="text-xl font-bold">{summary.roas.toFixed(1)}x</div></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50"><Eye className="h-5 w-5 text-blue-600" /></div>
            <div><div className="text-sm text-muted-foreground">Budget</div><div className="text-xl font-bold">{fmt(summary.totalBudget)}/mo</div></div>
          </CardContent>
        </Card>
      </div>

      {/* Filters + Add */}
      <div className="flex items-center gap-3">
        <Select value={platformFilter} onValueChange={setPlatformFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Platform" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Platforms</SelectItem>
            {PLATFORMS.map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {STATUSES.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" />Add Campaign</Button>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Platform</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Impressions</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">CPC</TableHead>
                <TableHead className="text-right">Conv.</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">ROAS</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={11} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : campaigns.length === 0 ? (
                <TableRow><TableCell colSpan={11} className="text-center py-8 text-muted-foreground">No campaigns found. Add one to get started.</TableCell></TableRow>
              ) : campaigns.map(c => (
                <TableRow key={c.id}>
                  <TableCell><Badge variant="outline" className={`capitalize ${platformBadge[c.platform] || ""}`}>{c.platform}</Badge></TableCell>
                  <TableCell className="font-medium">{c.campaignName}</TableCell>
                  <TableCell><Badge variant="outline" className={statusColors[c.status]}>{c.status}</Badge></TableCell>
                  <TableCell className="text-right">{fmt(c.spend)}</TableCell>
                  <TableCell className="text-right">{c.impressions.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{c.clicks.toLocaleString()}</TableCell>
                  <TableCell className="text-right">${cpc(c)}</TableCell>
                  <TableCell className="text-right">{c.conversions}</TableCell>
                  <TableCell className="text-right">{fmt(c.revenue)}</TableCell>
                  <TableCell className={`text-right font-medium ${Number(roas(c)) >= 2 ? "text-green-600" : Number(roas(c)) >= 1 ? "text-yellow-600" : "text-red-600"}`}>
                    {roas(c)}x
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(c)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteConfirm(c.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingItem(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editingItem ? "Edit Campaign" : "Add Campaign"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Campaign Name</Label><Input value={form.campaignName} onChange={e => setForm({ ...form, campaignName: e.target.value })} placeholder="Campaign name..." /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Platform</Label>
                <Select value={form.platform} onValueChange={v => setForm({ ...form, platform: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{PLATFORMS.map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Status</Label>
                <Select value={form.status} onValueChange={v => setForm({ ...form, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{STATUSES.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Start Date</Label><Input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></div>
              <div><Label>End Date</Label><Input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Monthly Budget ($)</Label><Input type="number" value={form.monthlyBudget} onChange={e => setForm({ ...form, monthlyBudget: Number(e.target.value) })} /></div>
              <div><Label>Spend ($)</Label><Input type="number" value={form.spend} onChange={e => setForm({ ...form, spend: Number(e.target.value) })} /></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Impressions</Label><Input type="number" value={form.impressions} onChange={e => setForm({ ...form, impressions: Number(e.target.value) })} /></div>
              <div><Label>Clicks</Label><Input type="number" value={form.clicks} onChange={e => setForm({ ...form, clicks: Number(e.target.value) })} /></div>
              <div><Label>Conversions</Label><Input type="number" value={form.conversions} onChange={e => setForm({ ...form, conversions: Number(e.target.value) })} /></div>
            </div>
            <div><Label>Revenue ($)</Label><Input type="number" value={form.revenue} onChange={e => setForm({ ...form, revenue: Number(e.target.value) })} /></div>
            <div><Label>Notes</Label><Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} placeholder="Campaign notes..." /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={!form.campaignName}>{editingItem ? "Save Changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete Campaign</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Are you sure? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
