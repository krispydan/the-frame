"use client";

/**
 * Store DNA — what our customers look like on Google Maps, in aggregate.
 *
 * The question this answers is "what should we go looking for?". Every panel
 * here maps onto an input the Apify Google Maps actor actually takes, so the
 * page ends with a ready-to-paste actor config rather than a set of
 * observations someone has to translate by hand.
 *
 * Lift is customer share ÷ control share, where controls are stores we called
 * that never ordered. Until that cohort is captured, lift is unanchored — a
 * category can look dominant simply because gift shops are everywhere — so we
 * say so rather than dressing up raw share as a signal.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Copy, Loader2, Store } from "lucide-react";

interface FeatureLift {
  value: string;
  customers: number;
  controls: number;
  customerPct: number;
  controlPct: number;
  lift: number;
}

interface Profile {
  customerListings: number;
  controlListings: number;
  categories: FeatureLift[];
  subTypes: FeatureLift[];
  reviews: {
    customerMedian: number | null;
    controlMedian: number | null;
    customerP25: number | null;
    customerP75: number | null;
    bands: Array<{ band: string; customers: number; controls: number; lift: number }>;
  };
  rating: { customerMedian: number | null; controlMedian: number | null; suggestedMinimumStars: string };
  website: { customerHasPct: number; controlHasPct: number; suggested: string };
  topStates: Array<{ state: string; customers: number }>;
  suggestedActorInput: Record<string, unknown>;
}

function LiftRows({ rows, hasControls }: { rows: FeatureLift[]; hasControls: boolean }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing captured yet.</p>;
  const max = Math.max(...rows.map((r) => r.customerPct), 1);
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.value} className="relative rounded-md border px-2.5 py-1.5 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-blue-100/70"
            style={{ width: `${Math.max(4, (r.customerPct / max) * 100)}%` }}
          />
          <div className="relative flex items-center justify-between gap-3 text-sm">
            <span className="font-medium truncate">{r.value}</span>
            <span className="tabular-nums shrink-0">
              {r.customerPct}%
              {hasControls && (
                <span className={`ml-2 text-xs ${r.lift >= 1.5 ? "text-green-700" : "text-muted-foreground"}`}>
                  {r.lift.toFixed(1)}× vs non-buyers
                </span>
              )}
            </span>
          </div>
          <div className="relative text-xs text-muted-foreground">{r.customers} customers</div>
        </div>
      ))}
    </div>
  );
}

export function StoreDna() {
  const [p, setP] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/customers/gmaps?profile=1");
      if (r.ok) {
        const j = await r.json();
        setP(j.profile ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Store DNA</CardTitle></CardHeader>
        <CardContent><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></CardContent>
      </Card>
    );
  }
  if (!p || p.customerListings === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Store className="h-4 w-4" /> Store DNA</CardTitle>
          <CardDescription>No Google Maps listings captured yet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const hasControls = p.controlListings > 0;
  const actorJson = JSON.stringify(p.suggestedActorInput, null, 2);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Store className="h-4 w-4" /> Store DNA — what our customers look like on Google Maps
        </CardTitle>
        <CardDescription>
          {p.customerListings.toLocaleString()} customer listings captured
          {hasControls
            ? ` · ${p.controlListings.toLocaleString()} control listings (called, never ordered)`
            : " · control cohort not captured yet, so shares below are raw, not lift"}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Headline numbers — each one is a filter we can actually set */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Median reviews</p>
            <p className="text-xl font-bold tabular-nums">{p.reviews.customerMedian ?? "—"}</p>
            <p className="text-xs text-muted-foreground">
              middle half {p.reviews.customerP25 ?? "—"}–{p.reviews.customerP75 ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Median rating</p>
            <p className="text-xl font-bold tabular-nums">{p.rating.customerMedian?.toFixed(1) ?? "—"}</p>
            <p className="text-xs text-muted-foreground">search floor: {p.rating.suggestedMinimumStars}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Have a website</p>
            <p className="text-xl font-bold tabular-nums">{p.website.customerHasPct}%</p>
            <p className="text-xs text-muted-foreground">filter: {p.website.suggested}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Top states</p>
            <p className="text-sm font-medium leading-6">
              {p.topStates.slice(0, 4).map((s) => `${s.state} (${s.customers})`).join(", ") || "—"}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-semibold mb-2">
              Store types {hasControls ? "over-represented among buyers" : "our customers are"}
            </h3>
            <p className="text-xs text-muted-foreground mb-2">
              Google&apos;s own labels. These become <code>categoryFilterWords</code> and search terms.
            </p>
            <LiftRows rows={p.subTypes.slice(0, 14)} hasControls={hasControls} />
          </div>

          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold mb-2">Primary category</h3>
              <p className="text-xs text-muted-foreground mb-2">
                The single label Google leads with — the narrowest, cleanest search term.
              </p>
              <LiftRows rows={p.categories.slice(0, 8)} hasControls={hasControls} />
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-2">Review count</h3>
              <p className="text-xs text-muted-foreground mb-2">
                Our rough proxy for foot traffic — and the band we should be filtering scrapes to.
              </p>
              <div className="space-y-1.5">
                {p.reviews.bands.map((b) => {
                  const max = Math.max(...p.reviews.bands.map((x) => x.customers), 1);
                  return (
                    <div key={b.band} className="relative rounded-md border px-2.5 py-1.5 overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 bg-amber-100/70"
                        style={{ width: `${Math.max(4, (b.customers / max) * 100)}%` }}
                      />
                      <div className="relative flex items-center justify-between text-sm">
                        <span className="font-medium">{b.band} reviews</span>
                        <span className="tabular-nums">{b.customers}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* The whole point: a config someone can paste into Apify today */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-sm font-semibold">Suggested Apify actor input</h3>
              <p className="text-xs text-muted-foreground">
                Derived from the profile above — paste into <code>compass/crawler-google-places</code> to find lookalikes.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(actorJson);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>
          <pre className="text-xs bg-muted/60 rounded-md p-3 overflow-x-auto">{actorJson}</pre>
        </div>

        {!hasControls && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <Badge variant="secondary" className="mr-2">Caveat</Badge>
            Without listings for stores we called that never ordered, a high share only tells us what our
            customers are — not what separates them from everyone else. Capture the control cohort before
            treating these as targeting rules.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
