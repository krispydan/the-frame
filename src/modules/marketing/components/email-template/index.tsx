import { STYLE_BLOCK } from "./shared/styles";
import { colors, fonts, layout } from "./shared/tokens";

import { HeaderLogoOnly } from "./header/LogoOnly";

import { HeroFullBleedOverlay } from "./hero/FullBleedOverlay";
import { HeroImage75Solid } from "./hero/Image75Solid";
import { HeroSplit5050 } from "./hero/Split5050";

import { SectionACentered } from "./sectionA/Centered";
import { SectionAWithPullquote } from "./sectionA/WithPullquote";

import { SecondaryFullBleed } from "./secondary/FullBleed";
import { SecondaryCentered75 } from "./secondary/Centered75";
import { SecondaryGrid2Up } from "./secondary/Grid2Up";

import { SectionBCenteredWithCta } from "./sectionB/CenteredWithCta";
import { SectionBTwoColumnWithCta } from "./sectionB/TwoColumnWithCta";

/**
 * EmailTemplateRenderer — the dispatcher.
 *
 * Takes a campaign row's data and assembles the email by dispatching
 * each block to the correct variant component. The entire returned
 * tree is email-safe HTML (table-based outer layout) rendered server-
 * side via React.
 *
 * Caller pattern (route handler):
 *   import { renderToStaticMarkup } from "react-dom/server";
 *   const html = renderToStaticMarkup(<EmailTemplateRenderer campaign={...} />);
 *
 * Adding a new variant = drop a component file, add an enum case here.
 * Nothing in the variant component files needs to know about the others.
 */

export interface CampaignData {
  // Hero
  heroVariant: "full_bleed_overlay" | "image_75_solid" | "split_50_50";
  heroImagePath?: string | null;
  heroImageAlt?: string | null;
  heroHeadline?: string | null;
  heroSubtitle?: string | null;
  heroCtaLabel?: string | null;
  heroCtaUrl?: string | null;
  heroScrim?: "dark" | "light" | "none" | null;

  // Section A
  sectionAVariant: "centered" | "with_pullquote";
  sectionAHeading?: string | null;
  sectionABody?: string | null;

  // Secondary image
  secondaryImageVariant: "full_bleed" | "centered_75" | "grid_2up";
  secondaryImagePath?: string | null;
  secondaryImagePath2?: string | null;
  secondaryImageAlt?: string | null;
  secondaryImageAlt2?: string | null;

  // Section B
  sectionBVariant: "centered_with_cta" | "two_column_with_cta";
  sectionBHeading?: string | null;
  sectionBBody?: string | null;
  sectionBCtaLabel?: string | null;
  sectionBCtaUrl?: string | null;
}

interface RendererProps {
  campaign: CampaignData;
  /** Returns the public URL for a stored image path. Caller injects so
   *  the renderer can be used in both server-side render + preview iframe
   *  paths without coupling to a specific URL helper. May return null
   *  for unresolvable paths — we degrade to the placeholder block. */
  imageUrlFor?: (path: string) => string | null;
}

const PLACEHOLDER = "—";

function imgUrl(
  path: string | null | undefined,
  urlFn?: (p: string) => string | null,
): string | null {
  if (!path) return null;
  if (!urlFn) return path;
  return urlFn(path);
}

export function EmailTemplateRenderer({ campaign: c, imageUrlFor }: RendererProps) {
  // ── HERO ──
  const heroBlock = (() => {
    const common = {
      imageUrl: imgUrl(c.heroImagePath, imageUrlFor),
      imageAlt: c.heroImageAlt ?? "",
      headline: c.heroHeadline ?? PLACEHOLDER,
      subtitle: c.heroSubtitle ?? PLACEHOLDER,
      ctaLabel: c.heroCtaLabel ?? "Find your pair",
      ctaUrl: c.heroCtaUrl ?? "#",
    };
    switch (c.heroVariant) {
      case "image_75_solid":
        return <HeroImage75Solid {...common} />;
      case "split_50_50":
        return <HeroSplit5050 {...common} />;
      case "full_bleed_overlay":
      default:
        return <HeroFullBleedOverlay {...common} scrim={c.heroScrim ?? "dark"} />;
    }
  })();

  // ── SECTION A ──
  const sectionABlock = (() => {
    const common = {
      heading: c.sectionAHeading ?? PLACEHOLDER,
      body: c.sectionABody ?? PLACEHOLDER,
    };
    switch (c.sectionAVariant) {
      case "with_pullquote":
        return <SectionAWithPullquote {...common} />;
      case "centered":
      default:
        return <SectionACentered {...common} />;
    }
  })();

  // ── SECONDARY IMAGE ──
  const secondaryBlock = (() => {
    const url = imgUrl(c.secondaryImagePath, imageUrlFor);
    const url2 = imgUrl(c.secondaryImagePath2, imageUrlFor);
    const alt = c.secondaryImageAlt ?? "";
    const alt2 = c.secondaryImageAlt2 ?? "";
    switch (c.secondaryImageVariant) {
      case "centered_75":
        return <SecondaryCentered75 imageUrl={url} imageAlt={alt} />;
      case "grid_2up":
        return <SecondaryGrid2Up imageUrl={url} imageUrl2={url2} imageAlt={alt} imageAlt2={alt2} />;
      case "full_bleed":
      default:
        return <SecondaryFullBleed imageUrl={url} imageAlt={alt} />;
    }
  })();

  // ── SECTION B ──
  const sectionBBlock = (() => {
    const common = {
      heading: c.sectionBHeading ?? PLACEHOLDER,
      body: c.sectionBBody ?? PLACEHOLDER,
      ctaLabel: c.sectionBCtaLabel ?? "See more",
      ctaUrl: c.sectionBCtaUrl ?? "#",
    };
    switch (c.sectionBVariant) {
      case "two_column_with_cta":
        return <SectionBTwoColumnWithCta {...common} />;
      case "centered_with_cta":
      default:
        return <SectionBCenteredWithCta {...common} />;
    }
  })();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="x-apple-disable-message-reformatting" />
        <title>Jaxy email preview</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE_BLOCK }} />
      </head>
      <body style={{ margin: 0, padding: 0, backgroundColor: colors.white, fontFamily: fonts.body }}>
        {/* Outer wrapper — 600px centered, background prevents
            Outlook from defaulting to a weird default bg. */}
        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          style={{ backgroundColor: colors.white, borderCollapse: "collapse" as const }}
        >
          <tbody>
            <tr>
              <td align="center" style={{ padding: 0 }}>
                <table
                  role="presentation"
                  width={layout.emailWidth}
                  cellPadding={0}
                  cellSpacing={0}
                  style={{
                    width: layout.emailWidth,
                    maxWidth: "100%",
                    backgroundColor: colors.white,
                    borderCollapse: "collapse" as const,
                  }}
                >
                  <tbody>
                    <HeaderLogoOnly />
                    {heroBlock}
                    {sectionABlock}
                    {secondaryBlock}
                    {sectionBBlock}
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}
