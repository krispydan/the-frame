"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import Link from "next/link";
import {
  ArrowLeft, ArrowRight, Building2, Globe, Phone, Mail, MapPin, Tag, Star,
  Edit, UserPlus, MessageSquare, Clock, ExternalLink, Plus, Save, X,
  Briefcase, Sparkles, Loader2, CheckCircle2, AlertCircle, Search,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
  DEAL_CHANNELS,
  type DealStage,
} from "@/modules/sales/schema/pipeline";

interface Company {
  id: string; name: string; type: string; website: string; domain: string;
  phone: string; email: string; address: string; city: string; state: string; zip: string;
  status: string; source: string; icp_tier: string; icp_score: number; icp_reasoning: string;
  icp_manual_override?: number | boolean | null;
  icp_updated_by?: string | null;
  icp_updated_at?: string | null;
  owner_id: string; owner_name: string; tags: string[]; notes: string;
  google_rating: number; google_review_count: number;
  enrichment_status: string;
  google_place_id: string;
  owner_name: string;
  business_hours: Record<string, string>;
  facebook_url: string;
  instagram_url: string;
  twitter_url: string;
  linkedin_url: string;
  yelp_url: string;
  enriched_at: string;
  enrichment_source: string;
  disqualify_reason: string;
  segment: string;
  category: string;
  lead_source_detail: string;
  source_type: string | null;
  source_id: string | null;
  source_query: string | null;
  created_at: string; updated_at: string;
}

interface Store {
  id: string; company_id: string; name: string; is_primary: number;
  address: string; city: string; state: string; zip: string;
  phone: string; email: string; manager_name: string;
  google_place_id: string; google_rating: number;
  latitude: number; longitude: number; status: string; notes: string;
}

interface Contact {
  id: string; store_id: string; company_id: string;
  first_name: string; last_name: string; title: string;
  email: string; phone: string; is_primary: boolean; notes: string;
}

interface Activity {
  id: string; event_type: string; module: string;
  entity_type: string; entity_id: string;
  data: string; user_id: string; created_at: string;
}

const statusColors: Record<string, string> = {
  new: "bg-gray-100 text-gray-700",
  contacted: "bg-blue-100 text-blue-700",
  qualified: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  customer: "bg-purple-100 text-purple-700",
};

const statusLabels: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  rejected: "Not Qualified",
  customer: "Customer",
};

const tierColors: Record<string, string> = {
  A: "bg-green-500 text-white",
  B: "bg-yellow-500 text-white",
  C: "bg-orange-500 text-white",
  D: "bg-red-500 text-white",
  F: "bg-gray-500 text-white",
};

export default function CompanyDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setOverride } = useBreadcrumbOverride();
  const [adjacent, setAdjacent] = useState<{ prev: string | null; next: string | null; position: number | null; total: number | null }>({ prev: null, next: null, position: null, total: null });
  const [company, setCompany] = useState<Company | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState<Record<string, unknown>>({});
  const [newNote, setNewNote] = useState("");
  const [showAddContact, setShowAddContact] = useState<string | null>(null);
  const [icpEditorOpen, setIcpEditorOpen] = useState(false);
  const [icpDraft, setIcpDraft] = useState<{ tier: string; score: string; reasoning: string }>({ tier: "", score: "", reasoning: "" });
  const [icpSaving, setIcpSaving] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [editingContact, setEditingContact] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState<Record<string, string>>({});
  const updateContactForm = (key: string, value: string) => {
    if (key === "_reset") setContactForm({});
    else setContactForm(prev => ({ ...prev, [key]: value }));
  };
  const [statusDropdown, setStatusDropdown] = useState(false);
  const [createDealOpen, setCreateDealOpen] = useState(false);
  const [dealStage, setDealStage] = useState<DealStage>("outreach");
  const [dealChannel, setDealChannel] = useState("");
  const [dealValue, setDealValue] = useState("");
  const [dealNotes, setDealNotes] = useState("");
  const [dealSaving, setDealSaving] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [newlyEnrichedFields, setNewlyEnrichedFields] = useState<string[]>([]);
  const [showDisqualifyDialog, setShowDisqualifyDialog] = useState(false);
  const [disqualifyReason, setDisqualifyReason] = useState("");

  const enrichCompany = async () => {
    if (!company) return;
    setEnriching(true);
    setNewlyEnrichedFields([]);
    try {
      const res = await fetch(`/api/v1/prospects/${company.id}/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const result = await res.json();
      if (result.newFields) {
        setNewlyEnrichedFields(result.newFields);
        // Auto-clear badges after 30s
        setTimeout(() => setNewlyEnrichedFields([]), 30000);
      }
      // Refresh company data
      const data = await (await fetch(`/api/v1/sales/prospects/${id}`)).json();
      setCompany(data.company);
      setActivities(data.activities || []);
    } finally {
      setEnriching(false);
    }
  };

  const createDeal = async () => {
    if (!company) return;
    setDealSaving(true);
    const res = await fetch("/api/v1/sales/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_id: company.id,
        title: company.name,
        stage: dealStage,
        channel: dealChannel || undefined,
        value: dealValue ? parseFloat(dealValue) : undefined,
        notes: dealNotes || undefined,
      }),
    });
    if (res.ok) {
      const { id: dealId } = await res.json();
      setDealSaving(false);
      setCreateDealOpen(false);
      setDealStage("outreach");
      setDealChannel("");
      setDealValue("");
      setDealNotes("");
      router.push(`/pipeline/${dealId}`);
    } else {
      setDealSaving(false);
    }
  };

  useEffect(() => {
    fetch(`/api/v1/sales/prospects/${id}`)
      .then(r => r.json())
      .then(data => {
        setCompany(data.company);
        setStores(data.stores || []);
        setContacts(data.contacts || []);
        setActivities(data.activities || []);
        setLoading(false);
        if (data.company?.name) setOverride(data.company.name);
      })
      .catch(() => setLoading(false));

    // Fetch adjacent prospect IDs for prev/next navigation
    const qs = searchParams.toString();
    if (qs) {
      fetch(`/api/v1/sales/prospects/${id}/adjacent?${qs}`)
        .then(r => r.json())
        .then(data => setAdjacent(data))
        .catch(() => {});
    }

    return () => setOverride(null);
  }, [id, setOverride, searchParams]);

  // Keyboard shortcuts: Left/Right arrow for prev/next navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea/select or contentEditable
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return;

      const qs = searchParams.toString();
      const suffix = qs ? `?${qs}` : "";

      if (e.key === "ArrowLeft" && adjacent.prev) {
        e.preventDefault();
        router.push(`/prospects/${adjacent.prev}${suffix}`);
      } else if (e.key === "ArrowRight" && adjacent.next) {
        e.preventDefault();
        router.push(`/prospects/${adjacent.next}${suffix}`);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [adjacent, searchParams, router]);

  const updateCompany = async (fields: Record<string, unknown>) => {
    await fetch(`/api/v1/sales/prospects/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    // Refresh
    const data = await (await fetch(`/api/v1/sales/prospects/${id}`)).json();
    setCompany(data.company);
    setActivities(data.activities || []);
  };

  const addNote = async () => {
    if (!newNote.trim() || !company) return;
    const existing = company.notes || "";
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const updated = `[${stamp}] ${newNote}\n${existing}`;
    await updateCompany({ notes: updated });
    setNewNote("");
  };

  const changeStatus = async (status: string) => {
    if (status === "rejected") {
      setStatusDropdown(false);
      setShowDisqualifyDialog(true);
      return;
    }
    await updateCompany({ status });
    setStatusDropdown(false);
  };

  const confirmDisqualify = async () => {
    await updateCompany({ status: "rejected", disqualify_reason: disqualifyReason || null });
    setShowDisqualifyDialog(false);
    setDisqualifyReason("");
  };

  const saveEdit = async () => {
    await updateCompany(editFields);
    setEditing(false);
    setEditFields({});
  };

  const addContact = async (storeId: string | null) => {
    await fetch("/api/v1/sales/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...contactForm, store_id: storeId, company_id: id }),
    });
    const data = await (await fetch(`/api/v1/sales/prospects/${id}`)).json();
    setContacts(data.contacts || []);
    setShowAddContact(null);
    setContactForm({});
  };

  const updateContact = async (contactId: string) => {
    await fetch("/api/v1/sales/contacts", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: contactId, ...contactForm }),
    });
    const data = await (await fetch(`/api/v1/sales/prospects/${id}`)).json();
    setContacts(data.contacts || []);
    setEditingContact(null);
    setContactForm({});
  };

  if (loading) return (
    <div className="p-6">
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-48 bg-muted rounded" />
        <div className="h-64 bg-muted rounded-lg" />
      </div>
    </div>
  );
  if (!company) return (
    <div className="p-6 text-center py-16">
      <AlertCircle className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
      <p className="font-medium text-muted-foreground">Company not found</p>
      <Link href="/prospects" className="mt-4 inline-flex items-center gap-2 text-sm text-primary hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to Prospects
      </Link>
    </div>
  );

  const isSingleStore = stores.length <= 1;
  const primaryStore = stores.find(s => s.is_primary) || stores[0];
  const filterQs = searchParams.toString();
  const navSuffix = filterQs ? `?${filterQs}` : "";

  // Source badge colors
  const sourceColorMap: Record<string, string> = {
    "expansion-v1": "bg-blue-100 text-blue-700",
    "expansion-v2": "bg-blue-100 text-blue-700",
    "stockist": "bg-purple-100 text-purple-700",
    "storemapper": "bg-orange-100 text-orange-700",
    "goodr": "bg-green-100 text-green-700",
    "car-wash": "bg-red-100 text-red-700",
    "original": "bg-gray-100 text-gray-600",
  };

  return (
    <div className="p-4 md:p-6 max-w-full xl:max-w-[1200px] mx-auto">
      {/* Prev/Next Navigation */}
      {(adjacent.prev || adjacent.next || adjacent.position) && (
        <div className="flex items-center justify-between mb-3 px-3 py-1.5 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-sm">
          {adjacent.prev ? (
            <Link href={`/prospects/${adjacent.prev}${navSuffix}`} className="flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Previous</span>
            </Link>
          ) : (
            <span className="flex items-center gap-1 text-gray-300 dark:text-gray-600 cursor-not-allowed">
              <ArrowLeft className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Previous</span>
            </span>
          )}
          <span className="text-gray-500 dark:text-gray-400 tabular-nums">
            {adjacent.position && adjacent.total
              ? `Lead ${adjacent.position.toLocaleString()} of ${adjacent.total.toLocaleString()}`
              : <Link href={`/prospects${filterQs ? `?${filterQs}` : ""}`} className="hover:text-gray-800 dark:hover:text-gray-200">Back to List</Link>
            }
          </span>
          {adjacent.next ? (
            <Link href={`/prospects/${adjacent.next}${navSuffix}`} className="flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
              <span className="hidden sm:inline">Next</span> <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          ) : (
            <span className="flex items-center gap-1 text-gray-300 dark:text-gray-600 cursor-not-allowed">
              <span className="hidden sm:inline">Next</span> <ArrowRight className="w-3.5 h-3.5" />
            </span>
          )}
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
        <Link href="/prospects" className="flex items-center gap-1 hover:text-gray-700">
          <ArrowLeft className="w-4 h-4" /> Prospects
        </Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-white">{company.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xl font-bold shrink-0">
            {company.name.charAt(0)}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{company.name}</h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
              {company.city && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{company.city}, {company.state}</span>}
              {company.website && (
                <a href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
                  target="_blank" className="flex items-center gap-1 text-blue-600 hover:underline">
                  <Globe className="w-3.5 h-3.5" />{company.domain || company.website}
                </a>
              )}
              {company.source && <span className="text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">{company.source.split("|")[0]}</span>}
              <a href={`https://www.google.com/search?q=${encodeURIComponent(`${company.name} ${company.city || ""} ${company.state || ""}`.trim())}`}
                target="_blank"
                className={`flex items-center gap-1 hover:underline ${company.website ? "text-gray-400 hover:text-gray-600" : "text-blue-600 font-medium"}`}>
                <Search className="w-3.5 h-3.5" />{company.website ? "Google it" : "Search Google"}
              </a>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* ICP — clickable badge that opens the inline editor */}
          <div className="relative">
            <button
              onClick={() => {
                setIcpDraft({
                  tier: company.icp_tier || "",
                  score: company.icp_score != null ? String(company.icp_score) : "",
                  reasoning: company.icp_reasoning || "",
                });
                setIcpEditorOpen((o) => !o);
              }}
              className={`px-3 py-1.5 rounded-lg text-sm font-bold inline-flex items-center gap-1.5 ${
                company.icp_tier ? (tierColors[company.icp_tier] || "bg-gray-100") : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
              }`}
              title="Click to edit ICP tier and score"
            >
              ICP {company.icp_tier || "—"}{company.icp_score != null ? ` · ${company.icp_score}` : ""}
              {company.icp_manual_override ? (
                <span title={`Manually set${company.icp_updated_at ? " · " + new Date(company.icp_updated_at).toLocaleDateString() : ""}`}>✓</span>
              ) : null}
            </button>

            {icpEditorOpen && (
              <div className="absolute right-0 top-full mt-2 w-80 bg-white dark:bg-gray-800 border rounded-lg shadow-lg z-50 p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Tier</label>
                  <div className="flex gap-1">
                    {(["A", "B", "C", "D", "F"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setIcpDraft((d) => ({ ...d, tier: t }))}
                        className={`flex-1 py-1.5 rounded text-sm font-bold ${
                          icpDraft.tier === t
                            ? tierColors[t] || "bg-gray-200"
                            : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                    <button
                      onClick={() => setIcpDraft((d) => ({ ...d, tier: "" }))}
                      className={`flex-1 py-1.5 rounded text-sm ${
                        icpDraft.tier === ""
                          ? "bg-gray-300 dark:bg-gray-600"
                          : "bg-gray-100 dark:bg-gray-700 hover:bg-gray-200"
                      }`}
                    >
                      —
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Score (0–10)</label>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={icpDraft.score}
                    onChange={(e) => setIcpDraft((d) => ({ ...d, score: e.target.value }))}
                    className="w-full px-3 py-1.5 border rounded text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Reasoning</label>
                  <textarea
                    value={icpDraft.reasoning}
                    onChange={(e) => setIcpDraft((d) => ({ ...d, reasoning: e.target.value }))}
                    rows={3}
                    placeholder="Why this tier? (e.g. 12 LA boutique locations, exact ICP fit)"
                    className="w-full px-3 py-1.5 border rounded text-sm"
                  />
                </div>

                {company.icp_manual_override && (
                  <div className="text-xs text-muted-foreground">
                    ✓ Manually set{company.icp_updated_at ? ` on ${new Date(company.icp_updated_at).toLocaleString()}` : ""}.
                    Auto-classifier won&apos;t change this until you click Reclassify below.
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1 border-t">
                  <button
                    onClick={async () => {
                      setIcpSaving(true);
                      const body: Record<string, unknown> = {
                        icp_tier: icpDraft.tier || null,
                        icp_reasoning: icpDraft.reasoning || null,
                      };
                      if (icpDraft.score !== "") body.icp_score = Number(icpDraft.score);
                      try {
                        const r = await fetch(`/api/v1/sales/prospects/${id}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(body),
                        });
                        if (r.ok) {
                          setIcpEditorOpen(false);
                          // Refetch the company
                          const cr = await fetch(`/api/v1/sales/prospects/${id}`);
                          if (cr.ok) setCompany(await cr.json());
                        }
                      } finally {
                        setIcpSaving(false);
                      }
                    }}
                    disabled={icpSaving}
                    className="flex-1 px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                  >
                    {icpSaving ? "Saving..." : "Save"}
                  </button>
                  <button
                    onClick={async () => {
                      if (!confirm("Re-classify this prospect using the auto-classifier? Your manual override will be cleared.")) return;
                      setReclassifying(true);
                      try {
                        const r = await fetch(`/api/v1/sales/prospects/${id}/reclassify`, { method: "POST" });
                        if (r.ok) {
                          setIcpEditorOpen(false);
                          const cr = await fetch(`/api/v1/sales/prospects/${id}`);
                          if (cr.ok) setCompany(await cr.json());
                        }
                      } finally {
                        setReclassifying(false);
                      }
                    }}
                    disabled={reclassifying}
                    className="px-3 py-1.5 border rounded text-sm font-medium hover:bg-muted disabled:opacity-50"
                    title="Clear manual override and let the classifier re-rate"
                  >
                    {reclassifying ? "..." : "↻ Reclassify"}
                  </button>
                  <button
                    onClick={() => setIcpEditorOpen(false)}
                    className="px-3 py-1.5 border rounded text-sm hover:bg-muted"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>


          {/* Status dropdown */}
          <div className="relative">
            <button onClick={() => setStatusDropdown(!statusDropdown)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${statusColors[company.status] || "bg-gray-100"}`}>
              {statusLabels[company.status] || company.status}
            </button>
            {statusDropdown && (
              <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 border rounded-lg shadow-lg z-50 py-1 w-40">
                {["new", "contacted", "qualified", "rejected", "customer"].map(s => (
                  <button key={s} onClick={() => changeStatus(s)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${s === company.status ? "font-bold" : ""}`}>
                    {statusLabels[s] || s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <Dialog open={createDealOpen} onOpenChange={setCreateDealOpen}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>
              <Briefcase className="w-4 h-4 mr-1" /> Create Deal
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Create Deal — {company.name}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Stage</Label>
                    <Select value={dealStage} onValueChange={(v) => setDealStage(v as DealStage)}>
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
                    <Select value={dealChannel} onValueChange={(v) => setDealChannel(v || "")}>
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
                  <Input type="number" placeholder="0" value={dealValue} onChange={(e) => setDealValue(e.target.value)} />
                </div>
                <div>
                  <Label>Notes</Label>
                  <Textarea placeholder="Initial notes..." value={dealNotes} onChange={(e) => setDealNotes(e.target.value)} rows={2} />
                </div>
                <Button onClick={createDeal} disabled={dealSaving} className="w-full">
                  {dealSaving ? "Creating..." : "Create Deal"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          {/* Disqualify confirmation dialog */}
          <Dialog open={showDisqualifyDialog} onOpenChange={setShowDisqualifyDialog}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Disqualify Prospect?</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  This will mark <strong>{company.name}</strong> as Not Qualified and hide them from the default prospect list.
                </p>
                <div>
                  <Label>Reason (optional)</Label>
                  <Textarea
                    placeholder="Why is this prospect not qualified?"
                    value={disqualifyReason}
                    onChange={(e) => setDisqualifyReason(e.target.value)}
                    rows={3}
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" onClick={() => { setShowDisqualifyDialog(false); setDisqualifyReason(""); }}>
                    Cancel
                  </Button>
                  <Button onClick={confirmDisqualify} className="bg-red-600 hover:bg-red-700 text-white">
                    Disqualify
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Enrichment status + button */}
          {company.enrichment_status === "enriched" ? (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-green-100 text-green-700">
              <CheckCircle2 className="w-4 h-4" /> Enriched
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={enrichCompany} disabled={enriching || company.enrichment_status === "queued"}>
              {enriching || company.enrichment_status === "queued" ? (
                <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Enriching...</>
              ) : company.enrichment_status === "failed" ? (
                <><AlertCircle className="w-4 h-4 mr-1 text-red-500" /> Retry Enrich</>
              ) : (
                <><Sparkles className="w-4 h-4 mr-1" /> Enrich</>
              )}
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={() => { setEditing(!editing); setEditFields({}); }}>
            <Edit className="w-4 h-4 mr-1" /> Edit
          </Button>
        </div>
      </div>

      {/* Edit mode */}
      {editing && (
        <Card className="mb-6 border-blue-200 bg-blue-50/50">
          <CardContent className="pt-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {[
                { key: "name", label: "Name", val: company.name },
                { key: "email", label: "Email", val: company.email },
                { key: "phone", label: "Phone", val: company.phone },
                { key: "website", label: "Website", val: company.website },
                { key: "address", label: "Address", val: company.address },
                { key: "city", label: "City", val: company.city },
                { key: "state", label: "State", val: company.state },
                { key: "zip", label: "ZIP", val: company.zip },
              ].map(f => (
                <div key={f.key}>
                  <label className="text-xs text-gray-500">{f.label}</label>
                  <input className="w-full px-2 py-1.5 border rounded text-sm dark:bg-gray-700 dark:border-gray-600"
                    defaultValue={f.val || ""}
                    onChange={e => setEditFields(prev => ({ ...prev, [f.key]: e.target.value }))} />
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3 justify-end">
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}><X className="w-4 h-4 mr-1" />Cancel</Button>
              <Button size="sm" onClick={saveEdit}><Save className="w-4 h-4 mr-1" />Save</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Company Info Card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Company Info</CardTitle>
            </CardHeader>
            <CardContent>
              {company.status === "rejected" && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <p className="text-sm font-medium text-red-800 dark:text-red-300">⛔ Not Qualified</p>
                  {company.disqualify_reason && (
                    <p className="text-sm text-red-600 dark:text-red-400 mt-1">{company.disqualify_reason}</p>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <InfoRow icon={<Mail className="w-4 h-4" />} label="Email" value={company.email} isNew={newlyEnrichedFields.includes("email")} />
                <InfoRow icon={<Phone className="w-4 h-4" />} label="Phone" value={company.phone} isNew={newlyEnrichedFields.includes("phone")} />
                <InfoRow icon={<MapPin className="w-4 h-4" />} label="Address"
                  value={[company.address, company.city, company.state, company.zip].filter(Boolean).join(", ")} />
                <InfoRow icon={<Globe className="w-4 h-4" />} label="Website" value={company.website} link isNew={newlyEnrichedFields.includes("website")} />
                {company.instagram_url && (
                  <InstagramRow url={company.instagram_url} isNew={newlyEnrichedFields.includes("instagram_url")} />
                )}
                {company.owner_name && <InfoRow icon={<UserPlus className="w-4 h-4" />} label="Owner" value={company.owner_name} isNew={newlyEnrichedFields.includes("owner_name")} />}
                {company.google_rating && (
                  <InfoRow icon={<Star className="w-4 h-4" />} label="Rating"
                    value={`${company.google_rating}★ (${company.google_review_count} reviews)`}
                    isNew={newlyEnrichedFields.includes("google_rating")} />
                )}
              </div>
              {/* Social Media Links */}
              {(company.facebook_url || company.instagram_url || company.twitter_url || company.linkedin_url || company.yelp_url) && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {company.facebook_url && (
                    <a href={company.facebook_url} target="_blank" className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 ${newlyEnrichedFields.includes("facebook_url") ? "ring-2 ring-green-400" : ""}`}>
                      Facebook <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {company.instagram_url && (
                    <a href={company.instagram_url} target="_blank" className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-pink-50 text-pink-700 hover:bg-pink-100 ${newlyEnrichedFields.includes("instagram_url") ? "ring-2 ring-green-400" : ""}`}>
                      Instagram <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {company.twitter_url && (
                    <a href={company.twitter_url} target="_blank" className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-50 text-sky-700 hover:bg-sky-100 ${newlyEnrichedFields.includes("twitter_url") ? "ring-2 ring-green-400" : ""}`}>
                      Twitter/X <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {company.linkedin_url && (
                    <a href={company.linkedin_url} target="_blank" className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 text-blue-800 hover:bg-blue-100 ${newlyEnrichedFields.includes("linkedin_url") ? "ring-2 ring-green-400" : ""}`}>
                      LinkedIn <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {company.yelp_url && (
                    <a href={company.yelp_url} target="_blank" className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-50 text-red-700 hover:bg-red-100 ${newlyEnrichedFields.includes("yelp_url") ? "ring-2 ring-green-400" : ""}`}>
                      Yelp <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              )}
              {/* Tags */}
              {company.tags?.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {company.tags.map(t => (
                    <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                  ))}
                </div>
              )}
              {/* ICP reasoning */}
              {company.icp_reasoning && (
                <div className="mt-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg text-sm text-gray-600 dark:text-gray-400">
                  <span className="font-medium text-gray-800 dark:text-gray-200">ICP Analysis: </span>
                  {company.icp_reasoning}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Stores & Contacts */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  {isSingleStore ? "Store & Contacts" : `Stores (${stores.length})`}
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {stores.length === 0 ? (
                <p className="text-sm text-gray-400">No stores linked to this company</p>
              ) : isSingleStore && primaryStore ? (
                // Single store: merged view
                <div>
                  <div className="grid grid-cols-2 gap-3 text-sm mb-4">
                    {primaryStore.address && <InfoRow icon={<MapPin className="w-4 h-4" />} label="Store Address"
                      value={[primaryStore.address, primaryStore.city, primaryStore.state, primaryStore.zip].filter(Boolean).join(", ")} />}
                    {primaryStore.phone && <InfoRow icon={<Phone className="w-4 h-4" />} label="Store Phone" value={primaryStore.phone} />}
                    {primaryStore.manager_name && <InfoRow icon={<UserPlus className="w-4 h-4" />} label="Manager" value={primaryStore.manager_name} />}
                    {primaryStore.google_rating && (
                      <InfoRow icon={<Star className="w-4 h-4" />} label="Google Rating" value={`${primaryStore.google_rating}★`} />
                    )}
                  </div>
                  <Separator className="my-4" />
                  <ContactsList
                    contacts={contacts.filter(c => !c.store_id || c.store_id === primaryStore.id)}
                    storeId={primaryStore.id}
                    companyId={company.id}
                    showAddContact={showAddContact}
                    setShowAddContact={setShowAddContact}
                    editingContact={editingContact}
                    setEditingContact={setEditingContact}
                    contactForm={contactForm}
                    setContactForm={updateContactForm}
                    addContact={addContact}
                    updateContact={updateContact}
                  />
                </div>
              ) : (
                // Multi-store: accordion-style
                <div className="space-y-4">
                  {stores.map(store => {
                    const storeContacts = contacts.filter(c => c.store_id === store.id);
                    return (
                      <div key={store.id} className="border rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <h4 className="font-medium text-sm flex items-center gap-2">
                              <Building2 className="w-4 h-4 text-gray-400" />
                              {store.name}
                              {store.is_primary ? <Badge variant="secondary" className="text-[10px]">Primary</Badge> : null}
                            </h4>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {[store.address, store.city, store.state].filter(Boolean).join(", ")}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-gray-500">
                            {store.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{store.phone}</span>}
                            {store.google_rating && <span>{store.google_rating}★</span>}
                          </div>
                        </div>
                        <ContactsList
                          contacts={storeContacts}
                          storeId={store.id}
                          companyId={company.id}
                          showAddContact={showAddContact}
                          setShowAddContact={setShowAddContact}
                          editingContact={editingContact}
                          setEditingContact={setEditingContact}
                          contactForm={contactForm}
                          setContactForm={updateContactForm}
                          addContact={addContact}
                          updateContact={updateContact}
                        />
                      </div>
                    );
                  })}
                  {/* Unlinked contacts */}
                  {contacts.filter(c => !c.store_id).length > 0 && (
                    <div className="border rounded-lg p-4 border-dashed">
                      <h4 className="font-medium text-sm text-gray-500 mb-2">Unlinked Contacts</h4>
                      <ContactsList
                        contacts={contacts.filter(c => !c.store_id)}
                        storeId={null}
                        companyId={company.id}
                        showAddContact={showAddContact}
                        setShowAddContact={setShowAddContact}
                        editingContact={editingContact}
                        setEditingContact={setEditingContact}
                        contactForm={contactForm}
                        setContactForm={updateContactForm}
                        addContact={addContact}
                        updateContact={updateContact}
                      />
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right sidebar */}
        <div className="space-y-6">
          {/* Lead Source */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Lead Source</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Source Type Badge (clickable — links to filtered list) */}
              {company.source_type && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Source Type</p>
                  <Link
                    href={`/prospects?${new URLSearchParams({ source_type: company.source_type, ...(company.source_id ? { source_id: company.source_id } : {}) })}`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors cursor-pointer"
                  >
                    {company.source_type === "storemapper" ? "🗺 StoreMapper" :
                     company.source_type === "outscraper" ? "🔍 Outscraper" :
                     company.source_type === "manual" ? "✋ Manual" :
                     company.source_type === "csv" ? "📄 CSV Import" :
                     company.source_type === "chrome-ext" ? "🌐 Chrome Extension" :
                     company.source_type}
                    {company.source_id && <span className="font-mono opacity-75">#{company.source_id}</span>}
                    <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
              )}
              {company.source_query && (
                <div>
                  <p className="text-xs text-gray-500">Source Query</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 italic">&ldquo;{company.source_query}&rdquo;</p>
                </div>
              )}
              {/* Legacy source display */}
              {company.source ? (
                <div className="flex flex-wrap gap-1.5">
                  {company.source.split("|").map(s => s.trim()).filter(Boolean).map(s => (
                    <span key={s} className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${sourceColorMap[s] || "bg-gray-100 text-gray-600"}`}>
                      {s}
                    </span>
                  ))}
                </div>
              ) : !company.source_type ? (
                <p className="text-sm text-gray-400">Unknown source</p>
              ) : null}
              {company.segment && (
                <div>
                  <p className="text-xs text-gray-500">Segment</p>
                  <p className="text-sm text-gray-900 dark:text-gray-100">{company.segment}</p>
                </div>
              )}
              {company.category && (
                <div>
                  <p className="text-xs text-gray-500">Category</p>
                  <p className="text-sm text-gray-900 dark:text-gray-100">{company.category}</p>
                </div>
              )}
              {company.lead_source_detail && (
                <div>
                  <p className="text-xs text-gray-500">Detail</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">{company.lead_source_detail}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 mb-3">
                <textarea placeholder="Add a note..." value={newNote} onChange={e => setNewNote(e.target.value)}
                  className="flex-1 px-3 py-2 border rounded-lg text-sm resize-none h-16 dark:bg-gray-800 dark:border-gray-700" />
                <Button size="sm" onClick={addNote} disabled={!newNote.trim()} className="self-end">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              {company.notes ? (
                <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {company.notes}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No notes yet</p>
              )}
            </CardContent>
          </Card>

          {/* Activity Timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {activities.length === 0 ? (
                <p className="text-sm text-gray-400">No activity yet</p>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {activities.slice(0, 20).map(a => {
                    let data: Record<string, unknown> = {};
                    try { data = JSON.parse(a.data as string); } catch {}
                    return (
                      <div key={a.id} className="flex gap-3 text-sm">
                        <div className="w-2 h-2 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                        <div>
                          <p className="text-gray-700 dark:text-gray-300">
                            {a.event_type === "change" && (
                              <><span className="font-medium">{String(data.field)}</span> changed
                                {data.old ? <> from <code className="text-xs bg-gray-100 px-1 rounded">{String(data.old).slice(0, 30)}</code></> : ""}
                                {data.new ? <> to <code className="text-xs bg-gray-100 px-1 rounded">{String(data.new).slice(0, 30)}</code></> : ""}
                              </>
                            )}
                            {a.event_type === "company_updated" && "Company updated"}
                            {a.event_type === "contact_created" && "New contact added"}
                            {a.event_type === "status_change" && `Status changed`}
                            {!["change", "company_updated", "contact_created", "status_change"].includes(a.event_type) && a.event_type}
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {a.created_at ? new Date(a.created_at + "Z").toLocaleString() : "—"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * Pull the @handle out of an Instagram URL.
 * Accepts:
 *   https://www.instagram.com/handle/         -> handle
 *   https://instagram.com/handle              -> handle
 *   instagram.com/handle/?utm=...             -> handle
 *   https://www.instagram.com/handle/p/abc/   -> handle (drops the post path)
 *   @handle                                    -> handle
 *   handle                                     -> handle
 */
function extractInstagramHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  const cleaned = url.trim().replace(/^@/, "");
  // Try to parse as URL first
  const m = cleaned.match(/(?:^|\/\/)(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/i);
  if (m) return m[1];
  // Plain handle (no scheme/host)
  if (/^[A-Za-z0-9._]+$/.test(cleaned)) return cleaned;
  return null;
}

function InstagramRow({ url, isNew }: { url: string; isNew?: boolean }) {
  const [copied, setCopied] = useState(false);
  const handle = extractInstagramHandle(url);
  const display = handle ? `@${handle}` : url;
  const copyValue = handle ? `@${handle}` : url;
  const igUrl = handle ? `https://www.instagram.com/${handle}` : url;

  return (
    <div className="flex items-start gap-2">
      <span className="text-pink-500 mt-0.5">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.6 5.6 0 0 0-2.03 1.32A5.6 5.6 0 0 0 .79 3.98C.49 4.74.29 5.62.23 6.89.17 8.17.16 8.58.16 11.84s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91a5.6 5.6 0 0 0 1.32 2.03 5.6 5.6 0 0 0 2.03 1.32c.76.3 1.64.5 2.91.56 1.28.06 1.69.07 4.95.07s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.6 5.6 0 0 0 2.03-1.32 5.6 5.6 0 0 0 1.32-2.03c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.6 5.6 0 0 0-1.32-2.03A5.6 5.6 0 0 0 19.86.63C19.1.33 18.22.13 16.95.07 15.67.01 15.26 0 12 0Zm0 5.84a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32Zm0 10.16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm6.41-10.4a1.44 1.44 0 1 0 0-2.88 1.44 1.44 0 0 0 0 2.88Z"/></svg>
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-gray-500 flex items-center gap-1.5">
          Instagram
          {isNew && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 animate-pulse">NEW</span>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <a
            href={igUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-pink-700 dark:text-pink-400 hover:underline font-medium truncate"
            title="Open Instagram profile"
          >
            {display}
          </a>
          <button
            onClick={async (e) => {
              e.preventDefault();
              try {
                await navigator.clipboard.writeText(copyValue);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch { /* clipboard unavailable */ }
            }}
            className="text-xs text-gray-500 hover:text-pink-600 hover:bg-pink-50 dark:hover:bg-pink-950 rounded px-1.5 py-0.5"
            title="Copy handle to clipboard"
          >
            {copied ? "✓" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ icon, label, value, link, isNew }: { icon: React.ReactNode; label: string; value: string | null; link?: boolean; isNew?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2">
      <span className="text-gray-400 mt-0.5">{icon}</span>
      <div>
        <p className="text-xs text-gray-500 flex items-center gap-1.5">
          {label}
          {isNew && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 animate-pulse">
              NEW
            </span>
          )}
        </p>
        {link ? (
          <a href={value.startsWith("http") ? value : `https://${value}`} target="_blank"
            className="text-blue-600 hover:underline flex items-center gap-1">
            {value} <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <p className={`text-gray-900 dark:text-gray-100 ${isNew ? "font-medium text-green-700 dark:text-green-400" : ""}`}>{value}</p>
        )}
      </div>
    </div>
  );
}

function ContactsList({
  contacts, storeId, companyId,
  showAddContact, setShowAddContact,
  editingContact, setEditingContact,
  contactForm, setContactForm,
  addContact, updateContact,
}: {
  contacts: Contact[];
  storeId: string | null;
  companyId: string;
  showAddContact: string | null;
  setShowAddContact: (v: string | null) => void;
  editingContact: string | null;
  setEditingContact: (v: string | null) => void;
  contactForm: Record<string, string>;
  setContactForm: (key: string, value: string) => void;
  addContact: (storeId: string | null) => Promise<void>;
  updateContact: (contactId: string) => Promise<void>;
}) {
  const formKey = storeId || "none";

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-xs font-semibold text-gray-500 uppercase">Contacts ({contacts.length})</h5>
        <Button variant="ghost" size="sm" className="h-7 text-xs"
          onClick={() => { setShowAddContact(formKey); setContactForm("_reset", ""); }}>
          <Plus className="w-3 h-3 mr-1" /> Add
        </Button>
      </div>

      {contacts.length === 0 && showAddContact !== formKey && (
        <p className="text-xs text-gray-400 mb-2">No contacts</p>
      )}

      {/* Contact rows */}
      <div className="space-y-2">
        {contacts.map(c => (
          <div key={c.id}>
            {editingContact === c.id ? (
              <div className="border rounded-lg p-3 bg-blue-50/50 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input placeholder="First name" className="px-2 py-1 border rounded text-sm"
                    defaultValue={c.first_name || ""}
                    onChange={e => setContactForm("first_name", e.target.value)} />
                  <input placeholder="Last name" className="px-2 py-1 border rounded text-sm"
                    defaultValue={c.last_name || ""}
                    onChange={e => setContactForm("last_name", e.target.value)} />
                  <input placeholder="Title" className="px-2 py-1 border rounded text-sm"
                    defaultValue={c.title || ""}
                    onChange={e => setContactForm("title", e.target.value)} />
                  <input placeholder="Email" className="px-2 py-1 border rounded text-sm"
                    defaultValue={c.email || ""}
                    onChange={e => setContactForm("email", e.target.value)} />
                  <input placeholder="Phone" className="px-2 py-1 border rounded text-sm"
                    defaultValue={c.phone || ""}
                    onChange={e => setContactForm("phone", e.target.value)} />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" size="sm" onClick={() => setEditingContact(null)}>Cancel</Button>
                  <Button size="sm" onClick={() => updateContact(c.id)}>Save</Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800 group">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-xs font-medium">
                    {(c.first_name?.[0] || "?")}{(c.last_name?.[0] || "")}
                  </div>
                  <div>
                    <div className="text-sm font-medium flex items-center gap-1.5">
                      {[c.first_name, c.last_name].filter(Boolean).join(" ") || "Unknown"}
                      {c.is_primary && <Badge variant="secondary" className="text-[10px] px-1">Primary</Badge>}
                    </div>
                    <div className="text-xs text-gray-500 flex items-center gap-3">
                      {c.title && <span>{c.title}</span>}
                      {c.email && <span className="flex items-center gap-0.5"><Mail className="w-3 h-3" />{c.email}</span>}
                      {c.phone && <span className="flex items-center gap-0.5"><Phone className="w-3 h-3" />{c.phone}</span>}
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 h-7 text-xs"
                  onClick={() => { setEditingContact(c.id); setContactForm("_reset", ""); }}>
                  <Edit className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add contact form */}
      {showAddContact === formKey && (
        <div className="border rounded-lg p-3 bg-green-50/50 mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="First name" className="px-2 py-1 border rounded text-sm"
              onChange={e => setContactForm("first_name", e.target.value)} />
            <input placeholder="Last name" className="px-2 py-1 border rounded text-sm"
              onChange={e => setContactForm("last_name", e.target.value)} />
            <input placeholder="Title" className="px-2 py-1 border rounded text-sm"
              onChange={e => setContactForm("title", e.target.value)} />
            <input placeholder="Email" className="px-2 py-1 border rounded text-sm"
              onChange={e => setContactForm("email", e.target.value)} />
            <input placeholder="Phone" className="px-2 py-1 border rounded text-sm"
              onChange={e => setContactForm("phone", e.target.value)} />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowAddContact(null)}>Cancel</Button>
            <Button size="sm" onClick={() => addContact(storeId)}>Add Contact</Button>
          </div>
        </div>
      )}
    </div>
  );
}
