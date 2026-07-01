"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Globe, Loader2, Mail, MapPin, Phone, Plug, Plus, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type PdDeal = {
  id: number;
  title: string;
  status: string;
  value: number | null;
  currency: string;
  pipeline: string | null;
  stage: string | null;
  owner: string | null;
  url: string | null;
};
type PdActivity = { subject: string; type: string | null; done: boolean; date: string | null; note: string | null };
type Summary = {
  connected: boolean;
  apiDomain: string | null;
  syncEnabled: boolean;
  orgId: number | null;
  synced: boolean;
  org?: { name: string; address: string | null; website: string | null; owner: string | null; url: string | null } | null;
  person?: { id: number; name: string | null; email: string | null; phone: string | null; url: string | null } | null;
  deals?: PdDeal[];
  activities?: PdActivity[];
  projection?: Array<Record<string, unknown>>;
  liveError?: string;
};
type PipelineConfig = Record<"ajm" | "catalog" | "customers", { pipelineId: number; stages: Record<string, number> }>;
type Config = {
  pipelineConfig: PipelineConfig | null;
  users?: Array<{ id: number; name: string; email: string }>;
  owner?: { id: number; name?: string } | null;
};

const PIPELINE_LABELS: Record<string, string> = {
  ajm: "AJM Reactivation",
  catalog: "Catalog Interested",
  customers: "Customers",
};

function money(v: number | null, currency = "USD") {
  if (v == null) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `$${Math.round(v)}`;
  }
}

function statusColor(s: string) {
  if (s === "won") return "bg-green-600 hover:bg-green-700 text-white";
  if (s === "lost") return "bg-red-600 hover:bg-red-700 text-white";
  return "";
}

export function PipedrivePanel({ companyId }: { companyId: string; companyName?: string | null }) {
  const [data, setData] = useState<Summary | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{ pipelineKey: "ajm" | "catalog" | "customers"; stageName: string; ownerId: string; value: string }>({
    pipelineKey: "catalog",
    stageName: "",
    ownerId: "",
    value: "",
  });
  const [msg, setMsg] = useState<string>("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/v1/sales/prospects/${companyId}/pipedrive`);
    setData(await r.json());
  }, [companyId]);

  useEffect(() => {
    load();
    fetch("/api/v1/integrations/pipedrive/status")
      .then((r) => r.json())
      .then((d) => {
        setConfig({ pipelineConfig: d.pipelineConfig ?? null, users: d.users, owner: d.owner });
        if (d.owner?.id) setForm((f) => ({ ...f, ownerId: String(d.owner.id) }));
      })
      .catch(() => setConfig(null));
  }, [load]);

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/v1/sales/prospects/${companyId}/pipedrive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function pushToPipedrive() {
    setBusy(true);
    setMsg("");
    try {
      const r = await post({ action: "push" });
      if (r.ok) {
        setMsg("Pushed to Pipedrive.");
        await load();
      } else setMsg(r.error || "Push failed");
    } finally {
      setBusy(false);
    }
  }

  async function createDeal() {
    setBusy(true);
    setMsg("");
    try {
      const r = await post({
        action: "create-deal",
        pipelineKey: form.pipelineKey,
        stageName: form.stageName || undefined,
        ownerId: form.ownerId ? parseInt(form.ownerId, 10) : undefined,
        value: form.value ? parseFloat(form.value) : undefined,
      });
      if (r.ok) {
        setMsg("Deal created in Pipedrive.");
        setShowCreate(false);
        setForm((f) => ({ ...f, value: "" }));
        await load();
      } else setMsg(r.error || "Create failed");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading Pipedrive…
        </CardContent>
      </Card>
    );
  }

  if (!data.connected) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Plug className="w-4 h-4" /> Pipedrive</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Not connected. <a href="/settings/integrations/pipedrive" className="text-blue-600 hover:underline">Connect Pipedrive →</a>
        </CardContent>
      </Card>
    );
  }

  const config_ok = !!config?.pipelineConfig;
  const stagesFor = (key: "ajm" | "catalog" | "customers") =>
    config?.pipelineConfig ? Object.keys(config.pipelineConfig[key].stages) : [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2"><Plug className="w-4 h-4 text-green-600" /> Pipedrive</CardTitle>
          {data.org?.url && (
            <a href={data.org.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1">
              Open in Pipedrive <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        {!data.synced && <CardDescription>This company isn&apos;t in Pipedrive yet.</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        {msg && <div className="text-xs text-muted-foreground">{msg}</div>}

        {!data.synced ? (
          <Button size="sm" onClick={pushToPipedrive} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plug className="h-4 w-4 mr-2" />}
            Push to Pipedrive
          </Button>
        ) : (
          <>
            {/* Org + primary contact */}
            {(data.org || data.person) && (
              <div className="space-y-1 text-xs text-muted-foreground">
                {data.org?.owner && (
                  <div className="flex items-center gap-1.5">
                    <User className="w-3 h-3 shrink-0" /> <span>Owner: {data.org.owner}</span>
                  </div>
                )}
                {data.org?.website && (
                  <div className="flex items-center gap-1.5">
                    <Globe className="w-3 h-3 shrink-0" />
                    <a href={/^https?:\/\//.test(data.org.website) ? data.org.website : `https://${data.org.website}`} target="_blank" rel="noreferrer" className="truncate hover:underline text-blue-600">
                      {data.org.website.replace(/^https?:\/\//, "")}
                    </a>
                  </div>
                )}
                {data.org?.address && (
                  <div className="flex items-center gap-1.5">
                    <MapPin className="w-3 h-3 shrink-0" /> <span className="truncate">{data.org.address}</span>
                  </div>
                )}
                {data.person && (data.person.name || data.person.email || data.person.phone) && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
                    {data.person.name && (
                      <a href={data.person.url || "#"} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
                        {data.person.name} <ExternalLink className="w-3 h-3 text-muted-foreground" />
                      </a>
                    )}
                    {data.person.email && (
                      <a href={`mailto:${data.person.email}`} className="inline-flex items-center gap-1 hover:underline"><Mail className="w-3 h-3" /> {data.person.email}</a>
                    )}
                    {data.person.phone && (
                      <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" /> {data.person.phone}</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Deals */}
            {(data.deals || []).length > 0 ? (
              <div className="space-y-2">
                {(data.deals || []).map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                    <div className="min-w-0">
                      <a href={d.url || "#"} target="_blank" rel="noreferrer" className="font-medium hover:underline truncate inline-flex items-center gap-1">
                        {d.title} <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0" />
                      </a>
                      <div className="text-xs text-muted-foreground">
                        {[d.pipeline, d.stage, d.owner].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {d.value != null && <span className="text-sm font-medium">{money(d.value, d.currency)}</span>}
                      <Badge className={statusColor(d.status)} variant={d.status === "open" ? "outline" : "default"}>{d.status}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No deals yet.</div>
            )}

            {/* Recent activity */}
            {(data.activities || []).length > 0 && (
              <div className="pt-1">
                <div className="text-xs font-medium text-muted-foreground mb-1">Recent activity</div>
                <div className="space-y-1">
                  {(data.activities || []).slice(0, 6).map((a, i) => (
                    <div key={i} className="text-xs text-muted-foreground flex items-center gap-2">
                      <span>{a.done ? "✓" : "•"}</span>
                      <span className="truncate">{a.subject}</span>
                      {a.date && <span className="ml-auto shrink-0">{new Date(a.date).toLocaleDateString()}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {data.liveError && <div className="text-xs text-amber-600">Live fetch issue: {data.liveError}</div>}

        {/* Create deal */}
        {config_ok && (
          <div className="pt-2 border-t">
            {!showCreate ? (
              <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4 mr-1" /> Create deal
              </Button>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Pipeline</label>
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={form.pipelineKey}
                      onChange={(e) => setForm((f) => ({ ...f, pipelineKey: e.target.value as "ajm" | "catalog" | "customers", stageName: "" }))}
                    >
                      {(["ajm", "catalog", "customers"] as const).map((k) => (
                        <option key={k} value={k}>{PIPELINE_LABELS[k]}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Stage</label>
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={form.stageName}
                      onChange={(e) => setForm((f) => ({ ...f, stageName: e.target.value }))}
                    >
                      <option value="">(first stage)</option>
                      {stagesFor(form.pipelineKey).map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Owner</label>
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={form.ownerId}
                      onChange={(e) => setForm((f) => ({ ...f, ownerId: e.target.value }))}
                    >
                      <option value="">Default</option>
                      {(config?.users || []).map((u) => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Value ($)</label>
                    <Input type="number" className="h-9" placeholder="0" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={createDeal} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Create
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)} disabled={busy}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
