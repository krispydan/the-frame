"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Layers3, Target, DollarSign, Users, ChevronRight, Loader2, Pencil, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

interface Segment {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icp_profile: string | null;
  email_templates: string | null;
  outreach_notes: string | null;
  status: "active" | "paused" | "retired";
  prospect_count: number;
  qualified_count: number;
  customer_count: number;
  active_deals: number;
  pipeline_value: number;
  order_count: number;
  revenue: number;
  campaign_count: number;
}

interface SegmentsResponse {
  data: Segment[];
  summary: {
    segments: number;
    prospects: number;
    qualified: number;
    pipelineValue: number;
    revenue: number;
  };
}

type SegmentFormState = {
  id: string | null;
  name: string;
  status: Segment["status"];
  description: string;
  icp_profile: string;
  email_templates: string;
  outreach_notes: string;
};

const emptyForm: SegmentFormState = {
  id: null,
  name: "",
  status: "active",
  description: "",
  icp_profile: "",
  email_templates: "",
  outreach_notes: "",
};

const statusTone: Record<Segment["status"], string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-yellow-100 text-yellow-800",
  retired: "bg-gray-100 text-gray-700",
};

export default function SegmentsPage() {
  const [payload, setPayload] = useState<SegmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<SegmentFormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);

  async function loadSegments() {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/sales/segments");
      const data = await response.json();
      setPayload(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSegments();
  }, []);

  function openCreateDialog() {
    setForm(emptyForm);
    setError(null);
    setDialogOpen(true);
  }

  function openEditDialog(segment: Segment) {
    setForm({
      id: segment.id,
      name: segment.name,
      status: segment.status,
      description: segment.description || "",
      icp_profile: segment.icp_profile || "",
      email_templates: segment.email_templates || "",
      outreach_notes: segment.outreach_notes || "",
    });
    setError(null);
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setError("Segment name is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/sales/segments", {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error || "Failed to save segment.");
        return;
      }

      setDialogOpen(false);
      setForm(emptyForm);
      await loadSegments();
    } catch {
      setError("Failed to save segment.");
    } finally {
      setSaving(false);
    }
  }

  function renderSegmentSummary(segment: Segment) {
    if (segment.icp_profile) return segment.icp_profile;
    if (segment.description) return segment.description;
    return "No ICP profile written yet.";
  }

  function renderOutreachNote(segment: Segment) {
    if (!segment.outreach_notes) return null;
    return (
      <div className="text-[11px] text-muted-foreground">
        Outreach: {segment.outreach_notes}
      </div>
    );
  }

  function renderEmailTemplate(segment: Segment) {
    if (!segment.email_templates) return null;
    return (
      <div className="text-[11px] text-muted-foreground">
        Template: {segment.email_templates}
      </div>
    );
  }

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading segments...</div>;
  }

  const segments = payload?.data || [];
  const summary = payload?.summary || {
    segments: 0,
    prospects: 0,
    qualified: 0,
    pipelineValue: 0,
    revenue: 0,
  };

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-full xl:max-w-[1200px] mx-auto">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Segments</h1>
          <p className="text-sm text-muted-foreground">
            First-class ICP buckets across prospects, deals, campaigns, and revenue.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="px-3 py-1 text-xs">
            {summary.segments} live segments
          </Badge>
          <Button onClick={openCreateDialog} className="gap-2">
            <Plus className="h-4 w-4" />
            New Segment
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <SummaryCard title="Segments" value={summary.segments.toLocaleString()} icon={<Layers3 className="w-4 h-4" />} />
        <SummaryCard title="Prospects" value={summary.prospects.toLocaleString()} icon={<Users className="w-4 h-4" />} />
        <SummaryCard title="Pipeline" value={`$${summary.pipelineValue.toLocaleString()}`} icon={<Target className="w-4 h-4" />} />
        <SummaryCard title="Revenue" value={`$${summary.revenue.toLocaleString()}`} icon={<DollarSign className="w-4 h-4" />} />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Segment Scoreboard</CardTitle>
        </CardHeader>
        <CardContent>
          {segments.length === 0 ? (
            <div className="text-sm text-muted-foreground">No structured segments yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Segment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Prospects</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">Customers</TableHead>
                  <TableHead className="text-right">Deals</TableHead>
                  <TableHead className="text-right">Campaigns</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Explore</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {segments.map((segment) => {
                  const conversionRate = segment.prospect_count > 0
                    ? (segment.customer_count / segment.prospect_count) * 100
                    : 0;
                  const averageOrderValue = segment.order_count > 0
                    ? segment.revenue / segment.order_count
                    : 0;

                  return (
                    <TableRow key={segment.id}>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <div className="font-medium text-gray-900 dark:text-white">{segment.name}</div>
                            <span className="text-[11px] text-muted-foreground">/{segment.slug}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {renderSegmentSummary(segment)}
                          </div>
                          {renderEmailTemplate(segment)}
                          {renderOutreachNote(segment)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusTone[segment.status]}`}>
                          {segment.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/prospects?segment=${encodeURIComponent(segment.name)}`}
                          className="hover:underline"
                        >
                          {segment.prospect_count.toLocaleString()}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/prospects?segment=${encodeURIComponent(segment.name)}&status=qualified`}
                          className="hover:underline"
                        >
                          {segment.qualified_count.toLocaleString()}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">
                        <div>
                          <Link
                            href={`/customers?segment=${encodeURIComponent(segment.name)}`}
                            className="hover:underline"
                          >
                            {segment.customer_count.toLocaleString()}
                          </Link>
                        </div>
                        <div className="text-xs text-muted-foreground">{conversionRate.toFixed(1)}% conv.</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div>
                          <Link
                            href={`/pipeline?segment=${encodeURIComponent(segment.name)}`}
                            className="hover:underline"
                          >
                            {segment.active_deals.toLocaleString()}
                          </Link>
                        </div>
                        <div className="text-xs text-muted-foreground">${segment.pipeline_value.toLocaleString()}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/campaigns?segment=${encodeURIComponent(segment.name)}`}
                          className="hover:underline"
                        >
                          {segment.campaign_count.toLocaleString()}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/orders?segment=${encodeURIComponent(segment.name)}`}
                          className="hover:underline"
                        >
                          {segment.order_count.toLocaleString()}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">
                        <div>${segment.revenue.toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">${averageOrderValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} AOV</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            type="button"
                            onClick={() => openEditDialog(segment)}
                            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit
                          </button>
                          <Link
                            href={`/prospects?segment=${encodeURIComponent(segment.name)}`}
                            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
                          >
                            Prospects <ChevronRight className="w-3 h-3" />
                          </Link>
                          <Link
                            href={`/campaigns?segment=${encodeURIComponent(segment.name)}`}
                            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
                          >
                            Campaigns <ChevronRight className="w-3 h-3" />
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setForm(emptyForm);
            setError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit Segment" : "Create Segment"}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="grid gap-2 md:grid-cols-[1.2fr_0.8fr]">
              <div className="space-y-2">
                <Label htmlFor="segment-name">Name</Label>
                <Input
                  id="segment-name"
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Museum Gift Shops"
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, status: value as Segment["status"] }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="paused">Paused</SelectItem>
                    <SelectItem value="retired">Retired</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="segment-description">Description</Label>
              <Textarea
                id="segment-description"
                rows={2}
                value={form.description}
                onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                placeholder="Short summary of the segment and why it matters."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="segment-icp">ICP Profile</Label>
              <Textarea
                id="segment-icp"
                rows={4}
                value={form.icp_profile}
                onChange={(event) => setForm((prev) => ({ ...prev, icp_profile: event.target.value }))}
                placeholder="What makes a strong lead here? Store traits, buyer behavior, merchandising fit, price sensitivity..."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="segment-templates">Email Templates</Label>
              <Textarea
                id="segment-templates"
                rows={4}
                value={form.email_templates}
                onChange={(event) => setForm((prev) => ({ ...prev, email_templates: event.target.value }))}
                placeholder="Core email angle, subject ideas, proof points, or full template draft..."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="segment-outreach">Outreach Notes</Label>
              <Textarea
                id="segment-outreach"
                rows={3}
                value={form.outreach_notes}
                onChange={(event) => setForm((prev) => ({ ...prev, outreach_notes: event.target.value }))}
                placeholder="Messaging angle, proof points, objections, follow-up notes..."
              />
            </div>

            {error && <div className="text-sm text-red-600">{error}</div>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {form.id ? "Save Segment" : "Create Segment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-semibold mt-1">{value}</p>
          </div>
          <div className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
