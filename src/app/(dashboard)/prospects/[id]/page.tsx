"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";
import Link from "next/link";
import {
  ArrowLeft, ArrowRight, Building2, Globe, Phone, Mail, MapPin, Tag, Star,
  Edit, UserPlus, MessageSquare, Clock, ExternalLink, Plus, Save, X,
  Briefcase, Sparkles, Loader2, CheckCircle2, XCircle, AlertCircle, Search, Store, Eye,
} from "lucide-react";
import { toast } from "sonner";
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
import {
  COMPANY_STATUS_LABELS,
  MANUAL_STATUS_OPTIONS,
  getCompanyStatusBadge,
} from "@/modules/sales/lib/company-status-display";
import { ProspectActivityTimeline } from "@/modules/sales/components/prospect-activity-timeline";

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
  // ── StoreLeads firmographics (filled on storeleads import / live
  //    enrichment via the storeleads/customer-sync flow) ──
  storeleads_id?: string | null;
  storeleads_last_synced_at?: string | null;
  description?: string | null;
  meta_description?: string | null;
  industry?: string | null;
  ecom_platform?: string | null;
  employee_count?: number | null;
  estimated_yearly_sales_cents?: number | null;
  estimated_monthly_visits?: number | null;
  average_product_price_cents?: number | null;
  contact_form_url?: string | null;
  tiktok_url?: string | null;
  tiktok_followers?: number | null;
  youtube_url?: string | null;
  youtube_followers?: number | null;
  // Extended cohort fields (added in the wider-import pass)
  estimated_monthly_sales_cents?: number | null;
  estimated_monthly_pageviews?: number | null;
  installed_apps_names?: string | null;   // colon- or comma-delimited list
  about_us_url?: string | null;
  storeleads_first_seen_at?: string | null;
  cluster_domains?: string | null;
  meta_keywords?: string | null;
  // ── Email verification (NeverBounce cache) ──
  email_verification_status?: string | null;
  email_verified_at?: string | null;
  // ── Eyewear crawl aggregates (from shopify_crawl source) ──
  top_brand?: string | null;
  eyewear_categories?: string | null;
  eyewear_sku_count?: number | null;
  eyewear_price_range?: string | null;
  eyewear_price_median_cents?: number | null;
  eyewear_top_competitors?: string | null;
  eyewear_sample_titles?: string | null;
  eyewear_sample_urls?: string | null;
  eyewear_sample_images?: string | null;
  eyewear_sample_prices_cents?: string | null;  // pipe-joined cents per sample
  // ── AI-generated cold-email opening lines ──
  ai_opener_email1?: string | null;
  ai_opener_email2?: string | null;
  ai_opener_generated_at?: string | null;
  ai_opener_model?: string | null;
  created_at: string; updated_at: string;
}

// Format money cents → "$1.2M" / "$450K" / "$320"
function fmtMoneyShortFromCents(cents: number | null | undefined): string | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  const usd = cents / 100;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd >= 10_000_000 ? 0 : 1)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${Math.round(usd)}`;
}
function fmtNumberShort(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
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

// Status labels + colors now live in a shared module — see
// src/modules/sales/lib/company-status-display.ts. Pre-pipeline-migration
// values (new/qualified/rejected/contacted) still get a sensible
// fallback via getCompanyStatusBadge so any unmigrated row renders OK.

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
  const [dealStage, setDealStage] = useState<DealStage>("interested");
  const [dealChannel, setDealChannel] = useState("");
  const [dealValue, setDealValue] = useState("");
  const [dealNotes, setDealNotes] = useState("");
  const [dealSaving, setDealSaving] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichingSL, setEnrichingSL] = useState(false);
  const [newlyEnrichedFields, setNewlyEnrichedFields] = useState<string[]>([]);
  const [showDisqualifyDialog, setShowDisqualifyDialog] = useState(false);
  const [disqualifyReason, setDisqualifyReason] = useState("");

  const enrichViaStoreLeads = async () => {
    if (!company) return;
    setEnrichingSL(true);
    setNewlyEnrichedFields([]);
    try {
      const res = await fetch(`/api/v1/sales/prospects/${company.id}/enrich-storeleads`, {
        method: "POST",
      });
      const result = (await res.json()) as
        | { ok: true; enrichedFields: string[]; notFound?: boolean }
        | { ok: false; error: string };
      if (!result.ok) {
        toast.error("StoreLeads enrichment failed", { description: result.error });
        return;
      }
      if (result.notFound) {
        toast.message("Not in StoreLeads", {
          description: `StoreLeads doesn't have a record for ${company.domain ?? "this domain"}. Synced timestamp updated so we don't keep retrying.`,
        });
        return;
      }
      if (result.enrichedFields.length === 0) {
        toast.success("Already up to date", {
          description: "All StoreLeads fields were already populated — nothing to merge.",
        });
      } else {
        toast.success(`Enriched ${result.enrichedFields.length} field${result.enrichedFields.length === 1 ? "" : "s"}`, {
          description: result.enrichedFields.join(", "),
        });
        setNewlyEnrichedFields(result.enrichedFields);
        setTimeout(() => setNewlyEnrichedFields([]), 30000);
      }
      // Refresh company data so the merged fields show up.
      const data = await (await fetch(`/api/v1/sales/prospects/${id}`)).json();
      setCompany(data.company);
      setActivities(data.activities || []);
    } catch (e) {
      toast.error("Request failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setEnrichingSL(false);
    }
  };

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
      setDealStage("interested");
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
      {/* Prev/Next Navigation. In pipeline-walk mode (when the URL
          carries ?pipeline=<stage>) the bar is themed slightly and
          links back to the kanban instead of the prospect list. */}
      {(adjacent.prev || adjacent.next || adjacent.position) && (() => {
        const pipelineStage = searchParams.get("pipeline");
        const stageLabel = pipelineStage ? (DEAL_STAGE_LABELS[pipelineStage as keyof typeof DEAL_STAGE_LABELS] || pipelineStage) : null;
        const backHref = pipelineStage ? "/pipeline" : `/prospects${filterQs ? `?${filterQs}` : ""}`;
        const backLabel = pipelineStage ? "Back to Pipeline" : "Back to List";
        return (
          <div className={`flex items-center justify-between mb-3 px-3 py-1.5 rounded-lg text-sm ${
            pipelineStage
              ? "bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900"
              : "bg-gray-50 dark:bg-gray-800/50"
          }`}>
            <Link
              href={backHref}
              className={`flex items-center gap-1.5 ${
                pipelineStage
                  ? "text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100 font-medium"
                  : "text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
              } transition-colors`}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {backLabel}
              {stageLabel && <span className="text-gray-500 dark:text-gray-400 font-normal">· {stageLabel}</span>}
            </Link>
            <div className="flex items-center gap-3">
              {adjacent.position && adjacent.total ? (
                <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                  {adjacent.position.toLocaleString()} of {adjacent.total.toLocaleString()}
                </span>
              ) : null}
              {adjacent.prev ? (
                <Link href={`/prospects/${adjacent.prev}${navSuffix}`} className="flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors" title="Previous (← arrow)">
                  <ArrowLeft className="w-3.5 h-3.5" />
                </Link>
              ) : (
                <span className="flex items-center gap-1 text-gray-300 dark:text-gray-600 cursor-not-allowed">
                  <ArrowLeft className="w-3.5 h-3.5" />
                </span>
              )}
              {adjacent.next ? (
                <Link href={`/prospects/${adjacent.next}${navSuffix}`} className="flex items-center gap-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors" title="Next (→ arrow)">
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              ) : (
                <span className="flex items-center gap-1 text-gray-300 dark:text-gray-600 cursor-not-allowed">
                  <ArrowRight className="w-3.5 h-3.5" />
                </span>
              )}
            </div>
          </div>
        );
      })()}

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
        <Link href="/prospects" className="flex items-center gap-1 hover:text-gray-700">
          <ArrowLeft className="w-4 h-4" /> Prospects
        </Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-white">{company.name}</span>
      </div>

      {/* Header — two-row layout: title + meta on top, status + actions below */}
      <div className="mb-6 space-y-3">
        {/* Row 1: identity */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xl font-bold shrink-0">
              {company.name.charAt(0)}
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white truncate">{company.name}</h1>
              <div className="flex items-center gap-3 mt-1 text-sm text-gray-500 flex-wrap">
                {company.city && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{company.city}, {company.state}</span>}
                {company.website && (
                  <a href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
                    target="_blank" className="flex items-center gap-1 text-blue-600 hover:underline">
                    <Globe className="w-3.5 h-3.5" />{company.domain || company.website}
                  </a>
                )}
                <a href={`https://www.google.com/search?q=${encodeURIComponent(`${company.name} ${company.city || ""} ${company.state || ""}`.trim())}`}
                  target="_blank"
                  className={`flex items-center gap-1 hover:underline ${company.website ? "text-gray-400 hover:text-gray-600" : "text-blue-600 font-medium"}`}>
                  <Search className="w-3.5 h-3.5" />{company.website ? "Google" : "Search Google"}
                </a>
              </div>
            </div>
          </div>
          {/* Terminal-state shortcuts (Overjoy-style Won / Lost) + Edit.
              Won → customer, Lost → not_interested. Both go through the
              regular PATCH + progressCompanyStatus path so the
              hub-and-spoke sync handles Instantly + PhoneBurner. */}
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => { setEditing(!editing); setEditFields({}); }}>
              <Edit className="w-4 h-4 mr-1" /> Edit
            </Button>
            {(() => {
              const isWon = company.status === "customer";
              const isLost = company.status === "not_interested";
              return (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (isLost) return;
                      if (!confirm(`Mark ${company.name} as Not Interested? This adds them to the Instantly blocklist so they stop receiving outreach.`)) return;
                      changeStatus("not_interested");
                    }}
                    disabled={isLost || isWon}
                    title={isWon ? "Already a customer" : isLost ? "Already marked Not Interested" : "Mark as Not Interested"}
                    className="bg-red-600 hover:bg-red-700 text-white disabled:bg-red-200 disabled:text-red-400 disabled:cursor-not-allowed"
                  >
                    <XCircle className="w-4 h-4 mr-1" /> Lost
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (isWon) return;
                      if (!confirm(`Mark ${company.name} as Customer? This closes the deal as won and stops further outreach.`)) return;
                      changeStatus("customer");
                    }}
                    disabled={isWon || isLost}
                    title={isWon ? "Already a customer" : isLost ? "Lead marked Not Interested" : "Mark as Customer"}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white disabled:bg-emerald-200 disabled:text-emerald-400 disabled:cursor-not-allowed"
                  >
                    <CheckCircle2 className="w-4 h-4 mr-1" /> Won
                  </Button>
                </>
              );
            })()}
          </div>
        </div>

        {/* Row 2: status pills (left) + action toolbar (right) */}
        <div className="flex items-center justify-between gap-3 flex-wrap"><div className="flex items-center gap-2 flex-wrap">
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
              className={`px-2.5 py-1 rounded-md text-xs font-semibold inline-flex items-center gap-1 border ${
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


          {/* Pipeline status dropdown */}
          <div className="relative">
            {(() => {
              const badge = getCompanyStatusBadge(company.status);
              return (
                <button onClick={() => setStatusDropdown(!statusDropdown)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium ${badge.color}`}>
                  {badge.label}
                </button>
              );
            })()}
            {statusDropdown && (
              <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 border rounded-lg shadow-lg z-50 py-1 w-44">
                {MANUAL_STATUS_OPTIONS.map(s => (
                  <button key={s} onClick={() => changeStatus(s)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${s === company.status ? "font-bold" : ""}`}>
                    {COMPANY_STATUS_LABELS[s] || s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Intermediate-stage quick advance buttons. Only render when
              a forward progression actually exists from the current
              status — keeps the bar clean for terminal states. */}
          {(() => {
            const s = company.status;
            const showCatalogSent = s === "qualified_lead" || s === "interested";
            const showRevisitLater = s === "qualified_lead" || s === "interested" || s === "catalog_sent";
            if (!showCatalogSent && !showRevisitLater) return null;
            return (
              <div className="flex items-center gap-1.5">
                <span className="text-gray-300 dark:text-gray-600 text-sm">→</span>
                {showCatalogSent && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => changeStatus("catalog_sent")}
                    title="Move to Catalog Sent"
                    className="border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:text-blue-300 dark:hover:bg-blue-950"
                  >
                    Catalog Sent
                  </Button>
                )}
                {showRevisitLater && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => changeStatus("revisit_later")}
                    title="Move to Revisit Later"
                    className="border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-900 dark:text-orange-300 dark:hover:bg-orange-950"
                  >
                    Revisit Later
                  </Button>
                )}
              </div>
            );
          })()}
          </div>{/* end left status pills */}

          {/* Right-aligned action toolbar */}
          <div className="flex items-center gap-2 flex-wrap">

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

          {/* Enrichment — single button. When already enriched, the
              button still works as a Re-enrich affordance but shows a
              small green dot to signal current state without a full
              status pill competing with the action toolbar. */}
          <Button
            variant="outline"
            size="sm"
            onClick={enrichCompany}
            disabled={enriching || company.enrichment_status === "queued"}
            title={company.enrichment_status === "enriched" ? "Enriched — click to re-enrich" : "Run AI enrichment"}
          >
            {enriching || company.enrichment_status === "queued" ? (
              <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Enriching...</>
            ) : company.enrichment_status === "failed" ? (
              <><AlertCircle className="w-4 h-4 mr-1 text-red-500" /> Retry Enrich</>
            ) : company.enrichment_status === "enriched" ? (
              <>
                <span className="w-2 h-2 rounded-full bg-green-500 mr-1.5 inline-block" />
                Enrich
              </>
            ) : (
              <><Sparkles className="w-4 h-4 mr-1" /> Enrich</>
            )}
          </Button>

          {/* StoreLeads enrichment — separate channel; merges by COALESCE so
              hand-edited values are preserved. Disabled when the prospect
              has no domain (StoreLeads keys on domain). */}
          <Button
            variant="outline"
            size="sm"
            onClick={enrichViaStoreLeads}
            disabled={enrichingSL || !company.domain}
            title={!company.domain ? "Add a domain first" : "Pull profile from StoreLeads"}
          >
            {enrichingSL ? (
              <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> StoreLeads…</>
            ) : (
              <><Store className="w-4 h-4 mr-1" /> StoreLeads</>
            )}
          </Button>

          </div>{/* end right actions */}
        </div>{/* end row 2 */}
      </div>{/* end header */}

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
              {/* Tags — collapsed by default. Most prospects have 4-6
                  internal segmentation tags (eyewear_cohort, crawl_v1,
                  carries_*, etc.) that are noise during day-to-day use
                  but useful when debugging segment membership. */}
              {company.tags?.length > 0 && (
                <details className="mt-4 group">
                  <summary className="text-xs text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 select-none">
                    Tags ({company.tags.length})
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {company.tags.map(t => (
                      <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                    ))}
                  </div>
                </details>
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

          {/* ─── Store Profile (StoreLeads firmographics) ─────────────────
              Surfaces every column the storeleads importer + live
              enrichment populate: site copy (description, meta_description),
              platform, employee count, sales/visits estimates, average
              product price, social URLs with follower counts. Renders
              only when at least one field is present so non-storeleads
              rows don't show an empty card. */}
          {(company.description || company.meta_description || company.industry ||
            company.ecom_platform || company.employee_count != null ||
            company.estimated_yearly_sales_cents != null ||
            company.estimated_monthly_sales_cents != null ||
            company.estimated_monthly_visits != null ||
            company.estimated_monthly_pageviews != null ||
            company.average_product_price_cents != null ||
            company.storeleads_first_seen_at ||
            company.tiktok_url || company.youtube_url ||
            company.storeleads_id || company.contact_form_url ||
            company.about_us_url || company.email_verification_status) && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Store className="w-4 h-4 text-blue-600" /> Store Profile
                  </CardTitle>
                  {company.storeleads_last_synced_at && (
                    <span className="text-xs text-gray-400">
                      synced {new Date(company.storeleads_last_synced_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Site copy — useful as opener-source material */}
                {(company.meta_description || company.description) && (
                  <div className="space-y-2">
                    {company.meta_description && (
                      <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                        <p className="text-xs font-medium text-gray-500 mb-1">Meta description</p>
                        <p className="text-sm text-gray-700 dark:text-gray-300">{company.meta_description}</p>
                      </div>
                    )}
                    {company.description && company.description !== company.meta_description && (
                      <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                        <p className="text-xs font-medium text-gray-500 mb-1">About us</p>
                        <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{company.description}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Firmographic facts grid */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                  {company.industry && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Industry</p>
                      <p className="font-medium">{company.industry}</p>
                    </div>
                  )}
                  {company.ecom_platform && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Platform</p>
                      <p className="font-medium capitalize">{company.ecom_platform}</p>
                    </div>
                  )}
                  {company.employee_count != null && company.employee_count > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Employees</p>
                      <p className="font-medium">{company.employee_count.toLocaleString()}</p>
                    </div>
                  )}
                  {company.estimated_yearly_sales_cents != null && company.estimated_yearly_sales_cents > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Est. yearly sales</p>
                      <p className="font-medium">{fmtMoneyShortFromCents(company.estimated_yearly_sales_cents)}</p>
                    </div>
                  )}
                  {company.estimated_monthly_sales_cents != null && company.estimated_monthly_sales_cents > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Monthly sales</p>
                      <p className="font-medium">{fmtMoneyShortFromCents(company.estimated_monthly_sales_cents)}</p>
                    </div>
                  )}
                  {company.estimated_monthly_visits != null && company.estimated_monthly_visits > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Monthly visits</p>
                      <p className="font-medium">{fmtNumberShort(company.estimated_monthly_visits)}</p>
                    </div>
                  )}
                  {company.estimated_monthly_pageviews != null && company.estimated_monthly_pageviews > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Monthly pageviews</p>
                      <p className="font-medium">{fmtNumberShort(company.estimated_monthly_pageviews)}</p>
                    </div>
                  )}
                  {company.average_product_price_cents != null && company.average_product_price_cents > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Avg product price</p>
                      <p className="font-medium">{fmtMoneyShortFromCents(company.average_product_price_cents)}</p>
                    </div>
                  )}
                  {company.storeleads_first_seen_at && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">First seen by StoreLeads</p>
                      <p className="font-medium">{company.storeleads_first_seen_at}</p>
                    </div>
                  )}
                  {company.email_verification_status && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Email verified</p>
                      <p className={`font-medium capitalize ${
                        company.email_verification_status === "valid" ? "text-green-700 dark:text-green-400" :
                        company.email_verification_status === "catchall" ? "text-yellow-700 dark:text-yellow-400" :
                        "text-gray-600 dark:text-gray-400"
                      }`}>
                        {company.email_verification_status}
                      </p>
                    </div>
                  )}
                  {company.storeleads_id && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">StoreLeads ID</p>
                      <p className="font-mono text-xs">{company.storeleads_id}</p>
                    </div>
                  )}
                </div>

                {/* Additional social + linkable URLs */}
                {(company.tiktok_url || company.youtube_url || company.contact_form_url || company.about_us_url) && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {company.about_us_url && (
                      <a href={company.about_us_url} target="_blank" rel="noopener"
                         className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:text-indigo-300">
                        About page <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {company.tiktok_url && (
                      <a href={company.tiktok_url} target="_blank" rel="noopener"
                         className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-gray-100 text-gray-800 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200">
                        TikTok
                        {company.tiktok_followers != null && company.tiktok_followers > 0 && (
                          <span className="text-gray-500">· {fmtNumberShort(company.tiktok_followers)}</span>
                        )}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {company.youtube_url && (
                      <a href={company.youtube_url} target="_blank" rel="noopener"
                         className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-red-50 text-red-700 hover:bg-red-100">
                        YouTube
                        {company.youtube_followers != null && company.youtube_followers > 0 && (
                          <span className="text-red-500">· {fmtNumberShort(company.youtube_followers)}</span>
                        )}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {company.contact_form_url && (
                      <a href={company.contact_form_url} target="_blank" rel="noopener"
                         className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
                        Contact form <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                )}

                {/* Cluster domains — sister sites in the same brand family. */}
                {company.cluster_domains && company.cluster_domains.split(",").filter((d) => d.trim() && d.trim() !== company.domain).length > 0 && (
                  <div className="pt-1">
                    <p className="text-xs font-medium text-gray-500 mb-1.5">Related domains</p>
                    <div className="flex flex-wrap gap-1.5">
                      {company.cluster_domains.split(",").map((d) => d.trim()).filter((d) => d && d !== company.domain).map((d) => (
                        <a key={d} href={`https://${d}`} target="_blank" rel="noopener"
                           className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-mono">
                          {d}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ─── Tech Stack (Shopify apps installed)
              installed_apps_names is a delimited list of every app
              the store runs. High competitive intel: tells us which
              email-marketing / reviews / loyalty / subscription /
              shipping platforms they're already on — useful both as
              an opener anchor and to gauge sophistication. */}
          {company.installed_apps_names && (() => {
            // StoreLeads delimits with `:` for apps but uses `,` sometimes too.
            // Normalize and dedupe.
            const apps = company.installed_apps_names!
              .split(/[:,]/)
              .map((s) => s.trim())
              .filter(Boolean);
            const unique = Array.from(new Set(apps));
            if (unique.length === 0) return null;
            return (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Briefcase className="w-4 h-4 text-cyan-600" /> Tech Stack
                    <span className="text-xs text-gray-400 font-normal">· {unique.length} apps</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    {unique.map((app) => (
                      <Badge key={app} variant="outline" className="text-xs">
                        {app}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400 italic mt-3">
                    Useful as an opener anchor — e.g. "saw you're on Klaviyo" or
                    "we work with a lot of Yotpo-powered boutiques."
                  </p>
                </CardContent>
              </Card>
            );
          })()}

          {/* ─── Eyewear Inventory (from the Shopify /products.json crawl)
              Per-store rollup of what this boutique already stocks. Used
              as the LLM context for the AI opener and as competitive
              intel for outreach. Renders only when a store actually
              carries eyewear (top_brand is the easiest signal). */}
          {(company.top_brand || company.eyewear_sku_count != null ||
            company.eyewear_sample_titles || company.eyewear_top_competitors) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Eye className="w-4 h-4 text-purple-600" /> Eyewear Inventory
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                  {company.top_brand && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Top brand</p>
                      <p className="font-medium">{company.top_brand}</p>
                    </div>
                  )}
                  {company.eyewear_categories && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Carries</p>
                      <p className="font-medium capitalize">
                        {company.eyewear_categories.split(",").map((c) => c.replace(/_/g, " ")).join(" + ")}
                      </p>
                    </div>
                  )}
                  {company.eyewear_sku_count != null && company.eyewear_sku_count > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Eyewear SKUs</p>
                      <p className="font-medium">{company.eyewear_sku_count}{company.eyewear_sku_count >= 25 ? "+" : ""}</p>
                    </div>
                  )}
                  {company.eyewear_price_range && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Price range</p>
                      <p className="font-medium">{company.eyewear_price_range}</p>
                    </div>
                  )}
                  {company.eyewear_price_median_cents != null && company.eyewear_price_median_cents > 0 && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">Median price</p>
                      <p className="font-medium">${(company.eyewear_price_median_cents / 100).toFixed(0)}</p>
                    </div>
                  )}
                </div>

                {company.eyewear_top_competitors && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1.5">Competing brands carried</p>
                    <div className="flex flex-wrap gap-1.5">
                      {company.eyewear_top_competitors.split("|").map((c) => c.trim()).filter(Boolean).map((c) => (
                        <Badge key={c} variant="outline" className="text-xs">{c}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {company.eyewear_sample_titles && (() => {
                  // Zip the four parallel arrays back into per-product
                  // tuples. titles is required; urls / images / prices
                  // are all optional (pre-fix rows have only titles).
                  const titles = company.eyewear_sample_titles!.split("|").map((s) => s.trim());
                  const urls = (company.eyewear_sample_urls || "").split("|").map((s) => s.trim());
                  const images = (company.eyewear_sample_images || "").split("|").map((s) => s.trim());
                  // prices are integer cents per slot, "" when not parseable.
                  const prices = (company.eyewear_sample_prices_cents || "").split("|").map((s) => {
                    const n = parseInt(s, 10);
                    return Number.isFinite(n) && n > 0 ? n : null;
                  });
                  const samples = titles
                    .map((title, i) => ({
                      title,
                      url: urls[i] || "",
                      image: images[i] || "",
                      priceCents: prices[i] ?? null,
                    }))
                    .filter((s) => s.title);
                  if (samples.length === 0) return null;
                  return (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-2">Sample products on their site</p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {samples.map((s, i) => {
                          const inner = (
                            <>
                              {s.image ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={s.image}
                                  alt={s.title}
                                  className="w-full h-32 object-cover rounded-md bg-gray-100 dark:bg-gray-800"
                                  loading="lazy"
                                  // Some Shopify CDN images are gated by referrer; fall back to
                                  // a placeholder block on load failure.
                                  onError={(e) => {
                                    (e.currentTarget as HTMLImageElement).style.display = "none";
                                  }}
                                />
                              ) : (
                                <div className="w-full h-32 rounded-md bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400">
                                  <Eye className="w-6 h-6" />
                                </div>
                              )}
                              <div className="mt-2 flex items-start gap-1.5">
                                <span className="text-sm text-gray-700 dark:text-gray-300 line-clamp-2 flex-1">
                                  {s.title}
                                </span>
                                {s.url && <ExternalLink className="w-3.5 h-3.5 shrink-0 mt-0.5 text-gray-400" />}
                              </div>
                              {s.priceCents != null && (
                                <p className="text-xs font-semibold text-gray-900 dark:text-gray-100 mt-1">
                                  ${(s.priceCents / 100).toFixed(2)}
                                </p>
                              )}
                            </>
                          );
                          return s.url ? (
                            <a
                              key={i}
                              href={s.url}
                              target="_blank"
                              rel="noopener"
                              className="block group hover:opacity-90 transition-opacity"
                              title={s.title}
                            >
                              {inner}
                            </a>
                          ) : (
                            <div key={i}>{inner}</div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          )}

          {/* ─── AI Outreach Openers (from generate-eyewear-openers)
              The two opening lines Claude wrote for this lead. Shipped
              to Instantly as {{ai_opener_email1}} and {{ai_opener_email2}}
              custom variables. Surfacing them here lets Daniel spot-check
              the copy before sending, and surfaces the model/timestamp
              so we know when to regenerate. */}
          {(company.ai_opener_email1 || company.ai_opener_email2) && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-500" /> AI Outreach Openers
                  </CardTitle>
                  <div className="text-xs text-gray-400 flex items-center gap-3">
                    {company.ai_opener_model && <span className="font-mono">{company.ai_opener_model}</span>}
                    {company.ai_opener_generated_at && (
                      <span>{new Date(company.ai_opener_generated_at).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {company.ai_opener_email1 && (
                  <div className="p-3 border-l-4 border-amber-300 bg-amber-50/50 dark:bg-amber-900/10 rounded-r-lg">
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
                      Email 1 — first touch
                    </p>
                    <p className="text-sm text-gray-800 dark:text-gray-200 italic">
                      "{company.ai_opener_email1}"
                    </p>
                  </div>
                )}
                {company.ai_opener_email2 && (
                  <div className="p-3 border-l-4 border-amber-200 bg-amber-50/30 dark:bg-amber-900/5 rounded-r-lg">
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
                      Email 2 — follow-up
                    </p>
                    <p className="text-sm text-gray-800 dark:text-gray-200 italic">
                      "{company.ai_opener_email2}"
                    </p>
                  </div>
                )}
                <p className="text-xs text-gray-400 italic">
                  Renders in Instantly as <code className="font-mono not-italic bg-gray-100 dark:bg-gray-800 px-1 rounded">{`{{ai_opener_email1}}`}</code> and <code className="font-mono not-italic bg-gray-100 dark:bg-gray-800 px-1 rounded">{`{{ai_opener_email2}}`}</code>.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Stores & Contacts — hidden entirely when both lists are
              empty. The common-case prospect has no linked stores and
              no contacts at intake; the empty card is just noise.
              When the user wants to add the first contact, they go
              through Edit mode. */}
          {(stores.length > 0 || contacts.length > 0) && (
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
          )}
        </div>

        {/* Right sidebar — Activity dominant on top, then Notes, then Lead Source. */}
        <div className="space-y-4">
          {/* Activity Timeline — primary right-column content. */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ProspectActivityTimeline
                activities={activities}
                emptyHint={(() => {
                  const s = company.status;
                  if (s === "prospect" || s === "not_qualified") {
                    return (
                      <div className="text-center py-6 text-sm text-gray-500 dark:text-gray-400">
                        <p>Not yet contacted.</p>
                        <Link href="/campaigns" className="inline-block mt-2 text-blue-600 dark:text-blue-400 hover:underline text-xs">
                          Send to a campaign →
                        </Link>
                      </div>
                    );
                  }
                  if (s === "qualified_lead") {
                    return (
                      <p className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
                        Outreach in progress. Events appear here as Instantly fires them.
                      </p>
                    );
                  }
                  return (
                    <p className="text-sm text-amber-600 dark:text-amber-500 py-6 text-center">
                      No activity yet, but this lead is at status <strong>{COMPANY_STATUS_LABELS[s as keyof typeof COMPANY_STATUS_LABELS] || s}</strong>. Something may be misconfigured.
                    </p>
                  );
                })()}
              />
            </CardContent>
          </Card>

          {/* Notes — compact: single-line input grows on focus. */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 mb-3">
                <textarea
                  placeholder="Add a note..."
                  value={newNote}
                  onChange={e => setNewNote(e.target.value)}
                  rows={newNote ? 3 : 1}
                  className="flex-1 px-3 py-2 border rounded-lg text-sm resize-none dark:bg-gray-800 dark:border-gray-700 focus:rows-3 transition-all"
                />
                <Button size="sm" onClick={addNote} disabled={!newNote.trim()} className="self-end">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              {company.notes ? (
                <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {company.notes}
                </div>
              ) : (
                <p className="text-xs text-gray-400">No notes yet</p>
              )}
            </CardContent>
          </Card>

          {/* Lead Source — compact 2-3 line summary. */}
          {(company.source_type || company.source || company.segment) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Lead Source</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {company.source_type && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Link
                      href={`/prospects?${new URLSearchParams({ source_type: company.source_type, ...(company.source_id ? { source_id: company.source_id } : {}) })}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50"
                      title={company.lead_source_detail || undefined}
                    >
                      {company.source_type}
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                    {company.category && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">· {company.category}</span>
                    )}
                  </div>
                )}
                {company.source_query && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                    &ldquo;{company.source_query}&rdquo;
                  </p>
                )}
                {company.segment && (
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    <span className="text-gray-400">Segment:</span> {company.segment}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          {/* Legacy timeline preserved below for safety during cutover —
              hidden by default. Remove once the new component proves out. */}
          {false && (
            <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Activity (legacy)</CardTitle>
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
                            {a.event_type.startsWith("instantly_") && (() => {
                              const campaign = (data.campaign_name as string) || "campaign";
                              const subject = (data.email_subject as string) || "";
                              const snippet = (data.reply_snippet as string) || "";
                              const step = data.step != null ? ` (step ${data.step})` : "";
                              switch (a.event_type) {
                                case "instantly_email_sent":
                                  return <>📧 Sent in <span className="font-medium">{campaign}</span>{step}</>;
                                case "instantly_email_opened":
                                  return <>👁 Opened {subject ? <em>“{subject}”</em> : <>email</>} in {campaign}</>;
                                case "instantly_email_link_clicked":
                                  return <>🔗 Clicked link in {campaign}</>;
                                case "instantly_reply_received":
                                  return (
                                    <>📨 <span className="font-medium">Replied</span> in {campaign}
                                      {snippet && (
                                        <div className="mt-1 text-xs text-gray-600 bg-gray-50 border-l-2 border-gray-300 pl-2 py-1 italic">
                                          {snippet.slice(0, 240)}{snippet.length > 240 ? "…" : ""}
                                        </div>
                                      )}
                                    </>
                                  );
                                case "instantly_lead_no_show":
                                  return <>📵 Meeting no-show ({campaign})</>;
                                case "instantly_lead_neutral":
                                  return <>↩️ Neutral reply ({campaign})</>;
                                case "instantly_email_bounced":
                                  return <>⚠️ Bounced in {campaign}</>;
                                case "instantly_lead_unsubscribed":
                                  return <>🚫 Unsubscribed from {campaign}</>;
                                case "instantly_lead_interested":
                                  return <>✅ <span className="font-medium">Marked Interested</span> in {campaign}</>;
                                case "instantly_lead_not_interested":
                                  return <>❌ Marked Not Interested in {campaign}</>;
                                case "instantly_lead_out_of_office":
                                  return <>🌴 Out of office ({campaign})</>;
                                case "instantly_lead_wrong_person":
                                  return <>🙅 Wrong person ({campaign})</>;
                                case "instantly_lead_meeting_booked":
                                  return <>📅 <span className="font-medium">Meeting booked</span> ({campaign})</>;
                                case "instantly_lead_meeting_completed":
                                  return <>🎉 Meeting completed ({campaign})</>;
                                case "instantly_campaign_completed":
                                  return <>🏁 Campaign completed: {campaign}</>;
                                default:
                                  return <>📨 {a.event_type.replace("instantly_", "")} ({campaign})</>;
                              }
                            })()}
                            {a.event_type === "phoneburner_call_completed" && (() => {
                              const disposition = (data.disposition as string) || "";
                              const duration = data.duration_seconds as number | null | undefined;
                              const agent = (data.agent_email as string) || (data.agent_id as string) || "";
                              const recording = (data.recording_url as string) || "";
                              const notes = (data.notes as string) || "";
                              return (
                                <>📞 <span className="font-medium">Called</span>
                                  {agent && <> by {agent}</>}
                                  {disposition && <> — <span className="font-medium">{disposition}</span></>}
                                  {duration != null && <> ({duration}s)</>}
                                  {recording && (
                                    <> · <a href={recording} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">▶ Play</a></>
                                  )}
                                  {notes && (
                                    <div className="mt-1 text-xs text-gray-600 bg-gray-50 border-l-2 border-gray-300 pl-2 py-1 italic">
                                      {notes.slice(0, 240)}{notes.length > 240 ? "…" : ""}
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                            {a.event_type !== "phoneburner_call_completed" && a.event_type.startsWith("phoneburner_") && (() => {
                              const agent = (data.agent_email as string) || (data.agent_id as string) || "";
                              const t = a.event_type;
                              const agentSuffix = agent ? ` by ${agent}` : "";
                              switch (t) {
                                case "phoneburner_call_started":
                                  return <>📞 Dialing…{agentSuffix}</>;
                                case "phoneburner_contact_displayed":
                                  return <>👁 Viewed in PhoneBurner{agentSuffix}</>;
                                case "phoneburner_email_unsubscribed":
                                  return <>🚫 Unsubscribed from PhoneBurner email</>;
                                case "phoneburner_sms_opt_out":
                                  return <>🚫 Replied STOP to SMS</>;
                                case "phoneburner_email_sent":
                                  return <>📧 PhoneBurner email sent{agentSuffix}</>;
                                case "phoneburner_email_opened":
                                  return <>👁 Opened PhoneBurner email</>;
                                case "phoneburner_email_clicked":
                                  return <>🔗 Clicked PhoneBurner email link</>;
                                case "phoneburner_email_resubscribed":
                                  return <>✅ Resubscribed to PhoneBurner email</>;
                                case "phoneburner_link_pickup":
                                case "phoneburner_document_pickup":
                                case "phoneburner_image_pickup":
                                case "phoneburner_smartpack_pickup":
                                  return <>📎 Opened {t.replace("phoneburner_", "").replace("_", " ")}</>;
                                case "phoneburner_appointment_scheduled":
                                  return <>📅 <span className="font-medium">Appointment booked</span>{agentSuffix}</>;
                                case "phoneburner_task_created":
                                  return <>✅ Task created in PhoneBurner{agentSuffix}</>;
                                case "phoneburner_call_transfer":
                                  return <>↪️ Call transferred{agentSuffix}</>;
                                case "phoneburner_manual_trigger":
                                  return <>🔔 Manual webhook from PhoneBurner</>;
                                default:
                                  return <>📞 {t.replace("phoneburner_", "")}{agentSuffix}</>;
                              }
                            })()}
                            {!["change", "company_updated", "contact_created", "status_change"].includes(a.event_type) && !a.event_type.startsWith("instantly_") && !a.event_type.startsWith("phoneburner_") && a.event_type}
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
          )}
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
