"use client";

/**
 * Self-contained API-key configuration card. Used on /settings/integrations
 * for integrations that don't have an OAuth flow yet (Klaviyo, Instantly,
 * Outscraper, ...) — they just store a single API key in the `settings`
 * table.
 *
 * Each card fetches its own value, saves on demand, and runs a test
 * connection against the shared /api/v1/settings/test-connection route.
 *
 * Replaces the duplicated "Integrations" tab on /settings that used to be
 * a second home for these same controls.
 */

import { useEffect, useState } from "react";
import { Save, Wifi, WifiOff, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

interface ApiKeyCardProps {
  /** Display name, e.g. "Klaviyo". */
  title: string;
  /** Short description shown under the title. */
  description: string;
  /** The settings key to store the value under, e.g. "klaviyo_api_key". */
  settingKey: string;
  /** The integration slug for /api/v1/settings/test-connection, e.g. "klaviyo". */
  testSlug: string;
  /** Optional integration-specific buttons rendered next to Save + Test
   *  (e.g. Instantly's "Sync campaigns" trigger). Kept generic so we
   *  don't have to fork the card for every integration. */
  extraActions?: React.ReactNode;
}

export function ApiKeyCard({ title, description, settingKey, testSlug, extraActions }: ApiKeyCardProps) {
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    fetch("/api/v1/settings")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as Record<string, string>;
        setValue(data[settingKey] ?? "");
      })
      .catch(() => {
        /* leave empty */
      })
      .finally(() => setLoaded(true));
  }, [settingKey]);

  async function onSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: settingKey, value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Saved");
    } catch (e) {
      toast.error("Failed to save", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch("/api/v1/settings/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integration: testSlug }),
      });
      const data = (await res.json()) as { ok: boolean; message: string };
      setResult(data);
      if (data.ok) toast.success(data.message);
      else toast.error(data.message);
    } catch {
      setResult({ ok: false, message: "Connection test failed" });
      toast.error("Connection test failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2">
          <Label htmlFor={settingKey}>API Key</Label>
          <Input
            id={settingKey}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={loaded ? "—" : "Loading…"}
            disabled={!loaded}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onSave} disabled={saving || !loaded}>
            <Save className="h-4 w-4 mr-1" /> Save
          </Button>
          <Button size="sm" variant="outline" onClick={onTest} disabled={testing || !loaded}>
            {testing ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Wifi className="h-4 w-4 mr-1" />
            )}
            Test Connection
          </Button>
          {result && (
            <span
              className={`text-sm flex items-center gap-1 ${result.ok ? "text-green-600" : "text-red-600"}`}
            >
              {result.ok ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {result.message}
            </span>
          )}
          {extraActions}
        </div>
      </CardContent>
    </Card>
  );
}
