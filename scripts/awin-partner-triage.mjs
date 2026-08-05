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
 * Flags: --advertiser <id>  --plan <path>  --page-size <n>  --verbose
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

/** Promotion types that are the whole reason this script exists. */
const COUPON_TYPES = [
  "discount code",
  "voucher",
  "voucher code",
  "cashback",
  "loyalty",
  "coupon",
];

/** Name/domain tokens that give away a coupon farm. */
const COUPON_TOKENS =
  /(coupon|promo[ -]?code|voucher|discount|deals?|bargain|saver|savings|cashback|rabatt|kupon|slevy|kortingscode|gutschein)/i;

/** Free/parked hosts — a "publisher" with no real site of their own. */
const WEAK_HOSTS =
  /(blogspot\.|wordpress\.com|wixsite\.|weebly\.|medium\.com|sites\.google\.com|linktr\.ee|bit\.ly)/i;

const SOCIAL_HOSTS =
  /(instagram\.com|tiktok\.com|facebook\.com|twitter\.com|x\.com|youtube\.com|pinterest\.)/i;

/** Regions the brands actually sell into. Everything else is a soft flag. */
const TARGET_REGIONS = new Set(["US", "GB", "UK", "CA"]);

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

  if (COUPON_TYPES.some((t) => type.includes(t))) {
    add(3, `promotion type is "${app.promotionalType}"`);
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

  if (!app.description || app.description.trim().length < 40) {
    add(2, "little or no profile description");
  }
  if (app.primaryRegion && !TARGET_REGIONS.has(app.primaryRegion.toUpperCase())) {
    add(1, `primary region ${app.primaryRegion} outside US/GB/CA`);
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
 * Field names are read from the webapp bundle rather than from a published
 * schema, so each one falls back through the plausible alternatives. Run
 * `list --raw` if something comes through blank — that prints the real payload.
 */
function normalize(row) {
  const socials = row.socialUrls ?? {};
  return {
    publisherId: row.id ?? row.publisherId ?? row.partnerId,
    companyName: row.companyName ?? row.company ?? row.name ?? "(unknown)",
    websiteUrl: row.websiteUrl ?? socials.website ?? row.url ?? "",
    promotionalType:
      row.primaryPromotionalType?.name ??
      row.promotionalType ??
      row.primaryType ??
      "",
    primaryRegion: row.primaryRegion?.countryCode ?? row.primaryRegion ?? "",
    sector: row.primarySector?.name ?? row.sector ?? "",
    description: row.description ?? row.summary ?? "",
    applicationDate: row.applicationDate ?? row.joinDate ?? "",
  };
}

async function fetchPending(advertiserId, pageSize, verbose) {
  const all = [];
  let page = 1;
  let total = null;
  for (;;) {
    const url = `${UI}/universal-search-api/partnerships/pending/${advertiserId}?page=${page}&size=${pageSize}`;
    const { ok, status, json, text } = await call("GET", url);
    if (!ok) {
      console.error(`GET pending page ${page} failed: HTTP ${status}\n${text.slice(0, 400)}`);
      process.exit(1);
    }
    const rows = json?.partnerships ?? json?.content ?? json?.results ?? [];
    total = json?.total ?? json?.totalElements ?? rows.length;
    if (verbose) console.error(`  page ${page}: ${rows.length} rows (total ${total})`);
    all.push(...rows);
    if (all.length >= total || rows.length === 0) break;
    page += 1;
    if (page > 100) break; // pagination guard
  }
  return { rows: all, total };
}

// --------------------------------------------------------------- commands ---

async function cmdList(opts) {
  const { rows, total } = await fetchPending(opts.advertiser, opts.pageSize, opts.verbose);

  if (opts.raw) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No pending applications.");
    return;
  }

  const plan = rows.map((raw) => {
    const app = normalize(raw);
    return { ...app, ...decide(app, score(app)) };
  });
  plan.sort((a, b) => b.points - a.points);

  const w = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
  console.log(`\n${rows.length} pending application(s) (API total: ${total})\n`);
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
    pageSize: Number(flag("page-size", "50")),
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
