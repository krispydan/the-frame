"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Mail, Users, TrendingUp, DollarSign, Play, Pause, Settings, Eye, MousePointer, Send } from "lucide-react";

type Campaign = {
  name: string;
  status: string;
  recipients: number;
  opens: number;
  clicks: number;
  revenue: number;
};

type Flow = {
  name: string;
  status: "active" | "paused" | "draft";
  emails: number;
  recipients: number;
  revenue: number;
};

type KlaviyoData = {
  configured: boolean;
  subscribers: number;
  campaigns: Campaign[];
  flows: Flow[];
  segments: { name: string; members: number }[];
  performance: { totalSent: number; avgOpenRate: number; avgClickRate: number; totalRevenue: number };
};

export function KlaviyoTab() {
  const [data, setData] = useState<KlaviyoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);
  const [apiKey, setApiKey] = useState("");

  const load = useCallback(() => {
    fetch("/api/v1/marketing/klaviyo").then(r => r.json()).then(d => { setData(d); setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveConfig = async () => {
    await fetch("/api/v1/marketing/klaviyo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }) });
    setShowConfig(false);
    load();
  };

  if (loading) return <div className="animate-pulse h-96 bg-muted rounded-lg" />;
  if (!data) return null;

  const openRate = data.performance.avgOpenRate;
  const clickRate = data.performance.avgClickRate;

  return (
    <div className="space-y-6">
      {/* Config Banner */}
      {!data.configured && (
        <Card className="border-yellow-200 bg-yellow-50">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-yellow-800">
              <Settings className="h-5 w-5" />
              <span className="text-sm font-medium">Klaviyo API key not configured — showing demo data</span>
            </div>
            <button onClick={() => setShowConfig(!showConfig)} className="px-3 py-1.5 text-sm font-medium rounded-md bg-yellow-600 text-white hover:bg-yellow-700">
              Configure
            </button>
          </CardContent>
          {showConfig && (
            <CardContent className="border-t border-yellow-200 pt-3">
              <div className="flex gap-2">
                <input type="password" placeholder="pk_xxxxxxxxxxxx" value={apiKey} onChange={e => setApiKey(e.target.value)} className="flex-1 px-3 py-2 rounded-md border text-sm bg-white" />
                <button onClick={saveConfig} disabled={!apiKey.trim()} className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Save</button>
              </div>
              <p className="text-xs text-yellow-700 mt-2">Find your API key at Settings → API Keys in Klaviyo. Uses read-only private key.</p>
            </CardContent>
          )}
        </Card>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Users className="h-4 w-4" />Subscribers</div>
            <div className="text-3xl font-bold mt-1">{data.subscribers.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Eye className="h-4 w-4" />Avg Open Rate</div>
            <div className="text-3xl font-bold mt-1">{openRate}%</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><MousePointer className="h-4 w-4" />Avg Click Rate</div>
            <div className="text-3xl font-bold mt-1">{clickRate}%</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><DollarSign className="h-4 w-4 text-green-600" />Email Revenue</div>
            <div className="text-3xl font-bold mt-1 text-green-600">${data.performance.totalRevenue.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      {/* Flows */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5" />Flows</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Flow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Emails</TableHead>
                <TableHead className="text-right">Recipients</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.flows.map(f => (
                <TableRow key={f.name}>
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell>
                    <Badge variant={f.status === "active" ? "default" : "outline"} className={f.status === "active" ? "bg-green-100 text-green-800" : f.status === "paused" ? "bg-yellow-100 text-yellow-800" : ""}>
                      {f.status === "active" ? <Play className="h-3 w-3 mr-1" /> : <Pause className="h-3 w-3 mr-1" />}
                      {f.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{f.emails}</TableCell>
                  <TableCell className="text-right">{f.recipients.toLocaleString()}</TableCell>
                  <TableCell className="text-right">${f.revenue.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Campaigns */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Mail className="h-5 w-5" />Campaigns</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Recipients</TableHead>
                <TableHead className="text-right">Opens</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.campaigns.map(c => (
                <TableRow key={c.name}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell><Badge variant={c.status === "sent" ? "default" : "outline"}>{c.status}</Badge></TableCell>
                  <TableCell className="text-right">{c.recipients.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{c.opens}</TableCell>
                  <TableCell className="text-right">{c.clicks}</TableCell>
                  <TableCell className="text-right">${c.revenue.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Segments */}
      <Card>
        <CardHeader><CardTitle>Segments</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Segment</TableHead><TableHead className="text-right">Members</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {data.segments.map(s => (
                <TableRow key={s.name}><TableCell>{s.name}</TableCell><TableCell className="text-right">{s.members.toLocaleString()}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
