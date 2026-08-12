/**
 * Awin partner application triage.
 *
 * Awin's *documented* API (api.awin.com) cannot approve or reject publisher
 * applications — there is no endpoint, and the `relationship` filter on
 * GET /advertisers/{id}/publishers is silently ignored. The Awin webapp does it
 * through an internal, undocumented API on ui.awin.com that is authenticated by
 * a browser session JWT, not by the public API token.
 *
 * So this script is deliberately human-in-the-loop:
 *
 *   1. You paste a session JWT (see "Getting a JWT" below).
 *   2. `list` pulls every pending application, scores it, and writes a plan file
 *      containing a proposed decision + reasons for each applicant.
 *   3. You read/edit the plan.
 *   4. `apply --confirm` executes exactly what the plan says. Nothing else.
 *
 * `list` is read-only. Only `apply --confirm` ever writes to Awin.
 *
 * Getting a JWT:
 *   Log in to Awin, open DevTools → Network, click Partnerships → Pending.
 *   Find a request to ui.awin.com/backend/... and copy its Authorization header
 *   value (the part after "Bearer "). Then:
 *     export AWIN_SESSION_JWT='eyJ...'
 *   It is short-lived — expect to re-grab it each session.
 *
 * Caveats worth knowing: the ui.awin.com API is undocumented and unsupported,
 * so Awin can change it without notice and this script will break. Accepting an
 * applicant here uses the program's default commission group — if you need the
 * coupon rate applied, set it in the UI after accepting.
 *
 * Usage:
 *   node scripts/awin-partner-triage.mjs list                  # score + write plan
 *   node scripts/awin-partner-triage.mjs list --enrich         # + fetch profile descriptions
 *   node scripts/awin-partner-triage.mjs list --raw            # dump raw API JSON
 *   node scripts/awin-partner-triage.mjs apply --confirm       # execute the plan
 *   node scripts/awin-partner-triage.mjs apply --confirm --only-rejects
 *   node scripts/awin-partner-triage.mjs end --confirm    # suspend LIVE partners
 *
 * Flags: --advertiser <id>  --plan <path>  --enrich  --verbose
 *
 * --enrich re-scores the undecided rows against their profile description,
 * which the pending list does not carry. Costs one call per undecided row.
 */

/** Overridable only so the flow can be exercised against a local mock in tests. */
const UI = process.env.AWIN_UI_BASE ?? "https://ui.awin.com/backend";
const DEFAULT_ADVERTISER = process.env.AWIN_ADVERTISER_ID ?? "59135";
const DEFAULT_PLAN = "awin-triage-plan.json";

/** Awin's fixed decline-reason vocabulary (from the webapp bundle). */
const DECLINE_REASONS = new Set([
  "profileIncomplete",
  "noUrlGiven",
  "deadUrl",
  "siteNotLive",
  "urlIrrelevant",
  "doesNotCompliment",
  "lacksDescription",
  "doesntWorkType",
  "pornContent",
  "otherSpecify",
]);

// ---------------------------------------------------------------- scoring ---

/**
 * Awin's promotional-type taxonomy, keyed by the numeric id the pending-list
 * endpoint returns. There is no readable lookup endpoint for advertisers
 * (/backend/api/v0/promotional-types returns 403), so this map was resolved by
 * calling the per-publisher promotion endpoint once per distinct id. Ids are
 * network-wide constants; unknown ones degrade to "type <id>".
 */
const PROMO_TYPES = {
  5: "Direct Linking", 6: "Linking via Landing Pages", 7: "Social Search",
  8: "Mobile Search", 10: "Ad Networks", 11: "Media Brokers", 12: "Sub Networks",
  13: "Direct Traffic", 14: "Social Traffic", 15: "Mobile Traffic",
  16: "Retargeting (Display)", 17: "Contextual Targeting", 18: "Comparison Engine",
  19: "Shopping Directory", 20: "Editorial Content", 21: "Social Content",
  22: "Media Content", 23: "Communities & UGC", 24: "Cashback", 25: "Loyalty",
  26: "Discount Code", 27: "Lead Generation (Content)", 29: "Newsletters",
  30: "Lead Generation (Email)", 31: "Retargeting (Email)",
  33: "Comparison Shopping Service (CSS)",
};

/** Promotion types that are the whole reason this script exists. */
const COUPON_TYPES = [
  "discount code",
  "voucher",
  "voucher code",
  "cashback",
  "loyalty",
  "coupon",
];

/**
 * Traffic-arbitrage types. Not coupon farms, but they resell or rebroker traffic
 * rather than bringing an audience of their own — worth a human look on a
 * program this size rather than a silent accept.
 */
const ARBITRAGE_TYPES = [
  "sub networks",
  "ad networks",
  "media brokers",
  "retargeting",
  "direct traffic",
  "mobile traffic",
  "social traffic",
];

/**
 * Name/domain tokens that give away a coupon farm, including the non-English
 * ones — a Spanish coupon site (codigosdescuentospromocionales.es) sailed
 * through an English-only version of this list.
 */
const COUPON_TOKENS = new RegExp(
  [
    // sav(e|ing) as a stem: "savings" alone missed saveonbest, savingheist,
    // savingpantry, savemypenny, savingupscale, savingarena, smartssaving
    "sav(e|ing)", "coupon", "copon", "promo", "code[sz]", "voucher", "discount",
    "deals?", "bargain", "cashback", "clearance", "freebie", "steal", "slash",
    // es / pt / it
    "descuento", "cupon", "cupom", "promocion", "codigos", "sconto", "buono",
    // de / nl / nordics
    "gutschein", "rabat", "korting", "tilbud",
    // pl / cz / sk
    "kupon", "kupny", "slevy", "zlavy", "rabatowe",
  ].join("|"),
  "i",
);

/** Free/parked hosts — a "publisher" with no real site of their own. */
const WEAK_HOSTS =
  /(blogspot\.|wordpress\.com|wixsite\.|weebly\.|medium\.com|sites\.google\.com|linktr\.ee|bit\.ly)/i;

const SOCIAL_HOSTS =
  /(instagram\.com|tiktok\.com|facebook\.com|twitter\.com|x\.com|youtube\.com|pinterest\.)/i;

/**
 * Domains that belong to somebody else. An applicant entering one as their own
 * website is padding a thin application — 11 separate applicants listed
 * shareasale.com, a competitor network's homepage. Ownership is checked by name
 * overlap, so Skimlinks listing skimlinks.com is not caught by this.
 */
const THIRD_PARTY_DOMAINS = new Set([
  "shareasale.com", "awin.com", "cj.com", "rakuten.com", "impact.com",
  "apps.apple.com", "play.google.com", "amazon.com", "ebay.com",
  "apartmenttherapy.com", "southernliving.com", "thespruceeats.com",
  "famousbirthdays.com", "eventbrite.co.uk", "msn.com", "ad4mat.com",
]);

/**
 * Sub-networks we do want, despite their category scoring as traffic arbitrage.
 * These bring genuine editorial inventory rather than intercepting carts.
 */
const TRUSTED_NETWORKS = new Set(["skimlinks.com", "sovrn.com"]);

/**
 * Business-model language in a profile description.
 *
 * Deliberately phrases rather than single words: a sock blog may well mention
 * "deals", but only a coupon business describes itself as running a discount
 * code site or a browser extension. Matched against the description only, never
 * the company name, so it cannot fire on a brand that merely sounds salesy.
 */
const BUSINESS_MODEL_TOKENS =
  /(coupon|voucher|promo(tional)? code|discount code|cash ?back|rebate|deal site|deals? platform|savings platform|browser extension|shopping assistant|price comparison)/i;

/**
 * Coupon, cashback and rewards operators identified by brand rather than by
 * wording, because the wording rules cannot see them.
 *
 * Both DontPayFull and Coupert filed two applications each: an honest one
 * declaring "Discount Code", and a second declaring a content type from a
 * domain containing no coupon token ("coupert" is not "coupon";
 * "dontpayfull" is nothing at all). The honest one was rejected and the
 * disguised one was accepted. Matching the registrable domain regardless of
 * declared type or subdomain closes that, and catches
 * extension.dontpayfull.com — a cart-injection browser extension — too.
 */
const COUPON_BRAND_DOMAINS = new Set([
  "dontpayfull.com", "coupert.com", "honey.com", "joinhoney.com",
  "fatcoupon.com", "simplycodes.com", "demand.io", "evreward.com",
  "refermate.com", "rewardsbunny.com", "maxrebates.com", "joko.com",
  "fanli.com", "55haitao.com", "trashie.io", "usebutton.com", "ibotta.com",
  "retailmenot.com", "slickdeals.net", "dealspotr.com", "groupon.com",
  "topcashback.com", "quidco.com", "shopback.com", "letyshops.com",
  "wildfire-corp.com", "cbqueen.com", "shoptastic.io", "mimoni.com",
  "salepops.com", "minty.com", "search.com", "pricecheckhq.com",
]);

/** Bare host, lowercased, no scheme/www/path. */
function hostOf(url) {
  return String(url ?? "").replace(/^https?:\/\/(www\.)?/i, "").split("/")[0].toLowerCase();
}

/**
 * Registrable domain, so a subdomain cannot be used to slip past a domain
 * check — extension.dontpayfull.com must resolve to dontpayfull.com. Handles
 * the common two-part public suffixes rather than shipping a full PSL.
 */
function registrableDomain(host) {
  const parts = String(host).split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const twoPartSuffix = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
  const lastTwo = parts.slice(-2).join(".");
  return twoPartSuffix.test(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/** Does the company name plausibly own this domain? Used to separate a brand */
/** using its own site from an applicant borrowing someone else's. */
function nameMatchesDomain(name, host) {
  const domainWord = host.split(".")[0].replace(/[^a-z0-9]/g, "");
  const nameWords = String(name).toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return nameWords.some((w) => domainWord.includes(w) || w.includes(domainWord));
}

/**
 * A social-only applicant is fine — plenty of real creators have no site — but
 * these patterns marked a farm of batch-registered fakes: handles that share no
 * words with the applicant's name, random digit strings, and generic
 * aggregator handles.
 */
function socialLooksFake(name, url) {
  const handle = (url.match(/(?:instagram|tiktok|youtube|facebook)\.com\/@?([\w.\-]+)/i) ?? [])[1];
  if (!handle) return null;
  if (/\d{4,}/.test(handle)) return { hard: true, why: "random digit string in handle" };
  if (/^(big|best|top|hot|cheap)?(buy|deal|shop|store|sav|offer)s?\d*$/i.test(handle) ||
      /^official[_.]?\w*(hub|store|shop|deals?)$/i.test(handle)) {
    return { hard: true, why: "generic aggregator handle" };
  }
  const nameWords = new Set(String(name).toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const handleWords = new Set(handle.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const overlap = [...nameWords].some((w) => handleWords.has(w) || handle.toLowerCase().includes(w));
  return overlap ? null : { hard: false, why: "applicant name shares nothing with the handle" };
}

/**
 * Score one applicant. Returns points plus the human-readable reasons behind
 * them, so every decision in the plan can be audited before it is applied.
 *
 * Higher score = more likely a low-quality coupon site.
 */
function score(app) {
  const reasons = [];
  let points = 0;
  const add = (n, why) => {
    points += n;
    reasons.push(`${n > 0 ? "+" : ""}${n} ${why}`);
  };

  const type = (app.promotionalType ?? "").toLowerCase();
  const name = app.companyName ?? "";
  const url = app.websiteUrl ?? "";
  const host = hostOf(url);

  const domain = registrableDomain(host);

  // A trusted sub-network short-circuits everything below it.
  if (TRUSTED_NETWORKS.has(domain) && nameMatchesDomain(name, host)) {
    reasons.push("trusted content sub-network");
    return { points: 0, reasons };
  }

  // Known coupon/cashback brand, whatever it declared itself as.
  if (COUPON_BRAND_DOMAINS.has(domain)) {
    add(6, `${domain} is a known coupon/cashback operator`);
  }

  // Promotion type. Coupon/cashback/loyalty and traffic arbitrage are both
  // rejections in their own right, not soft flags.
  const socialOnly = SOCIAL_HOSTS.test(url);
  if (!type) {
    if (!socialOnly) add(3, "no primary promotion type declared (incomplete profile)");
  } else if (COUPON_TYPES.some((t) => type.includes(t))) {
    add(6, `promotion type is "${app.promotionalType}"`);
  } else if (ARBITRAGE_TYPES.some((t) => type.includes(t))) {
    add(6, `promotion type is "${app.promotionalType}" (resells traffic)`);
  }

  // Coupon wording in the domain overrides whatever type was declared —
  // couponowner.com and idealcoupons.com both filed as "Editorial Content".
  if (COUPON_TOKENS.test(name)) add(3, "coupon/deal wording in company name");
  if (host && COUPON_TOKENS.test(host)) add(6, "coupon/deal wording in domain");

  // Check both forms: the set holds registrable domains like shareasale.com and
  // full hosts like apps.apple.com, whose registrable domain (apple.com) would
  // otherwise miss.
  const borrowed = THIRD_PARTY_DOMAINS.has(domain) || THIRD_PARTY_DOMAINS.has(host);
  if (borrowed && !nameMatchesDomain(name, host)) {
    add(6, `claims ${host}, a domain it does not own`);
  }
  // Consonant soup like bnccjiykdufcng.com — nobody's real brand.
  const label = host.split(".")[0];
  if (label.length >= 10 && !/[aeiou]{1}[a-z]*[aeiou]/.test(label)) {
    add(6, "random-string domain");
  }

  if (!url) {
    add(6, "no website URL on the application");
  } else if (SOCIAL_HOSTS.test(url)) {
    const fake = socialLooksFake(name, url);
    if (fake) add(fake.hard ? 6 : 3, `social profile only — ${fake.why}`);
    else add(0, "social profile only, but coherent personal brand");
  } else if (WEAK_HOSTS.test(url)) {
    add(2, "free/parked host, no owned domain");
  }

  // Only present when --enrich has fetched the applicant's profile. The pending
  // list itself carries no description, which is why so many applicants with no
  // declared promotion type could not be scored either way.
  if (app.description != null) {
    const desc = app.description.trim();
    if (!desc) {
      add(2, "profile has no description at all");
    } else if (BUSINESS_MODEL_TOKENS.test(desc)) {
      const hit = desc.match(BUSINESS_MODEL_TOKENS)[0];
      add(6, `describes itself as a coupon/cashback business ("${hit}")`);
    }
  }

  if (points === 0 && reasons.length === 0) reasons.push("no flags raised");
  return { points, reasons };
}

/**
 * Turn a score into a proposed decision + the decline reason Awin expects.
 *
 * Deliberately conservative: nothing is auto-accepted on a high score, and
 * anything ambiguous lands in `review` so a human looks at it.
 */
function decide(app, { points, reasons }) {
  if (!app.websiteUrl) {
    return { decision: "reject", declineReason: "noUrlGiven", points, reasons };
  }
  if (points >= 6) {
    // Pick the decline reason from whichever rule actually fired, so the
    // publisher gets an accurate one rather than a catch-all.
    const fired = reasons.join(" ");
    const reason = /does not own|random-string/.test(fired)
      ? "urlIrrelevant"
      : /social profile only/.test(fired)
        ? "profileIncomplete"
        : "doesntWorkType";
    return { decision: "reject", declineReason: reason, points, reasons };
  }
  if (points >= 3) return { decision: "review", declineReason: null, points, reasons };
  return { decision: "accept", declineReason: null, points, reasons };
}

/**
 * Fetch one applicant's profile description.
 *
 * Needs ?advertiserId — without it the endpoint 400s. Returns null rather than
 * throwing, so one bad profile cannot abort a whole enrichment pass.
 */
async function fetchDescription(advertiserId, publisherId) {
  const url = `${UI}/partner-profile-api/publishers/${publisherId}/profile?advertiserId=${advertiserId}`;
  const { ok, json } = await call("GET", url);
  if (!ok) return null;
  return typeof json?.description === "string" ? json.description : "";
}

/**
 * Re-score the undecided rows using their profile description.
 *
 * Scoped to `review` because that is where the extra signal changes the answer —
 * a row already rejected on its domain does not need a second opinion, and this
 * keeps the pass to a few dozen calls rather than one per applicant.
 */
async function enrichUndecided(plan, advertiserId, verbose) {
  const targets = plan.filter((p) => p.decision === "review");
  if (verbose) console.error(`  enriching ${targets.length} undecided applicant(s)...`);
  let moved = 0;
  for (const p of targets) {
    const description = await fetchDescription(advertiserId, p.publisherId);
    if (description == null) continue;
    p.description = description;
    const before = p.decision;
    Object.assign(p, decide(p, score(p)));
    if (p.decision !== before) moved += 1;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (verbose) console.error(`  enrichment resolved ${moved} of ${targets.length}`);
  return moved;
}

/**
 * Promote social-only applicants to `reject` when they look batch-registered.
 *
 * No per-applicant rule can see this: individually each one is just a creator
 * with a themed handle. What gave the farm away was publisher ids clustered
 * within a few hundred of each other on the same platform — five cycling
 * accounts at 2033625/2033637/2033717/2033719/2033891, gaps of 12, 80, 2, 172.
 * Real creators who happen to share a platform do not register in a burst.
 *
 * Mutates entries in place, so it runs before the plan is written.
 */
function flagBatchRegisteredClusters(plan, { window = 500, minSize = 3 } = {}) {
  const social = plan
    .filter((p) => SOCIAL_HOSTS.test(p.websiteUrl ?? "") && Number.isFinite(Number(p.publisherId)))
    .sort((a, b) => Number(a.publisherId) - Number(b.publisherId));

  let run = [];
  const flush = () => {
    if (run.length >= minSize) {
      for (const p of run) {
        if (p.decision === "reject") continue;
        p.decision = "reject";
        p.declineReason = "profileIncomplete";
        p.points += 6;
        p.reasons.push(
          `+6 one of ${run.length} social accounts registered in a burst ` +
            `(ids ${run[0].publisherId}–${run[run.length - 1].publisherId})`,
        );
      }
    }
    run = [];
  };
  for (const p of social) {
    if (run.length && Number(p.publisherId) - Number(run[run.length - 1].publisherId) > window) flush();
    run.push(p);
  }
  flush();
}

// ------------------------------------------------------------------- http ---

function jwt() {
  const t = process.env.AWIN_SESSION_JWT?.trim();
  if (!t) {
    console.error(
      "AWIN_SESSION_JWT is not set.\n" +
        "Grab it from DevTools → Network → any ui.awin.com/backend request →\n" +
        "Authorization header (drop the leading 'Bearer '), then:\n" +
        "  export AWIN_SESSION_JWT='eyJ...'",
    );
    process.exit(1);
  }
  return t.replace(/^Bearer\s+/i, "");
}

/** Decode the JWT payload without verifying it — for diagnostics only. */
function tokenClaims() {
  try {
    const payload = jwt().split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Unix seconds, or null if the token is unreadable. */
function tokenExpiry() {
  const exp = tokenClaims()?.exp;
  return typeof exp === "number" ? exp : null;
}

/**
 * Which Awin frontend issued this token. "nova" is app.awin.com and can write;
 * "darwin" is the older UI and its tokens carry read-only scopes, so they fail
 * membership writes with a 403 while reads keep working.
 */
function tokenClient() {
  return tokenClaims()?.["https://awin.com/client"] ?? null;
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${jwt()}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  // 401 and 403 both mean "not allowed", but for opposite reasons, and telling
  // them apart matters: one needs a fresh token, the other needs a token from a
  // different place. Decide from the token's own exp claim rather than guessing
  // from the status — a read-only token returns a bare "403 []" on a write while
  // still being perfectly valid, which an earlier version reported as expiry.
  if (res.status === 401 || res.status === 403) {
    const expired = tokenExpiry() != null && tokenExpiry() <= Date.now() / 1000;
    if (expired) {
      console.error(
        `\nHTTP ${res.status} from ${url}\n` +
          "The session JWT has expired — Awin's tokens last about an hour.\n" +
          "Grab a fresh one and re-run; nothing in this batch was applied.",
      );
    } else {
      console.error(
        `\nHTTP ${res.status} from ${url}\n` +
          `The token is still valid${tokenClient() ? ` (client "${tokenClient()}")` : ""} but is not ` +
          "allowed to do this.\n" +
          (text.trim() ? `Server said: ${text.trim().slice(0, 300)}\n` : "") +
          'Writes need a token from the "nova" client — the one app.awin.com itself uses.\n' +
          "Open app.awin.com (not the older UI), go to Partnerships > Pending partners,\n" +
          "and copy the Authorization header from a ui.awin.com/backend request there.\n" +
          "Nothing in this batch was applied.",
      );
    }
    process.exit(1);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — surfaced via `text` below */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Normalize a pending-application row.
 *
 * Shape confirmed against the live endpoint:
 *   { advertiserId, partnerId, company, website, primaryPromotionalType (id),
 *     sectors: [id], promotionalTypes: [id], membershipStatus, joinDate,
 *     pendingInvitationDate, applicationDate, pendingSuspensionDate,
 *     suspensionDate }
 *
 * Note the list carries no description and no region, so scoring works from
 * company name, website and promotion type only. applicationDate is null for
 * every row in practice. Run `list --raw` if Awin changes the schema.
 */
function normalize(row) {
  const typeId = row.primaryPromotionalType;
  return {
    publisherId: row.partnerId ?? row.publisherId ?? row.id,
    companyName: row.company ?? row.companyName ?? "(unknown)",
    websiteUrl: row.website ?? row.websiteUrl ?? "",
    promotionalType: typeId == null ? "" : (PROMO_TYPES[typeId] ?? `type ${typeId}`),
    allPromotionalTypes: (row.promotionalTypes ?? []).map(
      (id) => PROMO_TYPES[id] ?? `type ${id}`,
    ),
    membershipStatus: row.membershipStatus ?? "",
  };
}

/**
 * Page through the pending list. The endpoint ignores any `size` parameter and
 * always returns 5 rows per page, so a full backlog is a lot of round trips —
 * progress goes to stderr under --verbose.
 */
async function sweep(advertiserId, verbose) {
  const rows = [];
  let page = 1;
  let total = null;
  for (;;) {
    const url = `${UI}/universal-search-api/partnerships/pending/${advertiserId}?page=${page}`;
    const { ok, status, json, text } = await call("GET", url);
    if (!ok) {
      console.error(`GET pending page ${page} failed: HTTP ${status}\n${text.slice(0, 400)}`);
      process.exit(1);
    }
    const batch = json?.partnerships ?? [];
    total = json?.total ?? batch.length;
    rows.push(...batch);
    if (rows.length >= total || batch.length === 0) break;
    page += 1;
    if (page > Math.ceil(total / Math.max(batch.length, 1)) + 5) break; // guard
  }
  if (verbose) console.error(`  sweep returned ${rows.length} rows (API total ${total})`);
  return { rows, total };
}

/**
 * Collect the pending backlog.
 *
 * The endpoint ignores `size` (always 5 rows/page) and — more importantly — its
 * pagination is not stable: two identical passes returned 234 and 254 distinct
 * publishers against a claimed total of 296, with 32 and 52 publishers unique to
 * one pass. A single pass therefore silently under-reports. So sweep repeatedly
 * and union the results until we reach the claimed total or two consecutive
 * sweeps turn up nobody new.
 */
async function fetchPending(advertiserId, verbose) {
  const byId = new Map();
  let total = null;
  let barren = 0;

  for (let pass = 1; pass <= 8; pass += 1) {
    const before = byId.size;
    const res = await sweep(advertiserId, verbose);
    total = res.total;
    for (const row of res.rows) {
      const id = row.partnerId ?? row.publisherId ?? row.id;
      if (id != null && !byId.has(id)) byId.set(id, row);
    }
    const gained = byId.size - before;
    if (verbose) console.error(`  pass ${pass}: +${gained} new → ${byId.size}/${total} distinct`);
    if (total != null && byId.size >= total) break;
    barren = gained === 0 ? barren + 1 : 0;
    if (barren >= 2) break;
  }

  if (total != null && byId.size < total) {
    console.error(
      `\nNote: collected ${byId.size} distinct publishers but the API reports ${total}.\n` +
        `Its pagination is unstable, so a few applicants may be missing from this plan.\n` +
        `Re-run \`list\` later to pick up any stragglers.\n`,
    );
  }
  return { rows: [...byId.values()], total };
}

// --------------------------------------------------------------- commands ---

async function cmdList(opts) {
  const { rows, total } = await fetchPending(opts.advertiser, opts.verbose);

  if (opts.raw) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No pending applications.");
    return;
  }

  // The pending endpoint repeats publishers across pages — a full pull returned
  // 296 rows for 234 distinct partnerIds. Without this, apply would PUT the same
  // decision twice and the second call would fail as already-actioned.
  const seen = new Set();
  const plan = [];
  let duplicates = 0;
  for (const raw of rows) {
    const app = normalize(raw);
    if (seen.has(app.publisherId)) {
      duplicates += 1;
      continue;
    }
    seen.add(app.publisherId);
    plan.push({ ...app, ...decide(app, score(app)) });
  }
  if (opts.enrich) await enrichUndecided(plan, opts.advertiser, opts.verbose);
  flagBatchRegisteredClusters(plan);
  plan.sort((a, b) => b.points - a.points);

  const w = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
  console.log(
    `\n${plan.length} distinct pending application(s)` +
      `${duplicates ? ` (${rows.length} rows returned, ${duplicates} duplicate)` : ""}` +
      ` (API total: ${total})\n`,
  );
  console.log(`${w("decision", 8)} ${w("pts", 4)} ${w("publisher", 30)} ${w("type", 18)} website`);
  console.log("-".repeat(100));
  for (const p of plan) {
    console.log(
      `${w(p.decision, 8)} ${w(p.points, 4)} ${w(p.companyName, 30)} ${w(p.promotionalType, 18)} ${p.websiteUrl || "(none)"}`,
    );
    for (const r of p.reasons) console.log(`${" ".repeat(14)}${r}`);
    if (p.description) console.log(`${" ".repeat(14)}"${p.description.slice(0, 120)}"`);
  }

  const counts = plan.reduce((a, p) => ((a[p.decision] = (a[p.decision] ?? 0) + 1), a), {});
  console.log(
    `\nProposed: ${counts.accept ?? 0} accept, ${counts.review ?? 0} review, ${counts.reject ?? 0} reject`,
  );

  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    opts.plan,
    JSON.stringify({ advertiserId: opts.advertiser, generatedAt: new Date().toISOString(), plan }, null, 2),
  );
  console.log(
    `\nPlan written to ${opts.plan}\n` +
      `Edit the "decision" field (accept | reject | review | skip) as you like, then:\n` +
      `  node scripts/awin-partner-triage.mjs apply --confirm\n` +
      `Rows marked "review" or "skip" are never sent.`,
  );
}

async function cmdApply(opts) {
  if (!opts.confirm) {
    console.error("Refusing to write without --confirm. Run `list` first, review the plan, then re-run with --confirm.");
    process.exit(1);
  }
  const { readFileSync } = await import("node:fs");
  let doc;
  try {
    doc = JSON.parse(readFileSync(opts.plan, "utf8"));
  } catch {
    console.error(`Could not read plan file ${opts.plan}. Run \`list\` first.`);
    process.exit(1);
  }

  const advertiserId = doc.advertiserId ?? opts.advertiser;
  let actionable = doc.plan.filter((p) => p.decision === "accept" || p.decision === "reject");
  if (opts.onlyRejects) actionable = actionable.filter((p) => p.decision === "reject");

  if (actionable.length === 0) {
    console.log("Nothing actionable in the plan.");
    return;
  }
  console.log(`Applying ${actionable.length} decision(s) for advertiser ${advertiserId}...\n`);

  const url = `${UI}/membership-api/application/update?source=pending%20partners%20nova`;
  let okCount = 0;
  const failures = [];

  for (const p of actionable) {
    const action = p.decision === "accept" ? "accept" : "reject";
    const message =
      action === "reject"
        ? (DECLINE_REASONS.has(p.declineReason) ? p.declineReason : "otherSpecify")
        : (p.message ?? "");

    const { ok, status, text } = await call("PUT", url, {
      advertiserId: Number(advertiserId),
      publisherId: Number(p.publisherId),
      action,
      message,
    });

    if (ok) {
      okCount += 1;
      console.log(`  ✓ ${action.padEnd(6)} ${p.companyName} (${p.publisherId})`);
    } else {
      failures.push({ ...p, status, body: text.slice(0, 200) });
      console.log(`  ✗ ${action.padEnd(6)} ${p.companyName} (${p.publisherId}) — HTTP ${status}`);
      if (opts.verbose) console.log(`      ${text.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 400)); // be gentle on their API
  }

  console.log(`\nDone: ${okCount} succeeded, ${failures.length} failed.`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  ${f.companyName} (${f.publisherId}) HTTP ${f.status}: ${f.body}`);
    process.exitCode = 1;
  }
}

/**
 * End live partnerships listed in a plan file.
 *
 * Separate command from `apply` because this is a heavier action against a
 * different endpoint. `apply` accepts or declines an *application*; this
 * suspends an *existing* partner, which stops their tracking links and carries
 * the program's notice period (7 days by default — see `isUnderNotice`).
 *
 * Payload shape is read from the webapp bundle:
 *   POST membership-api/membership/suspend
 *   { membership: { advertiserId, publisherId, suspensionTypeId,
 *                   suspensionReason, isUnderNotice, status:"merchantSuspended" } }
 * with advertiserId and publisherId sent as strings. suspensionTypeId 0 is what
 * the UI sends for a provider-initiated close.
 *
 * Awin's own docs say partners cannot be bulk-removed through the interface and
 * to contact support, so this covers something the UI does not offer. It has
 * never been exercised against a live account — canary a single dormant partner
 * and confirm before running a batch.
 */
async function cmdEnd(opts) {
  if (!opts.confirm) {
    console.error(
      "Refusing to end partnerships without --confirm.\n" +
        "This suspends LIVE partners and stops their tracking links — heavier than declining\n" +
        "an application. Review the plan, then re-run with --confirm.",
    );
    process.exit(1);
  }
  const { readFileSync } = await import("node:fs");
  let doc;
  try {
    doc = JSON.parse(readFileSync(opts.plan, "utf8"));
  } catch {
    console.error(`Could not read plan file ${opts.plan}.`);
    process.exit(1);
  }

  const advertiserId = doc.advertiserId ?? opts.advertiser;
  const targets = doc.plan.filter((p) => p.decision === "end");
  if (targets.length === 0) {
    console.log('Nothing marked "end" in the plan.');
    return;
  }
  console.log(`Ending ${targets.length} partnership(s) for advertiser ${advertiserId}...\n`);

  const url = `${UI}/membership-api/membership/suspend?source=partner%20profile%20nova`;
  let okCount = 0;
  const failures = [];
  for (const p of targets) {
    const { ok, status, text } = await call("POST", url, {
      membership: {
        advertiserId: String(advertiserId),
        publisherId: String(p.publisherId),
        suspensionTypeId: p.suspensionTypeId ?? 0,
        suspensionReason: p.suspensionReason ?? "Inactive partner, no traffic in 12 months",
        isUnderNotice: p.isUnderNotice ?? true,
        status: "merchantSuspended",
      },
    });
    if (ok) {
      okCount += 1;
      console.log(`  ✓ ended  ${p.companyName} (${p.publisherId})`);
    } else {
      failures.push({ ...p, status, body: text.slice(0, 200) });
      console.log(`  ✗ failed ${p.companyName} (${p.publisherId}) — HTTP ${status}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`\nDone: ${okCount} ended, ${failures.length} failed.`);
  for (const f of failures) {
    console.log(`  ${f.companyName} (${f.publisherId}) HTTP ${f.status}: ${f.body}`);
  }
  if (failures.length) process.exitCode = 1;
}

// ------------------------------------------------------------------- main ---

function parseArgs(argv) {
  const cmd = argv[2] ?? "list";
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  return {
    cmd,
    advertiser: flag("advertiser", DEFAULT_ADVERTISER),
    plan: flag("plan", DEFAULT_PLAN),
    raw: argv.includes("--raw"),
    enrich: argv.includes("--enrich"),
    confirm: argv.includes("--confirm"),
    onlyRejects: argv.includes("--only-rejects"),
    verbose: argv.includes("--verbose"),
  };
}

/** Exported so the scoring rules can be unit-tested without hitting Awin. */
export { score, decide, normalize, DECLINE_REASONS, flagBatchRegisteredClusters };

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const opts = parseArgs(process.argv);
  if (opts.cmd === "list") await cmdList(opts);
  else if (opts.cmd === "apply") await cmdApply(opts);
  else if (opts.cmd === "end") await cmdEnd(opts);
  else {
    console.error(`Unknown command "${opts.cmd}". Use "list", "apply" or "end".`);
    process.exit(1);
  }
}
