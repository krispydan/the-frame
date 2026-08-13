/**
 * Email discovery probe for the qualifier bench.
 *
 * Google Maps has no email field, so a lead arrives with a website and no way
 * to email it. This crawls those websites for contact addresses and measures
 * what we actually get, because the number that decides whether cold email is
 * a viable channel is not "how many leads" but "how many leads we can send to".
 *
 * What it measures, and why each one matters more than raw yield:
 *
 *   yield        share of sites that give up any address at all
 *   kind         role (info@, hello@) vs personal (a named human) vs freemail
 *                (gmail.com). A named address at the shop's own domain is
 *                worth several role addresses; a gmail address on a business
 *                site is usually the owner and is often the BEST one.
 *   domainMatch  whether the address lives on the site's own domain. A
 *                mismatch usually means we scraped the web designer's footer
 *                or a platform support address, not the shop.
 *   verify       NeverBounce result. Scraped addresses have high invalid
 *                rates and sending to them is what burns a sending domain, so
 *                an unverified yield number is not a usable one.
 *
 * Deliberately sample-first: a probe over ~100 sites answers the quality
 * question for a fraction of the cost of crawling every lead.
 */

import { randomUUID } from "crypto";
import { sqlite } from "@/lib/db";
import { apifyClient } from "./apify-client";

const ACTOR_CONTACTS = process.env.APIFY_CONTACTS_ACTOR_ID || "vdrmota~contact-info-scraper";

/** Mailbox names that are a department, not a person. */
const ROLE_NAMES = new Set([
  "info", "hello", "hi", "contact", "contactus", "sales", "shop", "store", "orders",
  "support", "help", "admin", "office", "team", "mail", "email", "inquiries",
  "enquiries", "customerservice", "service", "wholesale", "press", "media",
  "marketing", "webmaster", "noreply", "no-reply", "donotreply", "billing",
  "accounts", "accounting", "returns", "privacy", "legal", "jobs", "careers",
]);

const FREE_HOSTS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "me.com", "msn.com", "live.com", "comcast.net", "verizon.net", "att.net",
  "protonmail.com", "proton.me", "gmx.com", "mail.com", "ymail.com",
]);

/** Addresses that are never the shop — platform, CMS, and agency boilerplate. */
const JUNK_PATTERNS = [
  /@(sentry|wixpress|squarespace|shopify|godaddy|wordpress|weebly|bigcartel|example)\./i,
  /@(\d+\.){3}\d+$/,
  /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i,
  /^[a-f0-9]{16,}@/i,          // hashed/tracking mailboxes
  /@sentry\.io$/i,
];

export type EmailKind = "role" | "personal" | "freemail";

export function classifyEmail(email: string, website: string | null): {
  kind: EmailKind; domainMatch: number; junk: boolean;
} {
  const e = email.trim().toLowerCase();
  const junk = JUNK_PATTERNS.some((re) => re.test(e));
  const [local, host = ""] = e.split("@");

  const siteHost = (() => {
    if (!website) return "";
    try { return new URL(website).hostname.replace(/^www\./, "").toLowerCase(); }
    catch { return ""; }
  })();

  const domainMatch = siteHost && (host === siteHost || host.endsWith(`.${siteHost}`)) ? 1 : 0;

  const kind: EmailKind = FREE_HOSTS.has(host)
    ? "freemail"
    : ROLE_NAMES.has(local.replace(/[.\-_]/g, ""))
      ? "role"
      : "personal";

  return { kind, domainMatch, junk };
}

interface SiteRow { id: string; website: string }

/**
 * Start a crawl over a sample of the batch's eligible leads that have a site.
 * `maxRequestsPerStartUrl` is kept low on purpose: contact details live on the
 * home page or a /contact page, and a deep crawl multiplies cost for pages
 * that will not carry an address.
 */
export async function startEmailProbe(
  batch: string,
  opts: { limit?: number; minScore?: number; pagesPerSite?: number } = {},
): Promise<{ probeId: string; sites: number; error?: string }> {
  const limit = opts.limit ?? 100;
  const minScore = opts.minScore ?? 0;

  const sites = sqlite
    .prepare(
      `SELECT id, website FROM apify_test_leads
        WHERE batch = ? AND excluded = 0 AND website IS NOT NULL AND website <> ''
          AND score >= ?
        ORDER BY score DESC, review_count DESC
        LIMIT ?`,
    )
    .all(batch, minScore, limit) as SiteRow[];

  const probeId = randomUUID();
  if (sites.length === 0) {
    sqlite
      .prepare(
        `INSERT INTO apify_test_email_runs (id, batch, status, sites_requested, error)
         VALUES (?,?,'failed',0,'no eligible leads with a website')`,
      )
      .run(probeId, batch);
    return { probeId, sites: 0, error: "no eligible leads with a website" };
  }

  try {
    const { runId, datasetId } = await apifyClient.startRun(
      {
        startUrls: sites.map((s) => ({ url: s.website })),
        maxRequestsPerStartUrl: opts.pagesPerSite ?? 3,
        maxDepth: 1,
        sameDomain: true,
        mergeContacts: true,
        considerChildFrames: true,
        useBrowser: false,
        proxyConfig: { useApifyProxy: true },
      },
      ACTOR_CONTACTS,
    );
    sqlite
      .prepare(
        `INSERT INTO apify_test_email_runs (id, batch, apify_run_id, dataset_id, status, sites_requested)
         VALUES (?,?,?,?,'running',?)`,
      )
      .run(probeId, batch, runId, datasetId, sites.length);
    return { probeId, sites: sites.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sqlite
      .prepare(
        `INSERT INTO apify_test_email_runs (id, batch, status, sites_requested, error)
         VALUES (?,?,'failed',?,?)`,
      )
      .run(probeId, batch, sites.length, msg);
    return { probeId, sites: sites.length, error: msg };
  }
}

type ContactItem = {
  url?: string; domain?: string; emails?: string[];
  [k: string]: unknown;
};

/** Match a crawled page back to the lead whose website it came from. */
function hostOf(u: string | null | undefined): string {
  if (!u) return "";
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

export async function pollEmailProbe(batch: string): Promise<{ ingested: number; stillRunning: number }> {
  const runs = sqlite
    .prepare("SELECT * FROM apify_test_email_runs WHERE batch = ? AND status = 'running'")
    .all(batch) as Array<{ id: string; apify_run_id: string; dataset_id: string }>;

  let ingested = 0;
  let stillRunning = 0;

  for (const r of runs) {
    let status: string;
    try { ({ status } = await apifyClient.getRunStatus(r.apify_run_id)); }
    catch { stillRunning++; continue; }

    if (status === "READY" || status === "RUNNING") { stillRunning++; continue; }
    if (status !== "SUCCEEDED") {
      sqlite.prepare("UPDATE apify_test_email_runs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?")
        .run(status, r.id);
      continue;
    }

    let items: ContactItem[];
    try { items = (await apifyClient.getDatasetItems(r.dataset_id, 5000)) as unknown as ContactItem[]; }
    catch { stillRunning++; continue; }

    // Index the batch's leads by website host so a crawled page maps home.
    const leads = sqlite
      .prepare("SELECT id, website FROM apify_test_leads WHERE batch = ? AND website IS NOT NULL AND website <> ''")
      .all(batch) as SiteRow[];
    const byHost = new Map<string, SiteRow>();
    for (const l of leads) { const h = hostOf(l.website); if (h && !byHost.has(h)) byHost.set(h, l); }

    const insert = sqlite.prepare(
      `INSERT OR IGNORE INTO apify_test_emails (id, batch, lead_id, website, email, kind, domain_match)
       VALUES (?,?,?,?,?,?,?)`,
    );

    const sitesWithEmail = new Set<string>();
    let emails = 0;
    sqlite.transaction(() => {
      for (const it of items) {
        const lead = byHost.get(hostOf(it.url) || String(it.domain || "").toLowerCase());
        if (!lead) continue;
        for (const raw of it.emails ?? []) {
          const email = String(raw).trim().toLowerCase();
          if (!email.includes("@")) continue;
          const { kind, domainMatch, junk } = classifyEmail(email, lead.website);
          if (junk) continue;
          insert.run(randomUUID(), batch, lead.id, lead.website, email, kind, domainMatch);
          sitesWithEmail.add(lead.id);
          emails++;
        }
      }
    })();

    sqlite
      .prepare(
        `UPDATE apify_test_email_runs
            SET status='done', sites_with_email=?, emails_found=?, finished_at=datetime('now')
          WHERE id=?`,
      )
      .run(sitesWithEmail.size, emails, r.id);
    ingested++;
  }

  return { ingested, stillRunning };
}

/**
 * Verify a sample through NeverBounce. Sampled rather than exhaustive: the
 * question is what share of scraped addresses are deliverable, and a hundred
 * answers that as well as a thousand while spending a tenth of the credits.
 */
export async function verifySample(batch: string, limit = 100): Promise<{ verified: number; skipped: number }> {
  const { verifyEmail } = await import("./neverbounce/client");

  const rows = sqlite
    .prepare(
      `SELECT id, email FROM apify_test_emails
        WHERE batch = ? AND verify_result IS NULL
        ORDER BY domain_match DESC, kind = 'personal' DESC
        LIMIT ?`,
    )
    .all(batch, limit) as Array<{ id: string; email: string }>;

  let verified = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const res = await verifyEmail(row.email);
      sqlite.prepare("UPDATE apify_test_emails SET verify_result = ? WHERE id = ?").run(res.result, row.id);
      verified++;
    } catch {
      skipped++;
    }
  }
  return { verified, skipped };
}

export function emailReport(batch: string) {
  const runs = sqlite
    .prepare("SELECT * FROM apify_test_email_runs WHERE batch = ? ORDER BY created_at")
    .all(batch) as Array<Record<string, unknown>>;

  const sitesProbed = runs.reduce((a, r) => a + Number(r.sites_requested ?? 0), 0);

  const totals = sqlite
    .prepare(
      `SELECT COUNT(*) emails, COUNT(DISTINCT lead_id) sitesWithEmail,
              SUM(kind='role') role, SUM(kind='personal') personal, SUM(kind='freemail') freemail,
              SUM(domain_match) onOwnDomain
         FROM apify_test_emails WHERE batch = ?`,
    )
    .get(batch) as Record<string, number>;

  const verify = sqlite
    .prepare(
      `SELECT verify_result r, COUNT(*) n FROM apify_test_emails
        WHERE batch = ? AND verify_result IS NOT NULL GROUP BY verify_result ORDER BY n DESC`,
    )
    .all(batch) as Array<{ r: string; n: number }>;

  // Yield by search term — a term is only as good as the sendable leads it produces.
  const byTerm = sqlite
    .prepare(
      `SELECT r.term,
              COUNT(DISTINCT l.id) sites,
              COUNT(DISTINCT e.lead_id) withEmail
         FROM apify_test_leads l
         JOIN apify_test_runs r ON r.id = l.run_id
         LEFT JOIN apify_test_emails e ON e.lead_id = l.id
        WHERE l.batch = ? AND l.excluded = 0 AND l.website IS NOT NULL AND l.website <> ''
        GROUP BY r.term ORDER BY withEmail DESC`,
    )
    .all(batch) as Array<{ term: string; sites: number; withEmail: number }>;

  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

  return {
    batch,
    runs: runs.map((r) => ({
      status: r.status, sitesRequested: r.sites_requested,
      sitesWithEmail: r.sites_with_email, emailsFound: r.emails_found, error: r.error,
    })),
    sitesProbed,
    emailsFound: totals?.emails ?? 0,
    sitesWithEmail: totals?.sitesWithEmail ?? 0,
    yieldPct: pct(totals?.sitesWithEmail ?? 0, sitesProbed),
    mix: {
      role: totals?.role ?? 0,
      personal: totals?.personal ?? 0,
      freemail: totals?.freemail ?? 0,
      onOwnDomainPct: pct(totals?.onOwnDomain ?? 0, totals?.emails ?? 0),
    },
    verification: verify.length
      ? {
          counts: Object.fromEntries(verify.map((v) => [v.r, v.n])),
          sampled: verify.reduce((a, v) => a + v.n, 0),
          validPct: pct(verify.find((v) => v.r === "valid")?.n ?? 0, verify.reduce((a, v) => a + v.n, 0)),
        }
      : null,
    byTerm: byTerm.map((t) => ({ ...t, yieldPct: pct(t.withEmail, t.sites) })),
  };
}

export function exportEmails(batch: string): Array<Record<string, unknown>> {
  return sqlite
    .prepare(
      `SELECT l.title, l.city, l.state, l.phone, l.website, l.score, l.review_count,
              e.email, e.kind, e.domain_match, e.verify_result, r.term, r.location
         FROM apify_test_emails e
         JOIN apify_test_leads l ON l.id = e.lead_id
         JOIN apify_test_runs r ON r.id = l.run_id
        WHERE e.batch = ?
        ORDER BY e.verify_result = 'valid' DESC, e.domain_match DESC, l.score DESC`,
    )
    .all(batch) as Array<Record<string, unknown>>;
}
