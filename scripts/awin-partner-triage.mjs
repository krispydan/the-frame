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
 *   node scripts/awin-partner-triage.mjs list --raw            # dump raw API JSON
 *   node scripts/awin-partner-triage.mjs apply --confirm       # execute the plan
 *   node scripts/awin-partner-triage.mjs apply --confirm --only-rejects
 *
 * Flags: --advertiser <id>  --plan <path>  --verbose
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
    "coupon", "promo[ -]?code", "voucher", "discount", "deals?", "bargain",
    "saver", "savings", "cashback", "clearance", "freebie",
    // es / pt / it
    "descuento", "cupon", "cupom", "promocion", "codigos", "sconto", "buono",
    // de / nl / nordics
    "gutschein", "rabatt", "korting", "kortingscode", "tilbud",
    // pl / cz / sk
    "kupon", "slevy", "zlavy", "rabatowe",
  ].join("|"),
  "i",
);

/** Free/parked hosts — a "publisher" with no real site of their own. */
const WEAK_HOSTS =
  /(blogspot\.|wordpress\.com|wixsite\.|weebly\.|medium\.com|sites\.google\.com|linktr\.ee|bit\.ly)/i;

const SOCIAL_HOSTS =
  /(instagram\.com|tiktok\.com|facebook\.com|twitter\.com|x\.com|youtube\.com|pinterest\.)/i;

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

  if (!type) {
    add(3, "no primary promotion type declared (incomplete profile)");
  } else if (COUPON_TYPES.some((t) => type.includes(t))) {
    add(3, `promotion type is "${app.promotionalType}"`);
  } else if (ARBITRAGE_TYPES.some((t) => type.includes(t))) {
    add(3, `promotion type is "${app.promotionalType}" (resells traffic)`);
  }

  if (COUPON_TOKENS.test(name)) add(3, "coupon/deal wording in company name");
  if (url && COUPON_TOKENS.test(url)) add(3, "coupon/deal wording in domain");

  if (!url) {
    add(4, "no website URL on the application");
  } else if (SOCIAL_HOSTS.test(url)) {
    add(1, "only a social profile, no owned site");
  } else if (WEAK_HOSTS.test(url)) {
    add(2, "free/parked host, no owned domain");
  }

  if (points === 0) reasons.push("no flags raised");
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
    const reason = COUPON_TOKENS.test(app.companyName ?? "") ||
      COUPON_TYPES.some((t) => (app.promotionalType ?? "").toLowerCase().includes(t))
      ? "doesntWorkType"
      : "urlIrrelevant";
    return { decision: "reject", declineReason: reason, points, reasons };
  }
  if (points >= 3) return { decision: "review", declineReason: null, points, reasons };
  return { decision: "accept", declineReason: null, points, reasons };
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
  if (res.status === 401) {
    console.error(
      `\n401 Unauthorized from ${url}\n` +
        "The session JWT is missing, expired, or wrong. Grab a fresh one from DevTools.",
    );
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
    confirm: argv.includes("--confirm"),
    onlyRejects: argv.includes("--only-rejects"),
    verbose: argv.includes("--verbose"),
  };
}

/** Exported so the scoring rules can be unit-tested without hitting Awin. */
export { score, decide, normalize, DECLINE_REASONS };

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const opts = parseArgs(process.argv);
  if (opts.cmd === "list") await cmdList(opts);
  else if (opts.cmd === "apply") await cmdApply(opts);
  else {
    console.error(`Unknown command "${opts.cmd}". Use "list" or "apply".`);
    process.exit(1);
  }
}
