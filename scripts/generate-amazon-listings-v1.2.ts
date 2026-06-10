/**
 * Generate the v1.2 Amazon listing copy for all eligible products WITHOUT
 * the Claude API: per-product copy fragments authored by hand (Claude in
 * chat, reviewed by Daniel), merged with live catalog data (shape, lens
 * type, colors) and the keyword assembler's pools/backend.
 *
 * Follows the same rules as amazon-listing-prompt.ts v1.2:
 *   - title ≤50 chars, ends "| Jaxy <Style>" (or "Jaxy" when tight)
 *   - lens claim is EITHER Polarized OR UV400 — never both
 *   - no frame-material claims, no cleaning cloth, case included
 *   - 5 bullets ≤500 chars, description 800–1800 chars
 *   - generic_keywords = assembler backend verbatim (≤240 bytes)
 *
 * Output: scripts/data/amazon-listings-v1.2.json
 * Apply with: npx tsx scripts/import-amazon-listings.ts
 *
 * Usage: npx tsx scripts/generate-amazon-listings-v1.2.ts
 */
import fs from "fs";
import path from "path";
import { sqlite } from "@/lib/db";
import { assembleProductKeywords } from "@/modules/catalog/lib/keywords/assemble";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";
import { FORBIDDEN_TERMS, canonicalShapeFor } from "@/modules/catalog/lib/keywords/scrub";

/** Hand-authored fragments per product. `title` is final (counted). */
interface Fragment {
  sku: string;
  title: string;
  /** Bullet-2 styling clause — the frame's look, no material words. */
  look: string;
  /** Description opening sentence(s) — the product's personality. */
  hook: string;
  /** Bullet-3 / description occasions clause. */
  occasions: string;
  /** Color guidance, "Black for X, Tortoise for Y" form. */
  colorPhrase: string;
  /** Description closing tagline after "<Name> by Jaxy:". */
  tagline: string;
}

const FRAGMENTS: Fragment[] = [
  {
    sku: "JX1001", title: "Cat Eye Polarized Sunglasses Women | Jaxy Monroe",
    look: "an angular cat eye with a confidently upturned rim — vintage attitude with modern polish",
    hook: "Meet Monroe: vintage-inspired cat eye sunglasses with an angular silhouette and upturned rim that bring serious retro attitude to everything you wear.",
    occasions: "From weekday errands to weekend brunch and golden-hour patios",
    colorPhrase: "Black for classic drama, Tortoise for vintage warmth, White for the unexpected head-turner",
    tagline: "retro attitude, modern clarity",
  },
  {
    sku: "JX1002", title: "Square Sunglasses UV400 Unisex | Jaxy Boulevard",
    look: "a bold, softened square with a slightly oversized silhouette that flatters without overwhelming",
    hook: "Boulevard makes a statement without saying a word: bold softened-square sunglasses with a slightly oversized silhouette and subtle detailing that reads effortlessly cool.",
    occasions: "City blocks, coffee runs, and long drives with the windows down",
    colorPhrase: "Black for the sharpest read or Tortoise for timeless warmth",
    tagline: "quiet confidence, block after block",
  },
  {
    sku: "JX1003", title: "Round Sunglasses UV400 Men Women | Jaxy Reverie",
    look: "a vintage round silhouette in translucent finishes that catch the light just right",
    hook: "The Reverie brings vintage charm to the everyday: round sunglasses in translucent finishes that catch the light just right, with a distinctive bridge that sets them apart.",
    occasions: "Picnics, beach walks, and any afternoon that deserves a soundtrack",
    colorPhrase: "Blue for the light-catcher, Sand for soft neutral, Tortoise for the classic",
    tagline: "vintage charm, everyday ease",
  },
  {
    sku: "JX1004", title: "Rectangle Polarized Sunglasses | Jaxy Palm State",
    look: "a confident rectangular silhouette with subtle details and an effortless vintage-cool vibe",
    hook: "The Palm State brings vintage cool to your everyday rotation: rectangle sunglasses with a confident silhouette and subtle details that read relaxed, not retro-costume.",
    occasions: "Road trips, rooftop afternoons, and the daily commute",
    colorPhrase: "Black for sharp, Brown for warm, Tortoise for the classic pairing",
    tagline: "everyday cool, zero effort",
  },
  {
    sku: "JX1005", title: "Square Polarized Sunglasses Unisex | Jaxy Windsor",
    look: "a retro square with softly rounded edges — the sweet spot between classic and current",
    hook: "Meet Windsor: retro square sunglasses that nail the sweet spot between classic square style and modern edge, with softly rounded corners that keep the look approachable.",
    occasions: "Work mornings, weekend markets, and everything scheduled in between",
    colorPhrase: "Black for clean lines, Olive for an unexpected twist, Tortoise for heritage",
    tagline: "classic shape, current energy",
  },
  {
    sku: "JX1006", title: "Round Sunglasses for Women UV400 | Jaxy Solstice",
    look: "chunky, oversized round frames that command attention while staying featherlight",
    hook: "The Solstice is for those who appreciate presence: oversized round sunglasses with chunky frames that command attention and a silhouette that flatters effortlessly.",
    occasions: "Festival fields, vacation terraces, and main-character moments",
    colorPhrase: "Brown for warmth, Purple for personality, Tortoise for timeless",
    tagline: "timeless style, full presence",
  },
  {
    sku: "JX1007", title: "Cat Eye Sunglasses Women UV400 | Jaxy Mystique",
    look: "an oversized cat eye with dramatic curves and gradient lenses that add depth to every glance",
    hook: "The Mystique is the ultimate cat eye: an oversized silhouette with dramatic curves and gradient lenses that fade from deep to light, channeling pure vintage glamour.",
    occasions: "Garden parties, gallery strolls, and every photo-worthy afternoon",
    colorPhrase: "Black for drama, Floral for the conversation-starter, Green Tort for vintage depth",
    tagline: "vintage glamour, modern mystery",
  },
  {
    sku: "JX1008", title: "Retro Oval Sunglasses UV400 Unisex | Jaxy Bardot",
    look: "a matte vintage oval with riveted hinge details that catch the light just right",
    hook: "Meet Bardot: the vintage-inspired oval that's anything but ordinary, with a matte finish and distinctive riveted hinges that give classic style a quietly industrial edge.",
    occasions: "Café mornings, vintage-shop afternoons, and city evenings",
    colorPhrase: "Black for matte minimalism, Brown for warmth, Olive for the subtle standout",
    tagline: "vintage soul, modern restraint",
  },
  {
    sku: "JX1009", title: "Retro Square Sunglasses UV400 | Jaxy The Regent",
    look: "a thick, sculptural 70s square with subtle gold-tone accents that catch the light",
    hook: "Meet The Regent: bold oversized square sunglasses that channel serious 70s energy, with thick sculptural lines and subtle gold-tone accent details.",
    occasions: "Statement dinners, weekend getaways, and anywhere first impressions count",
    colorPhrase: "Black for authority, Green for intrigue, Tortoise for the classic read",
    tagline: "70s energy, modern command",
  },
  {
    sku: "JX1010", title: "Aviator Sunglasses UV400 | Jaxy The Catalyst",
    look: "a chunky, oversized teardrop aviator with serious attitude",
    hook: "The Catalyst takes the classic aviator and gives it serious attitude: a chunky, oversized teardrop silhouette that commands attention instead of asking for it.",
    occasions: "Open roads, airport arrivals, and weekends that go off-script",
    colorPhrase: "Black for bold, Grey for cool neutral, Tort/Blue for the two-tone standout",
    tagline: "classic DNA, bolder instincts",
  },
  {
    sku: "JX1011", title: "Rectangle Sunglasses UV400 | Jaxy Velvet Hour",
    look: "a bold retro rectangle with rich patterning and a head-turning silhouette",
    hook: "Meet Velvet Hour: retro rectangle sunglasses that turn heads without trying too hard, with rich vintage patterning and a confident rectangular silhouette.",
    occasions: "Dinner reservations, gallery nights, and golden-hour everything",
    colorPhrase: "Amber/Teal for the two-tone moment, Black for sharp, Tortoise for heritage",
    tagline: "vintage energy, evening-ready",
  },
  {
    sku: "JX1012", title: "Round Sunglasses UV400 | Jaxy Sunset Theory",
    look: "a round silhouette in a black-to-honey ombré that flows like golden hour itself",
    hook: "The Sunset Theory captures the golden hour in a frame: a striking black-to-honey ombré that flows from deep to warm, like the last hour of daylight made wearable.",
    occasions: "Beach sunsets, rooftop hours, and every drive west at dusk",
    colorPhrase: "the signature ombré in Black, Grey, or Tortoise — each fading beautifully",
    tagline: "golden hour, on demand",
  },
  {
    sku: "JX2001", title: "Square Polarized Sunglasses Unisex | Jaxy Eclipse",
    look: "clean, confident square lines that work equally as mens or womens square sunglasses",
    hook: "The Eclipse is the square sunglasses workhorse: one confident frame, four colorways, zero occasions it doesn't work for.",
    occasions: "Suits, swimsuits, and every dress code in between",
    colorPhrase: "Black for sharp, Tortoise for classic, Olive Green for unexpected, Sand for summer",
    tagline: "your default pair, upgraded",
  },
  {
    sku: "JX2002", title: "Aviator Sunglasses UV400 Retro | Jaxy Drifter",
    look: "a slim square-aviator hybrid with gradient lenses and pure 70s cool",
    hook: "Meet Drifter: the sleek square aviator that captures pure 70s cool, with gradient lenses that blend retro style and modern wearability in one slim profile.",
    occasions: "Vinyl shopping, coastal drives, and long lunches that run late",
    colorPhrase: "Gold/Amber for warm retro or Gold/Green for the heritage lens look",
    tagline: "70s cool, zero effort",
  },
  {
    sku: "JX2003", title: "Aviator Sunglasses UV400 | Jaxy Groove Theory",
    look: "a slim rectangular-aviator hybrid with bold 70s energy",
    hook: "Meet Groove Theory: slim retro aviators that nail the sweet spot between aviator cool and vintage charm, with a rectangular-hybrid silhouette straight out of the 70s.",
    occasions: "Music festivals, flea markets, and afternoons that turn into evenings",
    colorPhrase: "Black/Amber for contrast, Brown/Green for earthy retro, Grey/Pink for the soft standout",
    tagline: "retro groove, modern fit",
  },
  {
    sku: "JX2004", title: "Square Polarized Sunglasses Retro | Jaxy Diner",
    look: "a clean square with subtle rivet details — retro cool without trying too hard",
    hook: "Diner nails retro cool without trying too hard: classic square sunglasses with subtle rivets that catch the light and a clean shape that earns its place in daily rotation.",
    occasions: "Diner booths, drive-ins, and every errand worth dressing for",
    colorPhrase: "Black for crisp, Grey for understated, Rust Tort for vintage warmth",
    tagline: "classic cool, daily driver",
  },
  {
    sku: "JX2005", title: "Square Sunglasses Women UV400 | Jaxy Wildflower",
    look: "a softly sculpted oversized square with delicate, feminine detailing",
    hook: "Meet Wildflower: a statement-making oversized square that blends feminine lines with delicate detailing — slip them on and channel effortless vintage spirit.",
    occasions: "Garden brunches, market Saturdays, and sundress season at large",
    colorPhrase: "Brown for grounded warmth, Pink for play, Teal for the unexpected",
    tagline: "soft lines, wild spirit",
  },
  {
    sku: "JX2006", title: "Hexagon Polarized Sunglasses | Jaxy The Hex",
    look: "sharp geometric angles that blend precision with retro soul",
    hook: "The Hex cuts angles that command attention: hexagon sunglasses with geometric precision and retro soul, equally at home on city streets or weekend escapes.",
    occasions: "City streets, gallery openings, and weekend escapes",
    colorPhrase: "Black for architectural, Brown for warm, Yellow for the bold move",
    tagline: "geometry with a pulse",
  },
  {
    sku: "JX2007", title: "Retro Aviator Sunglasses UV400 | Jaxy Burnout",
    look: "a chunky, angular aviator with a distinctive top bar that breaks from the usual",
    hook: "Meet Burnout: retro aviator frames that hit every trend alert, with a chunky angular silhouette and a distinctive top bar that sets them apart from the standard issue.",
    occasions: "Concert lawns, road trips, and parking-lot hangs that outlast the show",
    colorPhrase: "Black/Rose for edge, Brown for classic, Tort/Teal for the two-tone statement",
    tagline: "trend-proof attitude",
  },
  {
    sku: "JX2008", title: "Oval Polarized Sunglasses Women | Jaxy Deco",
    look: "a softly sculpted oval with a subtle cat-eye lift — feminine, flattering, a little bold",
    hook: "Meet the Deco: the perfect in-between — a softly sculpted oval with a subtle cat-eye lift that brings a vintage wink to modern wardrobes.",
    occasions: "Brunch patios, museum afternoons, and every little black dress moment",
    colorPhrase: "Black for polish, Red for the power move, Tortoise for vintage warmth",
    tagline: "a vintage wink, worn daily",
  },
  {
    sku: "JX3001", title: "Classic Square Polarized Sunglasses | Jaxy Canyon",
    look: "clean lines and confident proportions — proof that timeless never goes out of fashion",
    hook: "The Canyon proves timeless never goes out of fashion: classic square sunglasses with clean lines and confident proportions that make a statement without shouting.",
    occasions: "Trailheads, tailgates, and Tuesday mornings alike",
    colorPhrase: "Black for definitive, Sand for summer-soft, Tortoise for the heritage look",
    tagline: "built for every horizon",
  },
  {
    sku: "JX3002", title: "Square Sunglasses for Women UV400 | Jaxy Dahlia",
    look: "a soft oversized square with a subtle cat-eye influence and a stunning ombré finish",
    hook: "Meet Dahlia: a soft oversized square with a subtle cat-eye influence, finished in a striking ombré that fades from warm cognac to soft blush.",
    occasions: "Rosé afternoons, baby showers, and front-row sunshine",
    colorPhrase: "Amber/Pink for the signature ombré, Black for contrast, Tortoise for classic",
    tagline: "soft focus, full bloom",
  },
  {
    sku: "JX3003", title: "Round Polarized Sunglasses Men | Jaxy Havana Haze",
    look: "a classic round silhouette with vintage energy that softens sharper features",
    hook: "The Havana Haze combines classic design with modern performance: round sunglasses with perfect vintage energy and sleek lenses that flatter as they protect.",
    occasions: "Beach bars, boardwalks, and slow Sunday afternoons",
    colorPhrase: "Black for minimalist, Brown for warmth, Tortoise for the classic round pairing",
    tagline: "vintage haze, modern clarity",
  },
  {
    sku: "JX3004", title: "Square Aviator Sunglasses UV400 | Jaxy Diplomat",
    look: "a signature square aviator with a distinctive top-bridge detail and modern proportions",
    hook: "Meet Diplomat: the square aviator that owns every room, combining classic aviator DNA with modern proportions and a distinctive top-bridge detail.",
    occasions: "Negotiations, vacations, and everything that calls for presence",
    colorPhrase: "Black for authority, Sand for off-duty, Tort/Green or Tortoise for character",
    tagline: "diplomatic immunity from bad style",
  },
  {
    sku: "JX3005", title: "Polarized Aviator Sunglasses | Jaxy Phoenix",
    look: "a clean teardrop aviator with a bold top bar that flatters round, oval, and square faces",
    hook: "Phoenix brings the classic aviator into sharp focus: clean lines and a bold top bar in a timeless silhouette that works beautifully on nearly every face shape.",
    occasions: "Morning drives, afternoon flights, and every window seat",
    colorPhrase: "Black for definitive or Brown for warm classic",
    tagline: "the aviator, reborn",
  },
  {
    sku: "JX3006", title: "Round Polarized Sunglasses Slim | Jaxy Raven",
    look: "a slim-profile round with perfectly balanced proportions and a barely-there feel",
    hook: "The Raven brings classic round sunglasses into sharp focus: a slim profile with perfectly balanced proportions and clean lines that disappear into your look.",
    occasions: "Bookstore weekends, espresso bars, and long city walks",
    colorPhrase: "Black for stealth, Gold-tone for warmth, Silver-tone for cool precision",
    tagline: "light frame, sharp focus",
  },
  {
    sku: "JX3007", title: "Bold Square Polarized Sunglasses | Jaxy Foundry",
    look: "a bold, chunky square with substantial presence and serious retro vibes",
    hook: "Meet Foundry, where vintage-inspired meets everyday: chunky square sunglasses with a bold silhouette and substantial presence that commands attention.",
    occasions: "Workshop Saturdays, brewery patios, and big-plan brainstorms",
    colorPhrase: "Black for heavyweight cool, Olive for depth, Tortoise for the warm classic",
    tagline: "forged for the bold",
  },
  {
    sku: "JX3008", title: "Oval Polarized Sunglasses Women | Jaxy Scarlet",
    look: "a slim 90s oval with a sleek rim and vintage-inspired silhouette",
    hook: "Meet Scarlet: the slim oval sunglasses you've been searching for, with a sleek rim design and serious 90s style in a vintage-inspired silhouette.",
    occasions: "Vintage markets, rooftop happy hours, and every disposable-camera night",
    colorPhrase: "Antique Tort for collected-over-time charm, Burgundy for depth, Green for the wildcard",
    tagline: "90s muse, modern lens",
  },
  {
    sku: "JX4001", title: "Retro Oval Polarized Sunglasses | Jaxy Vinyl",
    look: "a small retro oval with a sleek profile — equal parts 90s revival and Y2K runway",
    hook: "Meet the Vinyl: retro oval sunglasses with a modern refresh — a small, perfectly proportioned lens that brings an editorial edge oversized frames can't touch.",
    occasions: "Record stores, fashion-week sidewalks, and photo dumps everywhere",
    colorPhrase: "Black/Amber for two-tone edge, Olive for understated, Tortoise for vintage warmth",
    tagline: "small frames, big work",
  },
  {
    sku: "JX4002", title: "Cat Eye Polarized Sunglasses 90s | Jaxy Cosmic",
    look: "a narrow oval-cat-eye with a subtle lift — pure 90s energy in a sleek profile",
    hook: "Meet Cosmic: sleek oval cat eye sunglasses channeling pure 90s energy, with narrow frames and just enough lift to add attitude without costume.",
    occasions: "Late brunches, thrift hauls, and nights that start at golden hour",
    colorPhrase: "Black for sleek or Tortoise for retro warmth",
    tagline: "90s energy, cosmic timing",
  },
  {
    sku: "JX4003", title: "Square Polarized Sunglasses Women | Jaxy Studio",
    look: "an oversized square with a gradient finish that flows from amber to electric tones",
    hook: "Studio frames command attention: oversized square sunglasses with a stunning gradient finish that flows from golden amber into cooler tones — 70s glamour, current edge.",
    occasions: "Photo studios, weekend city breaks, and front-facing cameras",
    colorPhrase: "Amber/Blue for the electric fade or Brown/Pink for the warm one",
    tagline: "main-character glamour",
  },
  {
    sku: "JX4004", title: "Aviator Polarized Sunglasses Men | Jaxy Eastwood",
    look: "a double-bridge aviator with clean geometric lines that works on every face shape",
    hook: "The Eastwood brings classic aviator style into sharp focus: a distinctive double-bridge design with clean geometric lines that flatter every face shape.",
    occasions: "Long highways, ranch weekends, and squint-free matinees",
    colorPhrase: "Black for classic, Brown for warm, Grey for the cool neutral",
    tagline: "a few frames more",
  },
  {
    sku: "JX4005", title: "Retro Square Polarized Sunglasses | Jaxy Westside",
    look: "a chunky, confident retro square that nails the vintage look without trying too hard",
    hook: "Meet the Westside: classic square sunglasses that nail the retro frame look without trying too hard, with a chunky, confident silhouette built for daily wear.",
    occasions: "Westside drives, taco stands, and pickup games at the park",
    colorPhrase: "Black for clean, Antique Tort for character, Blue Multi for play, Olive for depth",
    tagline: "west coast classic, everywhere",
  },
  {
    sku: "JX4006", title: "Round Polarized Sunglasses Retro | Jaxy Lennon",
    look: "perfectly balanced round frames with namesake-level retro credibility",
    hook: "Meet Lennon: round sunglasses that turn heads without trying, with perfectly balanced proportions and finishes that catch the light beautifully.",
    occasions: "Vinyl listening sessions, peace-and-quiet park days, and studio time",
    colorPhrase: "Black/Tort, Green/Black, Burgundy/Tort, or Rust/Green — every duo with vintage depth",
    tagline: "imagine better sunglasses",
  },
  {
    sku: "JX4007", title: "Cat Eye Sunglasses Women Polarized | Jaxy Dynasty",
    look: "a Hollywood-glamour cat eye that makes a statement without trying too hard",
    hook: "Meet Dynasty: the cat eye sunglasses women reach for when they want classic Hollywood glamour with modern wearability — a statement that doesn't strain.",
    occasions: "Premieres real or imagined, valet lines, and oversized-scarf weather",
    colorPhrase: "Black for icon status, Red for the bold era, Tortoise for old-money warmth",
    tagline: "glamour, inherited",
  },
  {
    sku: "JX4008", title: "Retro Aviator Polarized Sunglasses | Jaxy Captain",
    look: "a retro aviator with a distinctive top bar and serious character",
    hook: "The Captain brings retro aviator character in spades: a distinctive top bar and bold silhouette that stand out from the standard-issue pilot look.",
    occasions: "Marinas, mountain passes, and anywhere with a view worth protecting",
    colorPhrase: "Brown/Purple for depth, Green for heritage, Tortoise/Rose for the soft twist",
    tagline: "take the helm",
  },
  {
    sku: "JX4009", title: "Square Sunglasses Polarized Men Women Jaxy Theory",
    look: "a bold square in translucent finishes that catch light and create depth",
    hook: "Theory makes a statement without saying a word: bold square sunglasses in translucent finishes that catch the light and create depth most frames can't.",
    occasions: "Design studios, long lunches, and idea-heavy afternoons",
    colorPhrase: "Black for definitive, Green for the translucent standout, Tortoise for classic",
    tagline: "proven on contact",
  },
  {
    sku: "JX4010", title: "Polarized Aviator Sunglasses | Jaxy Horizon",
    look: "a true teardrop pilot silhouette with timeless, not trendy, proportions",
    hook: "The Horizon brings pilot style in for a smooth landing: the confident teardrop lens and clean browline you know, rebuilt lightweight with modern lenses doing the heavy lifting.",
    occasions: "Open roads, open water, and high-glare everything",
    colorPhrase: "Brown for warmth, Green for the heritage lens look, Grey for everyday neutral",
    tagline: "a century of cool, continued",
  },
  {
    sku: "JX4011", title: "Cat Eye Polarized Sunglasses Women | Jaxy Velour",
    look: "a boldly oversized cat eye with beautifully curved lines that sweep upward",
    hook: "The Velour commands attention: a boldly oversized cat eye with beautifully curved lines that sweep upward — sharp enough to elevate a plain tee, classic enough to outlast every trend.",
    occasions: "From morning coffee to golden hour, and every patio in between",
    colorPhrase: "glossy Black for full drama or Tortoise for a softer vintage read",
    tagline: "glamour, minus the compromise",
  },
];

// ── Copy assembly ────────────────────────────────────────────────────────

const SHAPE_LABEL: Record<string, string> = {
  round: "Round", "cat-eye": "Cat Eye", square: "Square", aviator: "Aviator",
  oval: "Oval", rectangle: "Rectangle", hexagon: "Hexagon",
};

/** Primary + secondary search phrases per shape, woven into copy. */
const SHAPE_PHRASES: Record<string, [string, string]> = {
  round: ["round sunglasses", "circle sunglasses"],
  "cat-eye": ["cat eye sunglasses", "cateye sunglasses"],
  square: ["square sunglasses", "square glasses"],
  aviator: ["aviator sunglasses", "aviators"],
  oval: ["oval sunglasses", "retro oval sunglasses"],
  rectangle: ["rectangle sunglasses", "rectangular sunglasses"],
  hexagon: ["hexagon sunglasses", "hexagonal sunglasses"],
};

function genderPhrase(gender: string | null): string {
  const g = (gender ?? "").toLowerCase();
  if (g.includes("women")) return "made for women";
  if (g === "male" || g === "men" || g === "mens") return "made for men";
  return "for men and women alike";
}

function lensBullet(lensType: string): string {
  return lensType === "polarized"
    ? "Polarized Lenses: Cut glare from roads, water, and bright pavement while keeping colors true — relaxed eyes on the longest, brightest days."
    : "UV400 Protection: Lenses rated UV400 block harmful UVA and UVB rays, shielding your eyes through full-sun days while keeping the view bright and true.";
}

function lensParagraph(lensType: string): string {
  return lensType === "polarized"
    ? "The polarized lenses do the quiet work: glare from windshields, water, and pavement is filtered out so colors stay rich and your eyes stay relaxed on the brightest days. No squinting contest — just crisp, comfortable clarity wherever the afternoon takes you."
    : "The UV400-rated lenses block harmful UVA and UVB rays, keeping your eyes shielded through full-sun days while the view stays bright and true. From morning errands to golden hour, protection comes standard — no squinting required.";
}

const PROMISE_BULLETS = [
  "The Jaxy Promise: Designed in-house and quality-checked twice before shipping. If you don't get compliments in the first week, give them time.",
  "The Jaxy Promise: Designed in-house, quality-checked twice. Style this good shouldn't require a designer price tag.",
  "The Jaxy Promise: Designed in-house and quality-checked twice before it reaches you. Everyday eyewear, elevated.",
];

interface GeneratedListing {
  sku: string;
  productName: string;
  title: string;
  bullets: [string, string, string, string, string];
  description: string;
  genericKeywords: string;
}

function buildListing(
  f: Fragment,
  ctx: {
    name: string; shape: string; lensType: string; gender: string | null;
    colors: string[]; backend: string;
  },
): GeneratedListing {
  const canonical = canonicalShapeFor(ctx.shape) ?? ctx.shape;
  const label = SHAPE_LABEL[canonical] ?? canonical;
  const [kw1] = SHAPE_PHRASES[canonical] ?? [`${canonical} sunglasses`];
  const lensWord = ctx.lensType === "polarized" ? "polarized" : "UV400";

  const bullets: [string, string, string, string, string] = [
    lensBullet(ctx.lensType),
    `${label} Silhouette: ${capitalize(f.look)}. Lightweight with sturdy hinges — comfortable all day, no pinching, no slipping.`,
    `Style That Travels: ${f.occasions}. ${capitalize(f.colorPhrase)}.`,
    "Protective Case Included: Every pair ships with a carrying case — protected in the bag, ready on your face.",
    PROMISE_BULLETS[hashPick(f.sku, PROMISE_BULLETS.length)],
  ];

  const description = [
    `${f.hook} These ${kw1} are ${genderPhrase(ctx.gender)}, with a fit that stays comfortable from first coffee to last light — lightweight on the face, steady on the move, and easy to love in any season.`,
    `${lensParagraph(ctx.lensType)} Choose ${f.colorPhrase}. However you wear them, the ${label.toLowerCase()} profile keeps the look intentional, and the included carrying case keeps them safe between wears.`,
    `${ctx.name} by Jaxy: ${f.tagline}. Real ${lensWord} lenses, a considered fit, and a silhouette that earns its spot in the everyday rotation.`,
  ].join("\n\n");

  return {
    sku: f.sku,
    productName: ctx.name,
    title: f.title,
    bullets,
    description,
    genericKeywords: ctx.backend,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function hashPick(seed: string, mod: number): number {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 997;
  return h % mod;
}

// ── Validation (mirrors the prompt's hard rules) ─────────────────────────

function validate(l: GeneratedListing, lensType: string): string[] {
  const issues: string[] = [];
  if (l.title.length > 50) issues.push(`title ${l.title.length} > 50`);
  if (!/jaxy/i.test(l.title)) issues.push("title missing Jaxy");
  if (l.bullets.length !== 5) issues.push("not 5 bullets");
  for (const [i, b] of l.bullets.entries()) {
    if (b.length > 500) issues.push(`bullet ${i + 1} ${b.length} > 500`);
  }
  if (l.description.length < 800) issues.push(`description ${l.description.length} < 800`);
  if (l.description.length > 1800) issues.push(`description ${l.description.length} > 1800`);
  if (Buffer.byteLength(l.genericKeywords, "utf8") > 240) issues.push("backend > 240 bytes");

  const haystack = [l.title, ...l.bullets, l.description].join("\n").toLowerCase();
  // Lens either/or — the OTHER lens word must not appear anywhere.
  const otherLens = lensType === "polarized" ? "uv400" : "polarized";
  if (haystack.includes(otherLens)) issues.push(`claims ${otherLens} but product is ${lensType}`);
  // No material claims.
  for (const mat of ["acetate", "tr90", " metal ", "metal frame", "plastic"]) {
    if (haystack.includes(mat)) issues.push(`material claim: ${mat.trim()}`);
  }
  if (haystack.includes("cloth")) issues.push("mentions cloth");
  for (const t of FORBIDDEN_TERMS) {
    if (new RegExp(`(?:^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(haystack)) {
      issues.push(`forbidden term: ${t}`);
    }
  }
  if (/[®©™]/.test(haystack)) issues.push("high-ASCII ®/©/™");
  return issues;
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const out: GeneratedListing[] = [];
  let failed = 0;

  for (const f of FRAGMENTS) {
    const p = sqlite.prepare(
      "SELECT id, name FROM catalog_products WHERE sku_prefix = ?",
    ).get(f.sku) as { id: string; name: string } | undefined;
    if (!p) { console.error(`✗ ${f.sku}: product not found`); failed++; continue; }

    const allTags = sqlite.prepare(
      "SELECT tag_name tagName, dimension FROM catalog_tags WHERE product_id=?",
    ).all(p.id) as Array<{ tagName: string; dimension: string }>;
    const curated = curatedAttrsFromTags(allTags);
    const secondary = allTags
      .filter((t) => (t.dimension ?? "").toLowerCase() === "secondary_shape")
      .map((t) => t.tagName);
    const colors = (sqlite.prepare(
      "SELECT DISTINCT color_name c FROM catalog_skus WHERE product_id=? AND color_name IS NOT NULL",
    ).all(p.id) as Array<{ c: string }>).map((r) => r.c);
    const ks = assembleProductKeywords({
      primaryShape: curated.frameShape,
      secondaryShapes: secondary,
    });
    const lensType = (curated.lensType ?? "uv400").toLowerCase();

    const listing = buildListing(f, {
      name: p.name, shape: curated.frameShape ?? "", lensType,
      gender: curated.gender, colors, backend: ks.backend,
    });

    const issues = validate(listing, lensType);
    if (issues.length > 0) {
      console.error(`✗ ${f.sku} ${p.name}: ${issues.join("; ")}`);
      failed++;
      continue;
    }
    console.log(`✓ ${f.sku} ${p.name.padEnd(14)} title=${listing.title.length} desc=${listing.description.length} backend=${Buffer.byteLength(listing.genericKeywords, "utf8")}B`);
    out.push(listing);
  }

  if (failed > 0) {
    console.error(`\n${failed} listings FAILED validation — JSON not written.`);
    process.exit(1);
  }

  const outPath = path.join(process.cwd(), "scripts", "data", "amazon-listings-v1.2.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`\nWrote ${out.length} listings → ${outPath}`);
}

main();
