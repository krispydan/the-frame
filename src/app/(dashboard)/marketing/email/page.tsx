"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, Mail, Image as ImageIcon, Calendar as CalendarIcon } from "lucide-react";

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
  "draft",
  "copywriting",
  "photography",
  "design_review",
  "scheduled",
  "sent",
  "analyzed",
] as const;

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  copywriting: "Copywriting",
  photography: "Photography",
  design_review: "Design review",
  scheduled: "Scheduled",
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
          <Link href="/marketing/calendar">
            <Button variant="outline">
              <CalendarIcon className="h-4 w-4 mr-2" />
              Calendar
            </Button>
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sensible defaults: next slot (Mon for retail, Tue for wholesale)
  const today = new Date();
  const day = today.getDay() || 7;
  const daysUntilNextMon = day === 1 ? 7 : 8 - day;
  const nextMon = new Date(today);
  nextMon.setDate(today.getDate() + daysUntilNextMon);
  const defaultDate = nextMon.toISOString().slice(0, 10);

  const [form, setForm] = useState({
    name: "",
    audience: "retail" as "retail" | "wholesale",
    scheduledDate: defaultDate,
    briefTitle: "",
    briefAngle: "",
    briefProductHook: "",
    briefSeasonalContext: "",
  });

  function update<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/marketing/email/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else if (data.campaign) {
        onCreated(data.campaign);
        // Reset form for next use, close modal
        setForm({
          name: "",
          audience: "retail",
          scheduledDate: defaultDate,
          briefTitle: "",
          briefAngle: "",
          briefProductHook: "",
          briefSeasonalContext: "",
        });
        setOpen(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-2" />
        New campaign
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-background border rounded-lg max-w-2xl w-full max-h-[90vh] overflow-auto"
            onClick={e => e.stopPropagation()}
          >
            <form onSubmit={submit} className="p-6 space-y-4">
              <div>
                <h2 className="text-xl font-semibold">New email campaign</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  The brief is what AI uses to generate everything. Be specific —
                  what&apos;s the angle, the product hook, why this email now.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Name (your internal label)</label>
                  <input
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    placeholder="e.g. Honey drop wk 1"
                    value={form.name}
                    onChange={e => update("name", e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Audience</label>
                  <select
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={form.audience}
                    onChange={e => update("audience", e.target.value as "retail" | "wholesale")}
                  >
                    <option value="retail">Retail (DTC)</option>
                    <option value="wholesale">Wholesale (Christina)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Scheduled date</label>
                  <input
                    type="date"
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={form.scheduledDate}
                    onChange={e => update("scheduledDate", e.target.value)}
                    required
                  />
                </div>
              </div>

              <hr className="border-border" />

              <div>
                <h3 className="text-sm font-medium mb-2">Campaign brief</h3>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Title (3–8 words)</label>
                    <input
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                      placeholder="e.g. Sunday Drive in Honey lands"
                      value={form.briefTitle}
                      onChange={e => update("briefTitle", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Angle (why this email, why now — 1–3 sentences)</label>
                    <textarea
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      rows={4}
                      placeholder="First time we've offered this colorway. Honey sits between amber and caramel — the warmest tortoise we've ever produced. Lead with the wait-list-energy."
                      value={form.briefAngle}
                      onChange={e => update("briefAngle", e.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Product hook (optional)</label>
                      <input
                        className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                        placeholder="SKU / category / colorway"
                        value={form.briefProductHook}
                        onChange={e => update("briefProductHook", e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Seasonal context (optional)</label>
                      <input
                        className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                        placeholder="holiday / weather / cultural anchor"
                        value={form.briefSeasonalContext}
                        onChange={e => update("briefSeasonalContext", e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {error && (
                <div className="text-sm text-destructive">{error}</div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Create campaign"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
