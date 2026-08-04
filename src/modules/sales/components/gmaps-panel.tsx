"use client";

/**
 * A store's Google Maps listing, as a rep needs it before a call.
 *
 * The point of this panel is answering "what IS this shop?" — Google's own
 * categorisation, how established it looks, and whether it's still trading —
 * without leaving the frame. Closure gets top billing because calling a shut
 * store is the single most embarrassing failure mode here.
 */

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Globe, Loader2, MapPin, Phone, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Listing {
  placeId: string | null;
  title: string | null;
  categoryName: string | null;
  categories: string[];
  subTypes: string[];
  rating: number | null;
  reviewCount: number | null;
  price: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  permanentlyClosed: boolean;
  temporarilyClosed: boolean;
  openingHours: Array<{ day: string; hours: string }>;
  description: string | null;
  mapsUrl: string | null;
  imageCount: number | null;
  scrapedAt: string | null;
}

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * Review count is the closest thing we have to "how much foot traffic does
 * this place get" — worth reading at a glance rather than as a bare number.
 */
function reviewBand(n: number | null): string | null {
  if (n == null) return null;
  if (n < 25) return "quiet / new";
  if (n < 100) return "established";
  if (n < 400) return "busy";
  return "high traffic";
}

export function GmapsPanel({ companyId }: { companyId: string }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [canRefresh, setCanRefresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/v1/customers/gmaps?companyId=${encodeURIComponent(companyId)}`);
      const j = await r.json();
      setListing(j.listing ?? null);
      setCanRefresh(j.canRefresh === true);
    } catch {
      setError("Could not load the Google Maps listing");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/customers/gmaps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      const j = await r.json();
      if (j.listing) setListing(j.listing);
      else if (j.result?.status === "no-match") setError("Google Maps has no confident match for this store");
      else if (j.error) setError(String(j.error));
    } catch {
      setError("Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Google Maps</CardTitle>
        </CardHeader>
        <CardContent>
          <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
        </CardContent>
      </Card>
    );
  }

  const age = daysAgo(listing?.scrapedAt ?? null);
  // Everything Google calls this place, deduped — categoryName is usually
  // already in subTypes, and the overlap is noise on a panel this size.
  const kinds = listing
    ? [...new Set([listing.categoryName, ...listing.subTypes, ...listing.categories].filter(Boolean))] as string[]
    : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4 text-red-600" />
            Google Maps
          </CardTitle>
          <CardDescription>
            {listing
              ? `What Google says this store is${age != null ? ` — captured ${age === 0 ? "today" : `${age}d ago`}` : ""}`
              : "No listing captured for this store yet"}
          </CardDescription>
        </div>
        {canRefresh && (
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="ml-1.5">{listing ? "Refresh" : "Look up"}</span>
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!listing && !error && (
          <p className="text-sm text-gray-500">
            Listings are captured automatically when a lead becomes a customer, and refreshed nightly once
            they&apos;re over 120 days old.
          </p>
        )}

        {listing && (
          <>
            {listing.permanentlyClosed && (
              <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800 font-medium">
                Permanently closed per Google — do not call.
              </div>
            )}
            {!listing.permanentlyClosed && listing.temporarilyClosed && (
              <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
                Temporarily closed per Google.
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 text-sm">
              {listing.rating != null && (
                <span className="inline-flex items-center gap-1 font-medium">
                  <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                  {listing.rating.toFixed(1)}
                </span>
              )}
              {listing.reviewCount != null && (
                <span className="text-gray-600">
                  {listing.reviewCount.toLocaleString()} reviews
                  {reviewBand(listing.reviewCount) && (
                    <span className="text-gray-400"> · {reviewBand(listing.reviewCount)}</span>
                  )}
                </span>
              )}
              {listing.price && <span className="text-gray-600">Price {listing.price}</span>}
              {listing.imageCount != null && (
                <span className="text-gray-400">{listing.imageCount.toLocaleString()} photos</span>
              )}
            </div>

            {kinds.length > 0 && (
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1.5">Store type</p>
                <div className="flex flex-wrap gap-1.5">
                  {kinds.slice(0, 12).map((k) => (
                    <Badge key={k} variant="secondary" className="font-normal">
                      {k}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {listing.description && (
              <p className="text-sm text-gray-700 italic">&ldquo;{listing.description}&rdquo;</p>
            )}

            <div className="grid gap-1.5 text-sm">
              {listing.address && (
                <div className="flex items-start gap-2 text-gray-700">
                  <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400" />
                  <span>{listing.address}</span>
                </div>
              )}
              {listing.phone && (
                <div className="flex items-center gap-2 text-gray-700">
                  <Phone className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <a href={`tel:${listing.phone}`} className="hover:underline">{listing.phone}</a>
                </div>
              )}
              {listing.website && (
                <div className="flex items-center gap-2 text-gray-700">
                  <Globe className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <a
                    href={listing.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline truncate"
                  >
                    {listing.website.replace(/^https?:\/\//, "")}
                  </a>
                </div>
              )}
            </div>

            {listing.openingHours.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-gray-500 hover:text-gray-700">Opening hours</summary>
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                  {listing.openingHours.map((h) => (
                    <div key={h.day} className="flex justify-between gap-4">
                      <span className="text-gray-500">{h.day}</span>
                      <span className="text-gray-800">{h.hours}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {listing.mapsUrl && (
              <a
                href={listing.mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
              >
                Open in Google Maps <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
