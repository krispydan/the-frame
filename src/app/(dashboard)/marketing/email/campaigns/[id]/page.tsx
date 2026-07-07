"use client";

import { use, useEffect, useState, useCallback, useRef, Fragment, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, Monitor, Smartphone, Save, Sparkles, Image as ImageIcon, Copy, Download, Loader2, ShieldCheck, RefreshCw, Check, Plus, X, Search, Package, MessageSquare, Send } from "lucide-react";
import { parseFeaturedIds } from "@/modules/marketing/lib/featured-products";
import type { ProductSummary } from "@/modules/marketing/lib/product-selector";

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

const TEXT_PLACEMENT_OPTIONS = [
  { value: "top",    label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
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
  // Which slot a per-slot image-prompt regenerate is targeting (null = both)
  const [regenSlot, setRegenSlot] = useState<"hero" | "secondary" | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [failedChecks, setFailedChecks] = useState<string[]>([]);
  const [lint, setLint] = useState<LintResult | null>(null);
  // True when the brief was edited after image prompts were generated
  // → the Higgsfield briefs are now stale and should be regenerated.
  const [briefStale, setBriefStale] = useState(false);
  // Bumped after each generate-copy so the copy-history panel refetches.
  const [historySignal, setHistorySignal] = useState(0);
  const [exportingKind, setExportingKind] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<{ url: string; name: string } | null>(null);
  const [exportScale, setExportScale] = useState<1 | 2 | 3>(2);
  const [copiedKind, setCopiedKind] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [validateMsg, setValidateMsg] = useState<string | null>(null);

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
        setHistorySignal(s => s + 1);
      }
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(null);
    }
  }

  // Natural-language "chat to improve the whole email" — sends feedback
  // to revise-copy, which rewrites every field and persists it
  // (snapshotting first, so it's undoable from Copy history).
  async function handleReviseCopy(feedbackText: string): Promise<boolean> {
    await save(); // flush pending edits so we revise the latest copy
    setGenerating("copy");
    setGenerateError(null);
    setFailedChecks([]);
    try {
      const res = await fetch(
        `/api/v1/marketing/email/campaigns/${id}/revise-copy`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback: feedbackText }) },
      );
      const { data, error: parseErr } = await parseAiResponse(res);
      if (parseErr || !data) { setGenerateError(parseErr ?? "Empty response"); return false; }
      if (data.error) { setGenerateError(String(data.error)); return false; }
      setCampaign(data.campaign as Campaign);
      setFailedChecks((data.failedChecks as string[]) ?? []);
      setLint((data.lint as LintResult) ?? null);
      setPreviewKey(k => k + 1);
      setSavedAt(Date.now());
      setHistorySignal(s => s + 1);
      return true;
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setGenerating(null);
    }
  }

  async function handleGenerateImagePrompts(slot?: "hero" | "secondary") {
    await save(); // flush any queued edits before the AI runs
    setGenerating("image_prompts");
    setRegenSlot(slot ?? null);
    setGenerateError(null);
    try {
      const qs = slot ? `?slot=${slot}` : "";
      const res = await fetch(
        `/api/v1/marketing/email/campaigns/${id}/generate-image-prompts${qs}`,
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
      setRegenSlot(null);
    }
  }

  // ── Export a block (or the whole email) to an image, client-side ──
  // Renders the section HTML in an offscreen 600px iframe and
  // rasterizes it with html-to-image. No server browser / Chromium —
  // works in any deploy. `download=false` opens the image in a new tab.
  async function exportSectionImage(kind: string, mode: "view" | "download" | "copy") {
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
      // Resolution preset: 1× = 600px, 2× = 1200px (retina), 3× = 1800px.
      const opts = { width: 600, height, pixelRatio: exportScale, backgroundColor: "#ffffff", cacheBust: true };

      const slug = String(campaign?.name || campaign?.subject || "campaign")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "campaign";

      if (mode === "copy") {
        // PNG blob → clipboard (image/png is the broadly-supported
        // clipboard image type). Falls back to the lightbox if the
        // browser blocks clipboard image writes.
        let blob: Blob | null = null;
        try { blob = await lib.toBlob(node, opts); }
        catch { blob = await lib.toBlob(node, { ...opts, skipFonts: true }); }
        if (blob && navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
          try {
            await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
            setExportError(null);
            setCopiedKind(kind);
            setTimeout(() => setCopiedKind((k) => (k === kind ? null : k)), 1800);
            return;
          } catch { /* clipboard blocked — fall through to lightbox */ }
        }
        if (blob) setImagePreview({ url: URL.createObjectURL(blob), name: `${slug}-${kind}.png` });
        return;
      }

      let dataUrl: string;
      try {
        dataUrl = await lib.toJpeg(node, { ...opts, quality: 0.92 });
      } catch {
        dataUrl = await lib.toJpeg(node, { ...opts, quality: 0.92, skipFonts: true });
      }

      if (mode === "download") {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `${slug}-${kind}@${exportScale}x.jpg`;
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

  // On-demand QA — re-runs the linter + readiness on the current row
  // (including any hand edits), via the same gate AI output passes.
  async function runValidate() {
    setValidating(true);
    setValidateMsg(null);
    try {
      await save(); // flush edits so we validate what's actually saved
      const res = await fetch(`/api/v1/marketing/email/campaigns/${id}/validate`);
      const data = await res.json();
      setLint((data.lint as LintResult) ?? null);
      if (data.readiness && !data.readiness.ready) {
        setValidateMsg(`Not ready to export — missing: ${data.readiness.missing.join(", ")}.`);
      } else if (data.lint && data.lint.errors?.length === 0 && data.lint.warnings?.length === 0) {
        setValidateMsg("Looks good — copy QA passed and all fields present.");
      } else {
        setValidateMsg(null);
      }
    } catch (e) {
      setValidateMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
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
  // Focal applies wherever the hero image is cover-cropped.
  const showFocalPicker =
    campaign.heroVariant === "full_bleed_overlay" || campaign.heroVariant === "split_50_50";
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
              <Button variant="outline" size="sm">← Email assistant</Button>
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
            onClick={() => handleGenerateImagePrompts()}
            disabled={generating !== null}
            title="Generate Higgsfield briefs for hero + secondary images"
          >
            <ImageIcon className="h-4 w-4 mr-2" />
            {generating === "image_prompts" ? "Briefing…" : "Generate image prompts"}
          </Button>
          <Button
            variant="outline"
            onClick={runValidate}
            disabled={validating}
            title="Run copy QA + export-readiness on the current copy (incl. hand edits)"
          >
            <ShieldCheck className="h-4 w-4 mr-2" />
            {validating ? "Checking…" : "Validate"}
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

      {/* Pipeline stepper — where am I, what's next */}
      <PipelineStepper campaign={campaign} />

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
      {validateMsg && (
        <div className={`rounded border px-3 py-2 text-sm ${validateMsg.startsWith("Looks good") ? "border-green-300 bg-green-50 dark:bg-green-950/20" : "border-amber-300 bg-amber-50 dark:bg-amber-950/20"}`}>
          {validateMsg}
        </div>
      )}

      {/* Brief edited after image prompts were generated → stale. */}
      {briefStale && (
        <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-sm flex items-center justify-between gap-3">
          <span>
            You edited the brief after generating the image prompts — the
            Higgsfield briefs below may no longer match.
          </span>
          <Button size="sm" variant="outline" onClick={() => handleGenerateImagePrompts()} disabled={generating !== null}>
            {generating === "image_prompts" && regenSlot === null ? "Regenerating…" : "Regenerate image prompts"}
          </Button>
        </div>
      )}

      {/* Image-prompt RESULTS — the Higgsfield briefs the AI produced.
          This is "where you see the response" after Generate image
          prompts. Persisted on the campaign + also shown to the
          designer in the queue. Per-slot "Regenerate" lets the
          designer refresh just hero or just secondary without
          discarding the one they like. */}
      <ImagePromptResults
        campaign={campaign}
        busy={generating === "image_prompts"}
        regenSlot={regenSlot}
        onRegenerate={(slot) => handleGenerateImagePrompts(slot)}
      />

      {/* Copy history — restore a prior version if a regenerate came
          back worse. Snapshots are taken automatically before each
          generate-copy. */}
      <CopyHistory
        campaignId={id}
        reloadSignal={historySignal}
        onRestored={(c) => { setCampaign(c); setPreviewKey(k => k + 1); setSavedAt(Date.now()); }}
      />

      {/* Chat to improve the whole email in natural language */}
      <ImproveCopyChat busy={generating !== null} onSend={handleReviseCopy} />

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

          <FeaturedProductsCard
            campaign={campaign}
            onChange={(idsJson) =>
              setCampaign((c) => (c ? { ...c, featuredProductIds: idsJson } : c))
            }
          />

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">
                Subject + preheader
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  Primary is what exports — keep the alt to A/B test angles
                </span>
              </CardTitle>
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

              {/* A/B alternate — a different angle for the same email. */}
              <div className="rounded-md border border-dashed border-input p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Alternate subject (A/B — different angle)
                  </span>
                  {(campaign.subjectAlt as string) && (
                    <button
                      type="button"
                      title="Swap the alternate into primary (and primary into alt)"
                      onClick={() => {
                        const s = campaign.subject as string ?? "";
                        const p = campaign.preheader as string ?? "";
                        const sa = campaign.subjectAlt as string ?? "";
                        const pa = campaign.preheaderAlt as string ?? "";
                        updateField("subject", sa);
                        updateField("preheader", pa);
                        updateField("subjectAlt", s);
                        updateField("preheaderAlt", p);
                      }}
                      className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                      ⇄ Make primary
                    </button>
                  )}
                </div>
                <LabeledInput
                  label="Alt subject (≤45 char)"
                  value={campaign.subjectAlt as string ?? ""}
                  onChange={v => updateField("subjectAlt", v)}
                  placeholder="a different angle on the same email"
                  maxLength={45}
                />
                <LabeledInput
                  label="Alt preheader (50–90 char)"
                  value={campaign.preheaderAlt as string ?? ""}
                  onChange={v => updateField("preheaderAlt", v)}
                  maxLength={90}
                />
              </div>
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
              {showScrimPicker && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Text placement
                  </label>
                  <div className="flex gap-1">
                    {TEXT_PLACEMENT_OPTIONS.map(o => (
                      <button
                        key={o.value}
                        onClick={() => updateField("heroTextPlacement", o.value)}
                        className={`px-3 py-1 text-xs rounded border ${
                          (campaign.heroTextPlacement ?? "middle") === o.value
                            ? "bg-accent border-foreground"
                            : "border-input"
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Where the headline sits over the image — the fade follows the text.
                  </p>
                </div>
              )}
              {showFocalPicker && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Image focal point
                  </label>
                  <div className="grid grid-cols-3 gap-1 w-fit">
                    {(["left top","center top","right top","left center","center center","right center","left bottom","center bottom","right bottom"] as const).map(f => (
                      <button
                        key={f}
                        title={f}
                        onClick={() => updateField("heroImageFocal", f)}
                        className={`w-7 h-7 rounded border flex items-center justify-center ${
                          (campaign.heroImageFocal ?? "center center") === f
                            ? "bg-accent border-foreground"
                            : "border-input"
                        }`}
                      >
                        <span className={`block w-1.5 h-1.5 rounded-full ${
                          (campaign.heroImageFocal ?? "center center") === f ? "bg-foreground" : "bg-muted-foreground/40"
                        }`} />
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Which part of the photo survives the crop — aim it at the product.
                  </p>
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
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">
                Export as images
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  per block — paste into Faire / Omnisend
                </span>
              </CardTitle>
              <label className="text-xs text-muted-foreground flex items-center gap-1">
                Resolution
                <select
                  value={exportScale}
                  onChange={(e) => setExportScale(Number(e.target.value) as 1 | 2 | 3)}
                  className="h-7 rounded-md border border-input bg-background px-1 text-xs"
                >
                  <option value={1}>1× (600px)</option>
                  <option value={2}>2× (1200px)</option>
                  <option value={3}>3× (1800px)</option>
                </select>
              </label>
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
                        onClick={() => exportSectionImage(kind, "view")}
                        disabled={exportingKind !== null}
                        className="text-xs underline text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => exportSectionImage(kind, "copy")}
                        disabled={exportingKind !== null}
                        className="text-xs px-2 py-1 rounded border border-input hover:bg-accent disabled:opacity-50"
                        title="Copy the image to the clipboard for pasting"
                      >
                        <Copy className="h-3 w-3 inline mr-1" />
                        {copiedKind === kind ? "Copied" : "Copy"}
                      </button>
                      <button
                        type="button"
                        onClick={() => exportSectionImage(kind, "download")}
                        disabled={exportingKind !== null}
                        className="text-xs px-2 py-1 rounded border border-input hover:bg-accent disabled:opacity-50"
                      >
                        <Download className="h-3 w-3 inline mr-1" />
                        JPG
                      </button>
                    </div>
                  </div>
                );
              })}
              {exportError && (
                <p className="text-xs text-destructive pt-1">{exportError}</p>
              )}
              {/* FULL-HTML EXPORT — Omnisend accepts custom-HTML emails, so
                  the whole email can go over as ONE artifact instead of
                  screenshot blocks. Images stay absolute URLs served by
                  the-frame, so the HTML works as-is. */}
              <div className="flex items-center justify-between gap-2 text-sm pt-2 border-t mt-2">
                <span>
                  Email HTML
                  <span className="ml-1 text-xs text-muted-foreground">for Omnisend custom-HTML</span>
                </span>
                <div className="flex gap-1 items-center">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await save(); // flush unsaved edits — export must match what's on screen
                        if (!navigator.clipboard) throw new Error("Clipboard needs HTTPS — use the .html download instead");
                        const res = await fetch(`/api/v1/marketing/email/campaigns/${id}/preview`);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        await navigator.clipboard.writeText(await res.text());
                        setCopiedKind("html");
                        setTimeout(() => setCopiedKind((k) => (k === "html" ? null : k)), 2000);
                      } catch (e) {
                        setExportError(e instanceof Error ? e.message : "Copy failed");
                      }
                    }}
                    className="text-xs px-2 py-1 rounded border border-input hover:bg-accent"
                    title="Copy the full email HTML — paste into Omnisend's custom HTML editor"
                  >
                    <Copy className="h-3 w-3 inline mr-1" />
                    {copiedKind === "html" ? "Copied" : "Copy HTML"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await save(); // flush unsaved edits first
                      window.open(`/api/v1/marketing/email/campaigns/${id}/preview?download=1`, "_blank");
                    }}
                    className="text-xs px-2 py-1 rounded border border-input hover:bg-accent"
                    title="Download the full email as an .html file"
                  >
                    <Download className="h-3 w-3 inline mr-1" />
                    .html
                  </button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground pt-2 border-t mt-2">
                Rendered in your browser ({exportScale}× = {600 * exportScale}px wide). No server
                wait — <strong>Copy</strong> puts the image on your clipboard (paste straight into Faire/Omnisend),
                <strong> View</strong> opens it, <strong>JPG</strong> downloads it.
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
// ────────────────────────────────────────────────────────────
// Featured products — attach real SKUs to a campaign so the copy +
// image briefs are grounded in actual products (specs + photos fed to
// the AI). Optional: only SOME emails feature products. Persists the
// id list to the campaign's featured_product_ids column on each change.
// ────────────────────────────────────────────────────────────
const MAX_FEATURED = 3;

function FeaturedProductsCard({
  campaign, onChange,
}: {
  campaign: Campaign;
  onChange: (idsJson: string | null) => void;
}) {
  const campaignId = campaign.id as string;
  const [ids, setIds] = useState<string[]>(() => parseFeaturedIds(campaign.featuredProductIds as string | null));
  const [selected, setSelected] = useState<ProductSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"in_stock" | "top_sellers">("in_stock");
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Resolve the selected ids → summaries for display.
  useEffect(() => {
    if (ids.length === 0) { setSelected([]); return; }
    let alive = true;
    fetch(`/api/v1/marketing/email/products?ids=${ids.join(",")}`)
      .then((r) => r.json())
      .then((d) => { if (alive) setSelected(d.products ?? []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [ids]);

  // Load candidates when the picker is open (debounced on the query).
  const loadCandidates = useCallback(() => {
    setLoading(true);
    const url = q.trim()
      ? `/api/v1/marketing/email/products?q=${encodeURIComponent(q.trim())}`
      : `/api/v1/marketing/email/products?mode=${mode}`;
    fetch(url)
      .then((r) => r.json())
      .then((d) => setCandidates(d.products ?? []))
      .catch(() => setCandidates([]))
      .finally(() => setLoading(false));
  }, [q, mode]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(loadCandidates, 250);
    return () => clearTimeout(t);
  }, [open, loadCandidates]);

  async function persist(next: string[]) {
    setIds(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/marketing/email/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featuredProductIds: next }),
      });
      const data = await res.json();
      onChange(data.campaign?.featuredProductIds ?? null);
    } finally {
      setSaving(false);
    }
  }
  const add = (id: string) => { if (!ids.includes(id) && ids.length < MAX_FEATURED) persist([...ids, id]); };
  const remove = (id: string) => persist(ids.filter((x) => x !== id));
  async function suggest() {
    const res = await fetch(`/api/v1/marketing/email/products?suggest=2&mode=${mode}`);
    const d = await res.json();
    const fresh = (d.products ?? []).map((p: ProductSummary) => p.id).filter((x: string) => !ids.includes(x));
    if (fresh.length) persist([...ids, ...fresh].slice(0, MAX_FEATURED));
  }

  const atMax = ids.length >= MAX_FEATURED;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Package className="h-4 w-4" />
          Featured products
          <span className="text-xs font-normal text-muted-foreground">
            optional — grounds copy + image briefs in real SKUs (specs + photos)
          </span>
          {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Selected products */}
        {selected.length > 0 ? (
          <div className="space-y-2">
            {selected.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded border border-input p-2">
                {p.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.imageUrl} alt={p.imageAlt ?? p.name} className="h-10 w-10 rounded object-cover" />
                ) : (
                  <div className="h-10 w-10 rounded bg-muted flex items-center justify-center"><Package className="h-4 w-4 text-muted-foreground" /></div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {p.priceRetail != null ? `$${p.priceRetail.toFixed(2)}` : ""}{p.specs[0] ? ` · ${p.specs[0]}` : ""}
                  </div>
                </div>
                <button type="button" onClick={() => remove(p.id)} className="text-muted-foreground hover:text-destructive" title="Remove">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No products attached — this will be a brand/theme email. Add 1–{MAX_FEATURED} to feature specific frames.
          </p>
        )}

        {/* Add / picker toggle */}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)} disabled={atMax}>
            <Plus className="h-3 w-3 mr-1" /> {open ? "Done" : "Add products"}
          </Button>
          <Button size="sm" variant="ghost" onClick={suggest} disabled={atMax} title="Attach random in-stock / top-selling products">
            <Sparkles className="h-3 w-3 mr-1" /> Suggest
          </Button>
          {atMax && <span className="text-xs text-muted-foreground">Max {MAX_FEATURED} reached</span>}
        </div>

        {/* Picker */}
        {open && (
          <div className="rounded border border-input p-2 space-y-2">
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => { setMode("in_stock"); setQ(""); }}
                className={`text-xs px-2 py-1 rounded ${mode === "in_stock" && !q ? "bg-accent" : "text-muted-foreground"}`}>In stock</button>
              <button type="button" onClick={() => { setMode("top_sellers"); setQ(""); }}
                className={`text-xs px-2 py-1 rounded ${mode === "top_sellers" && !q ? "bg-accent" : "text-muted-foreground"}`}>Top sellers</button>
              <div className="flex items-center gap-1 ml-auto">
                <Search className="h-3 w-3 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / SKU"
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs w-40" />
              </div>
            </div>
            {loading ? (
              <div className="text-xs text-muted-foreground py-2">Loading…</div>
            ) : candidates.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">No products found.</div>
            ) : (
              <div className="max-h-64 overflow-auto space-y-1">
                {candidates.map((p) => {
                  const chosen = ids.includes(p.id);
                  return (
                    <div key={p.id} className="flex items-center gap-2 rounded p-1 hover:bg-accent/50">
                      {p.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.imageUrl} alt={p.imageAlt ?? p.name} className="h-8 w-8 rounded object-cover" />
                      ) : (
                        <div className="h-8 w-8 rounded bg-muted flex items-center justify-center"><Package className="h-3 w-3 text-muted-foreground" /></div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs truncate">{p.name}</div>
                        <div className="text-[11px] text-muted-foreground truncate">{p.priceRetail != null ? `$${p.priceRetail.toFixed(2)}` : ""}</div>
                      </div>
                      <Button size="sm" variant={chosen ? "ghost" : "outline"} disabled={chosen || atMax} onClick={() => add(p.id)}>
                        {chosen ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────
// Improve-this-email chat — natural-language feedback that rewrites the
// WHOLE email. Each message revises from the current copy, so the
// operator can iterate conversationally. Every revision snapshots the
// prior copy (undo from Copy history).
// ────────────────────────────────────────────────────────────
function ImproveCopyChat({ busy, onSend }: { busy: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [input, setInput] = useState("");
  const [thread, setThread] = useState<Array<{ role: "you" | "ai"; text: string }>>([]);
  const [sending, setSending] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || busy || sending) return;
    setThread((t) => [...t, { role: "you", text }]);
    setInput("");
    setSending(true);
    try {
      const ok = await onSend(text);
      setThread((t) => [
        ...t,
        { role: "ai", text: ok ? "✓ Rewrote the email — check the preview." : "⚠ Couldn't apply that (see the error above)." },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="h-4 w-4" />
          Improve this email
          <span className="text-xs font-normal text-muted-foreground">
            tell the AI what to change in plain language — it rewrites the whole email
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {thread.length > 0 && (
          <div className="max-h-48 overflow-auto space-y-1.5 rounded border border-input p-2">
            {thread.map((m, i) => (
              <div key={i} className={`text-xs ${m.role === "you" ? "text-foreground" : "text-muted-foreground"}`}>
                <span className="font-medium">{m.role === "you" ? "You: " : "AI: "}</span>
                {m.text}
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send(); }}
            placeholder="e.g. Punchier hero, tie the CTA to the fit quiz, and cut the second paragraph in section B."
            rows={2}
            disabled={busy || sending}
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <Button size="sm" onClick={send} disabled={busy || sending || !input.trim()} title="Send (⌘/Ctrl+Enter)">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Each message rewrites the full email from the current copy — iterate as much as you like. Undo any change from Copy history.
        </p>
      </CardContent>
    </Card>
  );
}

// ────────────────────────────────────────────────────────────
// Pipeline stepper — turns the pile of controls into a sequence.
// Derives the current stage from the campaign's actual data (more
// reliable than the manually-settable status), highlights it, and
// names the single next action. Brief → Copy → Images → Designer →
// Schedule.
// ────────────────────────────────────────────────────────────
function PipelineStepper({ campaign }: { campaign: Campaign }) {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const status = s(campaign.status);

  const hasBrief = !!(s(campaign.briefAngle) || s(campaign.name));
  const hasCopy = !!(s(campaign.heroHeadline) || s(campaign.subject));
  const hasImagePrompts = !!s(campaign.heroImagePrompt);

  const secondaryNeeded = !campaign.secondaryDisabled;
  const secondary2Needed = secondaryNeeded && campaign.secondaryImageVariant === "grid_2up";
  const hasAllImages =
    (campaign.heroDisabled || !!s(campaign.heroImagePath)) &&
    (!secondaryNeeded || !!s(campaign.secondaryImagePath)) &&
    (!secondary2Needed || !!s(campaign.secondaryImagePath2));

  const isScheduledOrLater = ["scheduled", "sent", "analyzed"].includes(status);

  const steps = ["Brief", "Copy", "Images", "Designer", "Schedule"];
  const milestones = [hasBrief, hasCopy, hasImagePrompts, hasAllImages, isScheduledOrLater];
  const activeIndex = milestones.findIndex((m) => !m); // -1 = all done

  const NEXT: Record<number, string> = {
    0: "write the brief angle below, then Generate copy",
    1: "click Generate copy to draft subject + sections",
    2: "click Generate image prompts to brief the designer",
    3: "the designer renders & uploads images — track it in the Designer queue",
    4: "set the send date and switch status to Scheduled",
  };
  const nextHint =
    activeIndex === -1
      ? status === "sent" || status === "analyzed"
        ? "this campaign has sent — nothing left to do here"
        : "everything's ready — it's scheduled to send"
      : NEXT[activeIndex];

  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3">
      <div className="flex items-center">
        {steps.map((label, i) => {
          const done = milestones[i];
          const active = i === activeIndex;
          const circle = done
            ? "bg-foreground text-background border-transparent"
            : active
            ? "border-2 border-foreground text-foreground"
            : "border border-muted-foreground/30 text-muted-foreground";
          const text = active
            ? "font-medium text-foreground"
            : done
            ? "text-foreground"
            : "text-muted-foreground";
          return (
            <Fragment key={label}>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${circle}`}>
                  {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className={`text-sm ${text}`}>{label}</span>
              </div>
              {i < steps.length - 1 && (
                <div className={`mx-2 h-px flex-1 ${done ? "bg-foreground/30" : "bg-muted-foreground/20"}`} />
              )}
            </Fragment>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Next:</span> {nextHint}
      </p>
    </div>
  );
}

function ImagePromptResults({
  campaign, busy, regenSlot, onRegenerate,
}: {
  campaign: Campaign;
  busy: boolean;
  regenSlot: "hero" | "secondary" | null;
  onRegenerate: (slot: "hero" | "secondary") => void;
}) {
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

  // A per-slot "Regenerate" — refreshes just this slot, leaving the
  // other one untouched (so a good hero brief survives a secondary
  // redo, and vice versa). Disabled while any generation runs.
  const slotButton = (slot: "hero" | "secondary") => (
    <button
      type="button"
      onClick={() => onRegenerate(slot)}
      disabled={busy}
      className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
      title={`Regenerate only the ${slot} brief`}
    >
      <RefreshCw className={`h-3 w-3 ${busy && regenSlot === slot ? "animate-spin" : ""}`} />
      {busy && regenSlot === slot ? "Regenerating…" : "Regenerate"}
    </button>
  );

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
            action={slotButton("hero")}
          />
        )}
        {secondaryPrompt && (
          <CopyablePrompt
            label="Secondary"
            prompt={secondaryPrompt}
            alt={secondaryAlt}
            extra={null}
            action={slotButton("secondary")}
          />
        )}
        {secondaryPrompt2 && (
          <CopyablePrompt label="Secondary 2" prompt={secondaryPrompt2} alt={secondaryAlt2} extra={null} />
        )}
      </CardContent>
    </Card>
  );
}

function CopyablePrompt({
  label, prompt, alt, extra, action,
}: {
  label: string;
  prompt: string;
  alt: string;
  extra: string | null;
  action?: ReactNode;
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
        <div className="flex items-center gap-3">
          {action}
          <button
            type="button"
            onClick={copy}
            className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <Copy className="h-3 w-3" /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <p className="text-xs font-mono whitespace-pre-wrap leading-relaxed">{prompt}</p>
      {alt && <p className="text-xs text-muted-foreground"><strong>Alt:</strong> {alt}</p>}
      {extra && <p className="text-xs text-muted-foreground">{extra}</p>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Copy history — the "undo" for AI regeneration. A snapshot is taken
// before each generate-copy; this lists them with a one-click restore.
// ────────────────────────────────────────────────────────────
interface CopyVersion {
  id: string;
  source: string | null;
  label: string | null;
  createdAt: string | null;
  fields: Record<string, string>;
}

function CopyHistory({
  campaignId, reloadSignal, onRestored,
}: {
  campaignId: string;
  reloadSignal: number;
  onRestored: (campaign: Campaign) => void;
}) {
  const [versions, setVersions] = useState<CopyVersion[]>([]);
  const [open, setOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/v1/marketing/email/campaigns/${campaignId}/versions`)
      .then(r => r.json())
      .then(d => setVersions(d.versions ?? []))
      .catch(() => {});
  }, [campaignId]);

  useEffect(() => { load(); }, [load, reloadSignal]);

  async function restore(versionId: string) {
    if (!confirm("Restore this version? Your current copy is snapshotted first, so this is also undoable.")) return;
    setRestoringId(versionId);
    try {
      const res = await fetch(`/api/v1/marketing/email/campaigns/${campaignId}/versions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versionId }),
      });
      const data = await res.json();
      if (data.campaign) onRestored(data.campaign as Campaign);
      load();
    } finally {
      setRestoringId(null);
    }
  }

  if (versions.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex items-center justify-between w-full text-left"
        >
          <CardTitle className="text-sm">
            Copy history
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {versions.length} saved version{versions.length === 1 ? "" : "s"} — restore a prior draft
            </span>
          </CardTitle>
          <span className="text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-1">
          {versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-3 text-sm py-1 border-b last:border-0">
              <div className="min-w-0">
                <div className="truncate">{v.label || "(untitled)"}</div>
                <div className="text-xs text-muted-foreground">
                  {v.source === "pre_restore" ? "before a restore" : "before a regenerate"}
                  {v.createdAt ? ` · ${new Date(v.createdAt + "Z").toLocaleString()}` : ""}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={restoringId !== null}
                onClick={() => restore(v.id)}
              >
                {restoringId === v.id ? "Restoring…" : "Restore"}
              </Button>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
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
