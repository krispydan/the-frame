/**
 * Jaxy V2 brand tokens — for email rendering ONLY.
 *
 * Email clients (especially Outlook) ignore most CSS. Every value
 * below gets inlined into style="..." attributes by the variant
 * components. Keep this list tight — anything not used here doesn't
 * belong in an email.
 *
 * Source of truth: brand-context/visual-guidelines.md (V2 palette).
 * NEVER use pure black (#000000) — always Espresso (#39341F).
 * NEVER use the retired V1 lime/gold/chartreuse palette.
 */

export const colors = {
  // Backgrounds
  white:        "#FFFFFF",   // primary email background (Daniel: "cleaner and nicer")
  ivory:        "#FFFDF0",   // V2 Cream — alt background
  lavender:     "#DCDCEF",   // V2 light accent

  // Text
  espresso:     "#39341F",   // Jaxy's "black" — all text
  espressoSoft: "#5A5340",   // muted text (derived, ~70% strength) for fine print

  // Accents
  terracotta:   "#915127",   // primary CTA background
  moss:         "#7E8A60",   // secondary CTA / accent
  plum:         "#6A4F62",   // dark accent
  sage:         "#D4E3BB",   // light secondary
  slateBlue:    "#637797",   // cool accent (use sparingly)

  // Functional
  borderSubtle: "#E8E5D5",   // ivory-shifted neutral for dividers
  textOnDark:   "#FFFDF0",   // Ivory text on dark backgrounds
} as const;

/**
 * Typography — email-safe fallback chains. Most clients block web
 * fonts; the brand fonts go FIRST so where they DO load (Apple Mail
 * with system fonts, modern Gmail web) they render correctly.
 */
export const fonts = {
  // Display = "Instrument Sans" per V2; Glitz is LOGO ONLY now
  display: '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
  // Body = Jost per V2
  body: 'Jost, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
  // Pullquote = Syne per V2 (rare use)
  pullquote: '"Syne", Georgia, "Times New Roman", serif',
  // Logo wordmark uses Glitz with serif fallback (Cooper Black is the closest mainstream font)
  logo: 'Glitz, "Cooper Std Black", "Cooper Black", Georgia, serif',
} as const;

/**
 * Email width — 600px is the de-facto standard. Below that, mobile
 * @media query shrinks individual elements.
 */
export const layout = {
  emailWidth: 600,
  mobileBreakpoint: 480,
  // Hero block heights per variant — used to set min-height on cells
  heroHeight: 460,
  secondaryHeight: 360,
  // Horizontal padding for text sections
  textPadX: 36,
  textPadXMobile: 24,
} as const;
