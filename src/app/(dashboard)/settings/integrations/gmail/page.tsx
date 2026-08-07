"use client";

/**
 * Gmail integration settings: the OAuth app credentials (one-time, admin)
 * and each user's own Connect button.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, ExternalLink, Loader2, Mail, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

interface Connection {
  id: string; email: string; status: string; status_reason: string | null; last_synced_at: string | null;
}

export default function GmailSettingsPage() {
  const params = useSearchParams();
  const [configured, setConfigured] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const j = await fetch("/api/v1/email/connections").then((r) => r.json());
      setConfigured(j.configured === true);
      setConnection(j.connection ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) toast.success(`Gmail connected: ${connected}`);
    if (error) toast.error("Gmail connection failed", { description: error });
  }, [load, params]);

  const saveCreds = async () => {
    setSaving(true);
    try {
      for (const [key, value] of [
        ["gmail_oauth_client_id", clientId.trim()],
        ["gmail_oauth_client_secret", clientSecret.trim()],
      ] as const) {
        if (!value) continue;
        const res = await fetch("/api/v1/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
        });
        if (!res.ok) throw new Error(`failed saving ${key}`);
      }
      toast.success("OAuth credentials saved");
      setClientId(""); setClientSecret("");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!connection) return;
    await fetch(`/api/v1/email/connections?id=${connection.id}`, { method: "DELETE" });
    toast.success("Disconnected");
    void load();
  };

  return (
    <div className="space-y-6 p-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Mail className="h-6 w-6" /> Gmail
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Send and read email from the frame — composer, attachments, scheduling, and threads on
          customer and prospect pages.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your connection</CardTitle>
          <CardDescription>Each person connects their own Google account; email sends as you, from your address.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : connection ? (
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <div className="flex-1">
                <p className="text-sm font-medium">{connection.email}</p>
                <p className="text-xs text-muted-foreground">
                  {connection.status === "connected"
                    ? `Syncing — last ${connection.last_synced_at ? new Date(connection.last_synced_at + "Z").toLocaleString() : "pending first sync"}`
                    : `Needs attention: ${connection.status_reason ?? connection.status}`}
                </p>
              </div>
              {connection.status !== "connected" && (
                <Button size="sm" onClick={() => (window.location.href = "/api/v1/email/oauth")}>Reconnect</Button>
              )}
              <Button size="sm" variant="outline" onClick={disconnect}>
                <Unplug className="h-3.5 w-3.5 mr-1.5" /> Disconnect
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <p className="text-sm text-muted-foreground flex-1">
                {configured
                  ? "Not connected yet. You'll see Google's consent screen — including an “unverified app” notice, expected for an internal tool."
                  : "The OAuth app below must be configured first."}
              </p>
              <Button onClick={() => (window.location.href = "/api/v1/email/oauth")} disabled={!configured}>
                Connect Gmail
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">OAuth app {configured && <Badge variant="secondary" className="ml-2">configured</Badge>}</CardTitle>
          <CardDescription>One-time setup, shared by everyone. Values are stored in settings, never in code.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="text-sm text-muted-foreground list-decimal ml-4 space-y-1">
            <li>
              In <a className="text-blue-600 underline inline-flex items-center gap-0.5" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud Console <ExternalLink className="h-3 w-3" /></a>, create a project → enable the <strong>Gmail API</strong>.
            </li>
            <li>OAuth consent screen: External, publishing status <strong>Testing</strong>, and add each person&apos;s Google address as a test user (up to 100 — no Google verification needed).</li>
            <li>Create an OAuth client (Web application) with redirect URI <code className="bg-muted px-1 rounded">https://theframe.getjaxy.com/api/v1/email/oauth/callback</code>.</li>
            <li>Paste the client ID and secret here.</li>
          </ol>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Client ID</Label>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={configured ? "•••••• (set)" : "xxxx.apps.googleusercontent.com"} />
            </div>
            <div>
              <Label className="text-xs">Client secret</Label>
              <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={configured ? "•••••• (set)" : "GOCSPX-…"} />
            </div>
          </div>
          <Button size="sm" onClick={saveCreds} disabled={saving || (!clientId.trim() && !clientSecret.trim())}>
            {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null} Save credentials
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
