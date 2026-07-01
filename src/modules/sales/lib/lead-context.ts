/**
 * Assemble a compact, human-readable profile of a lead from everything
 * The Frame knows about it, so the AI opener writer has maximum context
 * (locality, size, existing eyewear, competitors, socials, ICP, what the
 * store is about). Only non-empty fields are included; the whole thing is
 * length-capped to keep token use sane.
 */
import { sqlite } from "@/lib/db";

interface Row {
  name: string | null;
  type: string | null;
  category: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  icp_tier: string | null;
  icp_score: number | null;
  icp_reasoning: string | null;
  tags: string | null;
  segment: string | null;
  description: string | null;
  enrichment_text: string | null;
  meta_description: string | null;
  ecom_platform: string | null;
  top_brand: string | null;
  eyewear_categories: string | null;
  eyewear_price_range: string | null;
  eyewear_top_competitors: string | null;
  eyewear_sample_titles: string | null;
  estimated_yearly_sales_cents: number | null;
  estimated_monthly_visits: number | null;
  instagram_url: string | null;
  tiktok_url: string | null;
  tiktok_followers: number | null;
  youtube_followers: number | null;
  facebook_url: string | null;
  socials: string | null;
  business_hours: string | null;
}

function money(cents: number | null, floorDollars = 0): string | null {
  if (!cents || cents <= 0) return null;
  const d = cents / 100;
  if (d < floorDollars) return null; // implausibly low → treat as bad data
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000) return `$${Math.round(d / 1_000)}k`;
  return `$${Math.round(d)}`;
}

/** Dedupe + tidy a "type · category · industry" style label. */
function cleanKind(parts: Array<string | null>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    if (!raw) continue;
    const v = raw.replace(/^[/\\\s]+/, "").trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.join(" · ");
}

function num(n: number | null): string | null {
  if (!n || n <= 0) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Returns a profile string, or "" if the company can't be found. */
export function loadLeadContext(companyId: string): string {
  let r: Row | undefined;
  try {
    r = sqlite
      .prepare(
        `SELECT name, type, category, industry, city, state, country,
                google_rating, google_review_count, icp_tier, icp_score, icp_reasoning,
                tags, segment, description, enrichment_text, meta_description,
                ecom_platform, top_brand, eyewear_categories, eyewear_price_range,
                eyewear_top_competitors, eyewear_sample_titles,
                estimated_yearly_sales_cents, estimated_monthly_visits,
                instagram_url, tiktok_url, tiktok_followers, youtube_followers,
                facebook_url, socials, business_hours
           FROM companies WHERE id = ?`,
      )
      .get(companyId) as Row | undefined;
  } catch {
    return "";
  }
  if (!r) return "";

  const lines: string[] = [];

  const kind = cleanKind([r.type, r.category, r.industry]);
  if (kind) lines.push(`Type: ${kind}`);

  const loc = [r.city, r.state, r.country && r.country !== "US" ? r.country : null].filter(Boolean).join(", ");
  if (loc) lines.push(`Location: ${loc}`);

  if (r.google_rating) {
    lines.push(`Google: ${r.google_rating}★${r.google_review_count ? ` (${r.google_review_count} reviews)` : ""}`);
  }

  if (r.icp_tier || r.icp_score != null) {
    const rz = r.icp_reasoning ? ` — ${r.icp_reasoning.slice(0, 160)}` : "";
    lines.push(`ICP: Tier ${r.icp_tier ?? "?"}${r.icp_score != null ? ` (score ${r.icp_score})` : ""}${rz}`);
  }

  const size: string[] = [];
  const yr = money(r.estimated_yearly_sales_cents, 5_000); // drop implausible sub-$5k/yr artifacts
  if (yr) size.push(`~${yr}/yr est. sales`);
  const vis = num(r.estimated_monthly_visits);
  if (vis) size.push(`~${vis} monthly visits`);
  if (r.ecom_platform) size.push(r.ecom_platform);
  if (size.length) lines.push(`Size: ${size.join(", ")}`);

  const soc: string[] = [];
  if (r.instagram_url) soc.push("Instagram");
  const tt = num(r.tiktok_followers);
  if (r.tiktok_url) soc.push(`TikTok${tt ? ` ${tt}` : ""}`);
  if (r.facebook_url) soc.push("Facebook");
  const yt = num(r.youtube_followers);
  if (yt) soc.push(`YouTube ${yt}`);
  if (soc.length) lines.push(`Socials: ${soc.join(", ")}`);

  // Existing eyewear intel (from storefront crawl).
  const eye: string[] = [];
  if (r.eyewear_categories) eye.push(r.eyewear_categories.replace(/,/g, ", "));
  if (r.eyewear_price_range) eye.push(`price ${r.eyewear_price_range}`);
  const comp = [r.eyewear_top_competitors, r.top_brand].filter(Boolean).join("|");
  if (comp) eye.push(`brands seen: ${comp.split("|").filter(Boolean).slice(0, 4).join(", ")}`);
  if (eye.length) lines.push(`Existing eyewear: ${eye.join(" · ")}`);

  try {
    const tags = r.tags ? (JSON.parse(r.tags) as string[]) : [];
    if (Array.isArray(tags) && tags.length) lines.push(`Tags: ${tags.slice(0, 8).join(", ")}`);
  } catch { /* ignore */ }
  if (r.segment) lines.push(`Segment: ${r.segment}`);

  const about = (r.description || r.enrichment_text || r.meta_description || "").trim();
  if (about) lines.push(`About: ${about.slice(0, 400)}`);

  return lines.join("\n");
}
