"use client";

/**
 * Meta (Facebook / Instagram) integration settings.
 *
 * The integration has two independent halves configured from different places
 * in Meta, and the usual confusion is thinking the Events Manager screen sets
 * up both. This page separates them, shows exactly which environment variables
 * are still missing and where each comes from, and provides the actions to
 * verify the connection once they're in.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { num } from "@/components/dashboard/format";
import { STATUS } from "@/components/dashboard/palette";
import {
  ArrowLeft, CheckCircle2, Circle, Copy, ExternalLink, Megaphone, RefreshCw, Send, AlertTriangle,
} from "lucide-react";

type Status = {
  configured: boolean;
  inbound: {
    ready: boolean; appSecret: boolean; verifyToken: boolean; pageToken: boolean;
    webhookUrl: string | null; knownForms: string[];
    leadsTotal: number; leads7d: number; lastLeadAt: string | null;
    byStatus: Array<{ status: string; n: number }>;
    pipeline: { pipelineId: number } | null;
    deliveries?: { total: number; last24h: number; rejected: number; lastAt: string | null };
  };
  outbound: {
    ready: boolean; capiToken: boolean; datasetId: string; graphVersion: string;
    testEventCode: boolean; sent: number; pending: number; errored: number;
    lastError: string | null;
  };
  missing: Array<{ key: string; label: string; where: string }>;
  canEdit: boolean;
};

type Diagnosis = {
  token: { valid: boolean; type?: string; error?: string };
  pages: Array<{
    id: string; name?: string; leadgenSubscribed?: boolean; error?: string;
    forms?: Array<{ id: string; name?: string; leads_count?: number }>;
  }>;
  error?: string;
};

export default function MetaIntegrationPage() {
  const [data, setData] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [testCode, setTestCode] = useState("");
  const [diag, setDiag] = useState<Diagnosis | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/v1/integrations/meta/status");
        const d = await res.json();
        if (!cancelled) setData(d.error ? null : d);
      } catch { /* keep prior */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      const res = await fetch("/api/v1/integrations/meta/status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const d = await res.json();
      if (res.ok && d.ok) {
        if (action === "diagnose") {
          setDiag({ token: d.token, pages: d.pages ?? [], error: d.error });
          const subscribed = (d.pages ?? []).filter((p: { leadgenSubscribed?: boolean }) => p.leadgenSubscribed).length;
          toast[subscribed > 0 ? "success" : "message"](
            subscribed > 0
              ? `Connection looks good — ${subscribed} page${subscribed === 1 ? "" : "s"} subscribed to leadgen`
              : "No page is subscribed to leadgen yet — see the details below",
          );
        } else if (action === "import-existing") {
          const r = d.result;
          toast[r.processed > 0 ? "success" : "message"](
            r.processed > 0
              ? `Imported ${r.processed} lead${r.processed === 1 ? "" : "s"} from ${r.forms} form${r.forms === 1 ? "" : "s"}`
              : r.forms > 0
                ? `Found ${r.forms} form${r.forms === 1 ? "" : "s"} but no leads to import`
                : "No lead forms found on the connected pages",
          );
          if (r.errors?.length) toast.error(r.errors[0]);
        } else {
          toast.success(
            action === "test-event" ? "Test event accepted — check Events Manager → Test Events"
            : action === "ensure-pipeline" ? "Facebook Leads pipeline ready in Pipedrive"
            : action === "subscribe-page" ? "Page subscribed to leadgen"
            : "Done",
          );
        }
        reload();
      } else {
        toast.error(d.result?.error ?? d.error ?? "Failed");
      }
    } catch {
      toast.error("Request failed");
    }
    setBusy(null);
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied"),
      () => toast.error("Couldn't copy"),
    );
  };

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex flex-1 items-center gap-2 text-2xl font-semibold tracking-tight">
          <Megaphone className="h-6 w-6" /> Meta — Facebook &amp; Instagram
        </h1>
        <Button variant="ghost" size="sm" onClick={reload}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></Button>
        <Button variant="outline" render={<Link href="/settings/integrations" />}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Integrations
        </Button>
      </div>

      {!data ? (
        <div className="h-40 animate-pulse rounded-xl border bg-muted/40" />
      ) : (
        <>
          {/* What's still needed */}
          {data.missing.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4" style={{ color: STATUS.warn }} />
                  {data.missing.length} setting{data.missing.length === 1 ? "" : "s"} still needed
                </CardTitle>
                <CardDescription>
                  Add these as environment variables in Railway. The integration switches on by itself once they&apos;re present — no code change needed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {data.missing.map((m) => (
                    <li key={m.key} className="py-2">
                      <div className="flex items-center gap-2">
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{m.key}</code>
                        <span className="text-sm">{m.label}</span>
                      </div>
                      <p className="ml-6 text-xs text-muted-foreground">{m.where}</p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Inbound */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between text-base">
                  Inbound — Lead Ads
                  <Pill ok={data.inbound.ready} okLabel="Connected" offLabel="Not connected" />
                </CardTitle>
                <CardDescription>
                  Lead-form submissions flow into the frame, get matched to a company, and open a Pipedrive deal. This is the half that replaces Zapier.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Checklist items={[
                  { label: "App secret", ok: data.inbound.appSecret },
                  { label: "Verify token", ok: data.inbound.verifyToken },
                  { label: "Page access token", ok: data.inbound.pageToken },
                  { label: "Pipedrive pipeline provisioned", ok: !!data.inbound.pipeline },
                ]} />

                {data.inbound.webhookUrl && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Webhook callback URL — paste into Meta</p>
                    <div className="flex items-center gap-1">
                      <code className="flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">{data.inbound.webhookUrl}</code>
                      <Button size="sm" variant="ghost" onClick={() => copy(data.inbound.webhookUrl!)}><Copy className="h-3.5 w-3.5" /></Button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      App Dashboard → Webhooks → Page → subscribe to the <code>leadgen</code> field.
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-4 gap-2 text-center">
                  <Mini label="Webhooks in" value={num(data.inbound.deliveries?.total ?? 0)}
                    tone={(data.inbound.deliveries?.total ?? 0) > 0 ? STATUS.good : STATUS.neutral} />
                  <Mini label="Leads total" value={num(data.inbound.leadsTotal)} />
                  <Mini label="Last 7 days" value={num(data.inbound.leads7d)} />
                  <Mini label="Forms seen" value={num(data.inbound.knownForms.length)} />
                </div>
                {/* Is Meta actually calling us? Answered plainly. */}
                <p className="text-xs text-muted-foreground">
                  {(data.inbound.deliveries?.total ?? 0) === 0
                    ? "Meta has never called this webhook. Until the Page is subscribed to leadgen, nothing will arrive."
                    : `Last delivery ${data.inbound.deliveries!.lastAt?.slice(0, 16).replace("T", " ")}` +
                      ((data.inbound.deliveries!.rejected ?? 0) > 0
                        ? ` · ${data.inbound.deliveries!.rejected} rejected on signature — check META_APP_SECRET`
                        : "")}
                </p>
                {data.inbound.lastLeadAt && (
                  <p className="text-xs text-muted-foreground">Most recent lead: {data.inbound.lastLeadAt.slice(0, 16).replace("T", " ")}</p>
                )}

                {data.canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy !== null || !data.inbound.ready} onClick={() => run("diagnose")}>
                      {busy === "diagnose" ? "Checking…" : "Check connection"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== null || !data.inbound.ready} onClick={() => run("import-existing")}>
                      {busy === "import-existing" ? "Importing…" : "Import existing leads"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("ensure-pipeline")}>
                      Provision pipeline
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== null || !data.inbound.ready} onClick={() => run("drain")}>
                      Process pending
                    </Button>
                  </div>
                )}

                {/* Connection diagnosis — the "connected but nothing arrives" answer */}
                {diag && (
                  <div className="space-y-2 rounded-lg border p-3 text-sm">
                    <div className="flex items-center gap-2">
                      {diag.token.valid
                        ? <CheckCircle2 className="h-4 w-4" style={{ color: STATUS.good }} />
                        : <AlertTriangle className="h-4 w-4" style={{ color: STATUS.critical }} />}
                      <span className="font-medium">
                        {diag.token.valid ? `Token valid (${diag.token.type ?? "token"})` : `Token problem: ${diag.token.error ?? "invalid"}`}
                      </span>
                    </div>
                    {diag.error && <p className="text-xs" style={{ color: STATUS.critical }}>{diag.error}</p>}
                    {diag.pages.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        This token can&apos;t see any Pages. In Business settings → System users, assign the Jaxy Page to
                        the user with Manage Page access, then regenerate the token.
                      </p>
                    ) : (
                      diag.pages.map((p) => (
                        <div key={p.id} className="rounded-md bg-muted/40 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{p.name ?? p.id}</span>
                            {p.leadgenSubscribed
                              ? <Badge className="bg-green-600 hover:bg-green-700">leadgen subscribed</Badge>
                              : data.canEdit && (
                                  <Button size="sm" variant="outline" disabled={busy !== null}
                                    onClick={() => run("subscribe-page", { pageId: p.id })}>
                                    Subscribe to leadgen
                                  </Button>
                                )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {(p.forms?.length ?? 0)} form{(p.forms?.length ?? 0) === 1 ? "" : "s"}
                            {p.forms && p.forms.length > 0 && ` · ${p.forms.reduce((a, f) => a + (f.leads_count ?? 0), 0)} leads on Meta`}
                          </p>
                          {p.error && <p className="text-xs" style={{ color: STATUS.critical }}>{p.error}</p>}
                          {p.forms?.slice(0, 6).map((f) => (
                            <div key={f.id} className="flex justify-between text-xs text-muted-foreground">
                              <span className="truncate">{f.name ?? f.id}</span>
                              <span>{f.leads_count ?? 0}</span>
                            </div>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                )}
                <Link href="/prospects/facebook-leads" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  Open lead manager <ExternalLink className="h-3 w-3" />
                </Link>
              </CardContent>
            </Card>

            {/* Outbound */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between text-base">
                  Outbound — Conversions API
                  <Pill ok={data.outbound.ready} okLabel="Connected" offLabel="Not connected" />
                </CardTitle>
                <CardDescription>
                  Funnel stages (Lead → Contacted → Qualified → Converted) are reported back to Meta so ad delivery optimises toward leads that actually buy.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Checklist items={[{ label: "Conversions API token", ok: data.outbound.capiToken }]} />
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div>Dataset <code className="rounded bg-muted px-1 py-0.5">{data.outbound.datasetId}</code></div>
                  <div>Graph API <code className="rounded bg-muted px-1 py-0.5">{data.outbound.graphVersion}</code></div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <Mini label="Sent" value={num(data.outbound.sent)} tone={STATUS.good} />
                  <Mini label="Queued" value={num(data.outbound.pending)} />
                  <Mini label="Errored" value={num(data.outbound.errored)} tone={data.outbound.errored > 0 ? STATUS.critical : undefined} />
                </div>
                {data.outbound.lastError && (
                  <p className="rounded-md px-2 py-1.5 text-xs" style={{ backgroundColor: `${STATUS.critical}12`, color: STATUS.critical }}>
                    Last error: {data.outbound.lastError}
                  </p>
                )}

                {data.canEdit && (
                  <>
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">
                        Send a test event — get the code from Events Manager → Test Events
                      </p>
                      <div className="flex items-center gap-1">
                        <Input value={testCode} onChange={(e) => setTestCode(e.target.value)} placeholder="TEST12345" className="h-8" />
                        <Button size="sm" disabled={busy !== null || !data.outbound.ready} onClick={() => run("test-event", { testEventCode: testCode })}>
                          <Send className="mr-1 h-3.5 w-3.5" /> {busy === "test-event" ? "Sending…" : "Send"}
                        </Button>
                      </div>
                    </div>
                    <Button size="sm" variant="outline" disabled={busy !== null || !data.outbound.ready} onClick={() => run("capi-sync")}>
                      {busy === "capi-sync" ? "Syncing…" : "Sync funnel events now"}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {data.inbound.ready && data.outbound.ready && data.inbound.leadsTotal === 0 && (
            <p className="rounded-lg border p-3 text-sm text-muted-foreground">
              Both halves are connected but no leads have arrived yet. Submit a test lead using Meta&apos;s
              Lead Ads Testing Tool, or wait for the next real submission — it should appear within seconds.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Pill({ ok, okLabel, offLabel }: { ok: boolean; okLabel: string; offLabel: string }) {
  return ok
    ? <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle2 className="mr-1 h-3 w-3" />{okLabel}</Badge>
    : <Badge variant="outline"><Circle className="mr-1 h-3 w-3" />{offLabel}</Badge>;
}

function Checklist({ items }: { items: Array<{ label: string; ok: boolean }> }) {
  return (
    <ul className="space-y-1">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2 text-sm">
          {i.ok
            ? <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: STATUS.good }} />
            : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className={i.ok ? "" : "text-muted-foreground"}>{i.label}</span>
        </li>
      ))}
    </ul>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2 py-1.5">
      <div className="text-base font-semibold tabular-nums" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
