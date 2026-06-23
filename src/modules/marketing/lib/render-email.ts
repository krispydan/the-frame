/**
 * Email HTML renderer — pure string templates.
 *
 * Why no React: Next 16 + Turbopack rejects every variant of
 * `react-dom/server` imports inside the App Router. The string-template
 * approach has zero framework dependency, zero runtime cost, and stays
 * email-safe (table layout + inline styles).
 *
 * One render path: clean modern-client HTML used by the editor preview
 * iframe AND captured to an image by the client-side "Export image"
 * action (html-to-image). Adding a new variant = drop a function below
 * + a case in the dispatcher.
 */

import { catalogImageUrl } from "@/lib/storage/image-url";
import type { CampaignData } from "./email-template-types";

// ── Brand tokens ────────────────────────────────────────────────

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

const F = {
  display:
    '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
  body:
    'Jost, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
  pullquote: '"Syne", Georgia, "Times New Roman", serif',
  logo: 'Glitz, "Cooper Std Black", "Cooper Black", Georgia, serif',
};

const EMAIL_W = 600;
const HERO_H = 460;

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
const escAttr = esc;

// ── Brand fonts ────────────────────────────────────────────────
const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Jost:wght@300;400;500;600&family=Syne:wght@600;700&display=swap">`;

// ── Mobile media query ────────────────────────────────────────
const STYLE_BLOCK = `
  body { margin: 0; padding: 0; background: ${C.white}; }
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

const CTA_STYLE = `display:inline-block;background:${C.terracotta};color:${C.ivory};text-decoration:none;font-family:${F.body};font-size:14px;font-weight:500;letter-spacing:0.02em;padding:13px 28px;border-radius:999px;`;

function scrimGradient(scrim: "dark" | "light" | "none"): string {
  if (scrim === "dark")
    return "linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0) 55%)";
  if (scrim === "light")
    return "linear-gradient(180deg, rgba(255,253,240,0.7) 0%, rgba(255,253,240,0) 55%)";
  return "";
}

function ctaButton(label: string, url: string): string {
  return `<a href="${escAttr(url)}" class="jx-cta-pill" style="${CTA_STYLE}">${esc(label)}</a>`;
}

// ── HEADER ─────────────────────────────────────────────────────

function headerLogoOnly(): string {
  return `
  <tr>
    <td style="padding:28px 0 24px;text-align:center;background-color:${C.white};">
      <span style="font-family:${F.logo};font-size:30px;font-weight:700;letter-spacing:0.04em;color:${C.espresso};">Jaxy</span>
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
  const isDark = p.scrim === "dark";
  const textColor = isDark ? C.ivory : C.espresso;
  const textShadow = isDark ? "0 1px 2px rgba(0,0,0,0.15)" : "none";
  const grad = scrimGradient(p.scrim);
  const bg = p.imageUrl
    ? `background-color:${C.ivory};background-image:url('${escAttr(p.imageUrl)}');background-size:cover;background-position:center;`
    : `background-color:${C.ivory};`;
  const inner = grad ? `background-image:${grad};` : "";

  return `
  <tr>
    <td role="img" aria-label="${escAttr(p.imageAlt)}" style="position:relative;min-height:${HERO_H}px;${bg}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="position:relative;padding:40px 36px 44px;text-align:center;${inner}min-height:${HERO_H}px;">
            <h1 class="jx-hero-headline" style="font-family:${F.display};font-size:44px;line-height:1.1;font-weight:500;color:${textColor};text-shadow:${textShadow};margin:0 0 12px;">${esc(p.headline)}</h1>
            <p class="jx-hero-subtitle" style="font-family:${F.body};font-size:14px;line-height:1.55;color:${textColor};text-shadow:${textShadow};margin:0 auto 20px;max-width:380px;">${esc(p.subtitle)}</p>
            ${ctaButton(p.ctaLabel, p.ctaUrl)}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function heroImage75Solid(p: HeroProps): string {
  const imgCell = p.imageUrl
    ? `<img src="${escAttr(p.imageUrl)}" alt="${escAttr(p.imageAlt)}" width="${Math.round(EMAIL_W * 0.75)}" style="width:100%;max-width:450px;height:auto;display:block;margin:0 auto;" />`
    : `<div style="width:100%;height:300px;line-height:300px;background:${C.lavender};color:${C.espresso};text-align:center;font-size:11px;font-family:${F.body};letter-spacing:0.1em;">[ hero image — 900×900 centered ]</div>`;

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
            <div style="margin-top:20px;">${ctaButton(p.ctaLabel, p.ctaUrl)}</div>
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

  return `
  <tr>
    <td style="background-color:${C.white};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td class="jx-grid-cell" width="50%" role="img" aria-label="${escAttr(p.imageAlt)}" style="${leftCell}min-height:${HERO_H}px;vertical-align:middle;">${placeholder}</td>
          <td class="jx-grid-cell" width="50%" style="padding:40px 28px;vertical-align:middle;background-color:${C.white};text-align:left;">
            <h1 class="jx-hero-headline" style="font-family:${F.display};font-size:36px;line-height:1.15;font-weight:500;color:${C.espresso};margin:0 0 12px;">${esc(p.headline)}</h1>
            <p class="jx-hero-subtitle" style="font-family:${F.body};font-size:14px;line-height:1.55;color:${C.espresso};margin:0 0 22px;">${esc(p.subtitle)}</p>
            ${ctaButton(p.ctaLabel, p.ctaUrl)}
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
  const sentences = p.body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const pullquote = sentences.reduce((a, b) => (b.length > a.length ? b : a), "");
  const rest = sentences.filter((s) => s !== pullquote).join(" ");

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
    : `<div style="height:360px;line-height:360px;text-align:center;color:${C.espresso};font-size:10px;font-family:${F.body};letter-spacing:0.1em;background-color:${C.ivory};">[ secondary image — 1200×800 full bleed ]</div>`;

  return `
  <tr>
    <td role="img" aria-label="${escAttr(p.imageAlt)}">${inner}</td>
  </tr>`;
}

function secondaryCentered75(p: { imageUrl: string | null; imageAlt: string }): string {
  const imgCell = p.imageUrl
    ? `<img src="${escAttr(p.imageUrl)}" alt="${escAttr(p.imageAlt)}" width="${Math.round(EMAIL_W * 0.75)}" style="width:100%;max-width:450px;height:auto;display:block;margin:0 auto;" />`
    : `<div style="width:100%;height:300px;line-height:300px;text-align:center;background:${C.lavender};color:${C.espresso};font-size:11px;font-family:${F.body};letter-spacing:0.1em;">[ secondary image — 900×800 centered ]</div>`;

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
      : `<div style="width:100%;height:200px;line-height:200px;text-align:center;background:${fallbackColor};color:${C.espresso};font-size:10px;font-family:${F.body};letter-spacing:0.1em;">[ image ${idx} — 580×580 ]</div>`;

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
  const paras = p.body.split(/\n\n+/).map((x) => x.trim()).filter(Boolean);
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
      ${ctaButton(p.ctaLabel, p.ctaUrl)}
    </td>
  </tr>`;
}

function sectionBTwoColumnWithCta(p: SectionBProps): string {
  const paras = p.body.split(/\n\n+/).map((x) => x.trim()).filter(Boolean);
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
      <div style="margin-top:12px;text-align:center;">${ctaButton(p.ctaLabel, p.ctaUrl)}</div>
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
    case "image_75_solid":
      return heroImage75Solid(common);
    case "split_50_50":
      return heroSplit5050(common);
    case "full_bleed_overlay":
    default:
      return heroFullBleedOverlay({ ...common, scrim: c.heroScrim ?? "dark" });
  }
}

function dispatchSectionA(c: CampaignData): string {
  const common = {
    heading: c.sectionAHeading ?? PLACEHOLDER,
    body: c.sectionABody ?? PLACEHOLDER,
  };
  switch (c.sectionAVariant) {
    case "with_pullquote":
      return sectionAWithPullquote(common);
    case "centered":
    default:
      return sectionACentered(common);
  }
}

function dispatchSecondary(c: CampaignData): string {
  const url = imgUrl(c.secondaryImagePath);
  const url2 = imgUrl(c.secondaryImagePath2);
  const alt = c.secondaryImageAlt ?? "";
  const alt2 = c.secondaryImageAlt2 ?? "";
  switch (c.secondaryImageVariant) {
    case "centered_75":
      return secondaryCentered75({ imageUrl: url, imageAlt: alt });
    case "grid_2up":
      return secondaryGrid2Up({ imageUrl: url, imageUrl2: url2, imageAlt: alt, imageAlt2: alt2 });
    case "full_bleed":
    default:
      return secondaryFullBleed({ imageUrl: url, imageAlt: alt });
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
    case "two_column_with_cta":
      return sectionBTwoColumnWithCta(common);
    case "centered_with_cta":
    default:
      return sectionBCenteredWithCta(common);
  }
}

/** Render a campaign to a full HTML document (includes DOCTYPE). */
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
        ${dispatchHero(campaign)}
        ${dispatchSectionA(campaign)}
        ${dispatchSecondary(campaign)}
        ${dispatchSectionB(campaign)}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
