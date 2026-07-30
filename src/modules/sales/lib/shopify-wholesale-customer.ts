/**
 * Interested lead → Shopify wholesale customer.
 *
 * When PhoneBurner dispositions a call "Set Appointment", the company
 * progresses to `interested` and the status fan-out enqueues this job. It
 * creates (or updates) the lead as a customer on the wholesale Shopify store,
 * tagged so downstream tools can segment them.
 *
 * Why Shopify is the hand-off point rather than a direct API push:
 *   - Omnisend already syncs from Shopify, so a customer landing here is
 *     enrolled in nurture automatically. That retires the frame's own Omnisend
 *     send instead of maintaining two paths that can disagree.
 *   - PostPilot pulls the same customer list for direct mail, so one record
 *     drives both channels and "stop mailing once they buy" is a single
 *     condition (they have orders) rather than a per-tool suppression list.
 *
 * Marketing consent IS set (SUBSCRIBED, single opt-in), per Daniel 2026-07-30
 * — with one hard exception: a customer who has already unsubscribed is left
 * alone. The store holds thousands of existing customers, so re-subscribing an
 * opt-out would otherwise happen silently and often.
 *
 * Idempotent: the Shopify customer id is stamped on the company, and we search
 * by email before creating so a lead already in the store is updated, never
 * duplicated.
 */

import { sqlite } from "@/lib/db";
import { getShopifyClientByChannel } from "@/modules/integrations/lib/shopify/admin-api";

/** Shopify requires these for a mailable address. */
export interface LeadAddress {
  address1: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string;
}

export interface WholesaleSyncResult {
  companyId: string;
  status: "created" | "updated" | "skipped" | "error";
  shopifyCustomerId?: string | null;
  tags?: string[];
  addressComplete?: boolean;
  missingAddress?: boolean;
  /** They already have orders — postpilot-mail is withheld. */
  alreadyOrdered?: boolean;
  /** They had opted out; we left their consent alone. */
  keptExistingUnsubscribe?: boolean;
  reason?: string;
}

export interface CompanyRow {
  id: string;
  name: string | null;
  status: string;
  source: string | null;
  tags: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  website: string | null;
  icp_tier: string | null;
  shopify_customer_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  owner_name: string | null;
  /** 1 when a PhoneBurner call on this company was dispositioned Set Appointment. */
  had_appointment: number;
  instagram_url: string | null;
  icp_reasoning: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  pipedrive_org_id: number | null;
  pipedrive_person_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  city_state: string | null;
}

/**
 * The column list every consumer needs. Shared as a constant because the admin
 * preview previously repeated it by hand and silently drifted from the real
 * sync — a preview that doesn't match what gets written is worse than none.
 */
export const COMPANY_SELECT = `
  SELECT c.id, c.name, c.status, c.source, c.tags, c.address, c.city, c.state, c.zip,
         c.country, c.website, c.icp_tier, c.shopify_customer_id,
         c.instagram_url, c.icp_reasoning, c.google_rating, c.google_review_count,
         c.pipedrive_org_id, c.pipedrive_person_id, c.created_at, c.updated_at,
         TRIM(COALESCE(c.city,'') || CASE WHEN COALESCE(c.state,'') <> '' THEN ', ' || c.state ELSE '' END) AS city_state,
         (SELECT ct.first_name FROM contacts ct WHERE ct.company_id = c.id
           ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS first_name,
         (SELECT ct.last_name FROM contacts ct WHERE ct.company_id = c.id
           ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS last_name,
         (SELECT ct.email FROM contacts ct WHERE ct.company_id = c.id
           AND TRIM(COALESCE(ct.email,'')) <> ''
           AND LOWER(ct.email) NOT LIKE '%@relay.faire.com%'
           ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS email,
         (SELECT cp.phone FROM company_phones cp WHERE cp.company_id = c.id
           ORDER BY cp.is_primary DESC, cp.created_at ASC LIMIT 1) AS phone,
         (SELECT u.name FROM users u WHERE u.id = c.owner_id) AS owner_name,
         (SELECT COUNT(*) FROM phoneburner_call_log pb
           WHERE pb.company_id = c.id
             AND REPLACE(LOWER(COALESCE(pb.disposition_label,'')), '.', '') LIKE 'set app%') AS had_appointment
    FROM companies c`;

function loadCompany(companyId: string): CompanyRow | undefined {
  return sqlite.prepare(`${COMPANY_SELECT} WHERE c.id = ?`).get(companyId) as CompanyRow | undefined;
}

/**
 * The closed set of source tags. Deliberately fixed rather than derived from
 * companies.source, which holds import filenames — slugifying it produced
 * segment names like "source-storeleads-csv-updated-boqtuies-csv", typo and
 * all. A Shopify segment built on a filename is worse than useless: it looks
 * meaningful and silently rots when the next import is named differently.
 */
export type SourceTag =
  | "source-cold-call"
  | "source-email"
  | "source-facebook-ads"
  | "source-faire"
  | "source-ajm"
  | "source-imported-list"
  | "source-other";

export function sourceTagFor(c: Pick<CompanyRow, "source" | "tags">): SourceTag {
  const src = (c.source || "").toLowerCase();
  let existing: string[] = [];
  try {
    existing = c.tags ? (JSON.parse(c.tags) as string[]).map((t) => String(t).toLowerCase()) : [];
  } catch { /* tags column may be legacy CSV */ }
  const has = (s: string) => src.includes(s) || existing.some((t) => t.includes(s));

  if (has("phoneburner") || has("cold")) return "source-cold-call";
  if (has("instantly")) return "source-email";
  if (has("facebook") || has("meta")) return "source-facebook-ads";
  if (has("faire")) return "source-faire";
  if (has("ajm")) return "source-ajm";
  // Bought/scraped lists — storeleads exports, CSV drops, eyewear crawls.
  if (has("storeleads") || has("csv") || has("import") || has("crawl") || has("boutique")) {
    return "source-imported-list";
  }
  return "source-other";
}

/**
 * Tags Shopify segments on. Kept lowercase and hyphenated because Shopify tag
 * matching is literal — "Cold Call" and "cold-call" are two different segments,
 * and a stray casing difference silently splits an audience in half.
 */
export function buildTags(c: CompanyRow): string[] {
  const tags = new Set<string>(["the-frame", "wholesale-lead"]);

  // Only leads a rep actually booked. Applying this to the whole interested
  // backlog — which arrives via email replies, ad forms and list imports —
  // would make any segment built on it a lie.
  if (c.had_appointment > 0) tags.add("appointment-set");

  tags.add(sourceTagFor(c));

  if (c.icp_tier) tags.add(`icp-${c.icp_tier.toLowerCase()}`);
  if (c.owner_name) tags.add(`rep-${c.owner_name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "")}`);

  // Month cohort, so a campaign can target "everyone who got interested in
  // July" without needing a date filter Shopify segments handle badly.
  tags.add(`interested-${new Date().toISOString().slice(0, 7)}`);

  // The direct-mail flag PostPilot pulls on. Removed once they order — see
  // suppressBuyersFromMail() below.
  tags.add("postpilot-mail");

  return [...tags];
}


/** One line of call history for the note. */
interface CallSummary {
  called_at: string | null;
  disposition_label: string | null;
  agent_email: string | null;
  duration_seconds: number | null;
  connected: number | null;
  notes: string | null;
}

/**
 * Build the customer note: everything a rep opening this record in Shopify
 * would otherwise have to go to three other systems to find.
 *
 * Shopify notes are plain text (no markup), so structure comes from labels and
 * line breaks. Deep links matter more than prose — the point is that whoever
 * picks this customer up can get back to the full history in one click rather
 * than searching for them by name.
 */
export function buildNote(c: CompanyRow): string {
  const base = (process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  const pdDomain = pipedriveDomain();
  const lines: string[] = [];

  lines.push("── Jaxy lead record (synced from The Frame) ──");
  if (c.name) lines.push(`Store: ${c.name}`);
  if (c.city_state) lines.push(`Location: ${c.city_state}`);
  lines.push(`Pipeline status: ${c.status}`);
  if (c.owner_name) lines.push(`Rep: ${c.owner_name}`);
  if (c.created_at) lines.push(`First added: ${c.created_at.slice(0, 10)}`);

  // How they got here, in the terms a human would use.
  const src = sourceTagFor(c).replace("source-", "").replace(/-/g, " ");
  lines.push(`Lead source: ${src}${c.source ? ` (${c.source})` : ""}`);
  if (c.had_appointment > 0) lines.push("Appointment set by phone — they asked to see the catalog.");

  if (c.icp_tier) {
    lines.push("");
    lines.push(`ICP tier: ${c.icp_tier}`);
    if (c.icp_reasoning) lines.push(`Why: ${c.icp_reasoning.slice(0, 400)}`);
  }

  if (c.google_rating != null || c.website || c.instagram_url) {
    lines.push("");
    if (c.website) lines.push(`Website: ${c.website}`);
    if (c.instagram_url) lines.push(`Instagram: ${c.instagram_url}`);
    if (c.google_rating != null) {
      lines.push(`Google: ${c.google_rating}★${c.google_review_count ? ` (${c.google_review_count} reviews)` : ""}`);
    }
  }

  // Call history — the single most useful thing when someone replies to a
  // campaign and a rep needs to know what was already said.
  const calls = sqlite
    .prepare(
      `SELECT called_at, disposition_label, agent_email, duration_seconds, connected, notes
         FROM phoneburner_call_log WHERE company_id = ?
        ORDER BY called_at DESC LIMIT 5`,
    )
    .all(c.id) as CallSummary[];
  const totalCalls = (sqlite
    .prepare("SELECT COUNT(*) n FROM phoneburner_call_log WHERE company_id = ?")
    .get(c.id) as { n: number }).n;

  if (calls.length) {
    lines.push("");
    lines.push(`Call history (${totalCalls} total, latest ${calls.length}):`);
    for (const call of calls) {
      const when = call.called_at ? call.called_at.slice(0, 10) : "?";
      const mins = call.duration_seconds ? ` ${Math.round(call.duration_seconds / 60)}m` : "";
      const who = call.agent_email ? ` by ${call.agent_email.split("@")[0]}` : "";
      lines.push(`  • ${when} — ${call.disposition_label || "no disposition"}${call.connected ? " (connected)" : ""}${mins}${who}`);
      if (call.notes) lines.push(`      "${call.notes.replace(/\s+/g, " ").slice(0, 200)}"`);
    }
  }

  // Recent non-call touches (email sends, replies, form fills).
  const events = sqlite
    .prepare(
      `SELECT event_type, created_at FROM activity_feed
        WHERE entity_type = 'company' AND entity_id = ?
        ORDER BY created_at DESC LIMIT 5`,
    )
    .all(c.id) as Array<{ event_type: string; created_at: string | null }>;
  if (events.length) {
    lines.push("");
    lines.push("Recent activity:");
    for (const e of events) {
      lines.push(`  • ${(e.created_at || "").slice(0, 10)} — ${e.event_type.replace(/[._]/g, " ")}`);
    }
  }

  lines.push("");
  lines.push("Links:");
  if (base) lines.push(`  The Frame: ${base}/prospects/${c.id}`);
  if (pdDomain && c.pipedrive_org_id) lines.push(`  Pipedrive org: ${pdDomain}/organization/${c.pipedrive_org_id}`);
  if (pdDomain && c.pipedrive_person_id) lines.push(`  Pipedrive person: ${pdDomain}/person/${c.pipedrive_person_id}`);
  lines.push(`  Synced: ${new Date().toISOString().slice(0, 10)}`);

  return lines.join("\n");
}

/** Pipedrive base URL from the stored OAuth api_domain, for deep links. */
function pipedriveDomain(): string | null {
  try {
    const r = sqlite.prepare("SELECT value FROM settings WHERE key = 'pipedrive_api_domain'").get() as { value: string } | undefined;
    return r?.value ? r.value.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

export function buildAddress(c: CompanyRow): LeadAddress {
  return {
    address1: (c.address || "").trim() || null,
    city: (c.city || "").trim() || null,
    province: (c.state || "").trim() || null,
    zip: (c.zip || "").trim() || null,
    country: (c.country || "US").trim() || "US",
  };
}

/**
 * US state / territory name → USPS code.
 *
 * Shopify validates province against its own list and rejects a free-text
 * value, which is what "Province is invalid" was: companies.state holds
 * whatever enrichment wrote, including full names and, on a couple of Puerto
 * Rico rows, a city name in the state field.
 */
const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR",
  "virgin islands": "VI", guam: "GU", "american samoa": "AS",
};

/** Two-letter province code, or null when the value isn't a US state at all. */
export function provinceCodeFor(raw: string | null): string | null {
  const v = (raw || "").trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v) && Object.values(STATE_CODES).includes(v.toUpperCase())) {
    return v.toUpperCase();
  }
  return STATE_CODES[v.toLowerCase()] ?? null;
}

/** Mailable = a street line with a number, plus city, state and zip. */
export function isAddressComplete(a: LeadAddress): boolean {
  return !!(a.address1 && /\d/.test(a.address1) && a.city && a.province && a.zip);
}

interface GqlCustomer {
  id: string;
  email: string | null;
  tags: string[];
  numberOfOrders?: string;
  emailMarketingConsent?: { marketingState: string; marketingOptInLevel: string | null } | null;
}

/** Find an existing customer by email so a re-run updates rather than duplicates. */
async function findByEmail(
  client: Awaited<ReturnType<typeof getShopifyClientByChannel>>,
  email: string,
): Promise<GqlCustomer | null> {
  const data = await client.graphql<{ customers: { edges: Array<{ node: GqlCustomer }> } }>(
    `query FindCustomer($q: String!) {
       customers(first: 1, query: $q) {
         edges { node {
           id email tags numberOfOrders
           emailMarketingConsent { marketingState marketingOptInLevel }
         } }
       }
     }`,
    // Quote the email: an address with a "+" or "-" is otherwise parsed as
    // search syntax and silently matches the wrong customer (or none).
    { q: `email:"${email.replace(/"/g, '\\"')}"` },
  );
  return data.customers.edges[0]?.node ?? null;
}

/**
 * Create or update the wholesale customer.
 *
 * Never throws out of the job path — a Shopify outage marks the result as an
 * error for retry rather than losing the lead.
 */
export async function syncInterestedLeadToShopify(
  companyId: string,
  opts: { force?: boolean } = {},
): Promise<WholesaleSyncResult> {
  const c = loadCompany(companyId);
  if (!c) return { companyId, status: "skipped", reason: "company not found" };

  // Only interested-or-better leads belong in the nurture list. A company that
  // has since gone not_interested must not be re-added by a late job.
  const eligible = ["interested", "catalog_sent", "customer"];
  if (!opts.force && !eligible.includes(c.status)) {
    return { companyId, status: "skipped", reason: `status is "${c.status}"` };
  }
  if (!c.email) {
    return { companyId, status: "skipped", reason: "no email on file — Shopify requires one" };
  }

  const tags = buildTags(c);
  const address = buildAddress(c);
  const complete = isAddressComplete(address);

  try {
    const client = await getShopifyClientByChannel("wholesale");

    // Reuse the stamped id, else look the customer up by email. The store has
    // thousands of existing customers, so a lead is quite likely already there.
    let customerId = c.shopify_customer_id;
    let existing: GqlCustomer | null = null;
    if (!customerId) {
      existing = await findByEmail(client, c.email);
      if (existing) customerId = existing.id;
    } else {
      existing = await findByEmail(client, c.email);
    }

    const alreadyOrdered = Number(existing?.numberOfOrders ?? "0") > 0;
    let finalTags = tags;
    if (alreadyOrdered) {
      // They've bought. Direct mail is supposed to stop at exactly that point,
      // so don't hand PostPilot a fresh reason to mail them.
      finalTags = finalTags.filter((t) => t !== "postpilot-mail");
    }
    if (existing?.tags?.length) {
      // CustomerInput.tags REPLACES the whole list. On a store with existing
      // customers that would silently wipe tags set by Omnisend, PostPilot or a
      // human — merge instead.
      finalTags = [...new Set([...existing.tags, ...finalTags])];
    }

    const input: Record<string, unknown> = {
      email: c.email,
      firstName: c.first_name || undefined,
      lastName: c.last_name || undefined,
      phone: c.phone || undefined,
      note: buildNote(c),
      tags: finalTags,
    };

    // Only send an address when it's actually mailable. A half-filled address
    // in Shopify looks complete to PostPilot and produces a wasted mailing.
    if (complete) {
      // Shopify wants ISO codes, not free text. Passing country: "US" and
      // province: "Florida" is what produced "Country is invalid" and
      // "Province is invalid" — it validates both against its own lists.
      const provinceCode = provinceCodeFor(address.province);
      input.addresses = [{
        address1: address.address1,
        city: address.city,
        zip: address.zip,
        countryCode: "US",
        // Omit rather than send something Shopify will reject: an address with
        // city + zip still delivers, an errored customer doesn't exist at all.
        ...(provinceCode ? { provinceCode } : {}),
        company: c.name || undefined,
        firstName: c.first_name || undefined,
        lastName: c.last_name || undefined,
      }];
    }

    // Subscribe to email marketing, per Daniel 2026-07-30 — but never overwrite
    // someone who already opted OUT. Re-subscribing an unsubscribe is the one
    // move here that turns a marketing decision into a legal problem, and on a
    // store with 6k existing customers it would happen silently.
    const previouslyUnsubscribed = existing?.emailMarketingConsent?.marketingState === "UNSUBSCRIBED";

    // Shopify accepts emailMarketingConsent inside customerCreate but REJECTS
    // it on customerUpdate ("please use the customerEmailMarketingConsentUpdate
    // Mutation instead"). So it goes inline on create and as a second call on
    // update — otherwise every existing customer errors out.
    const consent = {
      marketingState: "SUBSCRIBED",
      // Honest level: nobody double-opted in. Overstating it in Shopify's
      // consent record is what turns a deliverability question into a
      // compliance one.
      marketingOptInLevel: "SINGLE_OPT_IN",
      consentUpdatedAt: new Date().toISOString(),
    };
    if (!previouslyUnsubscribed && !customerId) {
      input.emailMarketingConsent = consent;
    }

    /**
     * Shopify enforces a unique phone across customers. Ours come from
     * enrichment, so a shared storefront number legitimately appears on several
     * leads — losing the whole customer over a duplicate phone would be absurd,
     * so we drop the phone and retry once.
     */
    const isPhoneClash = (msg: string) => /phone has already been taken/i.test(msg);

    let resultId: string | null = null;
    if (customerId) {
      const data = await client.graphql<{ customerUpdate: { customer: GqlCustomer | null; userErrors: Array<{ field: string[]; message: string }> } }>(
        `mutation UpdateCustomer($input: CustomerInput!) {
           customerUpdate(input: $input) {
             customer { id email tags }
             userErrors { field message }
           }
         }`,
        { input: { ...input, id: customerId } },
      );
      let errs = data.customerUpdate.userErrors;
      if (errs?.length && errs.every((e) => isPhoneClash(e.message))) {
        const retry = await client.graphql<{ customerUpdate: { customer: GqlCustomer | null; userErrors: Array<{ field: string[]; message: string }> } }>(
          `mutation UpdateCustomer($input: CustomerInput!) {
             customerUpdate(input: $input) { customer { id email tags } userErrors { field message } }
           }`,
          { input: { ...input, phone: undefined, id: customerId } },
        );
        errs = retry.customerUpdate.userErrors;
        if (!errs?.length) resultId = retry.customerUpdate.customer?.id ?? customerId;
      }
      if (errs?.length) {
        return { companyId, status: "error", reason: errs.map((e) => e.message).join("; ") };
      }
      resultId = resultId ?? data.customerUpdate.customer?.id ?? customerId;

      // Consent as its own call on the update path.
      if (!previouslyUnsubscribed && resultId) {
        try {
          const cs = await client.graphql<{ customerEmailMarketingConsentUpdate: { userErrors: Array<{ message: string }> } }>(
            `mutation Consent($input: CustomerEmailMarketingConsentUpdateInput!) {
               customerEmailMarketingConsentUpdate(input: $input) {
                 userErrors { message }
               }
             }`,
            { input: { customerId: resultId, emailMarketingConsent: consent } },
          );
          const cErrs = cs.customerEmailMarketingConsentUpdate.userErrors;
          if (cErrs?.length) {
            console.warn("[shopify-wholesale] consent update:", cErrs.map((e) => e.message).join("; "));
          }
        } catch (e) {
          // The customer record itself is written and correct; a consent
          // failure shouldn't discard that work and force a full retry.
          console.warn("[shopify-wholesale] consent update failed (non-fatal):", e instanceof Error ? e.message : e);
        }
      }
    } else {
      const data = await client.graphql<{ customerCreate: { customer: GqlCustomer | null; userErrors: Array<{ field: string[]; message: string }> } }>(
        `mutation CreateCustomer($input: CustomerInput!) {
           customerCreate(input: $input) {
             customer { id email tags }
             userErrors { field message }
           }
         }`,
        { input },
      );
      let errs = data.customerCreate.userErrors;
      if (errs?.length && errs.every((e) => isPhoneClash(e.message))) {
        const retry = await client.graphql<{ customerCreate: { customer: GqlCustomer | null; userErrors: Array<{ field: string[]; message: string }> } }>(
          `mutation CreateCustomer($input: CustomerInput!) {
             customerCreate(input: $input) { customer { id email tags } userErrors { field message } }
           }`,
          { input: { ...input, phone: undefined } },
        );
        errs = retry.customerCreate.userErrors;
        if (!errs?.length) resultId = retry.customerCreate.customer?.id ?? null;
      }
      if (errs?.length) {
        return { companyId, status: "error", reason: errs.map((e) => e.message).join("; ") };
      }
      resultId = resultId ?? data.customerCreate.customer?.id ?? null;
    }

    if (resultId) {
      sqlite
        .prepare("UPDATE companies SET shopify_customer_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(resultId, companyId);
    }

    // Ask for the address only when we couldn't supply one — a lead sitting in
    // the mail list with nowhere to mail to is invisible otherwise.
    if (!complete) {
      await alertMissingAddress(c, address, resultId);
    }

    return {
      companyId,
      status: customerId ? "updated" : "created",
      shopifyCustomerId: resultId,
      tags: finalTags,
      addressComplete: complete,
      missingAddress: !complete,
      alreadyOrdered,
      keptExistingUnsubscribe: previouslyUnsubscribed,
    };
  } catch (e) {
    return { companyId, status: "error", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function alertMissingAddress(c: CompanyRow, a: LeadAddress, shopifyId: string | null): Promise<void> {
  try {
    const { notifyWholesaleAddressNeeded } = await import("@/modules/integrations/lib/slack/notifications");
    const base = (process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
    const missing = [
      !a.address1 || !/\d/.test(a.address1 || "") ? "street" : "",
      !a.city ? "city" : "",
      !a.province ? "state" : "",
      !a.zip ? "zip" : "",
    ].filter(Boolean);
    await notifyWholesaleAddressNeeded({
      companyName: c.name,
      contactName: [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
      email: c.email,
      phone: c.phone,
      website: c.website,
      missing,
      have: [a.address1, a.city, a.province, a.zip].filter(Boolean).join(", ") || null,
      frameUrl: base ? `${base}/prospects/${c.id}` : null,
      shopifyCustomerId: shopifyId,
    });
  } catch (e) {
    console.warn("[shopify-wholesale] address alert failed (non-fatal):", e instanceof Error ? e.message : e);
  }
}

/**
 * Drop the direct-mail tag once a lead has actually bought.
 *
 * "Mail them until they buy" only works if something stops the mail. PostPilot
 * segments on the tag, so removing it is the off switch. Runs as a cron sweep
 * because an order can arrive through any channel, not just this store.
 */
export async function suppressBuyersFromMail(limit = 100): Promise<{ checked: number; suppressed: number; errors: string[] }> {
  const errors: string[] = [];
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.shopify_customer_id, c.name
         FROM companies c
        WHERE c.shopify_customer_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM orders o WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','returned'))
        ORDER BY c.updated_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; shopify_customer_id: string; name: string | null }>;

  if (rows.length === 0) return { checked: 0, suppressed: 0, errors };

  let suppressed = 0;
  try {
    const client = await getShopifyClientByChannel("wholesale");
    for (const r of rows) {
      try {
        const data = await client.graphql<{ tagsRemove: { userErrors: Array<{ message: string }> } }>(
          `mutation RemoveTag($id: ID!, $tags: [String!]!) {
             tagsRemove(id: $id, tags: $tags) { userErrors { message } }
           }`,
          { id: r.shopify_customer_id, tags: ["postpilot-mail"] },
        );
        if (data.tagsRemove.userErrors?.length) {
          errors.push(`${r.name ?? r.id}: ${data.tagsRemove.userErrors.map((e) => e.message).join("; ")}`);
        } else {
          suppressed++;
        }
      } catch (e) {
        errors.push(`${r.name ?? r.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  return { checked: rows.length, suppressed, errors };
}
