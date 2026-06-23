"use client";

import { use, useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Monitor, Smartphone, Save, Sparkles, Image as ImageIcon } from "lucide-react";

type Campaign = Record<string, unknown>;

const HERO_VARIANTS = [
  { value: "full_bleed_overlay", label: "Full-bleed + overlay", note: "Hero image + HTML text overlaid (top 30% calm)" },
  { value: "image_75_solid",     label: "75% image, text below", note: "Centered image, headline + CTA below" },
  { value: "split_50_50",        label: "Split 50 / 50",        note: "Image left half, text right half" },
];
const SECTIONA_VARIANTS = [
  { value: "centered",       label: "Centered",        note: "Heading + paragraph centered" },
  { value: "with_pullquote", label: "With pullquote",  note: "Longest sentence pulled larger in Syne italic" },
];
const SECONDARY_VARIANTS = [
  { value: "full_bleed",  label: "Full bleed",       note: "1200×800, no padding" },
  { value: "centered_75", label: "Centered 75%",     note: "900×800 with ivory gutters" },
  { value: "grid_2up",    label: "Grid 2-up",        note: "Two 580×580 images side-by-side" },
];
const SECTIONB_VARIANTS = [
  { value: "centered_with_cta",   label: "Centered + CTA",   note: "Single column + bottom CTA" },
  { value: "two_column_with_cta", label: "Two-column + CTA", note: "Body splits left/right, CTA below" },
];
const SCRIM_OPTIONS = [
  { value: "dark",  label: "Dark scrim" },
  { value: "light", label: "Light scrim" },
  { value: "none",  label: "No scrim" },
];

export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">("desktop");
  const [previewKey, setPreviewKey] = useState(0);
  const [generating, setGenerating] = useState<"copy" | "image_prompts" | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [failedChecks, setFailedChecks] = useState<string[]>([]);

  // ── AI generate handlers ────────────────────────────────────
  async function handleGenerateCopy() {
    // Warn if brief is empty — generation will still proceed but
    // with unspecified placeholders. Better to nudge the user back
    // to the brief field.
    const briefTitle = String(campaign?.briefTitle ?? "").trim();
    const briefAngle = String(campaign?.briefAngle ?? "").trim();
    if (!briefTitle || !briefAngle) {
      const cont = confirm(
        "The Campaign Brief (title + angle) is empty. The AI will generate with placeholders. Continue anyway?",
      );
      if (!cont) return;
    }

    // Save any in-flight edits to the brief BEFORE generating so the
    // server reads the latest values.
    if (campaign) {
      await fetch(`/api/v1/marketing/email/campaigns/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          briefTitle: campaign.briefTitle,
          briefAngle: campaign.briefAngle,
          briefProductHook: campaign.briefProductHook,
          briefSeasonalContext: campaign.briefSeasonalContext,
        }),
      });
    }

    setGenerating("copy");
    setGenerateError(null);
    setFailedChecks([]);
    try {
      const res = await fetch(
        `/api/v1/marketing/email/campaigns/${id}/generate-copy`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const data = await res.json();
      if (data.error) {
        setGenerateError(data.error);
      } else {
        setCampaign(data.campaign);
        setFailedChecks(data.failedChecks ?? []);
        setPreviewKey(k => k + 1);
        setSavedAt(Date.now());
      }
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(null);
    }
  }

  async function handleGenerateImagePrompts() {
    // Save brief edits first so the server sees the latest brief.
    if (campaign) {
      await fetch(`/api/v1/marketing/email/campaigns/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          briefTitle: campaign.briefTitle,
          briefAngle: campaign.briefAngle,
          briefProductHook: campaign.briefProductHook,
          briefSeasonalContext: campaign.briefSeasonalContext,
        }),
      });
    }
    setGenerating("image_prompts");
    setGenerateError(null);
    try {
      const res = await fetch(
        `/api/v1/marketing/email/campaigns/${id}/generate-image-prompts`,
        { method: "POST" },
      );
      const data = await res.json();
      if (data.error) setGenerateError(data.error);
      else {
        setCampaign(data.campaign);
        setPreviewKey(k => k + 1);
        setSavedAt(Date.now());
      }
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(null);
    }
  }

  // Load
  useEffect(() => {
    fetch(`/api/v1/marketing/email/campaigns/${id}`)
      .then(r => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setCampaign(data.campaign);
        setLoading(false);
      });
  }, [id]);

  // Field updater — local state only, debounced save
  const updateField = useCallback((key: string, value: string) => {
    setCampaign(c => (c ? { ...c, [key]: value } : c));
  }, []);

  // Save (called on blur / explicit click)
  const save = useCallback(async () => {
    if (!campaign) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/marketing/email/campaigns/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(campaign),
      });
      const data = await res.json();
      if (data.campaign) setCampaign(data.campaign);
      setSavedAt(Date.now());
      // Refresh preview iframe
      setPreviewKey(k => k + 1);
    } finally {
      setSaving(false);
    }
  }, [campaign, id]);

  async function handleDelete() {
    if (!confirm("Delete this campaign?")) return;
    await fetch(`/api/v1/marketing/email/campaigns/${id}`, { method: "DELETE" });
    window.location.href = "/marketing/email";
  }

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (error || !campaign) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Not found</h1>
        <Link href="/marketing/email"><Button variant="outline">Back to dashboard</Button></Link>
      </div>
    );
  }

  const showScrimPicker = campaign.heroVariant === "full_bleed_overlay";
  const showSecondaryImage2 = campaign.secondaryImageVariant === "grid_2up";

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Link href="/marketing/email">
              <Button variant="outline" size="sm">← Back</Button>
            </Link>
            <select
              value={campaign.audience as string}
              onChange={e => updateField("audience", e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              title="Audience"
            >
              <option value="retail">Retail (DTC)</option>
              <option value="wholesale">Wholesale (Christina)</option>
            </select>
            <select
              value={campaign.status as string}
              onChange={e => updateField("status", e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              title="Status (kanban stage)"
            >
              <option value="draft">Draft</option>
              <option value="copywriting">Copywriting</option>
              <option value="photography">Photography</option>
              <option value="design_review">Design review</option>
              <option value="scheduled">Scheduled</option>
              <option value="sent">Sent</option>
              <option value="analyzed">Analyzed</option>
            </select>
            <input
              type="date"
              value={campaign.scheduledDate as string}
              onChange={e => updateField("scheduledDate", e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              title="Scheduled send date"
            />
            {savedAt && (
              <span className="text-xs text-muted-foreground">
                Saved {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          <input
            value={(campaign.name as string) ?? ""}
            onChange={e => updateField("name", e.target.value)}
            placeholder="Campaign name (your internal label)"
            className="text-2xl font-semibold w-full bg-transparent border-0 outline-none focus:ring-1 focus:ring-foreground/20 rounded px-1 -mx-1"
          />
          <p className="text-sm text-muted-foreground mt-1">
            {(campaign.subject as string | null) ?? "(no subject yet)"}
            {" · "}
            Week of {campaign.weekOf as string}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleGenerateCopy}
            disabled={generating !== null}
            title="Generate subject, hero, and section copy via Claude using the v5 prompt"
          >
            <Sparkles className="h-4 w-4 mr-2" />
            {generating === "copy" ? "Writing…" : "Generate copy"}
          </Button>
          <Button
            variant="outline"
            onClick={handleGenerateImagePrompts}
            disabled={generating !== null}
            title="Generate Higgsfield briefs for hero + secondary images"
          >
            <ImageIcon className="h-4 w-4 mr-2" />
            {generating === "image_prompts" ? "Briefing…" : "Generate image prompts"}
          </Button>
          <Button onClick={save} disabled={saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button variant="ghost" onClick={handleDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* AI feedback banner — error OR failed self-check warnings */}
      {generateError && (
        <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          AI error: {generateError}
        </div>
      )}
      {failedChecks.length > 0 && (
        <div className="rounded border border-orange-300 bg-orange-50 dark:bg-orange-950/20 px-3 py-2 text-sm">
          <strong>Claude flagged self-check warnings:</strong>{" "}
          {failedChecks.join(", ")}. Review the copy before approving.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left pane — editor */}
        <div className="space-y-4">
          {/* CAMPAIGN BRIEF — the prompt/idea that drives every AI call.
              Save this BEFORE clicking Generate copy. */}
          <Card className="border-foreground/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">
                Campaign brief
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  The idea AI uses to generate everything below
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <LabeledInput
                label="Title (3–8 words)"
                value={campaign.briefTitle as string ?? ""}
                onChange={v => updateField("briefTitle", v)}
                placeholder="e.g. Sunday Drive in Honey lands"
              />
              <LabeledTextarea
                label="Angle (why this email, why now — 1–3 sentences)"
                value={campaign.briefAngle as string ?? ""}
                onChange={v => updateField("briefAngle", v)}
                rows={4}
              />
              <div className="grid grid-cols-2 gap-2">
                <LabeledInput
                  label="Product hook (optional)"
                  value={campaign.briefProductHook as string ?? ""}
                  onChange={v => updateField("briefProductHook", v)}
                  placeholder="SKU / category / colorway"
                />
                <LabeledInput
                  label="Seasonal context (optional)"
                  value={campaign.briefSeasonalContext as string ?? ""}
                  onChange={v => updateField("briefSeasonalContext", v)}
                  placeholder="holiday / weather / cultural anchor"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Save the brief before generating. AI calls (Generate copy +
                Generate image prompts) read these fields.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Subject + preheader</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <LabeledInput
                label="Subject (≤45 char)"
                value={campaign.subject as string ?? ""}
                onChange={v => updateField("subject", v)}
                placeholder="babe pls look at these"
                maxLength={45}
              />
              <LabeledInput
                label="Preheader (50–90 char)"
                value={campaign.preheader as string ?? ""}
                onChange={v => updateField("preheader", v)}
                placeholder="The snippet shown next to subject in inbox view"
                maxLength={90}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Hero block</CardTitle>
              <VariantPicker
                value={campaign.heroVariant as string}
                onChange={v => updateField("heroVariant", v)}
                options={HERO_VARIANTS}
              />
            </CardHeader>
            <CardContent className="space-y-3">
              <LabeledInput
                label="Headline (≤6 words)"
                value={campaign.heroHeadline as string ?? ""}
                onChange={v => updateField("heroHeadline", v)}
                placeholder="Made for the long way home"
              />
              <LabeledInput
                label="Subtitle (1 sentence)"
                value={campaign.heroSubtitle as string ?? ""}
                onChange={v => updateField("heroSubtitle", v)}
                placeholder="Three new colorways. $28."
              />
              <div className="grid grid-cols-2 gap-2">
                <LabeledInput
                  label="CTA label"
                  value={campaign.heroCtaLabel as string ?? ""}
                  onChange={v => updateField("heroCtaLabel", v)}
                  placeholder="See the three"
                />
                <LabeledInput
                  label="CTA URL"
                  value={campaign.heroCtaUrl as string ?? ""}
                  onChange={v => updateField("heroCtaUrl", v)}
                  placeholder="https://getjaxy.com/..."
                />
              </div>
              {showScrimPicker && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Scrim (text legibility)
                  </label>
                  <div className="flex gap-1">
                    {SCRIM_OPTIONS.map(o => (
                      <button
                        key={o.value}
                        onClick={() => updateField("heroScrim", o.value)}
                        className={`px-3 py-1 text-xs rounded border ${
                          campaign.heroScrim === o.value
                            ? "bg-accent border-foreground"
                            : "border-input"
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <LabeledInput
                label="Hero image path"
                value={campaign.heroImagePath as string ?? ""}
                onChange={v => updateField("heroImagePath", v)}
                placeholder="email/{id}/hero.jpg — uploads land in Phase 4"
              />
              <LabeledInput
                label="Hero image alt text"
                value={campaign.heroImageAlt as string ?? ""}
                onChange={v => updateField("heroImageAlt", v)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Section A (text)</CardTitle>
              <VariantPicker
                value={campaign.sectionAVariant as string}
                onChange={v => updateField("sectionAVariant", v)}
                options={SECTIONA_VARIANTS}
              />
            </CardHeader>
            <CardContent className="space-y-3">
              <LabeledInput
                label="Heading (3–5 words, sentence case)"
                value={campaign.sectionAHeading as string ?? ""}
                onChange={v => updateField("sectionAHeading", v)}
                placeholder="For the 405 at 6pm"
              />
              <LabeledTextarea
                label="Body (40–70 words)"
                value={campaign.sectionABody as string ?? ""}
                onChange={v => updateField("sectionABody", v)}
                rows={4}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Secondary image</CardTitle>
              <VariantPicker
                value={campaign.secondaryImageVariant as string}
                onChange={v => updateField("secondaryImageVariant", v)}
                options={SECONDARY_VARIANTS}
              />
            </CardHeader>
            <CardContent className="space-y-3">
              <LabeledInput
                label="Image path"
                value={campaign.secondaryImagePath as string ?? ""}
                onChange={v => updateField("secondaryImagePath", v)}
              />
              <LabeledInput
                label="Image alt text"
                value={campaign.secondaryImageAlt as string ?? ""}
                onChange={v => updateField("secondaryImageAlt", v)}
              />
              {showSecondaryImage2 && (
                <>
                  <LabeledInput
                    label="Image 2 path (grid_2up only)"
                    value={campaign.secondaryImagePath2 as string ?? ""}
                    onChange={v => updateField("secondaryImagePath2", v)}
                  />
                  <LabeledInput
                    label="Image 2 alt"
                    value={campaign.secondaryImageAlt2 as string ?? ""}
                    onChange={v => updateField("secondaryImageAlt2", v)}
                  />
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Section B (text + CTA)</CardTitle>
              <VariantPicker
                value={campaign.sectionBVariant as string}
                onChange={v => updateField("sectionBVariant", v)}
                options={SECTIONB_VARIANTS}
              />
            </CardHeader>
            <CardContent className="space-y-3">
              <LabeledInput
                label="Heading"
                value={campaign.sectionBHeading as string ?? ""}
                onChange={v => updateField("sectionBHeading", v)}
              />
              <LabeledTextarea
                label="Body (60–110 words — use blank line for paragraph break)"
                value={campaign.sectionBBody as string ?? ""}
                onChange={v => updateField("sectionBBody", v)}
                rows={6}
              />
              <div className="grid grid-cols-2 gap-2">
                <LabeledInput
                  label="CTA label"
                  value={campaign.sectionBCtaLabel as string ?? ""}
                  onChange={v => updateField("sectionBCtaLabel", v)}
                />
                <LabeledInput
                  label="CTA URL"
                  value={campaign.sectionBCtaUrl as string ?? ""}
                  onChange={v => updateField("sectionBCtaUrl", v)}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right pane — live preview */}
        <div className="lg:sticky lg:top-4 lg:self-start space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Live preview</div>
            <div className="flex gap-1">
              <button
                onClick={() => setPreviewMode("desktop")}
                className={`p-1.5 rounded border ${previewMode === "desktop" ? "bg-accent border-foreground" : "border-input"}`}
                title="Desktop (600px)"
              >
                <Monitor className="h-4 w-4" />
              </button>
              <button
                onClick={() => setPreviewMode("mobile")}
                className={`p-1.5 rounded border ${previewMode === "mobile" ? "bg-accent border-foreground" : "border-input"}`}
                title="Mobile (375px)"
              >
                <Smartphone className="h-4 w-4" />
              </button>
              <button
                onClick={() => setPreviewKey(k => k + 1)}
                className="p-1.5 rounded border border-input text-xs px-2"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="border rounded-lg bg-muted/30 p-4 flex justify-center overflow-hidden">
            <iframe
              key={previewKey}
              src={`/api/v1/marketing/email/campaigns/${id}/preview`}
              title="Email preview"
              style={{
                width: previewMode === "mobile" ? 375 : 600,
                height: 900,
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "white",
              }}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Save to refresh the preview.
          </p>

          {/* SECTION IMAGE EXPORT — JPG-per-block for pasting into
              Faire / Omnisend / wherever. Each button hits the
              export-image endpoint and triggers a download. */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">
                Export as images
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  JPG per block — paste into Faire / Omnisend
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {([
                { kind: "hero",       label: "Hero block" },
                { kind: "sectionA",   label: "Text section A" },
                { kind: "secondary",  label: "Secondary image block" },
                { kind: "sectionB",   label: "Text section B + CTA" },
                { kind: "full",       label: "Whole email" },
              ] as const).map(({ kind, label }) => (
                <div key={kind} className="flex items-center justify-between gap-2 text-sm">
                  <span>{label}</span>
                  <div className="flex gap-1">
                    <a
                      href={`/api/v1/marketing/email/campaigns/${id}/export-image?kind=${kind}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs underline text-muted-foreground hover:text-foreground"
                    >
                      View
                    </a>
                    <a
                      href={`/api/v1/marketing/email/campaigns/${id}/export-image?kind=${kind}&download=1`}
                      className="text-xs px-2 py-1 rounded border border-input hover:bg-accent"
                    >
                      <ImageIcon className="h-3 w-3 inline mr-1" />
                      Download JPG
                    </a>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground pt-2 border-t mt-2">
                First export ~1-2s (Chromium warms up), then ~300ms each.
                Renders at 2x retina. Width 600 by default — append
                <code className="mx-1 bg-muted px-1 rounded">&amp;width=1200</code>
                for double-density.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Form-element helpers
// ────────────────────────────────────────────────────────────

function LabeledInput({
  label, value, onChange, placeholder, maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">
        {label}
        {maxLength && (
          <span className={`ml-2 ${value.length > maxLength ? "text-destructive" : ""}`}>
            ({value.length}/{maxLength})
          </span>
        )}
      </label>
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function LabeledTextarea({
  label, value, onChange, rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">
        {label}
        <span className="ml-2 text-muted-foreground">({value.split(/\s+/).filter(Boolean).length} words)</span>
      </label>
      <Textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        className="font-normal"
      />
    </div>
  );
}

function VariantPicker({
  value, onChange, options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; note: string }[];
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="text-xs border rounded px-2 py-1 bg-background"
    >
      {options.map(o => (
        <option key={o.value} value={o.value} title={o.note}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
