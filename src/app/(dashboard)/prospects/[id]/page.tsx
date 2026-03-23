"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import Link from "next/link";
import {
  ArrowLeft, ArrowRight, Building2, Globe, Phone, Mail, MapPin, Tag, Star,
  Edit, UserPlus, MessageSquare, Clock, ExternalLink, Plus, Save, X,
  Briefcase, Sparkles, Loader2, CheckCircle2, AlertCircle,
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
  owner_id: string; owner_name: string; tags: string[]; notes: string;
  google_rating: number; google_review_count: number;
  enrichment_status: string;
  google_place_id: string;
  disqualify_reason: string;
  segment: string;
  category: string;
  lead_source_detail: string;
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
  const [adjacent, setAdjacent] = useState<{ prev: string | null; next: string | null }>({ prev: null, next: null });
  const [company, setCompany] = useState<Company | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState<Record<string, unknown>>({});
  const [newNote, setNewNote] = useState("");
  const [showAddContact, setShowAddContact] = useState<string | null>(null);
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
  const [showDisqualifyDialog, setShowDisqualifyDialog] = useState(false);
  const [disqualifyReason, setDisqualifyReason] = useState("");

  const enrichCompany = async () => {
    if (!company) return;
    setEnriching(true);
    try {
      await fetch("/api/v1/sales/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyIds: [company.id] }),
      });
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
    <div className="p-6 max-w-[1200px] mx-auto">
      {/* Prev/Next Navigation */}
      {(adjacent.prev || adjacent.next) && (
        <div className="flex items-center justify-between mb-3 px-2 py-1.5 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-sm">
          {adjacent.prev ? (
            <Link href={`/prospects/${adjacent.prev}${navSuffix}`} className="flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
              <ArrowLeft className="w-3.5 h-3.5" /> Previous
            </Link>
          ) : <span />}
          <Link href={`/prospects${filterQs ? `?${filterQs}` : ""}`} className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
            Back to List
          </Link>
          {adjacent.next ? (
            <Link href={`/prospects/${adjacent.next}${navSuffix}`} className="flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
              Next <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          ) : <span />}
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
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* ICP Badge */}
          {company.icp_tier && (
            <div className={`px-3 py-1.5 rounded-lg text-sm font-bold ${tierColors[company.icp_tier] || "bg-gray-100"}`}>
              ICP {company.icp_tier} · {company.icp_score}
            </div>
          )}

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
                <InfoRow icon={<Mail className="w-4 h-4" />} label="Email" value={company.email} />
                <InfoRow icon={<Phone className="w-4 h-4" />} label="Phone" value={company.phone} />
                <InfoRow icon={<MapPin className="w-4 h-4" />} label="Address"
                  value={[company.address, company.city, company.state, company.zip].filter(Boolean).join(", ")} />
                <InfoRow icon={<Globe className="w-4 h-4" />} label="Website" value={company.website} link />
                {company.owner_name && <InfoRow icon={<UserPlus className="w-4 h-4" />} label="Owner" value={company.owner_name} />}
                {company.google_rating && (
                  <InfoRow icon={<Star className="w-4 h-4" />} label="Rating"
                    value={`${company.google_rating}★ (${company.google_review_count} reviews)`} />
                )}
              </div>
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
              {company.source ? (
                <div className="flex flex-wrap gap-1.5">
                  {company.source.split("|").map(s => s.trim()).filter(Boolean).map(s => (
                    <span key={s} className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${sourceColorMap[s] || "bg-gray-100 text-gray-600"}`}>
                      {s}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400">Unknown source</p>
              )}
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

function InfoRow({ icon, label, value, link }: { icon: React.ReactNode; label: string; value: string | null; link?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2">
      <span className="text-gray-400 mt-0.5">{icon}</span>
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        {link ? (
          <a href={value.startsWith("http") ? value : `https://${value}`} target="_blank"
            className="text-blue-600 hover:underline flex items-center gap-1">
            {value} <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <p className="text-gray-900 dark:text-gray-100">{value}</p>
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
