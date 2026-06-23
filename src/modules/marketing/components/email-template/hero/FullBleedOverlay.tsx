import { colors, fonts, layout } from "../shared/tokens";
import { ctaPillStyle, scrimGradient } from "../shared/styles";

/**
 * Hero variant: full-bleed image with HTML overlay (headline,
 * subtitle, CTA) in the top portion.
 *
 * The designer's Higgsfield brief should leave the top 30% of the
 * image visually calm (sky, soft blur, pale wall) so HTML text
 * reads cleanly. A scrim gradient is layered on top for extra
 * legibility — dark for light images, light for dark images, none
 * if the image already has the right contrast.
 *
 * Email-client compat note: positioning an HTML overlay on top of
 * an image is tricky in Outlook. We use a table cell with a
 * background-image style; Outlook falls back to the bgcolor cream
 * tone if it ignores the bg-image, and the text + CTA stay
 * readable on cream because they have proper contrast either way.
 */
export interface FullBleedOverlayProps {
  imageUrl: string | null;        // null = preview placeholder
  imageAlt: string;
  headline: string;
  subtitle: string;
  ctaLabel: string;
  ctaUrl: string;
  scrim: "dark" | "light" | "none";
}

export function HeroFullBleedOverlay({
  imageUrl, imageAlt, headline, subtitle, ctaLabel, ctaUrl, scrim,
}: FullBleedOverlayProps) {
  const isDark = scrim === "dark";
  const textColor = isDark ? colors.ivory : colors.espresso;
  const textShadow = isDark
    ? "0 1px 2px rgba(0,0,0,0.15)"
    : "none";
  const scrimGrad = scrimGradient(scrim);

  // Background uses a pale ivory tone as fallback when image absent
  // or blocked. Image goes via inline background-image.
  const bgColor = colors.ivory;
  const bgStyle: React.CSSProperties = {
    backgroundColor: bgColor,
    ...(imageUrl
      ? {
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }
      : {}),
  };

  return (
    <tr>
      <td
        role="img"
        aria-label={imageAlt}
        style={{
          position: "relative" as const,
          minHeight: layout.heroHeight,
          ...bgStyle,
        }}
      >
        {/* Outer wrapper table for vertical alignment of the top
            overlay content. Email clients respect <table> alignment
            better than they do divs. */}
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={{
                position: "relative" as const,
                padding: "40px 36px 0",
                textAlign: "center" as const,
                // Scrim is implemented as a colored linear-gradient
                // applied to the cell background. Stacks on top of
                // the image via background composition. In clients
                // that don't honor multiple backgrounds, scrim falls
                // out and image stays — graceful degrade.
                backgroundImage: scrimGrad,
                minHeight: layout.heroHeight,
              }}>
                <h1
                  className="jx-hero-headline"
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 44,
                    lineHeight: 1.1,
                    fontWeight: 500,
                    color: textColor,
                    textShadow,
                    margin: "0 0 12px",
                  }}
                >
                  {headline}
                </h1>
                <p
                  className="jx-hero-subtitle"
                  style={{
                    fontFamily: fonts.body,
                    fontSize: 14,
                    lineHeight: 1.55,
                    color: textColor,
                    textShadow,
                    margin: "0 auto 20px",
                    maxWidth: 380,
                  }}
                >
                  {subtitle}
                </p>
                {/* CTA pill — always visible regardless of scrim, since
                    its own background gives it contrast. */}
                <a
                  href={ctaUrl}
                  className="jx-cta-pill"
                  style={ctaPillStyle()}
                >
                  {ctaLabel}
                </a>
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  );
}

HeroFullBleedOverlay.variant = "full_bleed_overlay" as const;
HeroFullBleedOverlay.dimensions = { width: 1200, height: 900 };
HeroFullBleedOverlay.safeZone = "top 30% must be calm (sky / soft blur / cream wall)";
