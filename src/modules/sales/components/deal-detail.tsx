"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
  DEAL_STAGE_COLORS,
  ACTIVITY_TYPES,
  type DealStage,
  type ActivityType,
} from "@/modules/sales/schema/pipeline";
import { ActivityTimeline } from "./activity-timeline";
import {
  ArrowLeft,
  Clock,
  Phone,
  Mail,
  Globe,
  MapPin,
  User,
  Calendar,
  Pause,
  ChevronRight,
  Trash2,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";

interface DealData {
  id: string;
  company_id: string;
  company_name: string;
  company_city: string;
  company_state: string;
  company_email: string | null;
  company_phone: string | null;
  company_website: string | null;
  title: string;
  value: number | null;
  stage: string;
  channel: string | null;
  owner_id: string | null;
  snooze_until: string | null;
  snooze_reason: string | null;
  last_activity_at: string | null;
  created_at: string | null;
  icp_tier: string | null;
  icp_score: number | null;
}

interface ContactData {
  id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
}

interface Props {
  deal: DealData;
  activities: Record<string, unknown>[];
  contacts: ContactData[];
  users: { id: string; name: string }[];
}

export function DealDetail({ deal, activities: initialActivities, contacts, users }: Props) {
  const router = useRouter();
  const { setOverride } = useBreadcrumbOverride();
  useEffect(() => {
    if (deal.company_name) setOverride(deal.company_name);
    return () => setOverride(null);
  }, [deal.company_name, setOverride]);
  const [activities, setActivities] = useState(initialActivities);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState("");
  const [snoozeReason, setSnoozeReason] = useState("");

  async function changeStage(newStage: DealStage) {
    await fetch(`/api/v1/sales/deals/${deal.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: newStage }),
    });
    router.refresh();
  }

  async function changeOwner(ownerId: string) {
    await fetch(`/api/v1/sales/deals/${deal.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: ownerId }),
    });
    router.refresh();
  }

  async function snoozeDeal() {
    if (!snoozeDate) return;
    await fetch(`/api/v1/sales/deals/${deal.id}/snooze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ until: snoozeDate, reason: snoozeReason }),
    });
    setSnoozeOpen(false);
    router.refresh();
  }

  async function unsnoozeDeal() {
    await fetch(`/api/v1/sales/deals/${deal.id}/snooze`, { method: "DELETE" });
    router.refresh();
  }

  async function addActivity(type: ActivityType, description: string) {
    const res = await fetch(`/api/v1/sales/deals/${deal.id}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, description }),
    });
    if (res.ok) {
      const newAct = {
        id: (await res.json()).id,
        deal_id: deal.id,
        type,
        description,
        created_at: new Date().toISOString(),
      };
      setActivities((prev) => [newAct, ...prev]);
    }
  }

  async function deleteDeal() {
    if (!confirm("Delete this deal? This cannot be undone.")) return;
    await fetch(`/api/v1/sales/deals/${deal.id}`, { method: "DELETE" });
    router.push("/pipeline");
  }

  const isSnoozed = deal.snooze_until ? new Date(deal.snooze_until) > new Date() : false;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={() => router.push("/pipeline")}>
        <ArrowLeft className="h-4 w-4 mr-1.5" /> Pipeline
      </Button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{deal.company_name}</h1>
          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            {deal.company_city}, {deal.company_state}
            {deal.value != null && (
              <>
                <span>·</span>
                <span className="font-medium text-green-700">
                  ${Number(deal.value).toLocaleString()}
                </span>
              </>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="text-destructive" onClick={deleteDeal}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Stage bar */}
      <div className="flex gap-1">
        {DEAL_STAGES.map((s) => (
          <button
            key={s}
            onClick={() => changeStage(s)}
            className={`flex-1 py-2 text-xs font-medium rounded transition-colors ${
              s === deal.stage
                ? DEAL_STAGE_COLORS[s] + " ring-2 ring-offset-1 ring-primary/30"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {DEAL_STAGE_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Snooze banner */}
      {isSnoozed && (
        <Card className="p-3 bg-amber-50 border-amber-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            <span className="text-sm">
              Snoozed until {format(new Date(deal.snooze_until!), "MMM d, yyyy")}
              {deal.snooze_reason && <span className="text-muted-foreground"> — {deal.snooze_reason}</span>}
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={unsnoozeDeal}>Wake Now</Button>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left column: details + contacts */}
        <div className="md:col-span-1 space-y-4">
          <Card className="p-4 space-y-3">
            <h3 className="font-semibold text-sm">Deal Info</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Channel</span>
                <Badge variant="secondary">{(deal.channel) || "—"}</Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{deal.created_at ? format(new Date(deal.created_at), "MMM d, yyyy") : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Activity</span>
                <span>{deal.last_activity_at ? formatDistanceToNow(new Date(deal.last_activity_at), { addSuffix: true }) : "—"}</span>
              </div>
              {deal.icp_tier && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">ICP</span>
                  <Badge>{deal.icp_tier} ({deal.icp_score})</Badge>
                </div>
              )}
            </div>
          </Card>

          {/* Owner */}
          <Card className="p-4 space-y-2">
            <h3 className="font-semibold text-sm">Owner</h3>
            <Select value={(deal.owner_id) || ""} onValueChange={(v) => v && changeOwner(v)}>
              <SelectTrigger><SelectValue placeholder="Assign owner..." /></SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Card>

          {/* Company contact info */}
          <Card className="p-4 space-y-2">
            <h3 className="font-semibold text-sm">Company</h3>
            <div className="space-y-1.5 text-sm">
              {deal.company_email && (
                <a href={`mailto:${deal.company_email}`} className="flex items-center gap-2 text-blue-600 hover:underline">
                  <Mail className="h-3.5 w-3.5" /> {deal.company_email}
                </a>
              )}
              {deal.company_phone && (
                <a href={`tel:${deal.company_phone}`} className="flex items-center gap-2 text-blue-600 hover:underline">
                  <Phone className="h-3.5 w-3.5" /> {deal.company_phone}
                </a>
              )}
              {deal.company_website && (
                <a href={deal.company_website} target="_blank" className="flex items-center gap-2 text-blue-600 hover:underline">
                  <Globe className="h-3.5 w-3.5" /> {deal.company_website}
                </a>
              )}
            </div>
          </Card>

          {/* Contacts */}
          {contacts.length > 0 && (
            <Card className="p-4 space-y-2">
              <h3 className="font-semibold text-sm">Contacts</h3>
              {contacts.map((c) => (
                <div key={c.id} className="text-sm border-b last:border-0 pb-2 last:pb-0">
                  <p className="font-medium">{c.first_name} {c.last_name}</p>
                  {c.title && <p className="text-xs text-muted-foreground">{c.title}</p>}
                  {c.email && <p className="text-xs">{c.email}</p>}
                  {c.phone && <p className="text-xs">{c.phone}</p>}
                </div>
              ))}
            </Card>
          )}

          {/* Quick actions */}
          <div className="flex flex-col gap-2">
            <Dialog open={snoozeOpen} onOpenChange={setSnoozeOpen}>
              <DialogTrigger
                render={<Button variant="outline" size="sm" className="w-full gap-1.5" />}
              >
                <Pause className="h-3.5 w-3.5" /> Snooze
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Snooze Deal</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label>Wake Date</Label>
                    <Input type="date" value={snoozeDate} onChange={(e) => setSnoozeDate(e.target.value)} />
                  </div>
                  <div>
                    <Label>Reason (optional)</Label>
                    <Input value={snoozeReason} onChange={(e) => setSnoozeReason(e.target.value)} placeholder="e.g. Wait for new collection" />
                  </div>
                  <Button onClick={snoozeDeal} disabled={!snoozeDate} className="w-full">Snooze</Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Right column: activity timeline */}
        <div className="md:col-span-2">
          <ActivityTimeline activities={activities} onAddActivity={addActivity} />
        </div>
      </div>
    </div>
  );
}
