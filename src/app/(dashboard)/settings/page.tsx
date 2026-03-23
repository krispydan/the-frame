"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { User, Plug, Bell, Database, Info, Save, Trash2, Upload, Download, ExternalLink, Wifi, WifiOff, Loader2, CheckCircle2, XCircle, Link2 } from "lucide-react";

// ── Helpers ──

function useSetting(settings: Record<string, string>, key: string, fallback = "") {
  return settings[key] ?? fallback;
}

async function fetchSettings(): Promise<Record<string, string>> {
  const res = await fetch("/api/v1/settings");
  if (!res.ok) throw new Error("Failed to fetch settings");
  return res.json();
}

async function saveSetting(key: string, value: string) {
  const res = await fetch("/api/v1/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Failed to save setting");
  return res.json();
}

async function testConnection(integration: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/v1/settings/test-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ integration }),
  });
  return res.json();
}

function validateApiKeyFormat(integration: string, value: string): string | null {
  if (!value) return null;
  const rules: Record<string, { pattern: RegExp; hint: string }> = {
    shopify_access_token: { pattern: /^shpat_[a-f0-9]{32,}$/i, hint: "Should start with 'shpat_' followed by hex characters" },
    instantly_api_key: { pattern: /^[a-zA-Z0-9_-]{20,}$/, hint: "Should be at least 20 alphanumeric characters" },
    faire_api_key: { pattern: /^[a-zA-Z0-9_-]{10,}$/, hint: "Should be at least 10 characters" },
    klaviyo_api_key: { pattern: /^pk_[a-zA-Z0-9]{20,}$/, hint: "Should start with 'pk_' followed by alphanumeric characters" },
    outscraper_api_key: { pattern: /^[a-zA-Z0-9_-]{20,}$/, hint: "Should be at least 20 characters" },
  };
  const rule = rules[integration];
  if (!rule) return null;
  return rule.pattern.test(value) ? null : rule.hint;
}

function ApiKeyInput({ id, value, onChange, integration }: { id: string; value: string; onChange: (v: string) => void; integration: string }) {
  const error = validateApiKeyFormat(integration, value);
  return (
    <div>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Enter ${integration.replace(/_/g, " ")} key`}
        className={error ? "border-yellow-500" : ""}
      />
      {error && <p className="text-xs text-yellow-600 mt-1">⚠️ {error}</p>}
    </div>
  );
}

function TestConnectionButton({ integration, settings: s }: { integration: string; settings: Record<string, string> }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Show last validation result from settings
  const validatedAt = s[`${integration}_validated_at`];
  const lastResult = s[`${integration}_validation_result`];

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await testConnection(integration);
      setResult(res);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch {
      setResult({ ok: false, message: "Connection test failed" });
      toast.error("Connection test failed");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={handleTest} disabled={testing}>
        {testing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Wifi className="h-4 w-4 mr-1" />}
        Test Connection
      </Button>
      {result && (
        <span className={`text-sm flex items-center gap-1 ${result.ok ? "text-green-600" : "text-red-600"}`}>
          {result.ok ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {result.message}
        </span>
      )}
      {!result && validatedAt && lastResult && (
        <span className={`text-xs ${lastResult === "success" ? "text-green-600" : "text-red-500"}`}>
          Last tested: {new Date(validatedAt).toLocaleDateString()} — {lastResult}
        </span>
      )}
    </div>
  );
}

// ── Xero Integration Card ──

function XeroIntegrationCard({ settings: s, onReload }: { settings: Record<string, string>; onReload: () => void }) {
  const [loading, setLoading] = useState(false);
  const [xeroStatus, setXeroStatus] = useState<{
    configured: boolean;
    connected: boolean;
    tenantName?: string;
    authUrl?: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/v1/finance/xero")
      .then((r) => r.json())
      .then(setXeroStatus)
      .catch(() => {});
  }, []);

  const handleConnect = () => {
    if (xeroStatus?.authUrl) {
      window.location.href = xeroStatus.authUrl;
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await fetch("/api/v1/finance/xero", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      toast.success("Disconnected from Xero");
      onReload();
      setXeroStatus((prev) => prev ? { ...prev, connected: false, tenantName: undefined } : prev);
    } catch {
      toast.error("Failed to disconnect");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Xero</span>
          {xeroStatus?.connected ? (
            <span className="flex items-center gap-1 text-sm font-normal text-green-600">
              <CheckCircle2 className="h-4 w-4" /> Connected
            </span>
          ) : (
            <span className="flex items-center gap-1 text-sm font-normal text-muted-foreground">
              <XCircle className="h-4 w-4" /> Not connected
            </span>
          )}
        </CardTitle>
        <CardDescription>
          Accounting integration — sync settlements, invoices, and chart of accounts
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {xeroStatus?.connected ? (
          <>
            {xeroStatus.tenantName && (
              <p className="text-sm">
                <span className="text-muted-foreground">Organisation:</span>{" "}
                <span className="font-medium">{xeroStatus.tenantName}</span>
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={handleDisconnect} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <XCircle className="h-4 w-4 mr-1" />}
                Disconnect
              </Button>
            </div>
          </>
        ) : xeroStatus?.configured ? (
          <Button size="sm" onClick={handleConnect}>
            <Link2 className="h-4 w-4 mr-2" /> Connect to Xero
          </Button>
        ) : (
          <div className="text-sm text-muted-foreground">
            <p>Set <code>XERO_CLIENT_ID</code> and <code>XERO_CLIENT_SECRET</code> environment variables to enable.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Component ──

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchSettings();
      setSettings(data);
    } catch {
      toast.error("Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const save = async (key: string) => {
    setSaving(true);
    try {
      await saveSetting(key, settings[key] ?? "");
      toast.success(`Saved ${key.replace(/_/g, " ")}`);
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveMultiple = async (keys: string[]) => {
    setSaving(true);
    try {
      await Promise.all(keys.map((k) => saveSetting(k, settings[k] ?? "")));
      toast.success("Settings saved");
    } catch {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleSetting = async (key: string) => {
    const next = settings[key] === "true" ? "false" : "true";
    update(key, next);
    try {
      await saveSetting(key, next);
      toast.success(`${key.replace(/_/g, " ")} ${next === "true" ? "enabled" : "disabled"}`);
    } catch {
      toast.error("Failed to toggle");
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Configure The Frame — profile, integrations, and preferences</p>
      </div>

      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList>
          <TabsTrigger value="profile" className="gap-2"><User className="h-4 w-4" /> Profile</TabsTrigger>
          <TabsTrigger value="integrations" className="gap-2"><Plug className="h-4 w-4" /> Integrations</TabsTrigger>
          <TabsTrigger value="notifications" className="gap-2"><Bell className="h-4 w-4" /> Notifications</TabsTrigger>
          <TabsTrigger value="data" className="gap-2"><Database className="h-4 w-4" /> Data</TabsTrigger>
          <TabsTrigger value="about" className="gap-2"><Info className="h-4 w-4" /> About</TabsTrigger>
        </TabsList>

        {/* ── Profile ── */}
        <TabsContent value="profile">
          <Card>
            <CardHeader>
              <CardTitle>Profile Settings</CardTitle>
              <CardDescription>Your account details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="user_name">Name</Label>
                <Input
                  id="user_name"
                  value={settings.user_name ?? ""}
                  onChange={(e) => update("user_name", e.target.value)}
                  placeholder="Your name"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="user_email">Email</Label>
                <Input
                  id="user_email"
                  type="email"
                  value={settings.user_email ?? ""}
                  onChange={(e) => update("user_email", e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <Button onClick={() => saveMultiple(["user_name", "user_email"])} disabled={saving}>
                <Save className="h-4 w-4 mr-2" /> Save Profile
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Integrations ── */}
        <TabsContent value="integrations">
          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Instantly</CardTitle>
                <CardDescription>Email campaign automation — provide your API key to enable outreach</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  <Label htmlFor="instantly_api_key">API Key</Label>
                  <ApiKeyInput
                    id="instantly_api_key"
                    value={settings.instantly_api_key ?? ""}
                    onChange={(v) => update("instantly_api_key", v)}
                    integration="instantly_api_key"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => save("instantly_api_key")} disabled={saving}>
                    <Save className="h-4 w-4 mr-2" /> Save
                  </Button>
                  <TestConnectionButton integration="instantly" settings={settings} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Outscraper</CardTitle>
                <CardDescription>Business data enrichment — Google Maps reviews, emails, phones</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  <Label htmlFor="outscraper_api_key">API Key</Label>
                  <ApiKeyInput
                    id="outscraper_api_key"
                    value={settings.outscraper_api_key ?? ""}
                    onChange={(v) => update("outscraper_api_key", v)}
                    integration="outscraper_api_key"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => save("outscraper_api_key")} disabled={saving}>
                    <Save className="h-4 w-4 mr-2" /> Save
                  </Button>
                  <TestConnectionButton integration="outscraper" settings={settings} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Shopify DTC (Retail)</CardTitle>
                <CardDescription>Consumer-facing store — jaxy-9712.myshopify.com → getjaxy.com</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  <Label htmlFor="shopify_dtc_store_domain">Store Domain</Label>
                  <Input
                    id="shopify_dtc_store_domain"
                    value={settings.shopify_dtc_store_domain ?? ""}
                    onChange={(e) => update("shopify_dtc_store_domain", e.target.value)}
                    placeholder="jaxy-9712.myshopify.com"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="shopify_dtc_access_token">Access Token</Label>
                  <ApiKeyInput
                    id="shopify_dtc_access_token"
                    value={settings.shopify_dtc_access_token ?? ""}
                    onChange={(v) => update("shopify_dtc_access_token", v)}
                    integration="shopify_access_token"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => saveMultiple(["shopify_dtc_store_domain", "shopify_dtc_access_token"])} disabled={saving}>
                    <Save className="h-4 w-4 mr-2" /> Save
                  </Button>
                  <TestConnectionButton integration="shopify_dtc" settings={settings} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Shopify Wholesale (B2B)</CardTitle>
                <CardDescription>Wholesale store for retailers — jaxy-wholesale.myshopify.com</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  <Label htmlFor="shopify_wholesale_store_domain">Store Domain</Label>
                  <Input
                    id="shopify_wholesale_store_domain"
                    value={settings.shopify_wholesale_store_domain ?? ""}
                    onChange={(e) => update("shopify_wholesale_store_domain", e.target.value)}
                    placeholder="jaxy-wholesale.myshopify.com"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="shopify_wholesale_access_token">Access Token</Label>
                  <ApiKeyInput
                    id="shopify_wholesale_access_token"
                    value={settings.shopify_wholesale_access_token ?? ""}
                    onChange={(v) => update("shopify_wholesale_access_token", v)}
                    integration="shopify_access_token"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => saveMultiple(["shopify_wholesale_store_domain", "shopify_wholesale_access_token"])} disabled={saving}>
                    <Save className="h-4 w-4 mr-2" /> Save
                  </Button>
                  <TestConnectionButton integration="shopify_wholesale" settings={settings} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Faire</CardTitle>
                <CardDescription>Wholesale marketplace integration</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  <Label htmlFor="faire_api_key">API Key</Label>
                  <ApiKeyInput
                    id="faire_api_key"
                    value={settings.faire_api_key ?? ""}
                    onChange={(v) => update("faire_api_key", v)}
                    integration="faire_api_key"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => save("faire_api_key")} disabled={saving}>
                    <Save className="h-4 w-4 mr-2" /> Save
                  </Button>
                  <TestConnectionButton integration="faire" settings={settings} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Klaviyo</CardTitle>
                <CardDescription>Email marketing and customer data platform</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  <Label htmlFor="klaviyo_api_key">API Key</Label>
                  <ApiKeyInput
                    id="klaviyo_api_key"
                    value={settings.klaviyo_api_key ?? ""}
                    onChange={(v) => update("klaviyo_api_key", v)}
                    integration="klaviyo_api_key"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => save("klaviyo_api_key")} disabled={saving}>
                    <Save className="h-4 w-4 mr-2" /> Save
                  </Button>
                  <TestConnectionButton integration="klaviyo" settings={settings} />
                </div>
              </CardContent>
            </Card>
            <XeroIntegrationCard settings={settings} onReload={load} />
          </div>
        </TabsContent>

        {/* ── Notifications ── */}
        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle>Notification Preferences</CardTitle>
              <CardDescription>Choose which events trigger notifications</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {[
                { key: "notify_prospect_imported", label: "New prospect imported", desc: "When a prospect is added via CSV or enrichment" },
                { key: "notify_deal_stage_changed", label: "Deal stage changed", desc: "When a deal moves through the pipeline" },
                { key: "notify_order_received", label: "Order received", desc: "When a new wholesale or DTC order comes in" },
                { key: "notify_low_stock", label: "Low stock alert", desc: "When inventory falls below threshold" },
              ].map(({ key, label, desc }) => (
                <div key={key} className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>{label}</Label>
                    <p className="text-sm text-muted-foreground">{desc}</p>
                  </div>
                  <Switch
                    checked={settings[key] === "true"}
                    onCheckedChange={() => toggleSetting(key)}
                  />
                </div>
              ))}

              <Separator />

              <div className="space-y-3">
                <h4 className="text-sm font-medium">Delivery Channels</h4>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Email notifications</Label>
                    <p className="text-sm text-muted-foreground">Send alerts to your email</p>
                  </div>
                  <Switch
                    checked={settings.notify_via_email === "true"}
                    onCheckedChange={() => toggleSetting("notify_via_email")}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Telegram notifications</Label>
                    <p className="text-sm text-muted-foreground">Send alerts to Telegram</p>
                  </div>
                  <Switch
                    checked={settings.notify_via_telegram === "true"}
                    onCheckedChange={() => toggleSetting("notify_via_telegram")}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Data Management ── */}
        <TabsContent value="data">
          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Import & Export</CardTitle>
                <CardDescription>Move data in and out of The Frame</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-3">
                <Button variant="outline" asChild>
                  <a href="/prospects?import=true">
                    <Upload className="h-4 w-4 mr-2" /> Import Prospects CSV
                  </a>
                </Button>
                <Button variant="outline" asChild>
                  <a href="/api/v1/prospects/export" download>
                    <Download className="h-4 w-4 mr-2" /> Export Prospects CSV
                  </a>
                </Button>
              </CardContent>
            </Card>

            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-destructive">Danger Zone</CardTitle>
                <CardDescription>Irreversible actions — proceed with caution</CardDescription>
              </CardHeader>
              <CardContent>
                <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="destructive">
                      <Trash2 className="h-4 w-4 mr-2" /> Clear All Data
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Are you absolutely sure?</DialogTitle>
                      <DialogDescription>
                        This will permanently delete all prospects, deals, orders, and activity data.
                        Settings and integrations will be preserved. This action cannot be undone.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setClearDialogOpen(false)}>Cancel</Button>
                      <Button
                        variant="destructive"
                        onClick={async () => {
                          try {
                            const res = await fetch("/api/v1/data/clear", { method: "POST" });
                            if (res.ok) {
                              toast.success("All data cleared");
                            } else {
                              toast.error("Failed to clear data");
                            }
                          } catch {
                            toast.error("Failed to clear data");
                          }
                          setClearDialogOpen(false);
                        }}
                      >
                        Yes, delete everything
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── About ── */}
        <TabsContent value="about">
          <Card>
            <CardHeader>
              <CardTitle>About The Frame</CardTitle>
              <CardDescription>Wholesale CRM & operations platform</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Version</p>
                  <p className="font-medium">0.1.0</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Framework</p>
                  <p className="font-medium">Next.js 16 + shadcn/ui</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Database</p>
                  <p className="font-medium">SQLite (better-sqlite3 + Drizzle)</p>
                </div>
                <div>
                  <p className="text-muted-foreground">License</p>
                  <p className="font-medium">Private</p>
                </div>
              </div>
              <Separator />
              <div className="flex gap-3">
                <Button variant="outline" size="sm" asChild>
                  <a href="https://github.com/krispydan/the-frame" target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 mr-2" /> GitHub Repository
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
