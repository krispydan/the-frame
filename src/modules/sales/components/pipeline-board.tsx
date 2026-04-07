"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
  DEAL_STAGE_COLORS,
  DEAL_CHANNELS,
  type DealStage,
} from "@/modules/sales/schema/pipeline";
import {
  Plus,
  Clock,
  RefreshCw,
  GripVertical,
  ChevronRight,
  Phone,
  Store,
  Globe,
  ShoppingBag,
  CircleDot,
  Calendar,
  Filter,
} from "lucide-react";
import { formatDistanceToNow, differenceInDays, format } from "date-fns";

interface Deal {
  id: string;
  company_id: string;
  company_name: string;
  company_city: string;
  company_state: string;
  title: string;
  value: number | null;
  stage: string;
  channel: string | null;
  owner_id: string | null;
  snooze_until: string | null;
  snooze_reason: string | null;
  last_activity_at: string;
  created_at: string;
  reorder_due_at: string | null;
}

interface StageSummary {
  stage: string;
  label: string;
  count: number;
  totalValue: number;
}

interface Props {
  deals: Deal[];
  stageSummaries: StageSummary[];
  companies: { id: string; name: string; city: string; state: string }[];
  users: { id: string; name: string; email: string }[];
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  shopify: <ShoppingBag className="h-3 w-3" />,
  faire: <Store className="h-3 w-3" />,
  phone: <Phone className="h-3 w-3" />,
  direct: <Globe className="h-3 w-3" />,
  other: <CircleDot className="h-3 w-3" />,
};

const CHANNEL_COLORS: Record<string, string> = {
  shopify: "bg-green-100 text-green-700",
  faire: "bg-purple-100 text-purple-700",
  phone: "bg-blue-100 text-blue-700",
  direct: "bg-gray-100 text-gray-700",
  other: "bg-gray-100 text-gray-500",
};

function formatCurrency(val: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(val);
}

// ── Deal Card ──
function DealCard({
  deal,
  onMoveStage,
  onOpenDetail,
  onDragStart,
}: {
  deal: Deal;
  onMoveStage: (dealId: string, newStage: DealStage) => void;
  onOpenDetail: (dealId: string) => void;
  onDragStart: (dealId: string) => void;
}) {
  const daysInStage = differenceInDays(new Date(), new Date(deal.created_at));
  const isSnoozed =
    deal.snooze_until && new Date(deal.snooze_until) > new Date();

  return (
    <Card
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", deal.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(deal.id);
      }}
      className="p-3 cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow border-l-4 group"
      style={{
        borderLeftColor: isSnoozed ? "#f59e0b" : undefined,
      }}
      onClick={() => onOpenDetail(deal.id)}
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-1.5 min-w-0 flex-1">
            <GripVertical className="h-4 w-4 mt-0.5 text-muted-foreground/50 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium text-sm truncate">{deal.company_name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {deal.company_city}, {deal.company_state}
              </p>
            </div>
          </div>
          {deal.value != null && deal.value > 0 && (
            <span className="text-sm font-semibold text-green-700 whitespace-nowrap">
              {formatCurrency(deal.value)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {deal.channel && (
            <Badge
              variant="secondary"
              className={`text-[10px] px-1.5 py-0 gap-1 ${CHANNEL_COLORS[deal.channel] || ""}`}
            >
              {CHANNEL_ICONS[deal.channel]}
              {deal.channel}
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
            <Clock className="h-2.5 w-2.5" />
            {daysInStage}d
          </Badge>
          {isSnoozed && (
            <Badge className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 gap-1">
              ⏰{" "}
              {formatDistanceToNow(new Date(deal.snooze_until!), {
                addSuffix: false,
              })}
            </Badge>
          )}
          {deal.reorder_due_at && deal.stage === "order_placed" && (
            <Badge className="text-[10px] px-1.5 py-0 bg-teal-100 text-teal-700 gap-1">
              <RefreshCw className="h-2.5 w-2.5" />
              {formatDistanceToNow(new Date(deal.reorder_due_at), {
                addSuffix: false,
              })}
            </Badge>
          )}
        </div>

        {/* Quick move buttons - show on hover */}
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {DEAL_STAGES.filter((s) => s !== deal.stage)
            .slice(0, 3)
            .map((s) => (
              <button
                key={s}
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveStage(deal.id, s);
                }}
                className={`text-[10px] px-1.5 py-0.5 rounded ${DEAL_STAGE_COLORS[s]} hover:opacity-80`}
              >
                {DEAL_STAGE_LABELS[s]}
              </button>
            ))}
        </div>
      </div>
    </Card>
  );
}

// ── New Deal Dialog ──
function NewDealDialog({
  companies,
  onCreated,
}: {
  companies: Props["companies"];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCompany, setSelectedCompany] = useState<string>("");
  const [stage, setStage] = useState<DealStage>("outreach");
  const [channel, setChannel] = useState<string>("");
  const [value, setValue] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const filteredCompanies = search.length >= 2
    ? companies.filter((c) =>
        c.name.toLowerCase().includes(search.toLowerCase())
      ).slice(0, 20)
    : [];

  async function handleCreate() {
    if (!selectedCompany) return;
    setSaving(true);
    const company = companies.find((c) => c.id === selectedCompany);
    await fetch("/api/v1/sales/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id: selectedCompany,
        title: company?.name || "New Deal",
        stage,
        channel: channel || undefined,
        value: value ? parseFloat(value) : undefined,
        notes: notes || undefined,
      }),
    });
    setSaving(false);
    setOpen(false);
    setSearch("");
    setSelectedCompany("");
    setValue("");
    setNotes("");
    onCreated();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
        <Plus className="h-4 w-4" /> New Deal
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Deal</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Company</Label>
            <Input
              placeholder="Search companies..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelectedCompany("");
              }}
            />
            {filteredCompanies.length > 0 && !selectedCompany && (
              <div className="border rounded-md mt-1 max-h-40 overflow-auto">
                {filteredCompanies.map((c) => (
                  <button
                    key={c.id}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent"
                    onClick={() => {
                      setSelectedCompany(c.id);
                      setSearch(c.name);
                    }}
                  >
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      {c.city}, {c.state}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Stage</Label>
              <Select value={stage} onValueChange={(v) => setStage(v as DealStage)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEAL_STAGES.map((s) => (
                    <SelectItem key={s} value={s}>{DEAL_STAGE_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Channel</Label>
              <Select value={channel} onValueChange={(v) => setChannel(v || "")}>
                <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                <SelectContent>
                  {DEAL_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Value ($)</Label>
            <Input type="number" placeholder="0" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea placeholder="Initial notes..." value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>

          <Button onClick={handleCreate} disabled={!selectedCompany || saving} className="w-full">
            {saving ? "Creating..." : "Create Deal"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Snoozed Tab ──
function SnoozedTab({ deals, onMoveStage, onOpenDetail }: { deals: Deal[]; onMoveStage: (id: string, stage: DealStage) => void; onOpenDetail: (id: string) => void }) {
  const snoozed = deals
    .filter((d) => d.snooze_until && new Date(d.snooze_until) > new Date())
    .sort((a, b) => new Date(a.snooze_until!).getTime() - new Date(b.snooze_until!).getTime());

  if (snoozed.length === 0) {
    return <div className="text-center text-muted-foreground py-12">No snoozed deals</div>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {snoozed.map((deal) => (
        <Card key={deal.id} className="p-4 cursor-pointer hover:shadow-md" onClick={() => onOpenDetail(deal.id)}>
          <div className="flex justify-between items-start mb-2">
            <div>
              <p className="font-medium">{deal.company_name}</p>
              <p className="text-xs text-muted-foreground">{deal.company_city}, {deal.company_state}</p>
            </div>
            <Badge className="bg-amber-100 text-amber-700">
              ⏰ Wakes {formatDistanceToNow(new Date(deal.snooze_until!), { addSuffix: true })}
            </Badge>
          </div>
          {deal.snooze_reason && <p className="text-sm text-muted-foreground mt-1">{deal.snooze_reason}</p>}
          <div className="flex gap-2 mt-3">
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onMoveStage(deal.id, (deal.stage || "outreach") as DealStage); }}>
              Wake Now
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Reorder Tab ──
function ReorderTab({ deals, onOpenDetail, onReengage }: { deals: Deal[]; onOpenDetail: (id: string) => void; onReengage: (deal: Deal) => void }) {
  const reorderDeals = deals
    .filter((d) => d.reorder_due_at && d.stage === "order_placed")
    .filter((d) => differenceInDays(new Date(d.reorder_due_at!), new Date()) <= 14)
    .sort((a, b) => new Date(a.reorder_due_at!).getTime() - new Date(b.reorder_due_at!).getTime());

  if (reorderDeals.length === 0) {
    return <div className="text-center text-muted-foreground py-12">No reorders due in the next 14 days</div>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {reorderDeals.map((deal) => {
        const daysUntil = differenceInDays(new Date(deal.reorder_due_at!), new Date());
        return (
          <Card key={deal.id} className="p-4 cursor-pointer hover:shadow-md" onClick={() => onOpenDetail(deal.id)}>
            <div className="flex justify-between items-start mb-2">
              <div>
                <p className="font-medium">{deal.company_name}</p>
                <p className="text-xs text-muted-foreground">{deal.company_city}, {deal.company_state}</p>
              </div>
              <Badge className={daysUntil <= 0 ? "bg-red-100 text-red-700" : "bg-teal-100 text-teal-700"}>
                {daysUntil <= 0 ? "Overdue" : `${daysUntil}d`}
              </Badge>
            </div>
            {deal.value && <p className="text-sm font-medium text-green-700">{formatCurrency(deal.value)}</p>}
            <Button size="sm" className="mt-3" onClick={(e) => { e.stopPropagation(); onReengage(deal); }}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Re-engage
            </Button>
          </Card>
        );
      })}
    </div>
  );
}

// ── Main Board ──
export function PipelineBoard({ deals: initialDeals, stageSummaries, companies, users }: Props) {
  const router = useRouter();
  const [deals, setDeals] = useState(initialDeals);
  const [activeTab, setActiveTab] = useState<"active" | "snoozed" | "reorder">("active");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const draggingDealId = useRef<string | null>(null);

  const filteredDeals = ownerFilter === "all" ? deals : deals.filter((d) => d.owner_id === ownerFilter);

  const refreshDeals = useCallback(async () => {
    const res = await fetch("/api/v1/sales/deals?limit=500");
    const json = await res.json();
    setDeals(json.data);
  }, []);

  async function moveStage(dealId: string, newStage: DealStage) {
    await fetch(`/api/v1/sales/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: newStage }),
    });
    setDeals((prev) =>
      prev.map((d) => (d.id === dealId ? { ...d, stage: newStage } : d))
    );
  }

  async function reengage(deal: Deal) {
    await fetch("/api/v1/sales/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id: deal.company_id,
        title: `Reorder: ${deal.company_name}`,
        stage: "outreach",
        channel: deal.channel,
      }),
    });
    refreshDeals();
  }

  function handleDrop(e: React.DragEvent, targetStage: DealStage) {
    e.preventDefault();
    setDragOverStage(null);
    const dealId = e.dataTransfer.getData("text/plain");
    if (!dealId) return;
    const deal = deals.find((d) => d.id === dealId);
    if (!deal || deal.stage === targetStage) return;
    moveStage(dealId, targetStage);
  }

  function openDetail(dealId: string) {
    router.push(`/pipeline/${dealId}`);
  }

  const tabs = [
    { key: "active" as const, label: "Active Pipeline", count: deals.filter((d) => !d.snooze_until || new Date(d.snooze_until) <= new Date()).length },
    { key: "snoozed" as const, label: "Snoozed", count: deals.filter((d) => d.snooze_until && new Date(d.snooze_until) > new Date()).length },
    { key: "reorder" as const, label: "Reorder Due", count: deals.filter((d) => d.reorder_due_at && d.stage === "order_placed" && differenceInDays(new Date(d.reorder_due_at), new Date()) <= 14).length },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            {deals.length} deals · {formatCurrency(deals.reduce((s, d) => s + (d.value || 0), 0))} total value
          </p>
        </div>
        <div className="flex items-center gap-3">
          {users.length > 0 && (
            <Select value={ownerFilter} onValueChange={(v) => setOwnerFilter(v || "all")}>
              <SelectTrigger className="w-40">
                <Filter className="h-3.5 w-3.5 mr-1.5" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Deals</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <NewDealDialog companies={companies} onCreated={refreshDeals} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted p-1 rounded-lg w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className="ml-2 bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === "active" && (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {DEAL_STAGES.map((stage) => {
            const stageDeals = filteredDeals.filter(
              (d) => d.stage === stage && (!d.snooze_until || new Date(d.snooze_until) <= new Date())
            );
            const totalValue = stageDeals.reduce((s, d) => s + (d.value || 0), 0);

            return (
              <div key={stage} className="flex-shrink-0 w-64 xl:w-72">
                {/* Column header */}
                <div className="mb-3 px-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${DEAL_STAGE_COLORS[stage]}`}>
                        {DEAL_STAGE_LABELS[stage]}
                      </span>
                      <span className="text-sm text-muted-foreground">{stageDeals.length}</span>
                    </div>
                  </div>
                  {totalValue > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">{formatCurrency(totalValue)}</p>
                  )}
                </div>

                {/* Cards — droppable column */}
                <div
                  className={`space-y-2 min-h-[200px] rounded-lg p-2 transition-colors ${
                    dragOverStage === stage ? "bg-primary/10 ring-2 ring-primary/20" : "bg-muted/30"
                  }`}
                  onDragOver={(e) => { e.preventDefault(); setDragOverStage(stage); }}
                  onDragLeave={() => setDragOverStage(null)}
                  onDrop={(e) => handleDrop(e, stage)}
                >
                  {stageDeals.map((deal) => (
                    <DealCard
                      key={deal.id}
                      deal={deal}
                      onMoveStage={moveStage}
                      onOpenDetail={openDetail}
                      onDragStart={(id) => { draggingDealId.current = id; }}
                    />
                  ))}
                  {stageDeals.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-8">
                      No deals
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === "snoozed" && (
        <SnoozedTab deals={filteredDeals} onMoveStage={moveStage} onOpenDetail={openDetail} />
      )}

      {activeTab === "reorder" && (
        <ReorderTab deals={filteredDeals} onOpenDetail={openDetail} onReengage={reengage} />
      )}
    </div>
  );
}
