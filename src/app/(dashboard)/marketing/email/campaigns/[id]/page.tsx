"use client";

import { use, useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Monitor, Smartphone, Save, Sparkles, Image as ImageIcon, Copy, Download, Loader2 } from "lucide-react";

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

/**
 * Wraps `fetch().then(r => r.json())` so empty bodies + non-JSON
 * responses (Railway proxy timeouts, Cloudflare 524s, framework
 * 500 HTML pages) produce an actionable error message instead of
 * the unhelpful "Unexpected end of JSON input."
 */
async function parseAiResponse(res: Response): Promise<{ data: Record<string, unknown> | null; error: string | null }> {
  const text = await res.text();
  if (!text || text.length === 0) {
    return {
      data: null,
      error: `HTTP ${res.status} from server with empty response body. This usually means the upstream timed out (Anthropic + Railway > ~30s). Try again — second attempt is usually faster because the model has cached context.`,
    };
  }
  try {
    return { data: JSON.parse(text), error: null };
  } catch {
    return {
      data: null,
      error: `HTTP ${res.status} returned non-JSON: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`,
    };
  }
}

export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  // Always-current campaign for use inside memoized callbacks (avoids
  // stale-closure reads). Set during render.
  const campaignRef = useRef<Campaign | null>(null);
  campaignRef.current = campaign;
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
  // True when the brief was edited after image prompts were generated
  // → the Higgsfield briefs are now stale and should be regenerated.
  const [briefStale, setBriefStale] = useState(false);
  const [exportingKind, setExportingKind] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<{ url: string; name: string } | null>(null);

  // ── AI generate handlers ────────────────────────────────────
  async function handleGenerateCopy() {
    // Warn if brief is empty — generation will still proceed but
    // with unspecified placeholders. Better to nudge the user back
    // to the brief field.
    // Title now = campaign.name (top of page). If empty, the AI
    // proposes one as part of the response. Angle is what we
    // really need for a quality generation.
    const briefAngle = String(campaign?.briefAngle ?? "").trim();
    if (!briefAngle) {
      const cont = confirm(
        "The Campaign Brief angle is empty. The AI will generate with placeholders. Continue anyway?",
      );
      if (!cont) return;
    }

    // Flush any pending in-flight edits before the AI runs so the
    // server reads the latest. flushChanges = no-op when nothing's
    // queued, so this is cheap when the user hasn't typed in a while.
    await save();

    setGenerating("copy");
    setGenerateError(null);
    setFailedChecks([]);
    setLint(null);
    try {
      const res = await fetch(
        `/api/v1/marketing/email/campaigns/${id}/generate-copy`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const { data, error: parseErr } = await parseAiResponse(res);
      if (parseErr || !data) {
        setGenerateError(parseErr ?? "Empty response");
      } else if (data.error) {
        setGenerateError(String(data.error));
      } else {
        setCampaign(data.campaign as Campaign);
        setFailedChecks((data.failedChecks as string[]) ?? []);
        setLint((data.lint as LintResult) ?? null);
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
    await save(); // flush any queued edits before the AI runs
    setGenerating("image_prompts");
    setGenerateError(null);
    try {
      const res = await fetch(
        `/api/v1/marketing/email/campaigns/${id}/generate-image-prompts`,
        { method: "POST" },
      );
      const { data, error: parseErr } = await parseAiResponse(res);
      if (parseErr || !data) {
        setGenerateError(parseErr ?? "Empty response");
      } else if (data.error) {
        setGenerateError(String(data.error));
      } else {
        setCampaign(data.campaign as Campaign);
        setPreviewKey(k => k + 1);
        setSavedAt(Date.now());
        setBriefStale(false);
      }
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(null);
    }
  }

  // ── Export a block (or the whole email) to an image, client-side ──
  // Renders the section HTML in an offscreen 600px iframe and
  // rasterizes it with html-to-image. No server browser / Chromium —
  // works in any deploy. `download=false` opens the image in a new tab.
  async function exportSectionImage(kind: string, download: boolean) {
    setExportingKind(kind);
    setExportError(null);
    let iframe: HTMLIFrameElement | null = null;
    try {
      await save(); // flush edits so the rendered block is current
      const html = await fetch(
        `/api/v1/marketing/email/campaigns/${id}/preview?kind=${kind}`,
      ).then((r) => r.text());

      iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:600px;height:200px;border:0;";
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument!;
      doc.open(); doc.write(html); doc.close();

      // Wait for layout + every image to finish.
      await new Promise((r) => setTimeout(r, 350));
      await Promise.all(
        Array.from(doc.images).map((img) =>
          img.complete ? Promise.resolve() : new Promise<void>((res) => { img.onload = img.onerror = () => res(); }),
        ),
      );

      const node = doc.body;
      const height = Math.max(node.scrollHeight, 40);
      const lib = await import("html-to-image");
      const opts = { width: 600, height, pixelRatio: 2, backgroundColor: "#ffffff", cacheBust: true };
      let dataUrl: string;
      try {
        dataUrl = await lib.toJpeg(node, { ...opts, quality: 0.92 });
      } catch {
        dataUrl = await lib.toJpeg(node, { ...opts, quality: 0.92, skipFonts: true });
      }

      const slug = String(campaign?.name || campaign?.subject || "campaign")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "campaign";
      if (download) {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `${slug}-${kind}.jpg`;
        document.body.appendChild(a); a.click(); a.remove();
      } else {
        // In-app lightbox (avoids popup blockers killing a new tab
        // opened after async work).
        setImagePreview({ url: dataUrl, name: `${slug}-${kind}.jpg` });
      }
    } catch (e) {
      setExportError(`Image export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (iframe) iframe.remove();
      setExportingKind(null);
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

  // ── Debounced diff PATCH ─────────────────────────────────────
  // Was: every updateField triggered a full-row PATCH (700+ fields).
  // That caused lost-update races when rapid edits piled up — a
  // second PATCH could clobber the first with stale local state.
  // Now: only the keys actually changed since the last save get
  // sent, batched on a 500ms debounce. Multiple field edits in
  // < 500ms collapse into one PATCH with the union of changes.
  const pendingChanges = useRef<Record<string, unknown>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushChanges = useCallback(async () => {
    const changes = pendingChanges.current;
    pendingChanges.current = {};
    if (Object.keys(changes).length === 0) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/marketing/email/campaigns/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await res.json();
      if (data.campaign) {
        // Merge server response into local state — don't fully
        // replace, in case the user has unsaved edits queued
        // since the PATCH started.
        setCampaign(c => (c ? { ...c, ...data.campaign } : data.campaign));
      }
      setSavedAt(Date.now());
      setPreviewKey(k => k + 1);
    } finally {
      setSaving(false);
    }
  }, [id]);

  const updateField = useCallback((key: string, value: unknown) => {
    setCampaign(c => (c ? { ...c, [key]: value } : c));
    // Editing the brief after image prompts exist makes those prompts
    // stale — flag it so the editor nudges a regenerate.
    if (
      ["name", "briefAngle", "briefProductHook", "briefSeasonalContext"].includes(key) &&
      campaignRef.current?.heroImagePrompt
    ) {
      setBriefStale(true);
    }
    pendingChanges.current[key] = value;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushChanges, 500);
  }, [flushChanges]);

  // Manual save fallback used by AI handlers — pushes any pending
  // edits immediately so the server reads the latest before the AI
  // call. Resolves once the PATCH lands.
  const save = flushChanges;

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
      {/* Image-export lightbox */}
      {imagePreview && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6"
          onClick={() => setImagePreview(null)}
        >
          <div className="bg-background rounded-lg p-3 max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2 gap-4">
              <span className="text-xs text-muted-foreground font-mono">{imagePreview.name}</span>
              <div className="flex gap-2">
                <a
                  href={imagePreview.url}
                  download={imagePreview.name}
                  className="text-xs px-2 py-1 rounded border border-input hover:bg-accent"
                >
                  <Download className="h-3 w-3 inline mr-1" /> Download
                </a>
                <button
                  onClick={() => setImagePreview(null)}
                  className="text-xs px-2 py-1 rounded border border-input hover:bg-accent"
                >
                  Close
                </button>
              </div>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imagePreview.url} alt="email export preview" style={{ maxWidth: "600px", width: "100%", height: "auto" }} />
          </div>
        </div>
      )}

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

      {/* AI status panel — visible while generating */}
      {generating !== null && (
        <GenerationStatus kind={generating} campaign={campaign} />
      )}

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

      {/* Deterministic copy QA (brand + hard-shape rules) — the real
          gate, run server-side on every generate. */}
      {lint && lint.errors.length > 0 && (
        <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
          <div className="font-medium text-destructive mb-1">
            {lint.errors.length} copy QA error{lint.errors.length > 1 ? "s" : ""} (score {lint.score}/100)
          </div>
          <ul className="list-disc ml-5 space-y-0.5">
            {lint.errors.map((f, i) => <li key={i}>{f.message}</li>)}
          </ul>
        </div>
      )}
      {lint && lint.errors.length === 0 && lint.warnings.length > 0 && (
        <div className="rounded border border-orange-300 bg-orange-50 dark:bg-orange-950/20 px-3 py-2 text-sm">
          <div className="font-medium mb-1">{lint.warnings.length} copy QA warning{lint.warnings.length > 1 ? "s" : ""}</div>
          <ul className="list-disc ml-5 space-y-0.5">
            {lint.warnings.map((f, i) => <li key={i}>{f.message}</li>)}
          </ul>
        </div>
      )}

      {/* Brief edited after image prompts were generated → stale. */}
      {briefStale && (
        <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-sm flex items-center justify-between gap-3">
          <span>
            You edited the brief after generating the image prompts — the
            Higgsfield briefs below may no longer match.
          </span>
          <Button size="sm" variant="outline" onClick={handleGenerateImagePrompts} disabled={generating !== null}>
            {generating === "image_prompts" ? "Regenerating…" : "Regenerate image prompts"}
          </Button>
        </div>
      )}

      {/* Image-prompt RESULTS — the Higgsfield briefs the AI produced.
          This is "where you see the response" after Generate image
          prompts. Persisted on the campaign + also shown to the
          designer in the queue. */}
      <ImagePromptResults campaign={campaign} />

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
              {/* Title used to live here as `briefTitle`. Now the
                  campaign NAME at the top of the page IS the title —
                  one field, one source of truth. If name is empty,
                  generate-copy will propose one + persist it. */}
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
                Title = the campaign name at the top of the page. Save the
                brief before generating. AI calls (Generate copy +
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

          <Card className={campaign.heroDisabled ? "opacity-50" : ""}>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Hero block</CardTitle>
              <div className="flex items-center gap-2">
                <SectionToggle
                  enabled={!campaign.heroDisabled}
                  onToggle={next => updateField("heroDisabled", !next)}
                />
                <VariantPicker
                  value={campaign.heroVariant as string}
                  onChange={v => updateField("heroVariant", v)}
                  options={HERO_VARIANTS}
                />
              </div>
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
              <InlineImageUpload
                campaignId={id}
                kind="hero"
                currentPath={campaign.heroImagePath as string | null}
                label="Hero image"
                hint="The big lead photo (variant dimensions vary)"
                onUploaded={path => updateField("heroImagePath", path)}
                onClear={() => updateField("heroImagePath", null)}
              />
              <LabeledInput
                label="Hero image alt text"
                value={campaign.heroImageAlt as string ?? ""}
                onChange={v => updateField("heroImageAlt", v)}
              />
            </CardContent>
          </Card>

          <Card className={campaign.sectionADisabled ? "opacity-50" : ""}>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Section A (text)</CardTitle>
              <div className="flex items-center gap-2">
                <SectionToggle
                  enabled={!campaign.sectionADisabled}
                  onToggle={next => updateField("sectionADisabled", !next)}
                />
                <VariantPicker
                  value={campaign.sectionAVariant as string}
                  onChange={v => updateField("sectionAVariant", v)}
                  options={SECTIONA_VARIANTS}
                />
              </div>
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

          <Card className={campaign.secondaryDisabled ? "opacity-50" : ""}>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Secondary image</CardTitle>
              <div className="flex items-center gap-2">
                <SectionToggle
                  enabled={!campaign.secondaryDisabled}
                  onToggle={next => updateField("secondaryDisabled", !next)}
                />
                <VariantPicker
                  value={campaign.secondaryImageVariant as string}
                  onChange={v => updateField("secondaryImageVariant", v)}
                  options={SECONDARY_VARIANTS}
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <InlineImageUpload
                campaignId={id}
                kind="secondary"
                currentPath={campaign.secondaryImagePath as string | null}
                label="Secondary image"
                onUploaded={path => updateField("secondaryImagePath", path)}
                onClear={() => updateField("secondaryImagePath", null)}
              />
              <LabeledInput
                label="Image alt text"
                value={campaign.secondaryImageAlt as string ?? ""}
                onChange={v => updateField("secondaryImageAlt", v)}
              />
              {showSecondaryImage2 && (
                <>
                  <InlineImageUpload
                    campaignId={id}
                    kind="secondary_2"
                    currentPath={campaign.secondaryImagePath2 as string | null}
                    label="Secondary image #2 (grid_2up only)"
                    onUploaded={path => updateField("secondaryImagePath2", path)}
                    onClear={() => updateField("secondaryImagePath2", null)}
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

          <Card className={campaign.sectionBDisabled ? "opacity-50" : ""}>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Section B (text + CTA)</CardTitle>
              <div className="flex items-center gap-2">
                <SectionToggle
                  enabled={!campaign.sectionBDisabled}
                  onToggle={next => updateField("sectionBDisabled", !next)}
                />
                <VariantPicker
                  value={campaign.sectionBVariant as string}
                  onChange={v => updateField("sectionBVariant", v)}
                  options={SECTIONB_VARIANTS}
                />
              </div>
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
              Faire / Omnisend / wherever. Rendered client-side with
              html-to-image (no server Chromium). */}
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
              ] as const).map(({ kind, label }) => {
                const busy = exportingKind === kind;
                return (
                  <div key={kind} className="flex items-center justify-between gap-2 text-sm">
                    <span>{label}</span>
                    <div className="flex gap-1 items-center">
                      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                      <button
                        type="button"
                        onClick={() => exportSectionImage(kind, false)}
                        disabled={exportingKind !== null}
                        className="text-xs underline text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => exportSectionImage(kind, true)}
                        disabled={exportingKind !== null}
                        className="text-xs px-2 py-1 rounded border border-input hover:bg-accent disabled:opacity-50"
                      >
                        <Download className="h-3 w-3 inline mr-1" />
                        Download JPG
                      </button>
                    </div>
                  </div>
                );
              })}
              {exportError && (
                <p className="text-xs text-destructive pt-1">{exportError}</p>
              )}
              <p className="text-xs text-muted-foreground pt-2 border-t mt-2">
                Rendered in your browser at 2× retina (600px wide). No server
                wait — &ldquo;View&rdquo; opens the image in a new tab, &ldquo;Download&rdquo; saves a JPG.
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

// ────────────────────────────────────────────────────────────
// AI generation status panel — replaces the silent spinner with
// a live view of what the AI sees + how long it's been running.
// Daniel: "add the loading for the ai generate with some updates
// so we know what's going on, maybe even show the prompt that
// we're using and the input etc."
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// Image-prompt RESULTS — shows the Higgsfield briefs the AI wrote
// (hero + secondary), so the user can read/copy them right in the
// editor. Mirrors how generate-copy fills the visible form fields.
// ────────────────────────────────────────────────────────────
function ImagePromptResults({ campaign }: { campaign: Campaign }) {
  const heroPrompt = (campaign.heroImagePrompt as string) || "";
  const secondaryPrompt = (campaign.secondaryImagePrompt as string) || "";
  const secondaryPrompt2 = (campaign.secondaryImagePrompt2 as string) || "";
  const heroAlt = (campaign.heroImageAlt as string) || "";
  const secondaryAlt = (campaign.secondaryImageAlt as string) || "";
  const secondaryAlt2 = (campaign.secondaryImageAlt2 as string) || "";
  const scrim = (campaign.heroScrim as string) || "";

  // Nothing generated yet — render nothing (the button + status panel
  // handle the "before" state).
  if (!heroPrompt && !secondaryPrompt) return null;

  return (
    <Card className="border-foreground/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <ImageIcon className="h-4 w-4" />
          Image prompts (Higgsfield briefs)
          <span className="text-xs font-normal text-muted-foreground">
            What the designer renders — also shown in the designer queue
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {heroPrompt && (
          <CopyablePrompt
            label="Hero"
            prompt={heroPrompt}
            alt={heroAlt}
            extra={scrim ? `Recommended scrim: ${scrim}` : null}
          />
        )}
        {secondaryPrompt && (
          <CopyablePrompt label="Secondary" prompt={secondaryPrompt} alt={secondaryAlt} extra={null} />
        )}
        {secondaryPrompt2 && (
          <CopyablePrompt label="Secondary 2" prompt={secondaryPrompt2} alt={secondaryAlt2} extra={null} />
        )}
      </CardContent>
    </Card>
  );
}

function CopyablePrompt({
  label, prompt, alt, extra,
}: {
  label: string;
  prompt: string;
  alt: string;
  extra: string | null;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — no-op */ }
  }
  return (
    <div className="rounded border border-input p-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <Copy className="h-3 w-3" /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-xs font-mono whitespace-pre-wrap leading-relaxed">{prompt}</p>
      {alt && <p className="text-xs text-muted-foreground"><strong>Alt:</strong> {alt}</p>}
      {extra && <p className="text-xs text-muted-foreground">{extra}</p>}
    </div>
  );
}

function GenerationStatus({
  kind, campaign, onCancel,
}: {
  kind: "copy" | "image_prompts";
  campaign: Campaign;
  onCancel?: () => void;
}) {
  // Elapsed-time tick — 1s resolution is fine, no need for RAF
  const [elapsed, setElapsed] = useState(0);
  const [calendarCount, setCalendarCount] = useState<number | null>(null);

  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Fetch calendar-event count so we can show "5 events in the
  // ±14 day window" — confirms the AI is using calendar context.
  useEffect(() => {
    const scheduled = campaign.scheduledDate as string | undefined;
    const audience = campaign.audience as string | undefined;
    if (!scheduled) return;
    const from = new Date(new Date(scheduled).getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const to = new Date(new Date(scheduled).getTime() + 14 * 86400000).toISOString().slice(0, 10);
    const qs = new URLSearchParams({ from, to, audience: audience ?? "all" });
    fetch(`/api/v1/marketing/calendar/events?${qs}`)
      .then(r => r.json())
      .then(d => setCalendarCount((d.events ?? []).length))
      .catch(() => setCalendarCount(0));
  }, [campaign.scheduledDate, campaign.audience]);

  const label = kind === "copy" ? "Generating copy" : "Generating image prompts";
  const promptVersion = kind === "copy" ? "v5" : "v3";

  return (
    <Card className="border-foreground/40 bg-accent/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 animate-pulse" />
            {label}
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {elapsed}s elapsed · typical 10-30s
            </span>
          </span>
          {onCancel && (
            <button onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground">
              Hide (generation continues)
            </button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div>
          <div className="font-medium text-muted-foreground mb-1">What the AI sees:</div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 pl-3 border-l-2 border-input">
            <dt className="text-muted-foreground">Name / title</dt>
            <dd className="font-mono">{(campaign.name as string) || <em className="text-muted-foreground">(blank — AI will propose)</em>}</dd>
            <dt className="text-muted-foreground">Angle</dt>
            <dd className="font-mono whitespace-pre-wrap">{(campaign.briefAngle as string) || <em className="text-muted-foreground">(blank)</em>}</dd>
            {(campaign.briefProductHook as string) && (<><dt className="text-muted-foreground">Product hook</dt><dd className="font-mono">{campaign.briefProductHook as string}</dd></>)}
            {(campaign.briefSeasonalContext as string) && (<><dt className="text-muted-foreground">Seasonal</dt><dd className="font-mono">{campaign.briefSeasonalContext as string}</dd></>)}
            <dt className="text-muted-foreground">Audience</dt>
            <dd className="font-mono">{campaign.audience as string}</dd>
            <dt className="text-muted-foreground">Send date</dt>
            <dd className="font-mono tabular-nums">{campaign.scheduledDate as string}</dd>
            <dt className="text-muted-foreground">Hero variant</dt>
            <dd className="font-mono">{campaign.heroVariant as string}</dd>
            {kind === "image_prompts" && (
              <>
                <dt className="text-muted-foreground">Secondary variant</dt>
                <dd className="font-mono">{campaign.secondaryImageVariant as string}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Calendar context</dt>
            <dd className="font-mono">
              {calendarCount === null
                ? "loading…"
                : calendarCount === 0
                  ? "no events in ±14 day window"
                  : `${calendarCount} event${calendarCount === 1 ? "" : "s"} in ±14 day window`}
            </dd>
            <dt className="text-muted-foreground">Brand context</dt>
            <dd className="font-mono">brand-bible.md + {campaign.audience === "wholesale" ? "wholesale-voice.md" : "retail voice"}</dd>
            <dt className="text-muted-foreground">Prompt version</dt>
            <dd className="font-mono">{promptVersion}</dd>
            <dt className="text-muted-foreground">Model</dt>
            <dd className="font-mono">Claude Opus</dd>
          </dl>
        </div>
        <div className="text-muted-foreground">
          AI is composing the email now. Server logs the full prompt server-side.
          Cancel-safe: closing this card does not abort the generation; result
          will land when ready.
        </div>
      </CardContent>
    </Card>
  );
}

// Section enable/disable toggle. Daniel: "you should be able to
// delete sections." We don't actually delete — we toggle a
// {section}_disabled flag and the renderer skips the block. That
// way content survives the toggle (turn it back on, copy is still
// there).
function SectionToggle({
  enabled, onToggle,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!enabled)}
      className={`text-xs px-2 py-1 rounded border transition-colors ${
        enabled
          ? "border-input hover:bg-accent"
          : "border-destructive/30 bg-destructive/10 text-destructive"
      }`}
      title={enabled ? "Hide this section in the rendered email" : "Show this section again"}
    >
      {enabled ? "✓ Included" : "✗ Hidden"}
    </button>
  );
}

// ────────────────────────────────────────────────────────────
// Inline image-upload field (drop or pick) — used for hero,
// secondary, logo, etc. Uploads via the campaign's upload-image
// endpoint, then triggers a parent refresh so the new path
// appears in the preview iframe + the form state.
// ────────────────────────────────────────────────────────────

function InlineImageUpload({
  campaignId, kind, currentPath, label, hint, onUploaded, onClear,
}: {
  campaignId: string;
  kind: "hero" | "secondary" | "secondary_2" | "logo";
  currentPath: string | null;
  label: string;
  hint?: string;
  onUploaded: (relPath: string) => void;
  onClear?: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handle(file: File) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      const res = await fetch(
        `/api/v1/marketing/email/campaigns/${campaignId}/upload-image`,
        { method: "POST", body: fd },
      );
      const data = await res.json();
      if (data.error) setError(data.error);
      else if (data.path) onUploaded(data.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  // Cache-bust on every render — re-uploaded images share the same
  // path, so without ?v=<timestamp> the browser shows the old copy.
  // Keyed on the path so it only changes when we actually replaced.
  const imgSrc = currentPath
    ? `/api/images/${currentPath.replace(/^\/*(data\/images\/)?/, "")}?v=${encodeURIComponent(currentPath)}`
    : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">{label}</label>
        {currentPath && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-destructive"
          >
            Clear
          </button>
        )}
      </div>

      <label
        className={`flex gap-3 items-center border-2 border-dashed rounded-md p-2 cursor-pointer transition-colors ${
          dragOver ? "border-foreground bg-accent" : "border-input hover:bg-accent"
        } ${uploading ? "opacity-50 pointer-events-none" : ""}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f && f.type.startsWith("image/")) handle(f);
          else if (f) setError(`Not an image: ${f.type}`);
        }}
      >
        {currentPath && imgSrc ? (
          <img
            src={imgSrc}
            alt={kind}
            className="w-16 h-16 object-cover rounded border border-input"
          />
        ) : (
          <div className="w-16 h-16 bg-muted rounded flex items-center justify-center text-muted-foreground">
            <ImageIcon className="h-5 w-5" />
          </div>
        )}
        <div className="text-xs flex-1 min-w-0">
          {uploading ? (
            <span className="text-foreground">Uploading…</span>
          ) : currentPath ? (
            <>
              <div className="font-medium truncate">Uploaded</div>
              <div className="text-muted-foreground truncate font-mono text-[10px]">{currentPath}</div>
              <div className="text-muted-foreground">Drop a new image to replace</div>
            </>
          ) : (
            <>
              <div className="font-medium">Drop or click to upload</div>
              {hint && <div className="text-muted-foreground">{hint}</div>}
            </>
          )}
        </div>
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) handle(f);
            e.target.value = "";
          }}
        />
      </label>

      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
