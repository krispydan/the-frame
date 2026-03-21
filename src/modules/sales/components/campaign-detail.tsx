"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ArrowLeft, Send, Eye, MessageSquare, AlertTriangle, Trophy, Zap, ExternalLink, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";

interface Lead {
  id: string;
  company_id: string;
  company_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string;
  reply_text: string | null;
  reply_classification: string | null;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  icp_tier: string | null;
  icp_score: number | null;
  icp_reasoning: string | null;
}

interface Campaign {
  id: string;
  name: string;
  type: string;
  status: string;
  description: string | null;
  instantly_campaign_id: string | null;
  variant_a_subject: string | null;
  variant_b_subject: string | null;
  sent: number;
  delivered: number;
  opened: number;
  replied: number;
  bounced: number;
  meetings_booked: number;
  orders_placed: number;
  variant_a_sent: number;
  variant_a_opened: number;
  variant_a_replied: number;
  variant_b_sent: number;
  variant_b_opened: number;
  variant_b_replied: number;
  lead_count: number;
  reply_count: number;
  leads: Lead[];
}

const STATUS_COLORS: Record<string, string> = {
  queued: "bg-gray-100 text-gray-800",
  sent: "bg-blue-100 text-blue-800",
  opened: "bg-cyan-100 text-cyan-800",
  replied: "bg-green-100 text-green-800",
  bounced: "bg-red-100 text-red-800",
  unsubscribed: "bg-orange-100 text-orange-800",
};

const CLASSIFICATION_COLORS: Record<string, string> = {
  interested: "bg-green-100 text-green-800",
  not_interested: "bg-red-100 text-red-800",
  out_of_office: "bg-yellow-100 text-yellow-800",
  wrong_person: "bg-orange-100 text-orange-800",
  question: "bg-blue-100 text-blue-800",
  auto_reply: "bg-gray-100 text-gray-800",
};

const ICP_COLORS: Record<string, string> = {
  A: "bg-green-600 text-white",
  B: "bg-blue-500 text-white",
  C: "bg-yellow-500 text-white",
  D: "bg-red-500 text-white",
  F: "bg-gray-500 text-white",
};

function pct(n: number, d: number) {
  return d > 0 ? ((n / d) * 100).toFixed(1) : "0.0";
}

function MetricCard({ label, value, sub, icon: Icon }: { label: string; value: string | number; sub?: string; icon: React.ElementType }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function ABTestSection({ campaign }: { campaign: Campaign }) {
  const aOpenRate = parseFloat(pct(campaign.variant_a_opened, campaign.variant_a_sent));
  const bOpenRate = parseFloat(pct(campaign.variant_b_opened, campaign.variant_b_sent));
  const aReplyRate = parseFloat(pct(campaign.variant_a_replied, campaign.variant_a_sent));
  const bReplyRate = parseFloat(pct(campaign.variant_b_replied, campaign.variant_b_sent));

  const aScore = aOpenRate + aReplyRate * 2;
  const bScore = bOpenRate + bReplyRate * 2;
  const winner = aScore > bScore ? "A" : bScore > aScore ? "B" : null;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">A/B Test Results</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className={winner === "A" ? "ring-2 ring-green-500" : ""}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Variant A</CardTitle>
              {winner === "A" && (
                <Badge className="bg-green-100 text-green-800"><Trophy className="mr-1 h-3 w-3" /> Winner</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">{campaign.variant_a_subject || "No subject"}</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div><div className="text-2xl font-bold">{campaign.variant_a_sent}</div><div className="text-xs text-muted-foreground">Sent</div></div>
              <div><div className="text-2xl font-bold">{aOpenRate}%</div><div className="text-xs text-muted-foreground">Open Rate</div></div>
              <div><div className="text-2xl font-bold">{aReplyRate}%</div><div className="text-xs text-muted-foreground">Reply Rate</div></div>
            </div>
          </CardContent>
        </Card>
        <Card className={winner === "B" ? "ring-2 ring-green-500" : ""}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Variant B</CardTitle>
              {winner === "B" && (
                <Badge className="bg-green-100 text-green-800"><Trophy className="mr-1 h-3 w-3" /> Winner</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">{campaign.variant_b_subject || "No subject"}</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div><div className="text-2xl font-bold">{campaign.variant_b_sent}</div><div className="text-xs text-muted-foreground">Sent</div></div>
              <div><div className="text-2xl font-bold">{bOpenRate}%</div><div className="text-xs text-muted-foreground">Open Rate</div></div>
              <div><div className="text-2xl font-bold">{bReplyRate}%</div><div className="text-xs text-muted-foreground">Reply Rate</div></div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function CampaignDetail({ campaign }: { campaign: Campaign }) {
  const [classifyingIcp, setClassifyingIcp] = useState(false);
  const [icpResult, setIcpResult] = useState<{ processed: number; summary?: Record<string, number> } | null>(null);
  const [leads, setLeads] = useState(campaign.leads);
  const [icpFilter, setIcpFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"default" | "icp_asc" | "icp_desc">("default");

  const handleClassifyIcp = async () => {
    setClassifyingIcp(true);
    try {
      const companyIds = leads.map((l) => l.company_id).filter(Boolean);
      const res = await fetch("/api/v1/sales/agents/icp-classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyIds }),
      });
      const data = await res.json();
      setIcpResult({ processed: data.data?.processed || data.processed || 0, summary: data.data?.summary });

      // Refresh leads with ICP data
      if (data.data?.results) {
        const tierMap = new Map(data.data.results.map((r: { id: string; tier: string; score: number }) => [r.id, r]));
        setLeads((prev) =>
          prev.map((l) => {
            const result = tierMap.get(l.company_id);
            if (result) {
              return { ...l, icp_tier: (result as { tier: string }).tier, icp_score: (result as { score: number }).score };
            }
            return l;
          })
        );
      }
    } finally {
      setClassifyingIcp(false);
    }
  };

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/campaigns">
              <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">{campaign.name}</h1>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="secondary">{campaign.type.replace("_", " ")}</Badge>
                <Badge className={campaign.status === "active" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}>
                  {campaign.status}
                </Badge>
                {campaign.instantly_campaign_id && (
                  <Badge variant="outline"><Zap className="mr-1 h-3 w-3" /> Instantly</Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleClassifyIcp}
              disabled={classifyingIcp}
            >
              <Sparkles className={`mr-2 h-4 w-4 ${classifyingIcp ? "animate-spin" : ""}`} />
              {classifyingIcp ? "Classifying..." : "Classify ICP"}
            </Button>
            {campaign.instantly_campaign_id && (
              <a href={`https://app.instantly.ai/campaigns/${campaign.instantly_campaign_id}`} target="_blank" rel="noopener">
                <Button variant="outline" size="sm">
                  <ExternalLink className="mr-2 h-4 w-4" /> Open in Instantly
                </Button>
              </a>
            )}
          </div>
        </div>

        {campaign.description && (
          <p className="text-muted-foreground">{campaign.description}</p>
        )}

        {/* ICP Classification Result Banner */}
        {icpResult && (
          <Card className="border-green-200 bg-green-50">
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-4">
                <Sparkles className="h-5 w-5 text-green-600" />
                <span className="text-sm font-medium text-green-800">
                  Classified {icpResult.processed} leads
                </span>
                {icpResult.summary && (
                  <div className="flex gap-2">
                    {Object.entries(icpResult.summary).map(([tier, count]) => (
                      <Badge key={tier} className={ICP_COLORS[tier] || ""}>
                        {tier}: {count}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Metrics */}
        <div className="grid gap-4 md:grid-cols-5">
          <MetricCard label="Sent" value={campaign.sent.toLocaleString()} icon={Send} />
          <MetricCard label="Opened" value={`${pct(campaign.opened, campaign.sent)}%`} sub={`${campaign.opened.toLocaleString()} emails`} icon={Eye} />
          <MetricCard label="Replied" value={`${pct(campaign.replied, campaign.sent)}%`} sub={`${campaign.replied.toLocaleString()} replies`} icon={MessageSquare} />
          <MetricCard label="Bounced" value={`${pct(campaign.bounced, campaign.sent)}%`} sub={`${campaign.bounced} emails`} icon={AlertTriangle} />
          <MetricCard label="Meetings" value={campaign.meetings_booked} sub={`${campaign.orders_placed} orders`} icon={Trophy} />
        </div>

        {campaign.type === "ab_test" && <ABTestSection campaign={campaign} />}

        {/* Leads Table */}
        <Tabs defaultValue="all">
          <div className="flex items-center justify-between">
            <TabsList>
              <TabsTrigger value="all">All Leads ({campaign.lead_count})</TabsTrigger>
              <TabsTrigger value="replied">Replied ({campaign.reply_count})</TabsTrigger>
            </TabsList>
            <div className="flex gap-2">
              <Select value={icpFilter} onValueChange={setIcpFilter}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="ICP Tier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Tiers</SelectItem>
                  <SelectItem value="A">Tier A</SelectItem>
                  <SelectItem value="B">Tier B</SelectItem>
                  <SelectItem value="C">Tier C</SelectItem>
                  <SelectItem value="D">Tier D</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem>
                  <SelectItem value="icp_desc">ICP: Best first</SelectItem>
                  <SelectItem value="icp_asc">ICP: Worst first</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <TabsContent value="all">
            <LeadTable leads={leads} icpFilter={icpFilter} sortBy={sortBy} />
          </TabsContent>
          <TabsContent value="replied">
            <LeadTable leads={leads.filter((l) => l.status === "replied")} icpFilter={icpFilter} sortBy={sortBy} />
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}

function LeadTable({ leads, icpFilter, sortBy }: { leads: Lead[]; icpFilter: string; sortBy: string }) {
  const tierOrder: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, F: 5 };

  const processed = useMemo(() => {
    let result = [...leads];
    if (icpFilter !== "all") {
      result = result.filter((l) => l.icp_tier === icpFilter);
    }
    if (sortBy === "icp_desc") {
      result.sort((a, b) => (tierOrder[a.icp_tier || "F"] || 5) - (tierOrder[b.icp_tier || "F"] || 5));
    } else if (sortBy === "icp_asc") {
      result.sort((a, b) => (tierOrder[b.icp_tier || "F"] || 5) - (tierOrder[a.icp_tier || "F"] || 5));
    }
    return result;
  }, [leads, icpFilter, sortBy]);

  const [expandedReasoning, setExpandedReasoning] = useState<string | null>(null);

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Contact</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>ICP</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Classification</TableHead>
            <TableHead>Reply</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {processed.map((l) => (
            <>
              <TableRow key={l.id}>
                <TableCell className="font-medium">
                  {[l.first_name, l.last_name].filter(Boolean).join(" ") || "—"}
                </TableCell>
                <TableCell>{l.company_name}</TableCell>
                <TableCell>
                  {l.icp_tier ? (
                    <div className="flex items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge className={`${ICP_COLORS[l.icp_tier] || ""} cursor-pointer`}>
                            {l.icp_tier}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="font-semibold">Score: {l.icp_score}/100</p>
                          <p className="text-xs mt-1">{l.icp_reasoning || "No reasoning available"}</p>
                        </TooltipContent>
                      </Tooltip>
                      {l.icp_reasoning && (
                        <button
                          onClick={() => setExpandedReasoning(expandedReasoning === l.id ? null : l.id)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {expandedReasoning === l.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{l.email || "—"}</TableCell>
                <TableCell>
                  <Badge className={STATUS_COLORS[l.status] || ""} variant="secondary">
                    {l.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {l.reply_classification ? (
                    <Badge className={CLASSIFICATION_COLORS[l.reply_classification] || ""} variant="secondary">
                      {l.reply_classification.replace("_", " ")}
                    </Badge>
                  ) : "—"}
                </TableCell>
                <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                  {l.reply_text || "—"}
                </TableCell>
              </TableRow>
              {expandedReasoning === l.id && l.icp_reasoning && (
                <TableRow key={`${l.id}-reasoning`}>
                  <TableCell colSpan={7} className="bg-muted/50 py-2 px-4">
                    <div className="text-sm">
                      <span className="font-medium">ICP Reasoning:</span>{" "}
                      <span className="text-muted-foreground">{l.icp_reasoning}</span>
                      {l.icp_score != null && <span className="ml-2 text-xs">(Score: {l.icp_score}/100)</span>}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </>
          ))}
          {processed.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                No leads found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
