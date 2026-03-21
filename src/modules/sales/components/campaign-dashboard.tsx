"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Mail, Send, Eye, MessageSquare, Zap, Plus, RefreshCw } from "lucide-react";
import { CampaignCreateDialog } from "./campaign-create-dialog";

const TYPE_BADGES: Record<string, { label: string; className: string }> = {
  email_sequence: { label: "Email", className: "bg-blue-100 text-blue-800" },
  calling: { label: "Calling", className: "bg-purple-100 text-purple-800" },
  re_engagement: { label: "Re-engage", className: "bg-orange-100 text-orange-800" },
  ab_test: { label: "A/B Test", className: "bg-pink-100 text-pink-800" },
};

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-gray-100 text-gray-800" },
  active: { label: "Active", className: "bg-green-100 text-green-800" },
  paused: { label: "Paused", className: "bg-yellow-100 text-yellow-800" },
  completed: { label: "Completed", className: "bg-blue-100 text-blue-800" },
};

interface Props {
  campaigns: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    instantly_campaign_id: string | null;
    sent: number;
    opened: number;
    replied: number;
    meetings_booked: number;
    orders_placed: number;
    lead_count: number;
    created_at: string;
  }>;
  summary: {
    active_campaigns: number;
    total_sent: number;
    avg_open_rate: number;
    avg_reply_rate: number;
  };
}

export function CampaignDashboard({ campaigns: initialCampaigns, summary }: Props) {
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [syncing, setSyncing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const filtered = campaigns.filter((c) => {
    if (typeFilter !== "all" && c.type !== typeFilter) return false;
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    return true;
  });

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/v1/sales/instantly/sync", { method: "POST" });
      const res = await fetch("/api/v1/sales/campaigns");
      const data = await res.json();
      setCampaigns(data.data);
    } finally {
      setSyncing(false);
    }
  };

  const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground">Manage outreach campaigns synced with Instantly</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            Sync Instantly
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" /> New Campaign
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Campaigns</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.active_campaigns}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Sent</CardTitle>
            <Send className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.total_sent.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Open Rate</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.avg_open_rate}%</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Reply Rate</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.avg_reply_rate}%</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <Select value={typeFilter} onValueChange={(v) => v && setTypeFilter(v)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="email_sequence">Email Sequence</SelectItem>
            <SelectItem value="calling">Calling</SelectItem>
            <SelectItem value="re_engagement">Re-engagement</SelectItem>
            <SelectItem value="ab_test">A/B Test</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Campaign Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Opened</TableHead>
              <TableHead className="text-right">Replied</TableHead>
              <TableHead className="text-right">Meetings</TableHead>
              <TableHead className="text-right">Orders</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((c) => {
              const typeBadge = TYPE_BADGES[c.type] || TYPE_BADGES.email_sequence;
              const statusBadge = STATUS_BADGES[c.status] || STATUS_BADGES.draft;
              return (
                <TableRow key={c.id} className="cursor-pointer hover:bg-muted/50">
                  <TableCell>
                    <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    {c.instantly_campaign_id && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        <Zap className="mr-1 h-3 w-3" /> Instantly
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge className={typeBadge.className} variant="secondary">{typeBadge.label}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={statusBadge.className} variant="secondary">{statusBadge.label}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.sent.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.opened.toLocaleString()} <span className="text-muted-foreground text-xs">({pct(c.opened, c.sent)}%)</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.replied.toLocaleString()} <span className="text-muted-foreground text-xs">({pct(c.replied, c.sent)}%)</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.meetings_booked}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.orders_placed}</TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No campaigns found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {showCreate && <CampaignCreateDialog open={showCreate} onClose={() => setShowCreate(false)} />}
    </div>
  );
}
