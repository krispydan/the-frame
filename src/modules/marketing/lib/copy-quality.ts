/**
 * Deterministic copy quality linter.
 *
 * The AI's `selfCheckPassed` is the model grading its own homework —
 * useful as a hint, untrustworthy as a gate. This module enforces the
 * hard-shape + brand constraints from copy-generation-prompt.md
 * deterministically, server-side, so every generated or hand-written
 * email is held to the same bar an agency would (consistency is the
 * whole point).
 *
 * Pure + dependency-free → unit-testable and reusable by the HTTP
 * routes, the MCP tools, and the editor's "Validate" affordance.
 */

/** Audience union (kept local so this module is self-contained). */
export type Audience = "retail" | "wholesale";

export type Level = "error" | "warning";

export interface Finding {
  level: Level;
  code: string;
  field: string;
  message: string;
}

export interface LintResult {
  ok: boolean; // no errors (warnings allowed)
  errors: Finding[];
  warnings: Finding[];
  score: number; // 0–100, for at-a-glance quality
}

/** The subset of a campaign the linter inspects. */
export interface LintableCopy {
  subject?: string | null;
  preheader?: string | null;
  subjectAlt?: string | null;
  preheaderAlt?: string | null;
  heroHeadline?: string | null;
  heroSubtitle?: string | null;
  heroCtaLabel?: string | null;
  heroCtaUrl?: string | null;
  sectionAHeading?: string | null;
  sectionABody?: string | null;
  sectionBHeading?: string | null;
  sectionBBody?: string | null;
  sectionBCtaLabel?: string | null;
  sectionBCtaUrl?: string | null;
}

// ── Brand banned phrases ────────────────────────────────────────
// Mirrors the banned-word list in system-prompt-base.md. HARD = always
// wrong (error). SOFT = marketing-speak the brand avoids but that has
// rare legitimate uses (warn, so it nudges without false-blocking).
const BANNED_HARD = [
  "curated",
  "premium",
  "luxury",
  "investment piece",
  "affordable luxury",
  "elevate",
  "elevated",
  "effortless",
  "game-changer",
  "game changer",
  "must-have",
  "must have",
  "staple",
  "wardrobe essential",
  "introducing",
  "we're so excited",
  "we are so excited",
  "we're thrilled",
  "we are thrilled",
  "great news",
  "treat yourself",
  "leverage",
  "synergy",
  "ecosystem",
  "made in la",
  "made in l.a.",
  "made in california",
  "crafted in la",
  "jaxy eyewear",
  "lose them",
  "throw them around",
  "crush them",
  "unlock",
  "level up",
];

// Context-dependent — the prompt allows these only with something
// "specific and TRUE to say." Warn rather than block.
const BANNED_SOFT = [
  "journey",
  "experience",
  "sustainable",
  "conscious",
  "mindful",
  "gender-neutral",
  "unisex",
];

// Subject-line openers that scream "marketing email."
const BANNED_SUBJECT_OPENERS = [
  "introducing",
  "we're excited",
  "we are excited",
  "don't miss",
  "last chance",
  "new arrival",
  "shop now",
];

// Emoji / pictographic ranges. Broad on purpose — brand voice is
// "no emoji."
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F1E6}-\u{1F1FF}]/u;

const RETAIL_HERO = "we/our/us";

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

function lc(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function allText(c: LintableCopy): string {
  return [
    c.subject,
    c.preheader,
    c.subjectAlt,
    c.preheaderAlt,
    c.heroHeadline,
    c.heroSubtitle,
    c.heroCtaLabel,
    c.sectionAHeading,
    c.sectionABody,
    c.sectionBHeading,
    c.sectionBBody,
    c.sectionBCtaLabel,
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

/** Valid CTA destination: http(s), mailto:, tel:, or the "#" placeholder.
 *  Wholesale CTAs are frequently mailto (Christina) — the prompt's own
 *  worked example uses mailto:christina@…, so it must pass. */
function isValidCtaUrl(s: string): boolean {
  const u = s.trim();
  return (
    u === "#" ||
    /^https?:\/\/[^\s]+\.[^\s]+/.test(u) ||
    /^mailto:[^\s@]+@[^\s]+/.test(u) ||
    /^tel:[+\d][\d\s().-]*$/.test(u)
  );
}

/** True Title Case = EVERY word (len≥2) is capitalized, i.e. no
 *  lowercase function word. "Find Your Pair" → flagged. A product-named
 *  CTA like "Shop the Main Character" keeps "the" lowercase → not
 *  flagged (proper-noun product names are endorsed by the prompt). */
function looksTitleCase(s: string): boolean {
  const w = words(s).filter((x) => x.length >= 2);
  if (w.length < 3) return false;
  return w.every((x) => /^[A-Z]/.test(x));
}

function isAllCaps(s: string): boolean {
  const letters = s.replace(/[^a-zA-Z]/g, "");
  return letters.length >= 3 && letters === letters.toUpperCase();
}

export function lintCopy(c: LintableCopy, audience: Audience): LintResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const err = (code: string, field: string, message: string) =>
    errors.push({ level: "error", code, field, message });
  const warn = (code: string, field: string, message: string) =>
    warnings.push({ level: "warning", code, field, message });

  const text = allText(c);
  const textLc = text.toLowerCase();

  // ── Subject ──
  const subject = (c.subject ?? "").trim();
  if (!subject) {
    err("subject_missing", "subject", "Subject line is empty.");
  } else {
    if (subject.length > 45)
      err("subject_too_long", "subject", `Subject is ${subject.length} chars (max 45; mobile cuts ~35).`);
    else if (subject.length > 40)
      warn("subject_long", "subject", `Subject is ${subject.length} chars — first 3 words must carry it.`);
    const sLc = subject.toLowerCase();
    for (const opener of BANNED_SUBJECT_OPENERS) {
      if (sLc.startsWith(opener))
        err("subject_cliche_opener", "subject", `Subject opens with cliché "${opener}".`);
    }
  }

  // ── Preheader ──
  const pre = (c.preheader ?? "").trim();
  if (!pre) {
    warn("preheader_missing", "preheader", "Preheader is empty — wastes inbox real estate.");
  } else {
    if (pre.length < 40 || pre.length > 100)
      warn("preheader_length", "preheader", `Preheader is ${pre.length} chars (aim 50–90).`);
    if (subject && pre.toLowerCase() === subject.toLowerCase())
      err("preheader_dupes_subject", "preheader", "Preheader duplicates the subject — it must complement, not repeat.");
    else if (subject && pre.toLowerCase().startsWith(subject.toLowerCase().slice(0, 20)) && subject.length > 20)
      warn("preheader_echoes_subject", "preheader", "Preheader echoes the start of the subject.");
  }

  // ── Emoji (none) ──
  if (EMOJI_RE.test(text))
    err("emoji", "body", "Copy contains an emoji — brand voice is no-emoji.");

  // ── Exclamation marks (≤1 per email) ──
  const bangs = (text.match(/!/g) ?? []).length;
  if (bangs > 1)
    err("too_many_exclamations", "body", `${bangs} exclamation marks — max 1 per email.`);

  // ── Banned phrases (hard = error, soft = warn) ──
  for (const phrase of BANNED_HARD) {
    if (textLc.includes(phrase))
      err("banned_phrase", "body", `Banned phrase: "${phrase}".`);
  }
  for (const phrase of BANNED_SOFT) {
    if (new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(textLc))
      warn("soft_banned_phrase", "body", `Marketing-speak "${phrase}" — only keep if it says something specific + true.`);
  }

  // ── A/B alternate subject/preheader ──
  const subjectAlt = (c.subjectAlt ?? "").trim();
  if (subjectAlt) {
    if (subjectAlt.length > 45)
      warn("subject_alt_long", "subjectAlt", `Alt subject is ${subjectAlt.length} chars (max 45 — it can become primary).`);
    if (subject && subjectAlt.toLowerCase() === subject.toLowerCase())
      warn("subject_alt_same", "subjectAlt", "Alt subject is identical to the primary — A/B needs a different angle.");
  }
  const preheaderAlt = (c.preheaderAlt ?? "").trim();
  if (preheaderAlt && (preheaderAlt.length < 40 || preheaderAlt.length > 100))
    warn("preheader_alt_length", "preheaderAlt", `Alt preheader is ${preheaderAlt.length} chars (aim 50–90).`);

  // ── Hero headline ≤6 words ──
  const hh = (c.heroHeadline ?? "").trim();
  if (hh) {
    const n = words(hh).length;
    if (n > 6) err("hero_headline_long", "heroHeadline", `Hero headline is ${n} words (max 6).`);
  } else {
    warn("hero_headline_missing", "heroHeadline", "Hero headline is empty.");
  }

  // ── Section body lengths (soft) ──
  const aBody = (c.sectionABody ?? "").trim();
  if (aBody) {
    const n = words(aBody).length;
    if (n < 30 || n > 80) warn("section_a_length", "sectionABody", `Section A is ${n} words (aim 40–70).`);
  }
  const bBody = (c.sectionBBody ?? "").trim();
  if (bBody) {
    const n = words(bBody).length;
    if (n < 45 || n > 130) warn("section_b_length", "sectionBBody", `Section B is ${n} words (aim 60–110).`);
  }

  // ── CTA labels: 2–4 words, sentence case ──
  for (const [field, label] of [
    ["heroCtaLabel", c.heroCtaLabel],
    ["sectionBCtaLabel", c.sectionBCtaLabel],
  ] as const) {
    const l = (label ?? "").trim();
    if (!l) continue;
    const n = words(l).length;
    if (n > 5) warn("cta_label_long", field, `CTA "${l}" is ${n} words (aim 2–4).`);
    if (isAllCaps(l)) err("cta_all_caps", field, `CTA "${l}" is ALL CAPS — sentence case only.`);
    else if (looksTitleCase(l)) warn("cta_title_case", field, `CTA "${l}" looks Title Case — sentence case only.`);
  }

  // ── CTA URLs: http(s) / mailto: / tel: / "#" if present ──
  for (const [field, url] of [
    ["heroCtaUrl", c.heroCtaUrl],
    ["sectionBCtaUrl", c.sectionBCtaUrl],
  ] as const) {
    const u = (url ?? "").trim();
    if (u && !isValidCtaUrl(u))
      err("cta_url_invalid", field, `CTA URL "${u}" is not a valid http(s)/mailto/tel URL.`);
  }

  // ── Reader-as-hero pronoun ratio (retail) ──
  const bodyForPronouns = `${aBody} ${bBody} ${lc(c.heroSubtitle)}`.toLowerCase();
  const youCount = (bodyForPronouns.match(/\b(you|your|yours|you're)\b/g) ?? []).length;
  const weCount = (bodyForPronouns.match(/\b(we|our|us|we're|jaxy)\b/g) ?? []).length;
  if (audience === "retail" && weCount > youCount && weCount >= 2) {
    warn(
      "pronoun_ratio",
      "body",
      `Brand pronouns (${RETAIL_HERO}: ${weCount}) outnumber reader pronouns (you: ${youCount}) — the customer should be the hero.`,
    );
  }

  // ── Wholesale: needs a number + Christina's sign-off ──
  if (audience === "wholesale") {
    const hasNumber = /\$?\d/.test(text);
    if (!hasNumber)
      warn("wholesale_no_number", "body", "Wholesale copy has no number (price/qty/%/stat) — buyers need the math.");
    if (!/christina/i.test(`${lc(c.sectionBBody)} ${lc(c.sectionABody)}`))
      warn("wholesale_no_signoff", "sectionBBody", "Wholesale email isn't signed by Christina — add a '— Christina' sign-off.");
  }

  // ── Score ──
  const score = Math.max(0, 100 - errors.length * 15 - warnings.length * 5);

  return { ok: errors.length === 0, errors, warnings, score };
}

/**
 * Map a raw AI copy-generation output (the tool-use JSON, with
 * `heroCtaUrlSuggestion` naming) onto the LintableCopy shape.
 */
export function lintGeneratedCopy(out: Record<string, unknown>, audience: Audience): LintResult {
  const s = (k: string) => (typeof out[k] === "string" ? (out[k] as string) : null);
  return lintCopy(
    {
      subject: s("subject"),
      preheader: s("preheader"),
      subjectAlt: s("subjectAlt"),
      preheaderAlt: s("preheaderAlt"),
      heroHeadline: s("heroHeadline"),
      heroSubtitle: s("heroSubtitle"),
      heroCtaLabel: s("heroCtaLabel"),
      heroCtaUrl: s("heroCtaUrlSuggestion") ?? s("heroCtaUrl"),
      sectionAHeading: s("sectionAHeading"),
      sectionABody: s("sectionABody"),
      sectionBHeading: s("sectionBHeading"),
      sectionBBody: s("sectionBBody"),
      sectionBCtaLabel: s("sectionBCtaLabel"),
      sectionBCtaUrl: s("sectionBCtaUrlSuggestion") ?? s("sectionBCtaUrl"),
    },
    audience,
  );
}
