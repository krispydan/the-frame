/**
 * Email Strategy Engine
 *
 * Daniel: "this should be a methodic machine and not just random
 * prompts, it should be smart. over time, once we have more data,
 * we should use the learnings to build an even smarter engine —
 * we don't need to do this now but it should be built very
 * modularly so we can easily integrate this at a later stage."
 *
 * This module is the recommendation layer that sits between
 * "raw AI generation" and "specific campaign defaults." It tells
 * the planner WHAT TO PICK for any given audience × week × slot,
 * based on a deterministic rotation strategy.
 *
 * The MCP tools (plan_week, build_campaign_from_idea) consult
 * `recommendForSlot()` to seed sensible defaults; the user can
 * still override every choice in the editor.
 *
 * ──────────── MODULAR for the future ────────────
 *
 * v1 (this file): static rotation rules — heuristic, deterministic,
 *   no data dependency. We know the right answers from first
 *   principles (lifestyle vs flat-lay, subject angle variety).
 *
 * v2 (later, when we have ≥6 months of open/click data):
 *   - Add a `learned_strategy` table that overrides static rules
 *     for slots where data shows a different combo wins
 *   - Add `recordOutcome(campaignId, opens, clicks)` so we
 *     accumulate signal
 *   - `recommendForSlot()` checks `learned_strategy` first, falls
 *     back to static
 *
 * v3 (much later): per-segment personalization, A/B test cohorts,
 *   send-time optimization. All of these slot into recommendForSlot
 *   without callers changing.
 *
 * The function signature is the contract; the implementation grows.
 */

// ── The vocabulary of the strategy ─────────────────────────────

/**
 * Layout = the combination of hero + secondary image variants.
 * Each layout has a "feel" that rotates across weeks to avoid
 * the inbox going visually stale.
 */
export const LAYOUT_PROFILES = {
  /** Hero is the visual story (full-bleed image with overlay text).
   *  Secondary is a moody full-bleed product/lifestyle beat. The
   *  "magazine cover" feel. */
  editorial_full_bleed: {
    heroVariant: "full_bleed_overlay" as const,
    sectionAVariant: "centered" as const,
    secondaryImageVariant: "full_bleed" as const,
    sectionBVariant: "centered_with_cta" as const,
    description: "Magazine cover — hero image dominates, text overlaid",
  },

  /** Hero image presented as a centered "object" with cream gutters
   *  — product-catalog feel. Secondary is also centered. Calmer,
   *  more product-focused than editorial. */
  product_catalog: {
    heroVariant: "image_75_solid" as const,
    sectionAVariant: "centered" as const,
    secondaryImageVariant: "centered_75" as const,
    sectionBVariant: "centered_with_cta" as const,
    description: "Product catalog — clean, centered, more curated",
  },

  /** Split hero (image left, text right) — for Faire/wholesale
   *  product-card style emails. Secondary is full bleed for
   *  the second beat. */
  split_pivot: {
    heroVariant: "split_50_50" as const,
    sectionAVariant: "centered" as const,
    secondaryImageVariant: "full_bleed" as const,
    sectionBVariant: "two_column_with_cta" as const,
    description: "Split hero — mirrors Faire storefront cards",
  },

  /** UGC-friendly — image_75_solid for the customer photo (no
   *  text on the face), 2-up grid below for "shop the look" /
   *  related products. */
  ugc_centered: {
    heroVariant: "image_75_solid" as const,
    sectionAVariant: "with_pullquote" as const,
    secondaryImageVariant: "grid_2up" as const,
    sectionBVariant: "centered_with_cta" as const,
    description: "UGC repost — customer photo + grid of related",
  },
} as const;
export type LayoutProfile = keyof typeof LAYOUT_PROFILES;

/**
 * Image style = what the designer's hero photo SHOULD show.
 * Drives the Higgsfield prompt direction.
 *
 * Daniel: "1st email of the week can be images of the product
 * with a nice setting and the 2nd email can be the glasses on
 * someone's face. we alternate the email layouts."
 */
export const IMAGE_STYLES = {
  product_flatlay: {
    label: "Product still-life / flat-lay",
    higgsfield_directive:
      "Sunglasses presented as the subject on a warm neutral surface (linen, sand, weathered wood) with thoughtful props (dried flora, brass key, ceramic dish). Golden-hour sidelight, depth of field shallow on the frames. NO model. Style: editorial product photography, Kodak Portra 400 grade.",
  },
  on_model_lifestyle: {
    label: "Glasses on a real face — lifestyle",
    higgsfield_directive:
      "Model wearing the sunglasses, mid-action (laughing, walking, in conversation), NOT posing for camera. Natural California lifestyle setting — Pacific coast, palm tree, urban warm architecture. Eyewear is the visual hero of the shot. Golden hour or bright California sun. Diverse, approachable, real face — not high-fashion plastic.",
  },
  product_detail_macro: {
    label: "Macro detail — texture and craft",
    higgsfield_directive:
      "Tight macro shot of the frame's hinge, lens edge, or temple stamp. Hands holding or adjusting the frames. Show craft + materials. Warm light, shallow DOF. Reads as 'made with care' without saying so.",
  },
  paired_2up_colorways: {
    label: "Two colorways side-by-side (for grid_2up secondary)",
    higgsfield_directive:
      "Two sunglasses — same shape, different colorways — laid as a pair on warm linen. Each occupies its own square. Match composition + lighting between the two for a clean grid. Used for 'pick a mood' / colorway emails.",
  },
} as const;
export type ImageStyle = keyof typeof IMAGE_STYLES;

/**
 * Subject angle = the lens through which the subject line frames
 * the email. We rotate angles to test what works in this audience.
 *
 * Future v2: log open rates per angle, weight rotation by winner.
 */
export const SUBJECT_ANGLES = {
  product_focused: {
    label: "Product-focused — names a specific frame/colorway",
    example_retail: "the Sunday Drive came back in Honey",
    example_wholesale: "6 new frames in — and 2 are already moving",
    promptHint: "Lead with the specific product/colorway. Naming the SKU does the work.",
  },
  lifestyle_sensation: {
    label: "Lifestyle sensation — names a moment/feeling",
    example_retail: "it's coffee-on-the-porch weather",
    example_wholesale: "What's moving at boutiques like yours this month",
    promptHint: "Lead with a sensory moment or store-fit observation. Product comes second.",
  },
  curiosity_hook: {
    label: "Curiosity hook — incomplete information, fragmented",
    example_retail: "this is what we mean by 'on purpose'",
    example_wholesale: "the math on a $140 starter mix",
    promptHint: "Open-loop subject line. Leaves the reader wanting the email body for resolution.",
  },
  social_proof: {
    label: "Social proof — name a customer/store/stat",
    example_retail: "@sara's poolside Main Character moment",
    example_wholesale: "Austin and Asheville both reordered in 10 days",
    promptHint: "Lead with someone else's enthusiasm. Borrowed credibility opens.",
  },
  practical_value: {
    label: "Practical value — numbers + deadline",
    example_retail: "$5 off + free shipping through Sunday",
    example_wholesale: "Faire Summer Market — 10% off opening orders",
    promptHint: "Lead with the dollar/percent/deadline. No mystery. The buyer needs to act.",
  },
} as const;
export type SubjectAngle = keyof typeof SUBJECT_ANGLES;

// ── The rotation rules ─────────────────────────────────────────

/**
 * For each audience, define what slot 1 vs slot 2 of the week does
 * by default. Slot 1 = the first email (Monday for retail / Tuesday
 * for wholesale). Slot 2 = the second (Thursday / Friday).
 *
 * The slot 1/2 split is per Daniel's spec: "1st email of the week
 * can be images of the product with a nice setting and the 2nd
 * email can be the glasses on someone's face."
 */
const SLOT_DEFAULTS: Record<
  "retail" | "wholesale",
  Record<1 | 2, { imageStyle: ImageStyle; subjectAngle: SubjectAngle }>
> = {
  retail: {
    1: {
      imageStyle: "product_flatlay",
      subjectAngle: "product_focused",
    },
    2: {
      imageStyle: "on_model_lifestyle",
      subjectAngle: "lifestyle_sensation",
    },
  },
  wholesale: {
    1: {
      imageStyle: "product_flatlay",
      subjectAngle: "social_proof",
    },
    2: {
      imageStyle: "on_model_lifestyle",
      subjectAngle: "practical_value",
    },
  },
};

/**
 * Layout rotation by week-of-year. Index = week % LAYOUT_CYCLE.length.
 *
 * Editorial → product catalog → split → UGC → repeat. This gives
 * the inbox a quarterly rhythm without anyone having to think
 * about it.
 */
const LAYOUT_CYCLE: LayoutProfile[] = [
  "editorial_full_bleed",
  "product_catalog",
  "split_pivot",
  "ugc_centered",
];

/**
 * Subject-angle rotation by week-of-year. Used to TEST different
 * angles without having to manually plan. Combined with slot
 * defaults: slot 1 still gets the slot-1 angle, but the angle
 * itself rotates week-over-week for variety.
 *
 * v2: this gets replaced by data-driven angle weighting.
 */
const ANGLE_ROTATIONS_RETAIL: SubjectAngle[] = [
  "product_focused",
  "lifestyle_sensation",
  "curiosity_hook",
  "social_proof",
];

const ANGLE_ROTATIONS_WHOLESALE: SubjectAngle[] = [
  "social_proof",
  "practical_value",
  "product_focused",
  "curiosity_hook",
];

// ── The public API ─────────────────────────────────────────────

export interface SlotRecommendation {
  audience: "retail" | "wholesale";
  weekOf: string;             // ISO Monday
  slotInWeek: 1 | 2;          // 1 = first email, 2 = second
  scheduledDate: string;      // ISO date for this slot
  layoutProfile: LayoutProfile;
  layoutVariants: {
    heroVariant: string;
    sectionAVariant: string;
    secondaryImageVariant: string;
    sectionBVariant: string;
  };
  imageStyle: ImageStyle;
  imageStyleDirective: string;
  subjectAngle: SubjectAngle;
  subjectAngleHint: string;
  rationale: string;          // human-readable "why this combo"
}

/**
 * The core recommender. Pure function — same input → same output,
 * no DB calls, easy to test, easy to override.
 */
export function recommendForSlot(
  audience: "retail" | "wholesale",
  weekOf: string,           // ISO Monday
  slotInWeek: 1 | 2,
): SlotRecommendation {
  const slotDefault = SLOT_DEFAULTS[audience][slotInWeek];
  const weekIndex = isoWeekIndex(weekOf);

  // Layout rotates BY WEEK (both slots in the same week share a
  // layout — keeps the week visually coherent before pivoting).
  const layoutProfile = LAYOUT_CYCLE[weekIndex % LAYOUT_CYCLE.length];
  const layout = LAYOUT_PROFILES[layoutProfile];

  // Within-week hero variety: the layout rotates by week, so without
  // this both slots would inherit the SAME hero variant and a week's
  // emails would look monotone. Slot 2 takes the NEXT hero variant in
  // a fixed order so a single week mixes at least two hero layouts.
  // (Other block variants stay from the profile — hero is the
  // dominant visual, so offsetting it is enough.)
  const HERO_ORDER = ["full_bleed_overlay", "image_75_solid", "split_50_50"] as const;
  const heroVariant =
    slotInWeek === 2
      ? HERO_ORDER[(HERO_ORDER.indexOf(layout.heroVariant as typeof HERO_ORDER[number]) + 1) % HERO_ORDER.length]
      : layout.heroVariant;

  // Image style is locked to slot (1 = flat-lay, 2 = on-model) —
  // this is Daniel's explicit ask. Don't rotate it.
  const imageStyle = slotDefault.imageStyle;
  const imageDirective = IMAGE_STYLES[imageStyle].higgsfield_directive;

  // Subject angle rotates BY WEEK, then offset by slot. So slot 1
  // gets the week's "primary" angle, slot 2 gets the next angle in
  // the rotation. This gives the inbox 8 distinct angles per
  // 4-week cycle.
  const angleRotation = audience === "retail"
    ? ANGLE_ROTATIONS_RETAIL
    : ANGLE_ROTATIONS_WHOLESALE;
  const angleIndex = (weekIndex + (slotInWeek - 1)) % angleRotation.length;
  const subjectAngle = angleRotation[angleIndex];
  const subjectHint = SUBJECT_ANGLES[subjectAngle].promptHint;

  const scheduledDate = computeSlotDate(audience, weekOf, slotInWeek);

  const rationale = [
    `Week ${weekIndex + 1} of rotation → layout: ${layoutProfile} (${layout.description})`,
    `Slot ${slotInWeek} → image style: ${IMAGE_STYLES[imageStyle].label}`,
    `Subject angle: ${SUBJECT_ANGLES[subjectAngle].label}`,
  ].join(". ");

  return {
    audience,
    weekOf,
    slotInWeek,
    scheduledDate,
    layoutProfile,
    layoutVariants: {
      heroVariant,
      sectionAVariant: layout.sectionAVariant,
      secondaryImageVariant: layout.secondaryImageVariant,
      sectionBVariant: layout.sectionBVariant,
    },
    imageStyle,
    imageStyleDirective: imageDirective,
    subjectAngle,
    subjectAngleHint: subjectHint,
    rationale,
  };
}

/**
 * Recommend both slots for one week of one audience. Convenience
 * wrapper used by plan_week.
 */
export function recommendForWeek(
  audience: "retail" | "wholesale",
  weekOf: string,
): SlotRecommendation[] {
  return [
    recommendForSlot(audience, weekOf, 1),
    recommendForSlot(audience, weekOf, 2),
  ];
}

/**
 * Recommend all slots for N weeks of one audience. Used by
 * plan_week when count > 1.
 */
export function recommendForWeeks(
  audience: "retail" | "wholesale",
  startWeekOf: string,
  weeks: number,
): SlotRecommendation[] {
  const out: SlotRecommendation[] = [];
  for (let w = 0; w < weeks; w++) {
    const wkOf = addDaysIso(startWeekOf, w * 7);
    out.push(...recommendForWeek(audience, wkOf));
  }
  return out;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Compute the actual send date for a slot. Retail: Mon (offset 0)
 * and Thu (offset 3). Wholesale: Tue (offset 1) and Fri (offset 4).
 */
export function computeSlotDate(
  audience: "retail" | "wholesale",
  weekOf: string,
  slotInWeek: 1 | 2,
): string {
  const offsets = audience === "retail"
    ? [0, 3]
    : [1, 4];
  return addDaysIso(weekOf, offsets[slotInWeek - 1]);
}

/**
 * ISO week index — number of full weeks since 2026-01-05 (a
 * Monday). Used to seed the rotation deterministically.
 */
function isoWeekIndex(weekOfIso: string): number {
  const epoch = new Date("2026-01-05T00:00:00Z").getTime();
  const week = new Date(`${weekOfIso}T00:00:00Z`).getTime();
  return Math.floor((week - epoch) / (7 * 24 * 60 * 60 * 1000));
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Future: outcome recording ──────────────────────────────────
// Stub for v2. Once we have ≥3 months of campaigns with open/click
// data, this is where we'd train the layout/angle weighting.

/**
 * Record the outcome of a campaign so the strategy can learn from it.
 * v1 is a no-op stub — the table doesn't exist yet. v2 wires this
 * up to weight subject-angle + layout choices toward winners.
 *
 * Call sites (later): the email-send-results capture form,
 * Omnisend webhook, manual entry.
 */
export function recordOutcome(_opts: {
  campaignId: string;
  layoutProfile: LayoutProfile;
  imageStyle: ImageStyle;
  subjectAngle: SubjectAngle;
  opens: number;
  clicks: number;
  recipients: number;
}): void {
  // v2 will write to a `marketing_email_strategy_outcomes` table.
  // v1 no-op — leaving the function present so call sites can be
  // wired up now without conditional checks.
}
