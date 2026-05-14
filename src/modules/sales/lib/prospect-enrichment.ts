/**
 * Prospect enrichment — what the LLM classifier sees beyond name + tags.
 *
 * Two-mode operation:
 *   1. If the company has a `website`, fetch its homepage HTML and extract
 *      cleaned content text + contact info.
 *   2. If not (or fetch fails), query Brave Search for the company by name
 *      + city + state and take the top result snippets.
 *
 * Contact extraction runs against the HTML/snippets and recovers emails,
 * phone numbers, contact-form URLs, and social links — saving us a second
 * pass when we want to reach out.
 *
 * Both worker (Mac mini) and any future server-side enrichment use this
 * same function so the data shape is consistent.
 *
 * Note: this is for LLM-classifier enrichment. The legacy `enrichment.ts`
 * in this directory is for Outscraper-driven contact enrichment and is
 * unrelated.
 */

const HTTP_TIMEOUT_MS = 10_000;
const MAX_TEXT_LEN = 2_000;
const MAX_HTML_LEN = 250_000;  // ~250KB ceiling on what we'll parse
const USER_AGENT = "JaxyClassifier/1.0 (+https://theframe.getjaxy.com)";

const SPAM_EMAIL_PREFIXES = [
  "noreply", "no-reply", "donotreply", "do-not-reply",
  "support@wordpress", "support@wix", "support@squarespace",
  "abuse@", "postmaster@",
];

export type EnrichmentSource = "homepage" | "brave" | "none";

export interface EnrichmentContacts {
  emails: string[];
  phones: string[];
  contact_form_url: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
}

export interface EnrichmentResult {
  text: string;
  source: EnrichmentSource;
  contacts: EnrichmentContacts;
}

export interface EnrichInput {
  name: string;
  website: string | null;
  city: string | null;
  state: string | null;
  braveApiKey: string | null;     // optional; if null we skip Brave fallback
}

export async function enrichProspect(input: EnrichInput): Promise<EnrichmentResult> {
  // 1. Try homepage scrape first
  if (input.website) {
    const homepageUrl = normalizeUrl(input.website);
    if (homepageUrl) {
      const r = await tryFetchHomepage(homepageUrl);
      if (r) return r;
    }
  }

  // 2. Brave Search fallback
  if (input.braveApiKey) {
    const r = await tryBraveSearch(input, input.braveApiKey);
    if (r) return r;
  }

  return {
    text: "",
    source: "none",
    contacts: emptyContacts(),
  };
}

// ── Homepage scrape ─────────────────────────────────────────────────────

async function tryFetchHomepage(url: string): Promise<EnrichmentResult | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      redirect: "follow",
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return null;

    const html = (await res.text()).slice(0, MAX_HTML_LEN);

    return {
      text: extractText(html).slice(0, MAX_TEXT_LEN),
      source: "homepage",
      contacts: extractContacts(html, url),
    };
  } catch {
    return null;
  }
}

/** Strip script/style/nav/footer/etc., collapse whitespace, decode entities. */
export function extractText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<header[\s\S]*?<\/header>/gi, " ");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

// ── Contact extraction ────────────────────────────────────────────────

export function extractContacts(html: string, baseUrl: string): EnrichmentContacts {
  return {
    emails: extractEmails(html),
    phones: extractPhones(html),
    contact_form_url: findContactFormUrl(html, baseUrl),
    instagram_url: findFirstSocial(html, "instagram.com"),
    facebook_url: findFirstSocial(html, "facebook.com"),
  };
}

function extractEmails(html: string): string[] {
  const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const email = raw.toLowerCase();
    if (seen.has(email)) continue;
    if (SPAM_EMAIL_PREFIXES.some((p) => email.startsWith(p))) continue;
    if (/bounce|tracking|wf-?form|sentry/i.test(email)) continue;
    if (email.endsWith(".png") || email.endsWith(".jpg") || email.endsWith(".webp")) continue;
    seen.add(email);
    out.push(email);
    if (out.length >= 5) break;
  }
  return out;
}

function extractPhones(html: string): string[] {
  const matches = html.match(/\b(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const digits = raw.replace(/\D/g, "");
    const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    if (local.length !== 10) continue;
    const formatted = `+1 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
    if (seen.has(formatted)) continue;
    seen.add(formatted);
    out.push(formatted);
    if (out.length >= 3) break;
  }
  return out;
}

function findContactFormUrl(html: string, baseUrl: string): string | null {
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    const txt = (match[2] || "").trim().toLowerCase();
    const hrefLower = href.toLowerCase();
    if (hrefLower.startsWith("mailto:") || hrefLower.startsWith("tel:")) continue;
    if (hrefLower.includes("/contact") || hrefLower.includes("/get-in-touch")) {
      return resolveUrl(baseUrl, href);
    }
    if (txt.includes("contact us") || txt === "contact") {
      return resolveUrl(baseUrl, href);
    }
  }
  return null;
}

function findFirstSocial(html: string, host: string): string | null {
  const re = new RegExp(`https?://(?:www\\.)?${host.replace(".", "\\.")}/[^"'\\s<>]+`, "i");
  const m = html.match(re);
  if (!m) return null;
  return m[0].replace(/[)>,.;]+$/, "").split("?")[0];
}

function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

// ── Brave Search fallback ─────────────────────────────────────────────

interface BraveResult {
  title: string;
  url: string;
  description: string;
}

async function tryBraveSearch(input: EnrichInput, apiKey: string): Promise<EnrichmentResult | null> {
  try {
    const q = [input.name, input.city, input.state].filter(Boolean).join(" ");
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=3&country=us`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: {
        "X-Subscription-Token": apiKey,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
      },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) return null;
    const json = await res.json() as { web?: { results?: BraveResult[] } };
    const results = json.web?.results ?? [];
    if (results.length === 0) return null;

    const text = results
      .slice(0, 3)
      .map((r) => `${r.title} — ${r.description}`)
      .join("\n\n")
      .slice(0, MAX_TEXT_LEN);

    return {
      text,
      source: "brave",
      contacts: emptyContacts(),
    };
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function emptyContacts(): EnrichmentContacts {
  return {
    emails: [],
    phones: [],
    contact_form_url: null,
    instagram_url: null,
    facebook_url: null,
  };
}

function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const url = new URL(s);
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}
