"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Plug, AlertCircle, CheckCircle, Loader2, Trash2, ExternalLink, GitBranch, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type PdPipeline = { id: number; name: string };
type PdStage = { id: number; name: string; pipeline_id: number };
type PdUser = { id: number; name: string; email: string };
type PipelineConfig = {
  ajm: { pipelineId: number; stages: Record<string, number> };
  catalog: { pipelineId: number; stages: Record<string, number> };
  customers: { pipelineId: number; stages: Record<string, number> };
};

type PipedriveStatus = {
  configured: boolean;
  connected: boolean;
  companyName?: string;
  apiDomain?: string;
  connectedAt?: string;
  redirectUri?: string | null;
  ping?: { ok: boolean; error?: string };
  pipelines?: PdPipeline[];
  stages?: PdStage[];
  users?: PdUser[];
  pipelineConfig?: PipelineConfig | null;
  owner?: { id: number; name?: string } | null;
  stagesError?: string;
};

function PipedriveIntegrationsPageInner() {
  const search = useSearchParams();
  const [status, setStatus] = useState<PipedriveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; title: string; message: string } | null>(null);
  const [ownerSel, setOwnerSel] = useState<string>("");

  useEffect(() => {
    const connected = search?.get("connected");
    const errorCode = search?.get("error");
    const errorMessage = search?.get("error_message");
    if (connected) {
      setBanner({ kind: "success", title: "Connected", message: `${connected} is now connected to the-frame.` });
    } else if (errorCode) {
      setBanner({ kind: "error", title: `Connection failed (${errorCode})`, message: errorMessage || "Try again." });
    }
  }, [search]);

  async function reload() {
    const res = await fetch("/api/v1/integrations/pipedrive/status");
    const data = (await res.json()) as PipedriveStatus;
    setStatus(data);
    if (data.owner?.id) setOwnerSel(String(data.owner.id));
  }

  useEffect(() => {
    reload();
  }, []);

  async function post(body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string }> {
    const res = await fetch("/api/v1/integrations/pipedrive/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function disconnect() {
    if (!confirm("Disconnect Pipedrive? You can reconnect any time.")) return;
    setBusy(true);
    try {
      await post({ action: "disconnect" });
      await reload();
      setBanner({ kind: "success", title: "Disconnected", message: "Pipedrive is no longer connected." });
    } finally {
      setBusy(false);
    }
  }

  async function setupPipelines() {
    setBusy(true);
    try {
      const r = await post({ action: "setup-pipelines" });
      if (r.ok) {
        await reload();
        setBanner({ kind: "success", title: "Pipelines ready", message: "AJM Reactivation, Catalog Interested, and Customers pipelines are provisioned." });
      } else {
        setBanner({ kind: "error", title: "Setup failed", message: r.error || "Could not create pipelines." });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveOwner() {
    if (!ownerSel) return;
    setBusy(true);
    try {
      const ownerId = parseInt(ownerSel, 10);
      const ownerName = status?.users?.find((u) => u.id === ownerId)?.name;
      const r = await post({ action: "set-owner", ownerId, ownerName });
      if (r.ok) {
        await reload();
        setBanner({ kind: "success", title: "Owner saved", message: `Deals will be assigned to ${ownerName || "the selected user"}.` });
      } else {
        setBanner({ kind: "error", title: "Save failed", message: r.error || "Could not save owner." });
      }
    } finally {
      setBusy(false);
    }
  }

  function startConnect() {
    window.location.href = "/api/auth/pipedrive";
  }

  const stagesFor = (pipelineId: number) =>
    (status?.stages || []).filter((s) => s.pipeline_id === pipelineId);

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Plug className="h-7 w-7" />
          Pipedrive
        </h1>
        <p className="text-muted-foreground mt-2">
          CRM for high-intent leads. The frame pushes AJM reactivation contacts, catalog-interested leads, and
          wholesale customers into dedicated pipelines, and syncs deal stages two-way.
        </p>
      </div>

      {banner && (
        <Alert className="mb-6" variant={banner.kind === "error" ? "destructive" : "default"}>
          {banner.kind === "error" ? <AlertCircle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {!status ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading...
          </CardContent>
        </Card>
      ) : !status.configured ? (
        <Card>
          <CardHeader>
            <CardTitle>Pipedrive is not configured</CardTitle>
            <CardDescription>
              Create a private OAuth app in the Pipedrive Developer Hub, then set <code>PIPEDRIVE_CLIENT_ID</code> and{" "}
              <code>PIPEDRIVE_CLIENT_SECRET</code> in the Railway environment and refresh this page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {status.redirectUri && (
              <div className="text-sm">
                <div className="text-muted-foreground mb-1">Set this as the app&apos;s Callback URL:</div>
                <pre className="text-xs bg-muted p-3 rounded whitespace-pre-wrap">{status.redirectUri}</pre>
              </div>
            )}
          </CardContent>
        </Card>
      ) : !status.connected ? (
        <Card>
          <CardHeader>
            <CardTitle>Connect to Pipedrive</CardTitle>
            <CardDescription>
              You&apos;ll be redirected to Pipedrive to approve access. After approval you&apos;ll be sent back here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button onClick={startConnect} size="lg">
              <Plug className="h-4 w-4 mr-2" />
              Connect to Pipedrive
            </Button>
            {status.redirectUri && (
              <p className="text-xs text-muted-foreground">
                Callback URL on the app must be <code>{status.redirectUri}</code>
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Connected</span>
              {status.ping && !status.ping.ok ? (
                <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />Auth failed</Badge>
              ) : (
                <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle className="h-3 w-3 mr-1" />Healthy</Badge>
              )}
            </CardTitle>
            <CardDescription>Active Pipedrive connection. Tokens auto-refresh before expiry.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">Company</div>
                <div className="font-medium flex items-center gap-1">
                  {status.companyName || "—"}
                  {status.apiDomain && (
                    <a href={status.apiDomain} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Connected</div>
                <div className="font-medium">{status.connectedAt ? new Date(status.connectedAt).toLocaleString() : "—"}</div>
              </div>
            </div>

            {status.ping && !status.ping.ok && status.ping.error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-xs break-all">{status.ping.error}</AlertDescription>
              </Alert>
            )}

            <div className="flex gap-2 pt-2 border-t flex-wrap">
              <Button variant="outline" onClick={startConnect} disabled={busy}>
                Reconnect
              </Button>
              <Button variant="outline" onClick={disconnect} disabled={busy}>
                <Trash2 className="h-4 w-4 mr-2" />
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {status?.connected && status.ping?.ok && (
        <div className="mt-6 space-y-6">
          {/* Pipeline provisioning */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <GitBranch className="h-5 w-5" />
                Pipelines
              </CardTitle>
              <CardDescription>
                The CRM plan needs three pipelines: <strong>AJM Reactivation</strong>, <strong>Catalog Interested</strong>,
                and <strong>Customers</strong>. Provisioning is idempotent — safe to re-run.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {status.pipelineConfig ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  {(["ajm", "catalog", "customers"] as const).map((key) => {
                    const cfg = status.pipelineConfig![key];
                    const label = key === "ajm" ? "AJM Reactivation" : key === "catalog" ? "Catalog Interested" : "Customers";
                    return (
                      <div key={key} className="rounded-md border p-3">
                        <div className="font-medium mb-1">{label}</div>
                        <div className="text-xs text-muted-foreground mb-2">Pipeline #{cfg.pipelineId}</div>
                        <div className="flex flex-wrap gap-1">
                          {Object.keys(cfg.stages).map((s) => (
                            <Badge key={s} variant="outline" className="text-xs font-normal">{s}</Badge>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No pipelines provisioned yet.</p>
              )}
              <Button onClick={setupPipelines} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <GitBranch className="h-4 w-4 mr-2" />}
                {status.pipelineConfig ? "Re-sync pipelines" : "Create pipelines"}
              </Button>
            </CardContent>
          </Card>

          {/* Default deal owner */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserCheck className="h-5 w-5" />
                Default deal owner
              </CardTitle>
              <CardDescription>
                AJM reactivation deals are owned by Christina. Pick the Pipedrive user new deals are assigned to.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm min-w-[16rem]"
                  value={ownerSel}
                  onChange={(e) => setOwnerSel(e.target.value)}
                >
                  <option value="">— Select a user —</option>
                  {(status.users || []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </select>
                <Button onClick={saveOwner} disabled={busy || !ownerSel}>
                  Save owner
                </Button>
              </div>
              {status.owner?.id && (
                <p className="text-sm text-muted-foreground">
                  Current owner: <strong>{status.owner.name || `user #${status.owner.id}`}</strong>
                </p>
              )}
            </CardContent>
          </Card>

          {/* Live pipelines in the account (reference) */}
          {(status.pipelines || []).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">All pipelines in Pipedrive</CardTitle>
                <CardDescription>Everything currently in the connected account, for reference.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3 text-sm">
                  {(status.pipelines || []).map((p) => (
                    <div key={p.id}>
                      <div className="font-medium">{p.name} <span className="text-muted-foreground font-normal">#{p.id}</span></div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {stagesFor(p.id).map((s) => (
                          <Badge key={s.id} variant="outline" className="text-xs font-normal">{s.name}</Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

export default function PipedriveIntegrationsPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading...</div>}>
      <PipedriveIntegrationsPageInner />
    </Suspense>
  );
}
