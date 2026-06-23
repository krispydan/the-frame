/**
 * Inline-style helpers + the shared <style> block with media query.
 *
 * Email clients are wildly inconsistent. The rules of survival:
 *   1. ALL critical styles inline via `style={}`
 *   2. Use <style> blocks ONLY for media queries (mobile responsive)
 *      — most clients honor them, the holdouts get the desktop layout
 *   3. Mark every responsive override with !important — Outlook
 *      sometimes overrides arbitrary CSS
 *   4. Use <table> for outer layout — div positioning fails Outlook
 */

import { colors, fonts, layout } from "./tokens";

/**
 * The <style> block injected once into the email <head>. Contains
 * only the mobile media query and a few class hooks.
 */
export const STYLE_BLOCK = `
  /* Email clients respect <style> selectively. We use it only for
     the @media query — every other rule is inline. */
  body { margin: 0; padding: 0; background: ${colors.white}; }
  img { display: block; border: 0; max-width: 100%; height: auto; }
  a { color: inherit; }
  table { border-collapse: collapse; }

  @media only screen and (max-width: ${layout.mobileBreakpoint}px) {
    .jx-hero-headline { font-size: 32px !important; line-height: 1.15 !important; }
    .jx-hero-subtitle { font-size: 13px !important; }
    .jx-text-pad      { padding-left: ${layout.textPadXMobile}px !important;
                        padding-right: ${layout.textPadXMobile}px !important; }
    .jx-section-heading { font-size: 11px !important; }
    .jx-section-body    { font-size: 14px !important; }
    .jx-cta-pill        { padding: 10px 22px !important; font-size: 12px !important; }
    .jx-grid-cell       { display: block !important; width: 100% !important; }
  }
`;

/**
 * CTA pill — used by hero + section B variants. Inline-styled <a>.
 * Pass children as the label text. URL via `href`.
 */
export function ctaPillStyle(opts: { color?: "primary" | "ivory" } = {}): React.CSSProperties {
  const isIvory = opts.color === "ivory";
  return {
    display: "inline-block",
    background: isIvory ? colors.ivory : colors.terracotta,
    color: isIvory ? colors.espresso : colors.ivory,
    textDecoration: "none",
    fontFamily: fonts.body,
    fontSize: 13,
    fontWeight: 500,
    letterSpacing: "0.15em",
    padding: "12px 28px",
    borderRadius: 999,
    textTransform: "uppercase" as const,
  };
}

export function headlineStyle(): React.CSSProperties {
  return {
    fontFamily: fonts.display,
    fontSize: 44,
    lineHeight: 1.1,
    fontWeight: 500,
    color: colors.espresso,
    margin: 0,
  };
}

export function subtitleStyle(): React.CSSProperties {
  return {
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 1.55,
    color: colors.espresso,
    margin: "10px auto 0",
    maxWidth: 380,
    fontWeight: 400,
  };
}

export function sectionHeadingStyle(): React.CSSProperties {
  return {
    fontFamily: fonts.body,
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: "0.22em",
    color: colors.espresso,
    margin: 0,
    textTransform: "uppercase" as const,
  };
}

export function sectionBodyStyle(): React.CSSProperties {
  return {
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 1.65,
    color: colors.espresso,
    margin: 0,
  };
}

/** Scrim gradient — used only by hero/FullBleedOverlay. */
export function scrimGradient(scrim: "dark" | "light" | "none"): string | undefined {
  if (scrim === "dark") {
    return "linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0) 55%)";
  }
  if (scrim === "light") {
    return "linear-gradient(180deg, rgba(255,253,240,0.7) 0%, rgba(255,253,240,0) 55%)";
  }
  return undefined;
}

/**
 * Cell padding for text sections. Helper so the mobile media query
 * class hook (.jx-text-pad) can override consistently.
 */
export function textCellStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    padding: `40px ${layout.textPadX}px 28px`,
    textAlign: "center" as const,
    backgroundColor: colors.white,
    ...extra,
  };
}
