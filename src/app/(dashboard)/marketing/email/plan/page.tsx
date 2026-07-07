"use client";

/**
 * Monthly email planner.
 *
 * Daniel: "let's work on the marketing calendar for the next month/
 * 2 months. it gives suggestions for themes for each email (different
 * concepts) based on the calendar (if anything). it creates the
 * title and short brief per email. that is what each email campaign
 * would use as the input to generate the emails."
 *
 * Flow:
 *  1. Pick audience + start date + # weeks
 *  2. Click Plan → AI proposes a brief per slot (calendar-aware)
 *  3. Review the table — edit any field inline
 *  4. Click Create campaigns → bulk-creates with status=draft
 *  5. Navigate to each campaign and Generate copy/images from there
 */

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles, ArrowRight, RefreshCw, Loader2, CheckCircle2, AlertTriangle, Wand2 } from "lucide-react";

interface ProposalBrief {
  name: string;
  angle: string;
  productHook: string;
  seasonalContext: string;
  rationale: string;
}

interface Proposal {
  slotIndex: number;
  scheduledDate: string;
  slotInWeek: 1 | 2;
  weekOf: string;
  layoutProfile: string;
  imageStyle: string;
  subjectAngle: string;
  layoutVariants: {
    heroVariant: string;
    sectionAVariant: string;
    secondaryImageVariant: string;
    sectionBVariant: string;
  };
  rationale: string;
  brief: ProposalBrief;
}

function nextMonday(): string {
  const d = new Date();
  const day = d.getDay() || 7;
  const daysUntilMon = day === 1 ? 7 : 8 - day;
  d.setDate(d.getDate() + daysUntilMon);
  return d.toISOString().slice(0, 10);
}

export default function PlanMonthPage() {
  const [audience, setAudience] = useState<"retail" | "wholesale">("retail");
  const [startDate, setStartDate] = useState(nextMonday());
  const [weeks, setWeeks] = useState(4);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [eventsConsidered, setEventsConsidered] = useState<number>(0);
  const [proposing, setProposing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string[] | null>(null);
  const [autoFeatureProducts, setAutoFeatureProducts] = useState(true);

  async function propose() {
    setProposing(true);
    setError(null);
    setProposals(null);
    setCreated(null);
    try {
      const res = await fetch("/api/v1/marketing/email/plan-month/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience, startDate, weeks }),
      });
      const text = await res.text();
      let data: { error?: string; warning?: string; proposals?: Proposal[]; eventsConsidered?: number };
      try { data = JSON.parse(text); } catch {
        setError(`HTTP ${res.status}: ${text.slice(0, 300) || "(empty response — upstream timeout, try again)"}`);
        return;
      }
      if (data.error) { setError(data.error); return; }
      setProposals(data.proposals ?? []);
      setEventsConsidered(data.eventsConsidered ?? 0);
      // Partial-accept path: the AI returned fewer briefs than slots —
      // proposals still render (trailing ones blank), surfaced as a
      // non-fatal notice in the same banner slot.
      if (data.warning) setError(data.warning);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProposing(false);
    }
  }

  function updateBrief(slotIndex: number, key: keyof ProposalBrief, value: string) {
    setProposals(ps => ps?.map(p =>
      p.slotIndex === slotIndex ? { ...p, brief: { ...p.brief, [key]: value } } : p,
    ) ?? null);
  }

  // Per-card natural-language feedback → AI revises that one brief.
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const [revising, setRevising] = useState<number | null>(null);

  async function reviseOne(p: Proposal) {
    const fb = (feedback[p.slotIndex] ?? "").trim();
    if (!fb) return;
    setRevising(p.slotIndex);
    setError(null);
    try {
      const res = await fetch("/api/v1/marketing/email/plan-month/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audience,
          scheduledDate: p.scheduledDate,
          slotContext: `slot ${p.slotInWeek} · layout=${p.layoutProfile} · image=${p.imageStyle} · subject-angle=${p.subjectAngle}`,
          current: {
            name: p.brief.name,
            angle: p.brief.angle,
            productHook: p.brief.productHook,
            seasonalContext: p.brief.seasonalContext,
          },
          feedback: fb,
        }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      const b = data.brief as Partial<ProposalBrief>;
      setProposals(ps => ps?.map(x => x.slotIndex === p.slotIndex ? {
        ...x,
        brief: {
          name: b.name ?? x.brief.name,
          angle: b.angle ?? x.brief.angle,
          productHook: b.productHook ?? "",
          seasonalContext: b.seasonalContext ?? "",
          rationale: b.rationale ?? x.brief.rationale,
        },
      } : x) ?? null);
      setFeedback(f => ({ ...f, [p.slotIndex]: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevising(null);
    }
  }

  async function createAll() {
    if (!proposals) return;
    // Guardrails before a 16-campaign bulk create: warn on blank briefs
    // (partial-accept planning can leave trailing slots empty) and always
    // confirm the count — one click creating a month of drafts deserves
    // an "are you sure".
    const blank = proposals.filter((p) => !p.brief.name.trim() && !p.brief.angle.trim()).length;
    const msg =
      `Create ${proposals.length} ${audience} campaign${proposals.length === 1 ? "" : "s"} as drafts?` +
      (blank > 0 ? `\n\n⚠ ${blank} slot${blank === 1 ? " has" : "s have"} a blank brief — they'll be created empty.` : "");
    if (!confirm(msg)) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/marketing/email/plan-month/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience, proposals, autoFeatureProducts }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setCreated(data.campaignIds ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <Link href="/marketing/email" className="text-sm text-muted-foreground hover:text-foreground">
            ← Email assistant
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Plan the month</h1>
          <p className="text-muted-foreground">
            AI reads the marketing calendar + strategy rotation, proposes a unique
            brief per email slot. Review, edit, then bulk-create campaigns.
          </p>
        </div>
      </div>

      {/* Inputs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Planning window</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Audience</label>
            <select
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={audience}
              onChange={e => setAudience(e.target.value as "retail" | "wholesale")}
              disabled={proposing}
            >
              <option value="retail">Retail (DTC — Mon + Thu)</option>
              <option value="wholesale">Wholesale (Christina — Tue + Fri)</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Start date</label>
            <input
              type="date"
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              disabled={proposing}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Weeks</label>
            <select
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={weeks}
              onChange={e => setWeeks(parseInt(e.target.value))}
              disabled={proposing}
            >
              <option value={1}>1 week (2 emails)</option>
              <option value={2}>2 weeks (4 emails)</option>
              <option value={3}>3 weeks (6 emails)</option>
              <option value={4}>4 weeks (8 emails)</option>
              <option value={6}>6 weeks (12 emails)</option>
              <option value={8}>8 weeks (16 emails)</option>
            </select>
          </div>
          <div className="flex items-end">
            <Button onClick={propose} disabled={proposing} className="w-full">
              {proposing ? (
                <><RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Planning…</>
              ) : (
                <><Sparkles className="h-4 w-4 mr-2" /> Plan with AI</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {proposing && (
        <Card className="border-foreground/40 bg-accent/30">
          <CardContent className="p-4 text-sm">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-4 w-4 animate-pulse" />
              <strong>AI is reading the calendar + strategy engine + brand voice</strong>
            </div>
            <div className="text-muted-foreground text-xs">
              Loading calendar events in window → walking strategy engine for slot
              dimensions → composing {weeks * 2} unique briefs → typically 20-60s
              for a 4-week window.
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {created && (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div>
              <div className="text-sm flex items-center gap-2 mb-2">
                <strong>Created {created.length} campaign{created.length === 1 ? "" : "s"}.</strong>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href="/marketing/email">
                  <Button size="sm" variant="outline">Open dashboard</Button>
                </Link>
                {created.slice(0, 4).map(id => (
                  <Link key={id} href={`/marketing/email/campaigns/${id}`}>
                    <Button size="sm" variant="outline">Open campaign <ArrowRight className="h-3 w-3 ml-1" /></Button>
                  </Link>
                ))}
                {created.length > 4 && (
                  <span className="text-xs text-muted-foreground self-center">
                    + {created.length - 4} more — open from the dashboard
                  </span>
                )}
              </div>
            </div>
            <BatchGenerate campaignIds={created} />
          </CardContent>
        </Card>
      )}

      {proposals && proposals.length > 0 && !created && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Proposed briefs</h2>
              <p className="text-xs text-muted-foreground">
                {proposals.length} slot{proposals.length === 1 ? "" : "s"} ·
                {" "}{eventsConsidered} calendar event{eventsConsidered === 1 ? "" : "s"} considered ·
                {" "}Edit any field below — changes are saved on Create.
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Button onClick={createAll} disabled={creating}>
                {creating
                  ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Creating…</>
                  : `Create ${proposals.length} campaign${proposals.length === 1 ? "" : "s"}`}
              </Button>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoFeatureProducts}
                  onChange={(e) => setAutoFeatureProducts(e.target.checked)}
                />
                Auto-feature a product on product-anchored emails
              </label>
            </div>
          </div>

          <div className="space-y-3">
            {proposals.map(p => (
              <Card key={p.slotIndex}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <Badge>{audience}</Badge>
                    <Badge variant="outline" className="tabular-nums">{p.scheduledDate}</Badge>
                    <Badge variant="outline">slot {p.slotInWeek}</Badge>
                    <Badge variant="outline">{p.layoutProfile}</Badge>
                    <Badge variant="outline">{p.imageStyle}</Badge>
                    <Badge variant="outline">angle: {p.subjectAngle}</Badge>
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Name / title</label>
                    <input
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm font-medium"
                      value={p.brief.name}
                      onChange={e => updateBrief(p.slotIndex, "name", e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Angle (the idea)</label>
                    <textarea
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      rows={3}
                      value={p.brief.angle}
                      onChange={e => updateBrief(p.slotIndex, "angle", e.target.value)}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Product hook</label>
                      <input
                        className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                        value={p.brief.productHook}
                        onChange={e => updateBrief(p.slotIndex, "productHook", e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Seasonal context</label>
                      <input
                        className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                        value={p.brief.seasonalContext}
                        onChange={e => updateBrief(p.slotIndex, "seasonalContext", e.target.value)}
                      />
                    </div>
                  </div>

                  {p.brief.rationale && (
                    <div className="text-xs text-muted-foreground italic border-l-2 border-input pl-3">
                      <strong>AI rationale:</strong> {p.brief.rationale}
                    </div>
                  )}

                  {/* Natural-language feedback → AI revises this brief */}
                  <div className="border-t pt-3 space-y-2">
                    <label className="text-xs text-muted-foreground block">
                      Suggest changes (natural language)
                    </label>
                    <textarea
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      rows={2}
                      placeholder="e.g. Lean into the honey drop and tie it to Labor Day — less urgency, more warmth."
                      value={feedback[p.slotIndex] ?? ""}
                      onChange={e => setFeedback(f => ({ ...f, [p.slotIndex]: e.target.value }))}
                      disabled={revising !== null}
                      onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") reviseOne(p); }}
                    />
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => reviseOne(p)}
                        disabled={revising !== null || !(feedback[p.slotIndex] ?? "").trim()}
                      >
                        {revising === p.slotIndex
                          ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Revising…</>
                          : <><Wand2 className="h-3 w-3 mr-1" /> Suggest changes</>}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="flex justify-end pt-2 sticky bottom-2">
            <Button onClick={createAll} disabled={creating} size="lg">
              {creating
                ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" /> Creating…</>
                : `Create ${proposals.length} campaign${proposals.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      )}

      {proposals && proposals.length === 0 && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            AI returned 0 briefs. Try a smaller window or check the strategy engine.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// Batch generate — turns the planner's N freshly-created drafts into
// drafted emails in one action instead of opening each campaign and
// clicking Generate individually. Client-driven serial loop (each
// per-campaign call is a normal request within maxDuration; serial =
// naturally rate-limited; a failure on one doesn't block the rest).
// ────────────────────────────────────────────────────────────

type BatchItem = {
  id: string;
  label: string;
  state: "pending" | "running" | "done" | "error";
  detail?: string;
};

function BatchGenerate({ campaignIds }: { campaignIds: string[] }) {
  const [doCopy, setDoCopy] = useState(true);
  const [doImages, setDoImages] = useState(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [items, setItems] = useState<BatchItem[]>(
    campaignIds.map((id, i) => ({ id, label: `Campaign ${i + 1}`, state: "pending" })),
  );

  function patch(id: string, p: Partial<BatchItem>) {
    setItems(its => its.map(it => (it.id === id ? { ...it, ...p } : it)));
  }

  async function run() {
    if (!doCopy && !doImages) return;
    setRunning(true);
    setFinished(false);
    for (const id of campaignIds) {
      patch(id, { state: "running", detail: doCopy ? "writing copy…" : "briefing images…" });
      try {
        if (doCopy) {
          const res = await fetch(`/api/v1/marketing/email/campaigns/${id}/generate-copy`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
          });
          const data = await res.json().catch(() => ({}));
          if (data?.error) throw new Error(String(data.error));
          if (data?.campaign?.name) patch(id, { label: data.campaign.name });
        }
        if (doImages) {
          patch(id, { detail: "briefing images…" });
          const res2 = await fetch(`/api/v1/marketing/email/campaigns/${id}/generate-image-prompts`, { method: "POST" });
          const data2 = await res2.json().catch(() => ({}));
          if (data2?.error) throw new Error(String(data2.error));
        }
        patch(id, { state: "done", detail: undefined });
      } catch (e) {
        patch(id, { state: "error", detail: e instanceof Error ? e.message : String(e) });
      }
      // Gentle spacing between campaigns.
      await new Promise(r => setTimeout(r, 400));
    }
    setRunning(false);
    setFinished(true);
  }

  const doneCount = items.filter(i => i.state === "done").length;
  const errCount = items.filter(i => i.state === "error").length;

  return (
    <div className="rounded-lg border border-foreground/20 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Wand2 className="h-4 w-4" />
        <span className="text-sm font-medium">Draft all {campaignIds.length} with AI</span>
        <span className="text-xs text-muted-foreground">— skip opening each one by hand</span>
      </div>

      {!running && !finished && (
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={doCopy} onChange={e => setDoCopy(e.target.checked)} />
            Generate copy
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={doImages} onChange={e => setDoImages(e.target.checked)} />
            Generate image prompts
          </label>
          <Button size="sm" onClick={run} disabled={!doCopy && !doImages}>
            Run on {campaignIds.length}
          </Button>
          <span className="text-xs text-muted-foreground">
            Serial — keep this tab open. ~30–60s per email.
          </span>
        </div>
      )}

      {(running || finished) && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 text-green-600" />}
            <span>{doneCount}/{items.length} done{errCount > 0 ? ` · ${errCount} failed` : ""}</span>
          </div>
          <div className="space-y-1 max-h-56 overflow-auto">
            {items.map(it => (
              <div key={it.id} className="flex items-center gap-2 text-xs">
                {it.state === "running" && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
                {it.state === "done" && <CheckCircle2 className="h-3 w-3 text-green-600 shrink-0" />}
                {it.state === "error" && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
                {it.state === "pending" && <span className="h-3 w-3 inline-block rounded-full border border-muted-foreground/40 shrink-0" />}
                <Link href={`/marketing/email/campaigns/${it.id}`} className="truncate hover:underline">
                  {it.label}
                </Link>
                {it.detail && <span className="text-muted-foreground truncate">— {it.detail}</span>}
              </div>
            ))}
          </div>
          {finished && (
            <p className="text-xs text-muted-foreground">
              Done. Review each in the editor{doImages ? "" : ", then generate image prompts when the copy looks right"}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
