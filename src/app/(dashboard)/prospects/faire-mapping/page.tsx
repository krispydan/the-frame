"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users, ExternalLink, Loader2, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Customer = {
  id: string;
  name: string | null;
  relay_email: string | null;
  order_count: number;
  total_revenue: number;
  last_order_at: string | null;
};

export default function FaireMappingPage() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [forms, setForms] = useState<Record<string, { website: string; email: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  async function load() {
    const res = await fetch("/api/v1/sales/faire-unmapped");
    const data = await res.json();
    setCustomers(data.customers || []);
  }
  useEffect(() => {
    load();
  }, []);

  function set(id: string, field: "website" | "email", value: string) {
    setForms((f) => {
      const cur = f[id] || { website: "", email: "" };
      return { ...f, [id]: { ...cur, [field]: value } };
    });
  }

  async function save(id: string) {
    const form = forms[id];
    if (!form || (!form.website?.trim() && !form.email?.trim())) return;
    setSaving(id);
    try {
      const res = await fetch(`/api/v1/sales/prospects/${id}/faire-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website: form.website?.trim() || "", email: form.email?.trim() || "" }),
      });
      if (res.ok) {
        setDone((d) => new Set(d).add(id));
        setCustomers((cs) => (cs ? cs.filter((c) => c.id !== id) : cs));
      }
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="container mx-auto p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Users className="h-7 w-7" />
          Faire customers to map
        </h1>
        <p className="text-muted-foreground mt-2">
          These stores ordered via Faire with an anonymized email (<code>@relay.faire.com</code>) and no website yet.
          Add their real website + email so we can reach them and sync clean data to Pipedrive.
        </p>
      </div>

      {customers === null ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading...
          </CardContent>
        </Card>
      ) : customers.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-600" />
            {done.size > 0 ? "All caught up — nice work." : "Nothing to map right now."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{customers.length} need mapping</CardTitle>
            <CardDescription>Saving updates the company and pushes the website + email to Pipedrive.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {customers.map((c) => {
              const form = forms[c.id] || { website: "", email: "" };
              return (
                <div key={c.id} className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                  <div className="min-w-[14rem] flex-1">
                    <Link
                      href={`/prospects/${c.id}`}
                      className="font-medium hover:underline inline-flex items-center gap-1"
                    >
                      {c.name || "Unnamed"}
                      <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {c.order_count} order{c.order_count === 1 ? "" : "s"} · $
                      {Number(c.total_revenue || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      {c.relay_email ? <> · <code>{c.relay_email}</code></> : null}
                    </div>
                  </div>
                  <Input
                    className="h-9 w-48"
                    placeholder="https://store.com"
                    value={form.website}
                    onChange={(e) => set(c.id, "website", e.target.value)}
                  />
                  <Input
                    className="h-9 w-56"
                    placeholder="owner@store.com"
                    value={form.email}
                    onChange={(e) => set(c.id, "email", e.target.value)}
                  />
                  <Button
                    size="sm"
                    onClick={() => save(c.id)}
                    disabled={saving === c.id || (!form.website.trim() && !form.email.trim())}
                  >
                    {saving === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
