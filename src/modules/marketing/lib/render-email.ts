/**
 * Email HTML renderer — pure string templates.
 *
 * Why no React: Next 16 + Turbopack rejects every variant of
 * `react-dom/server` imports inside the App Router. The previous
 * approach (renderToStaticMarkup of a React component tree) was
 * elegant but kept tripping the build. Pivoted to plain string
 * templates which:
 *   - Don't depend on any framework's rendering pipeline
 *   - Have zero runtime cost (no React tree to walk)
 *   - Work in any future Next/Turbopack/Vite/anything
 *   - Still email-safe (table-based layout + inline styles)
 *
 * Adding a new variant = drop a function below + a case in the
 * dispatcher. Same modularity as the React version, less framework
 * coupling.
 */

import { catalogImageUrl } from "@/lib/storage/image-url";
import type { CampaignData } from "./email-template-types";

// ── Brand tokens (mirror lib/email-template/shared/tokens.ts) ──
// Inlined here so this file is self-contained and the React
// component tree can be deleted in a follow-up cleanup.

const C = {
  white: "#FFFFFF",
  ivory: "#FFFDF0",
  lavender: "#DCDCEF",
  espresso: "#39341F",
  terracotta: "#915127",
  sage: "#D4E3BB",
  borderSubtle: "#E8E5D5",
  textOnDark: "#FFFDF0",
};

// Daniel (2026-06-23): "it should be Instrument Sans for the text
// copy and Syne — look at the brand book to see the fonts to use."
//
// The brand book typography table (V2 Brand Guidelines pg 15) lists:
//   Heading      Instrument Sans Medium
//   Subheading   Instrument Sans Semibold
//   Body text    Jost Regular                  ← Daniel overrode this
//   Pull quote   Syne Bold
//   Pull quote caption  Jost Medium             ← we don't use this
//
// Per Daniel's explicit direction, BODY now also uses Instrument
// Sans (not Jost). The brand book remains the long-term canonical
// reference but Daniel's pragmatic call: fewer typefaces = tighter
// system + faster Google Fonts load + lower chance of any font
// failing to render. Jost stays as the system fallback so email
// clients without Instrument Sans still get a humanist sans.
// IMPORTANT: family names use SINGLE quotes, not double. These strings
// are interpolated into double-quoted style="…" attributes; a double
// quote inside would terminate the attribute early and silently drop
// every CSS declaration after font-family (verified: it truncated
// headlines + CTA pills to default styling). Single quotes are valid
// CSS and safe inside both style="…" attributes and the <style> block.
const F = {
  display:
    "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif",
  body:
    "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif",
  pullquote: "'Syne', Georgia, 'Times New Roman', serif",
  logo: "Glitz, 'Cooper Std Black', 'Cooper Black', Georgia, serif",
};

const EMAIL_W = 600;

// ── HTML escape ────────────────────────────────────────────────

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}
function escAttr(s: string | null | undefined): string {
  return esc(s);
}

// ── Brand fonts ────────────────────────────────────────────────
// Per V2 BRAND-GUIDELINES.md: Instrument Sans (headings), Jost
// (body), Syne (pullquote). Glitz is LOGO ONLY — Cooper Black
// fallback covers it in email clients that block custom fonts.
//
// Loaded from Google Fonts. Many email clients block web fonts
// entirely (Outlook 2007-19 most notably) — those clients fall back
// to the system stack in each font-family declaration. The preview
// iframe in the editor + most modern clients (Apple Mail, iOS Mail,
// Gmail app) DO load these.
// Per Daniel's "use Instrument Sans + Syne" call, we only load two
// families now (was three: Instrument + Jost + Syne). Faster, more
// reliable. Glitz isn't loaded — it's logo-only and the logo is now
// a vendored SVG.
const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&amp;family=Syne:wght@600;700&amp;display=swap">`;

// ── Mobile media query ────────────────────────────────────────

const STYLE_BLOCK = `
  html, body {
    margin: 0; padding: 0; background: ${C.white};
    /* Safety net: anything that loses its inline font-family
       (email-client CSS stripping, dev-tools "computed style"
       inspection) inherits brand-correct Instrument Sans. */
    font-family: ${F.body};
  }
  img { display: block; border: 0; max-width: 100%; height: auto; }
  a { color: inherit; }
  table { border-collapse: collapse; }
  @media only screen and (max-width: 480px) {
    .jx-hero-headline { font-size: 32px !important; line-height: 1.15 !important; }
    .jx-hero-subtitle { font-size: 13px !important; }
    .jx-text-pad      { padding-left: 24px !important; padding-right: 24px !important; }
    .jx-section-heading { font-size: 14px !important; }
    .jx-section-body    { font-size: 14px !important; }
    .jx-cta-pill        { padding: 10px 22px !important; font-size: 12px !important; }
    .jx-grid-cell       { display: block !important; width: 100% !important; }
  }
`;

// CTA styling — sentence-case per BRAND-BIBLE.md ("Sentence case
// always. Never Title Case, never ALL CAPS."). Terracotta pill from
// the V2 secondary palette. Subtle letter-spacing for legibility on
// the button without shouting.
const CTA_STYLE = `display:inline-block;background:${C.terracotta};color:${C.ivory};text-decoration:none;font-family:${F.body};font-size:14px;font-weight:500;letter-spacing:0.02em;padding:13px 28px;border-radius:999px;`;

// Render a CTA pill — but only when there's a REAL destination. A
// missing/"#" URL would otherwise emit a fully-styled button that
// links nowhere; a dead button is worse than no button (the
// readiness/validate step already flags the missing URL to the
// operator). Returns "" when there's nothing to link to.
function ctaAnchor(label: string | null | undefined, url: string | null | undefined): string {
  const real = url && url.trim() && url.trim() !== "#" ? url.trim() : null;
  if (!real) return "";
  return `<a href="${escAttr(real)}" class="jx-cta-pill" style="${CTA_STYLE}">${esc(label || "Shop now")}</a>`;
}

// Center-weighted scrim — content is vertically centered in the hero,
// so the darkening/lightening peaks in the middle (behind the text)
// and eases toward both edges so the image still breathes.
function scrimGradient(scrim: "dark" | "light" | "none"): string {
  if (scrim === "dark")
    return "linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.12) 100%)";
  if (scrim === "light")
    return "linear-gradient(180deg, rgba(255,253,240,0.35) 0%, rgba(255,253,240,0.85) 50%, rgba(255,253,240,0.35) 100%)";
  return "";
}

// ── HEADER ─────────────────────────────────────────────────────

/**
 * Per BRAND-GUIDELINES.md §logo: the wordmark MUST be the real SVG
 * file — "Don't recreate the logo in a different font that 'looks
 * like Glitz.' It must be the actual file."
 *
 * The SVG lives at /public/brand/jaxy-logo-black.svg (copied from
 * the brand assets folder, vendored into the repo). The renderer
 * emits an absolute URL so the image still resolves when the email
 * is sent or screenshotted by Playwright — relative paths break
 * outside the dashboard.
 *
 * If campaign.logoImagePath is set (uploaded per-campaign override
 * for co-branding), we use that instead.
 */
function publicBaseUrl(): string {
  return (
    process.env.SHOPIFY_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_BASE_URL ||
    "https://theframe.getjaxy.com"
  );
}

function headerLogoOnly(): string {
  // Brand logo is fixed — Daniel: "we don't need any custom logos,
  // the current one is ok. we will never really change it so we
  // can remove this part of the app — make it static."
  // SVG lives at /public/brand/jaxy-logo-black.svg (vendored from
  // assets/logos/svg/jaxy-logo-black.svg). Width 96px per V2.
  const logoSrc = `${publicBaseUrl()}/brand/jaxy-logo-black.svg`;
  return `
  <tr>
    <td style="padding:32px 0 28px;text-align:center;background-color:${C.white};">
      <img
        src="${escAttr(logoSrc)}"
        alt="Jaxy"
        width="96"
        style="display:inline-block;height:auto;width:96px;max-width:96px;border:0;"
      />
    </td>
  </tr>`;
}

// ── HERO VARIANTS ──────────────────────────────────────────────

interface HeroProps {
  imageUrl: string | null;
  imageAlt: string;
  headline: string;
  subtitle: string;
  ctaLabel: string;
  ctaUrl: string;
}

function heroFullBleedOverlay(p: HeroProps & { scrim: "dark" | "light" | "none" }): string {
  const hasImg = !!p.imageUrl;
  // Legibility-safe: over an image, never leave text un-scrimmed. A
  // bare scrim:"none" + image would paint dark text on a photo with no
  // backdrop, so we treat "none over an image" as a subtle light scrim
  // (lightens behind the dark text). Explicit dark/light are preserved.
  const effScrim: "dark" | "light" | "none" =
    hasImg && p.scrim === "none" ? "light" : p.scrim;
  const isDark = effScrim === "dark";
  const textColor = isDark ? C.ivory : C.espresso;
  // Always shadow text when it sits over an image, regardless of scrim.
  const textShadow = hasImg
    ? isDark
      ? "0 1px 3px rgba(0,0,0,0.5)"
      : "0 1px 3px rgba(255,253,240,0.7)"
    : "none";
  const grad = scrimGradient(effScrim);
  const bg = p.imageUrl
    ? `background-color:${C.ivory};background-image:url('${escAttr(p.imageUrl)}');background-size:cover;background-position:center;`
    : `background-color:${C.ivory};`;
  const inner = grad ? `background-image:${grad};` : "";
  const cta = ctaAnchor(p.ctaLabel, p.ctaUrl);

  return `
  <tr>
    <td role="img" aria-label="${escAttr(p.imageAlt)}" style="position:relative;${bg}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td height="460" style="position:relative;height:460px;padding:48px 36px;text-align:center;vertical-align:middle;${inner}">
            <h1 class="jx-hero-headline" style="font-family:${F.display};font-size:44px;line-height:1.1;font-weight:500;color:${textColor};text-shadow:${textShadow};margin:0 0 12px;">${esc(p.headline)}</h1>
            <p class="jx-hero-subtitle" style="font-family:${F.body};font-size:14px;line-height:1.55;color:${textColor};text-shadow:${textShadow};margin:0 auto 20px;max-width:380px;">${esc(p.subtitle)}</p>
            ${cta}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function heroImage75Solid(p: HeroProps): string {
  const imgCell = p.imageUrl
    ? `<img src="${escAttr(p.imageUrl)}" alt="${escAttr(p.imageAlt)}" width="${Math.round(EMAIL_W * 0.75)}" style="width:100%;max-width:450px;height:auto;display:block;margin:0 auto;" />`
    : `<div style="width:100%;aspect-ratio:1/1;background:${C.lavender};color:${C.espresso};display:flex;align-items:center;justify-content:center;font-size:11px;font-family:${F.body};letter-spacing:0.1em;">[ hero image — 900×900 centered ]</div>`;
  const cta = ctaAnchor(p.ctaLabel, p.ctaUrl);

  return `
  <tr>
    <td style="background-color:${C.white};padding:8px 0 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="12.5%">&nbsp;</td>
          <td width="75%" style="text-align:center;">${imgCell}</td>
          <td width="12.5%">&nbsp;</td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td class="jx-text-pad" style="padding:28px 36px 0;text-align:center;">
            <h1 class="jx-hero-headline" style="font-family:${F.display};font-size:44px;line-height:1.1;font-weight:500;color:${C.espresso};margin:0;">${esc(p.headline)}</h1>
            <p class="jx-hero-subtitle" style="font-family:${F.body};font-size:15px;line-height:1.55;color:${C.espresso};margin:10px auto 0;max-width:380px;font-weight:400;">${esc(p.subtitle)}</p>
            ${cta ? `<div style="margin-top:20px;">${cta}</div>` : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function heroSplit5050(p: HeroProps): string {
  const leftCell = p.imageUrl
    ? `background-color:${C.ivory};background-image:url('${escAttr(p.imageUrl)}');background-size:cover;background-position:center;`
    : `background-color:${C.ivory};`;
  const placeholder = p.imageUrl
    ? ""
    : `<div style="text-align:center;color:${C.espresso};font-size:10px;font-family:${F.body};letter-spacing:0.1em;padding:16px;">[ hero image — 600×900 portrait, fills left ]</div>`;
  const cta = ctaAnchor(p.ctaLabel, p.ctaUrl);

  return `
  <tr>
    <td style="background-color:${C.white};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td class="jx-grid-cell" width="50%" role="img" aria-label="${escAttr(p.imageAlt)}" style="${leftCell}min-height:460px;vertical-align:middle;">${placeholder}</td>
          <td class="jx-grid-cell" width="50%" style="padding:40px 28px;vertical-align:middle;background-color:${C.white};text-align:left;">
            <h1 class="jx-hero-headline" style="font-family:${F.display};font-size:36px;line-height:1.15;font-weight:500;color:${C.espresso};margin:0 0 12px;">${esc(p.headline)}</h1>
            <p class="jx-hero-subtitle" style="font-family:${F.body};font-size:14px;line-height:1.55;color:${C.espresso};margin:0 0 ${cta ? "22px" : "0"};">${esc(p.subtitle)}</p>
            ${cta}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

// ── SECTION A VARIANTS ─────────────────────────────────────────

function sectionACentered(p: { heading: string; body: string }): string {
  return `
  <tr>
    <td class="jx-text-pad" style="padding:40px 36px 28px;text-align:center;background-color:${C.white};">
      <div class="jx-section-heading" style="font-family:${F.display};font-size:15px;font-weight:600;letter-spacing:0.01em;color:${C.espresso};margin:0 0 14px;">${esc(p.heading)}</div>
      <p class="jx-section-body" style="font-family:${F.body};font-size:15px;line-height:1.65;color:${C.espresso};margin:0;">${esc(p.body)}</p>
    </td>
  </tr>`;
}

function sectionAWithPullquote(p: { heading: string; body: string }): string {
  const sentences = p.body.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const pullquote = sentences.reduce((a, b) => (b.length > a.length ? b : a), "");
  const rest = sentences.filter(s => s !== pullquote).join(" ");

  // A pull quote needs supporting copy beneath it. On a single-sentence
  // body (or when nothing is left after pulling the quote) the layout
  // degenerates into a lone floating italic line — fall back to the
  // clean centered layout instead.
  if (sentences.length < 2 || !rest) {
    return sectionACentered(p);
  }

  return `
  <tr>
    <td class="jx-text-pad" style="padding:40px 36px 28px;text-align:center;background-color:${C.white};">
      <div class="jx-section-heading" style="font-family:${F.display};font-size:15px;font-weight:600;letter-spacing:0.01em;color:${C.espresso};margin:0 0 14px;">${esc(p.heading)}</div>
      <p style="font-family:${F.pullquote};font-style:italic;font-size:22px;line-height:1.4;color:${C.espresso};max-width:480px;margin:0 auto 18px;">&ldquo;${esc(pullquote)}&rdquo;</p>
      ${rest ? `<p class="jx-section-body" style="font-family:${F.body};font-size:15px;line-height:1.65;color:${C.espresso};margin:0;">${esc(rest)}</p>` : ""}
    </td>
  </tr>`;
}

// ── SECONDARY IMAGE VARIANTS ───────────────────────────────────

function secondaryFullBleed(p: { imageUrl: string | null; imageAlt: string }): string {
  const inner = p.imageUrl
    ? `<img src="${escAttr(p.imageUrl)}" alt="${escAttr(p.imageAlt)}" width="${EMAIL_W}" style="width:100%;height:360px;object-fit:cover;display:block;" />`
    : `<div style="display:flex;align-items:flex-end;justify-content:center;height:360px;padding:16px;color:${C.espresso};font-size:10px;font-family:${F.body};letter-spacing:0.1em;">[ secondary image — 1200×800 full bleed ]</div>`;
  const bg = p.imageUrl ? "" : `background-color:${C.ivory};`;

  return `
  <tr>
    <td role="img" aria-label="${escAttr(p.imageAlt)}" style="${bg}height:360px;position:relative;">${inner}</td>
  </tr>`;
}

function secondaryCentered75(p: { imageUrl: string | null; imageAlt: string }): string {
  const imgCell = p.imageUrl
    ? `<img src="${escAttr(p.imageUrl)}" alt="${escAttr(p.imageAlt)}" width="${Math.round(EMAIL_W * 0.75)}" style="width:100%;max-width:450px;height:auto;display:block;margin:0 auto;" />`
    : `<div style="width:100%;aspect-ratio:9/8;background:${C.lavender};color:${C.espresso};display:flex;align-items:center;justify-content:center;font-size:11px;font-family:${F.body};letter-spacing:0.1em;">[ secondary image — 900×800 centered ]</div>`;

  return `
  <tr>
    <td style="background-color:${C.white};padding:12px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="12.5%">&nbsp;</td>
          <td width="75%" style="text-align:center;">${imgCell}</td>
          <td width="12.5%">&nbsp;</td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function secondaryGrid2Up(p: {
  imageUrl: string | null;
  imageUrl2: string | null;
  imageAlt: string;
  imageAlt2: string;
}): string {
  const cell = (url: string | null, alt: string, fallbackColor: string, idx: number) =>
    url
      ? `<img src="${escAttr(url)}" alt="${escAttr(alt)}" width="290" style="width:100%;height:auto;display:block;" />`
      : `<div style="width:100%;aspect-ratio:1/1;background:${fallbackColor};color:${C.espresso};display:flex;align-items:center;justify-content:center;font-size:10px;font-family:${F.body};letter-spacing:0.1em;">[ image ${idx} — 580×580 ]</div>`;

  return `
  <tr>
    <td style="background-color:${C.white};padding:12px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="8">
        <tr>
          <td class="jx-grid-cell" width="50%" style="padding:0 4px;">${cell(p.imageUrl, p.imageAlt, C.lavender, 1)}</td>
          <td class="jx-grid-cell" width="50%" style="padding:0 4px;">${cell(p.imageUrl2, p.imageAlt2, C.sage, 2)}</td>
        </tr>
      </table>
    </td>
  </tr>`;
}

// ── SECTION B VARIANTS ─────────────────────────────────────────

interface SectionBProps {
  heading: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
}

function sectionBCenteredWithCta(p: SectionBProps): string {
  const paras = p.body.split(/\n\n+/).map(x => x.trim()).filter(Boolean);
  const paraHtml = paras
    .map((para, i) => {
      const mb = i < paras.length - 1 ? 12 : 22;
      return `<p class="jx-section-body" style="font-family:${F.body};font-size:15px;line-height:1.65;color:${C.espresso};margin:0 0 ${mb}px;">${esc(para)}</p>`;
    })
    .join("");

  return `
  <tr>
    <td class="jx-text-pad" style="padding:36px 36px 48px;text-align:center;background-color:${C.white};">
      <div class="jx-section-heading" style="font-family:${F.display};font-size:15px;font-weight:600;letter-spacing:0.01em;color:${C.espresso};margin:0 0 14px;">${esc(p.heading)}</div>
      ${paraHtml}
      ${ctaAnchor(p.ctaLabel, p.ctaUrl)}
    </td>
  </tr>`;
}

function sectionBTwoColumnWithCta(p: SectionBProps): string {
  const paras = p.body.split(/\n\n+/).map(x => x.trim()).filter(Boolean);
  const [left, right] = paras;
  if (!right) return sectionBCenteredWithCta(p);

  return `
  <tr>
    <td class="jx-text-pad" style="padding:36px 36px 48px;text-align:center;background-color:${C.white};">
      <div class="jx-section-heading" style="font-family:${F.display};font-size:15px;font-weight:600;letter-spacing:0.01em;color:${C.espresso};margin:0 0 20px;text-align:center;">${esc(p.heading)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td class="jx-grid-cell" width="48%" style="vertical-align:top;padding-right:12px;">
            <p class="jx-section-body" style="font-family:${F.body};font-size:15px;line-height:1.65;color:${C.espresso};text-align:left;margin:0 0 16px;">${esc(left)}</p>
          </td>
          <td class="jx-grid-cell" width="4%">&nbsp;</td>
          <td class="jx-grid-cell" width="48%" style="vertical-align:top;padding-left:12px;">
            <p class="jx-section-body" style="font-family:${F.body};font-size:15px;line-height:1.65;color:${C.espresso};text-align:left;margin:0 0 16px;">${esc(right)}</p>
          </td>
        </tr>
      </table>
      ${(() => { const cta = ctaAnchor(p.ctaLabel, p.ctaUrl); return cta ? `<div style="margin-top:12px;text-align:center;">${cta}</div>` : ""; })()}
    </td>
  </tr>`;
}

// ── DISPATCHER ─────────────────────────────────────────────────

const PLACEHOLDER = "—";

function imgUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return catalogImageUrl(path);
}

function dispatchHero(c: CampaignData): string {
  const common = {
    imageUrl: imgUrl(c.heroImagePath),
    imageAlt: c.heroImageAlt ?? "",
    headline: c.heroHeadline ?? PLACEHOLDER,
    subtitle: c.heroSubtitle ?? PLACEHOLDER,
    ctaLabel: c.heroCtaLabel ?? "Find your pair",
    ctaUrl: c.heroCtaUrl ?? "#",
  };
  switch (c.heroVariant) {
    case "image_75_solid": return heroImage75Solid(common);
    case "split_50_50": return heroSplit5050(common);
    case "full_bleed_overlay":
    default: return heroFullBleedOverlay({ ...common, scrim: c.heroScrim ?? "dark" });
  }
}

function dispatchSectionA(c: CampaignData): string {
  const common = {
    heading: c.sectionAHeading ?? PLACEHOLDER,
    body: c.sectionABody ?? PLACEHOLDER,
  };
  switch (c.sectionAVariant) {
    case "with_pullquote": return sectionAWithPullquote(common);
    case "centered":
    default: return sectionACentered(common);
  }
}

function dispatchSecondary(c: CampaignData): string {
  const url = imgUrl(c.secondaryImagePath);
  const url2 = imgUrl(c.secondaryImagePath2);
  const alt = c.secondaryImageAlt ?? "";
  const alt2 = c.secondaryImageAlt2 ?? "";
  switch (c.secondaryImageVariant) {
    case "centered_75": return secondaryCentered75({ imageUrl: url, imageAlt: alt });
    case "grid_2up": return secondaryGrid2Up({ imageUrl: url, imageUrl2: url2, imageAlt: alt, imageAlt2: alt2 });
    case "full_bleed":
    default: return secondaryFullBleed({ imageUrl: url, imageAlt: alt });
  }
}

function dispatchSectionB(c: CampaignData): string {
  const common = {
    heading: c.sectionBHeading ?? PLACEHOLDER,
    body: c.sectionBBody ?? PLACEHOLDER,
    ctaLabel: c.sectionBCtaLabel ?? "See more",
    ctaUrl: c.sectionBCtaUrl ?? "#",
  };
  switch (c.sectionBVariant) {
    case "two_column_with_cta": return sectionBTwoColumnWithCta(common);
    case "centered_with_cta":
    default: return sectionBCenteredWithCta(common);
  }
}

/**
 * Render a campaign to a full HTML document (includes DOCTYPE).
 * Pure string building — no React, no react-dom/server.
 */
export type SectionKind = "hero" | "sectionA" | "secondary" | "sectionB";

/**
 * Render a SINGLE section in isolation, wrapped in the same
 * <html><head> shell (so fonts + media queries still load).
 *
 * Used by the client-side image export — the editor loads this URL
 * into an offscreen iframe and rasterizes the body with html-to-image,
 * then the operator pastes/downloads the JPG into Faire / wherever.
 * (No server browser: the deploy has no Chromium system libs.)
 *
 * The wrapper table mirrors the structure of the full email so
 * widths + padding stay identical — a hero block rendered alone
 * looks exactly like the hero block in the assembled email.
 */
export function renderSectionHtml(campaign: CampaignData, kind: SectionKind): string {
  let inner = "";
  switch (kind) {
    case "hero":      inner = dispatchHero(campaign); break;
    case "sectionA":  inner = dispatchSectionA(campaign); break;
    case "secondary": inner = dispatchSecondary(campaign); break;
    case "sectionB":  inner = dispatchSectionB(campaign); break;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jaxy email section — ${kind}</title>
${FONT_LINK}
<style>${STYLE_BLOCK}
  body { background: ${C.white}; }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.white};font-family:${F.body};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${C.white};border-collapse:collapse;">
  <tr>
    <td align="center" style="padding:0;">
      <table role="presentation" width="${EMAIL_W}" cellpadding="0" cellspacing="0" style="width:${EMAIL_W}px;max-width:100%;background-color:${C.white};border-collapse:collapse;">
        ${inner}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export function renderEmailHtml(campaign: CampaignData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>Jaxy email preview</title>
${FONT_LINK}
<style>${STYLE_BLOCK}</style>
</head>
<body style="margin:0;padding:0;background-color:${C.white};font-family:${F.body};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${C.white};border-collapse:collapse;">
  <tr>
    <td align="center" style="padding:0;">
      <table role="presentation" width="${EMAIL_W}" cellpadding="0" cellspacing="0" style="width:${EMAIL_W}px;max-width:100%;background-color:${C.white};border-collapse:collapse;">
        ${headerLogoOnly()}
        ${campaign.heroDisabled ? "" : dispatchHero(campaign)}
        ${campaign.sectionADisabled ? "" : dispatchSectionA(campaign)}
        ${campaign.secondaryDisabled ? "" : dispatchSecondary(campaign)}
        ${campaign.sectionBDisabled ? "" : dispatchSectionB(campaign)}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
