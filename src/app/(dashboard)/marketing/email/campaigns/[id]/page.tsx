"use client";

import { use, useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Trash2, Monitor, Smartphone, Save, Sparkles, Image as ImageIcon,
  Download, ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle, ShieldCheck,
} from "lucide-react";
import { STATUS_ORDER, STATUS_LABELS } from "@/modules/marketing/lib/workflow";

type Campaign = Record<string, unknown>;

interface LintFinding { level: "error" | "warning"; code: string; field: string; message: string }
interface LintResult { ok: boolean; errors: LintFinding[]; warnings: LintFinding[]; score: number }

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
  const [lint, setLint] = useState<LintResult | null>(null);
  const [pipelineMsg, setPipelineMsg] = useState<string | null>(null);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

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
        setLint(data.lint ?? null);
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

  // ── Pipeline: advance / revert with gate validation ─────────
  async function handleAdvance(direction: "forward" | "back") {
    setPipelineBusy(true);
    setPipelineMsg(null);
    try {
      const res = await fetch(`/api/v1/marketing/email/campaigns/${id}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      const data = await res.json();
      if (data.ok && data.campaign) {
        setCampaign(data.campaign);
        setSavedAt(Date.now());
      } else if (data.blocked) {
        setPipelineMsg(`Can't advance to "${data.target}": ${data.blocked.join(" ")}`);
      } else if (data.error) {
        setPipelineMsg(data.error);
      }
    } finally {
      setPipelineBusy(false);
    }
  }

  // ── Validate (deterministic server-side QA) ─────────────────
  async function runValidate() {
    setPipelineBusy(true);
    setPipelineMsg(null);
    try {
      const res = await fetch(`/api/v1/marketing/email/campaigns/${id}/validate`);
      const data = await res.json();
      setLint(data.lint ?? null);
      if (data.readiness && !data.readiness.ready) {
        setPipelineMsg(`Not export-ready — missing: ${data.readiness.missing.join(", ")}.`);
      } else {
        setPipelineMsg("Export-ready. Copy QA below.");
      }
    } finally {
      setPipelineBusy(false);
    }
  }

  // ── Export (Omnisend HTML download / Faire JSON) ────────────
  async function handleExport(format: "omnisend" | "faire") {
    setExporting(true);
    setPipelineMsg(null);
    try {
      if (format === "omnisend") {
        // Trigger a file download of the standalone HTML.
        const a = document.createElement("a");
        a.href = `/api/v1/marketing/email/campaigns/${id}/export?format=omnisend`;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Reflect the status change.
        setTimeout(() => {
          fetch(`/api/v1/marketing/email/campaigns/${id}`)
            .then(r => r.json())
            .then(d => { if (d.campaign) setCampaign(d.campaign); });
        }, 600);
        setPipelineMsg("Omnisend HTML downloaded. Paste into Omnisend's custom-code block.");
      } else {
        const res = await fetch(`/api/v1/marketing/email/campaigns/${id}/export?format=faire`);
        const data = await res.json();
        await navigator.clipboard.writeText(data.plainText ?? JSON.stringify(data.blocks, null, 2));
        fetch(`/api/v1/marketing/email/campaigns/${id}`)
          .then(r => r.json())
          .then(d => { if (d.campaign) setCampaign(d.campaign); });
        setPipelineMsg("Faire blocks copied to clipboard. Paste into Faire's email builder.");
      }
    } catch (e) {
      setPipelineMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
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
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/marketing/email">
              <Button variant="outline" size="sm">← Back</Button>
            </Link>
            <Badge variant={campaign.audience === "wholesale" ? "default" : "outline"}>
              {campaign.audience as string}
            </Badge>
            <Badge variant="outline">{campaign.status as string}</Badge>
            {savedAt && (
              <span className="text-xs text-muted-foreground">
                Saved {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          <h1 className="text-2xl font-semibold">
            {(campaign.subject as string | null) ?? (campaign.heroHeadline as string | null) ?? "(no subject yet)"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Scheduled {campaign.scheduledDate as string} · Week of {campaign.weekOf as string}
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
          <Button variant="outline" onClick={runValidate} disabled={pipelineBusy} title="Deterministic copy QA + export-readiness check">
            <ShieldCheck className="h-4 w-4 mr-2" />
            Validate
          </Button>
          <Button variant="outline" onClick={() => handleExport("omnisend")} disabled={exporting} title="Download standalone HTML to paste into Omnisend">
            <Download className="h-4 w-4 mr-2" />
            {exporting ? "Exporting…" : "Omnisend"}
          </Button>
          <Button variant="outline" onClick={() => handleExport("faire")} disabled={exporting} title="Copy Faire blocks to clipboard">
            <Download className="h-4 w-4 mr-2" />
            Faire
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

      {/* Pipeline stepper — the 10-stage workflow */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-1 overflow-x-auto pb-1">
            {STATUS_ORDER.map((s, i) => {
              const curIdx = STATUS_ORDER.indexOf(campaign.status as typeof STATUS_ORDER[number]);
              const done = i < curIdx;
              const current = i === curIdx;
              return (
                <div key={s} className="flex items-center shrink-0">
                  <div
                    className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs whitespace-nowrap ${
                      current
                        ? "bg-foreground text-background font-medium"
                        : done
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    {done && <CheckCircle2 className="h-3 w-3" />}
                    {STATUS_LABELS[s]}
                  </div>
                  {i < STATUS_ORDER.length - 1 && (
                    <ChevronRight className="h-3 w-3 text-muted-foreground/40 mx-0.5" />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => handleAdvance("back")} disabled={pipelineBusy}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Back
            </Button>
            <Button size="sm" onClick={() => handleAdvance("forward")} disabled={pipelineBusy}>
              Advance <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
            {pipelineMsg && (
              <span className="text-xs text-muted-foreground">{pipelineMsg}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Deterministic copy-QA results */}
      {lint && (lint.errors.length > 0 || lint.warnings.length > 0) && (
        <div className="space-y-2">
          {lint.errors.length > 0 && (
            <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
              <div className="flex items-center gap-1 font-medium text-destructive mb-1">
                <AlertTriangle className="h-4 w-4" /> {lint.errors.length} QA error{lint.errors.length > 1 ? "s" : ""} (score {lint.score}/100)
              </div>
              <ul className="list-disc ml-5 space-y-0.5">
                {lint.errors.map((f, i) => <li key={i}>{f.message}</li>)}
              </ul>
            </div>
          )}
          {lint.warnings.length > 0 && (
            <div className="rounded border border-orange-300 bg-orange-50 dark:bg-orange-950/20 px-3 py-2 text-sm">
              <div className="flex items-center gap-1 font-medium mb-1">
                <AlertTriangle className="h-4 w-4" /> {lint.warnings.length} warning{lint.warnings.length > 1 ? "s" : ""}
              </div>
              <ul className="list-disc ml-5 space-y-0.5">
                {lint.warnings.map((f, i) => <li key={i}>{f.message}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {lint && lint.ok && lint.warnings.length === 0 && (
        <div className="rounded border border-green-300 bg-green-50 dark:bg-green-950/20 px-3 py-2 text-sm flex items-center gap-1">
          <CheckCircle2 className="h-4 w-4 text-green-600" /> Copy QA passed (score {lint.score}/100).
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

          {["exported", "sent", "analyzed"].includes(campaign.status as string) && (
            <ResultsPanel
              campaignId={id}
              onRecorded={(c) => { if (c) setCampaign(c); setSavedAt(Date.now()); }}
            />
          )}
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
            Save to refresh the preview. Image paths show as placeholder blocks until Phase 4 wires uploads.
          </p>
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

// ────────────────────────────────────────────────────────────
// Results capture — Phase 6 manual entry (Omnisend / Faire metrics).
// Feeds the strategy learning loop.
// ────────────────────────────────────────────────────────────

function ResultsPanel({
  campaignId, onRecorded,
}: {
  campaignId: string;
  onRecorded: (campaign: Campaign | null) => void;
}) {
  const [platform, setPlatform] = useState<"omnisend" | "faire">("omnisend");
  const [recipients, setRecipients] = useState("");
  const [opens, setOpens] = useState("");
  const [clicks, setClicks] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    fetch(`/api/v1/marketing/email/campaigns/${campaignId}/results`)
      .then(r => r.json())
      .then(d => setHistory(d.results ?? []));
  }, [campaignId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  async function submit() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/marketing/email/campaigns/${campaignId}/results`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          recipients: recipients ? Number(recipients) : undefined,
          opens: opens ? Number(opens) : undefined,
          clicks: clicks ? Number(clicks) : undefined,
          notes: notes || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) { setMsg(data.error); return; }
      const or = data.openRate != null ? `${(data.openRate * 100).toFixed(1)}% open` : "";
      const cr = data.clickRate != null ? `${(data.clickRate * 100).toFixed(1)}% click` : "";
      setMsg(`Recorded. ${[or, cr].filter(Boolean).join(" · ")}`);
      setRecipients(""); setOpens(""); setClicks(""); setNotes("");
      loadHistory();
      // Refresh campaign to reflect the advanced status.
      const c = await fetch(`/api/v1/marketing/email/campaigns/${campaignId}`).then(r => r.json());
      onRecorded(c.campaign ?? null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-foreground/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          Results
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            Paste Omnisend / Faire metrics — feeds the strategy engine
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-1">
          {(["omnisend", "faire"] as const).map(p => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={`px-3 py-1 text-xs rounded border ${platform === p ? "bg-accent border-foreground" : "border-input"}`}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <LabeledInput label="Recipients" value={recipients} onChange={setRecipients} placeholder="0" />
          <LabeledInput label="Opens" value={opens} onChange={setOpens} placeholder="0" />
          <LabeledInput label="Clicks" value={clicks} onChange={setClicks} placeholder="0" />
        </div>
        <LabeledInput label="Notes (optional)" value={notes} onChange={setNotes} />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Record results"}
          </Button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
        {history.length > 0 && (
          <div className="text-xs text-muted-foreground space-y-1 pt-1 border-t">
            {history.map((h, i) => {
              const rate = (n: unknown) => (typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "—");
              return (
                <div key={i} className="flex justify-between tabular-nums">
                  <span>{String(h.platform)} · {Number(h.recipients) || 0} sent</span>
                  <span>{rate(h.openRate)} open · {rate(h.clickRate)} click</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
