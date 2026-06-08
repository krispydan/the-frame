export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/normalize-company-names
 *
 * Sweep companies.name for formatting issues introduced by CSV
 * imports and other upstream feeds, and clean them up. Daniel's
 * examples that triggered this:
 *
 *   '"FREE"'        → 'FREE'     (wrapped in escaped CSV quotes)
 *   '#GunTherapy'   → 'GunTherapy' (leading hash from social-handle copy)
 *
 * Each transformation is a named rule. Rules apply in order — a
 * name that triggers two rules (e.g. '"#FOO"') gets stripped twice.
 *
 * Auth: x-admin-key: jaxy2026
 *
 * Body:
 *   { dry_run?: boolean }    // default true (safety)
 *
 * Returns:
 *   { ok, scanned, would_change | changed, rule_breakdown, sample: [{ id, before, after, rules }] }
 */

interface Rule {
  name: string;
  /** Returns the cleaned name, or null if the rule didn't apply. */
  apply: (s: string) => string | null;
}

const RULES: Rule[] = [
  {
    name: "strip-wrapping-double-quotes",
    // Daniel's actual example was '""FREE""' (CSV double-escape).
    // Strip iteratively so '""FREE""' → '"FREE"' → 'FREE' in one
    // rule application. Same for any depth of accidental quoting.
    apply: (s) => {
      let cur = s;
      while (cur.length >= 2 && cur.startsWith('"') && cur.endsWith('"')) {
        cur = cur.slice(1, -1).trim();
      }
      return cur !== s ? cur : null;
    },
  },
  {
    name: "strip-wrapping-single-quotes",
    apply: (s) => {
      let cur = s;
      while (cur.length >= 2 && cur.startsWith("'") && cur.endsWith("'")) {
        cur = cur.slice(1, -1).trim();
      }
      return cur !== s ? cur : null;
    },
  },
  {
    name: "strip-leading-hash",
    // Daniel: '#GunTherapy' → 'GunTherapy'.
    // BUT: '#094 Wynn Las Vegas' is a legit store-number prefix,
    // and '#1 MOBILE DETAIL' is a marketing self-styling. So only
    // strip when the next character is a LETTER — that distinguishes
    // social-handle copies ('#GunTherapy', '#SmallTownGirl') from
    // store-number prefixes ('#094', '#1'). Also skip '##' chains
    // (section-header noise where the post-# content may not be a
    // real name).
    apply: (s) => {
      if (s.length > 1 && s.startsWith("#") && !s.startsWith("##") && /^[a-zA-Z]/.test(s[1])) {
        return s.slice(1).trim();
      }
      return null;
    },
  },
  {
    name: "collapse-internal-whitespace",
    // "Acme   Boutique" → "Acme Boutique". Newlines, tabs, runs of
    // spaces — all collapsed to a single space.
    apply: (s) => {
      const collapsed = s.replace(/\s+/g, " ").trim();
      return collapsed !== s ? collapsed : null;
    },
  },
  {
    name: "trim-surrounding-whitespace",
    // Defensive — most other rules call .trim() on their result so
    // this is mostly a backstop for names that didn't match any
    // other rule but still have padding.
    apply: (s) => {
      const t = s.trim();
      return t !== s ? t : null;
    },
  },
];

interface Change {
  id: string;
  before: string;
  after: string;
  rules: string[];
}

function applyRules(original: string): { cleaned: string; ruleNames: string[] } {
  let cur = original;
  const ruleNames: string[] = [];
  for (const rule of RULES) {
    const out = rule.apply(cur);
    if (out !== null && out !== cur) {
      ruleNames.push(rule.name);
      cur = out;
    }
  }
  return { cleaned: cur, ruleNames };
}

export async function POST(req: NextRequest) {
  try {
    const key = req.headers.get("x-admin-key");
    if (key !== "jaxy2026") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: { dry_run?: boolean } = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }
    const dryRun = body.dry_run !== false;  // default true

    // Pull every row that COULD be malformed. We over-fetch a tiny
    // bit (any name with whitespace or quotes or # — caught by the
    // LIKE filter below) and let the rule engine decide what to
    // actually change. Cheaper than scanning every row in companies.
    const candidates = sqlite.prepare(
      `SELECT id, name FROM companies
        WHERE name IS NOT NULL
          AND (name LIKE '"%'
            OR name LIKE '%"'
            OR name LIKE '''%'
            OR name LIKE '%'''
            OR name LIKE '#%'
            OR name LIKE '% %  %'        -- multiple internal spaces
            OR name != TRIM(name)         -- trailing/leading space
          )`,
    ).all() as Array<{ id: string; name: string }>;

    const changes: Change[] = [];
    const ruleBreakdown: Record<string, number> = {};
    for (const r of candidates) {
      const { cleaned, ruleNames } = applyRules(r.name);
      if (cleaned !== r.name && cleaned.length > 0) {
        changes.push({ id: r.id, before: r.name, after: cleaned, rules: ruleNames });
        for (const rn of ruleNames) {
          ruleBreakdown[rn] = (ruleBreakdown[rn] ?? 0) + 1;
        }
      }
    }

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dry_run: true,
        scanned: candidates.length,
        would_change: changes.length,
        rule_breakdown: ruleBreakdown,
        sample: changes.slice(0, 30),
      });
    }

    // Apply in a transaction. update_at touched so the change shows
    // up in activity logs and downstream sync flows.
    const updateStmt = sqlite.prepare(
      `UPDATE companies
          SET name = ?, updated_at = datetime('now')
        WHERE id = ?`,
    );
    const txn = sqlite.transaction(() => {
      for (const c of changes) updateStmt.run(c.after, c.id);
    });
    txn();

    return NextResponse.json({
      ok: true,
      scanned: candidates.length,
      changed: changes.length,
      rule_breakdown: ruleBreakdown,
      sample: changes.slice(0, 15),
    });
  } catch (e) {
    const err = e as Error;
    return NextResponse.json(
      { error: err.message, stack: err.stack?.split("\n").slice(0, 5) },
      { status: 500 },
    );
  }
}
