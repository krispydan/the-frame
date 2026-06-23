"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, Mail, Image as ImageIcon } from "lucide-react";

type Campaign = {
  id: string;
  audience: "retail" | "wholesale";
  scheduledDate: string;
  weekOf: string | null;
  status: string;
  subject: string | null;
  heroHeadline: string | null;
  createdAt: string;
};

const STATUS_ORDER = [
  "idea",
  "themed",
  "copy_pending",
  "copy_review",
  "image_pending",
  "image_review",
  "preview_ready",
  "exported",
  "sent",
  "analyzed",
] as const;

const STATUS_LABELS: Record<string, string> = {
  idea: "Idea",
  themed: "Themed",
  copy_pending: "Copy pending",
  copy_review: "Copy review",
  image_pending: "Image pending",
  image_review: "Image review",
  preview_ready: "Preview ready",
  exported: "Exported",
  sent: "Sent",
  analyzed: "Analyzed",
};

export default function EmailAssistantDashboard() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/marketing/email/campaigns")
      .then((r) => r.json())
      .then((data) => {
        setCampaigns(data.campaigns ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Group by status for pipeline chips
  const statusCounts: Record<string, number> = {};
  for (const s of STATUS_ORDER) statusCounts[s] = 0;
  for (const c of campaigns) {
    statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
  }

  // Identify "this week" (Mon–Sun of the week containing today)
  const today = new Date();
  const monday = new Date(today);
  const dow = today.getDay() || 7;
  monday.setDate(today.getDate() - (dow - 1));
  const mondayIso = monday.toISOString().slice(0, 10);
  const thisWeek = campaigns.filter((c) => c.weekOf === mondayIso);

  const designerQueueCount =
    statusCounts["image_pending"] + statusCounts["image_review"];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Email Assistant</h1>
          <p className="text-muted-foreground">
            Weekly email pipeline — ideation, copy, designer handoff, export.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/marketing/email/calendar">
            <Button variant="outline">Calendar</Button>
          </Link>
          <Link href="/marketing/email/designer-queue">
            <Button variant="outline" className="relative">
              <ImageIcon className="h-4 w-4 mr-2" />
              Designer queue
              {designerQueueCount > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {designerQueueCount}
                </Badge>
              )}
            </Button>
          </Link>
          <NewCampaignButton onCreated={(c) => setCampaigns((cs) => [c, ...cs])} />
        </div>
      </div>

      {/* Status pipeline */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-2">
            {STATUS_ORDER.map((s) => (
              <div
                key={s}
                className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
              >
                <span className="text-muted-foreground">{STATUS_LABELS[s]}</span>
                <span className="font-medium">{statusCounts[s]}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* This week */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">This week ({mondayIso})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : thisWeek.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No emails scheduled this week.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {thisWeek.map((c) => (
                <Link
                  key={c.id}
                  href={`/marketing/email/campaigns/${c.id}`}
                  className="block rounded-lg border p-3 hover:bg-accent"
                >
                  <div className="flex items-center justify-between mb-2">
                    <Badge
                      variant={c.audience === "wholesale" ? "default" : "outline"}
                    >
                      {c.audience}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {c.scheduledDate}
                    </span>
                  </div>
                  <div className="font-medium text-sm leading-snug">
                    {c.subject ?? c.heroHeadline ?? "(no subject yet)"}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {STATUS_LABELS[c.status]}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* All campaigns */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All campaigns</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : campaigns.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              <Mail className="inline h-4 w-4 mr-1" />
              No campaigns yet. Click <strong>New campaign</strong> to start.
            </div>
          ) : (
            <div className="divide-y">
              {campaigns.map((c) => (
                <Link
                  key={c.id}
                  href={`/marketing/email/campaigns/${c.id}`}
                  className="flex items-center justify-between py-2 hover:bg-accent rounded px-2 -mx-2"
                >
                  <div className="flex items-center gap-3">
                    <Badge
                      variant={c.audience === "wholesale" ? "default" : "outline"}
                    >
                      {c.audience}
                    </Badge>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {c.scheduledDate}
                    </span>
                    <span className="text-sm">
                      {c.subject ?? c.heroHeadline ?? "(no subject)"}
                    </span>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {STATUS_LABELS[c.status]}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NewCampaignButton({ onCreated }: { onCreated: (c: Campaign) => void }) {
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      // Default: schedule for next Monday, retail. User can change.
      const today = new Date();
      const day = today.getDay() || 7;
      const daysUntilNextMon = day === 1 ? 7 : 8 - day;
      const next = new Date(today);
      next.setDate(today.getDate() + daysUntilNextMon);
      const iso = next.toISOString().slice(0, 10);

      const res = await fetch("/api/v1/marketing/email/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience: "retail", scheduledDate: iso }),
      });
      const data = await res.json();
      if (data.campaign) onCreated(data.campaign);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus className="h-4 w-4 mr-2" />
      {busy ? "Creating…" : "New campaign"}
    </Button>
  );
}
