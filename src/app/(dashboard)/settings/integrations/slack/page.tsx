"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, Sparkles, Send, RefreshCw, CheckCircle, AlertCircle, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";

type Routing = {
  topic: string;
  label: string;
  group: string;
  description: string;
  defaultChannel: string;
  channelId: string | null;
  channelName: string | null;
  enabled: boolean;
  updatedAt: string | null;
};

type RecentMessage = {
  id: string;
  topic: string | null;
  channelName: string | null;
  textPreview: string | null;
  ok: boolean | null;
  error: string | null;
  sentAt: string | null;
};

type Status = {
  configured: boolean;
  auth: { ok: boolean; team?: string; user?: string; error?: string };
  routing: Routing[];
  recentMessages: RecentMessage[];
};

export default function SlackIntegrationsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [edits, setEdits] = useState<Record<string, { channelName: string; enabled: boolean }>>({});
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/v1/integrations/slack");
    const data = await res.json();
    setStatus(data);
    // seed edits from saved values so the inputs are controlled
    const seed: Record<string, { channelName: string; enabled: boolean }> = {};
    for (const r of (data.routing || []) as Routing[]) {
      seed[r.topic] = { channelName: r.channelName ?? "", enabled: r.enabled };
    }
    setEdits(seed);
  }

  useEffect(() => { load(); }, []);

  function setEdit(topic: string, patch: { channelName?: string; enabled?: boolean }) {
    setEdits((cur) => ({ ...cur, [topic]: { ...cur[topic], ...patch } }));
  }

  async function applyDefaults() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/integrations/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "applyDefaults" }),
      });
      const data = await res.json();
      const failed = (data.results || []).filter((r: { ok: boolean }) => !r.ok);
      if (failed.length > 0) {
        toast.warning(`Filled most defaults, but ${failed.length} channel${failed.length === 1 ? "" : "s"} were not found in your workspace. Create them or rename and try again.`);
      } else {
        toast.success("Default channel mappings applied. Review and Save.");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveAll() {
    setBusy(true);
    try {
      const mappings = Object.entries(edits).map(([topic, e]) => ({
        topic,
        channelName: e.channelName.trim() || null,
        enabled: e.enabled,
      }));
      const res = await fetch("/api/v1/integrations/slack", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings }),
      });
      const data = await res.json();
      const failed = (data.results || []).filter((r: { ok: boolean }) => !r.ok);
      const ok = (data.results || []).filter((r: { ok: boolean }) => r.ok);
      if (failed.length > 0) {
        const firstError = failed[0]?.error || "see details";
        toast.warning(`Saved ${ok.length} mapping${ok.length === 1 ? "" : "s"}. ${failed.length} failed: ${firstError}`);
      } else {
        toast.success(`Saved ${ok.length} mapping${ok.length === 1 ? "" : "s"}.`);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function testRoute(topic: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/integrations/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", topic }),
      });
      const data = await res.json();
      if (data.ok) toast.success("Test message sent ✓");
      else toast.error(`Test failed: ${data.error || "unknown"}`);
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return <div className="container mx-auto p-6 max-w-5xl"><Loader2 className="h-4 w-4 inline animate-spin mr-2" />Loading...</div>;
  }

  // Group routing by category for nicer rendering
  const grouped: Record<string, Routing[]> = {};
  for (const r of status.routing) {
    (grouped[r.group] ||= []).push(r);
  }
  const groupOrder = ["Orders", "Stock", "Ops", "Finance", "Digests"];

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <MessageSquare className="h-7 w-7" />
          Slack
        </h1>
        <p className="text-muted-foreground mt-2">
          Route notifications from the-frame to your Slack workspace. Each topic posts to the channel you map below.
        </p>
      </div>

      {/* Connection card */}
      {!status.configured ? (
        <Card>
          <CardHeader>
            <CardTitle>Slack bot not configured</CardTitle>
            <CardDescription>
              Set <code>SLACK_BOT_TOKEN</code> in Railway. The token starts with <code>xoxb-</code> and comes from your Slack app&apos;s OAuth & Permissions page.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : !status.auth.ok ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Slack authentication failed</AlertTitle>
          <AlertDescription>{status.auth.error || "Unknown error"}. Check that SLACK_BOT_TOKEN in Railway is correct.</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span>Connected</span>
              <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle className="h-3 w-3 mr-1" />Healthy</Badge>
            </CardTitle>
            <CardDescription>
              Workspace <span className="font-medium text-foreground">{status.auth.team}</span> · Bot <span className="font-medium text-foreground">{status.auth.user}</span>
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Routing card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between">
            <span>Channel routing</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={load} disabled={busy}><RefreshCw className="h-3 w-3 mr-1" />Refresh</Button>
              <Button variant="outline" size="sm" onClick={applyDefaults} disabled={busy}><Sparkles className="h-3 w-3 mr-1" />Apply defaults</Button>
              <Button size="sm" onClick={saveAll} disabled={busy}><Save className="h-3 w-3 mr-1" />Save all</Button>
            </div>
          </CardTitle>
          <CardDescription>
            Map each notification topic to a Slack channel. Type the channel name (with or without <code>#</code>) and we&apos;ll resolve it. The bot posts via{" "}
            <code>chat:write.public</code> so it doesn&apos;t need to be invited to public channels.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {groupOrder.filter((g) => grouped[g]).map((group) => (
            <div key={group} className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{group}</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[35%]">Topic</TableHead>
                    <TableHead className="w-[35%]">Channel</TableHead>
                    <TableHead className="w-[15%]">On</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grouped[group].map((r) => (
                    <TableRow key={r.topic}>
                      <TableCell>
                        <div className="font-medium">{r.label}</div>
                        <div className="text-xs text-muted-foreground">{r.description}</div>
                      </TableCell>
                      <TableCell>
                        <Input
                          value={edits[r.topic]?.channelName ?? ""}
                          onChange={(e) => setEdit(r.topic, { channelName: e.target.value })}
                          placeholder={`#${r.defaultChannel}`}
                          className="font-mono text-sm"
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={edits[r.topic]?.enabled ?? true}
                          onCheckedChange={(v) => setEdit(r.topic, { enabled: v })}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!r.channelId || busy}
                          onClick={() => testRoute(r.topic)}
                        >
                          <Send className="h-3 w-3 mr-1" />Test
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Recent messages */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Recent messages</CardTitle>
          <CardDescription>Last 15 messages the-frame attempted to send to Slack.</CardDescription>
        </CardHeader>
        <CardContent>
          {status.recentMessages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages sent yet. Click Test on a topic above to confirm routing works.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Topic</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="w-[40%]">Preview</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.recentMessages.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="text-xs text-muted-foreground">{m.sentAt ? new Date(m.sentAt).toLocaleTimeString() : "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{m.topic ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{m.channelName ?? "—"}</TableCell>
                    <TableCell>
                      {m.ok ? (
                        <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle className="h-3 w-3 mr-1" />Sent</Badge>
                      ) : (
                        <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />{m.error?.slice(0, 30) || "Failed"}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground truncate">{m.textPreview ?? ""}</TableCell>
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
