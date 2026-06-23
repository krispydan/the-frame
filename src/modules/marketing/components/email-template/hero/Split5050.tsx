import { colors, fonts, layout } from "../shared/tokens";
import { ctaPillStyle } from "../shared/styles";

/**
 * Hero variant: image fills LEFT half, text/CTA fills RIGHT half.
 *
 * Best for Faire promo emails (mirrors Faire's own storefront card
 * layout) and seasonal pivots where the visual is moody (better as
 * its own column, not as background to overlaid text).
 *
 * Email-client compat: 2-column tables work everywhere. We use
 * inline width="50%" on the td cells, and the mobile @media
 * query in shared/styles.ts stacks them via the .jx-grid-cell class.
 *
 * Designer brief: 600×900 (portrait). Subject in the photo can
 * sit anywhere — there's no overlay to worry about.
 */
export interface Split5050Props {
  imageUrl: string | null;
  imageAlt: string;
  headline: string;
  subtitle: string;
  ctaLabel: string;
  ctaUrl: string;
}

export function HeroSplit5050({
  imageUrl, imageAlt, headline, subtitle, ctaLabel, ctaUrl,
}: Split5050Props) {
  return (
    <tr>
      <td style={{ backgroundColor: colors.white }}>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
          <tbody>
            <tr>
              {/* Image column — left 50% */}
              <td
                className="jx-grid-cell"
                width="50%"
                role="img"
                aria-label={imageAlt}
                style={{
                  backgroundColor: colors.ivory,
                  ...(imageUrl
                    ? {
                        backgroundImage: `url(${imageUrl})`,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                      }
                    : {}),
                  minHeight: 460,
                  verticalAlign: "middle" as const,
                }}
              >
                {!imageUrl && (
                  <div style={{
                    textAlign: "center" as const,
                    color: colors.espresso,
                    fontSize: 10,
                    fontFamily: fonts.body,
                    letterSpacing: "0.1em",
                    padding: 16,
                  }}>
                    [ hero image — 600×900 portrait, fills left ]
                  </div>
                )}
              </td>

              {/* Text column — right 50% */}
              <td
                className="jx-grid-cell"
                width="50%"
                style={{
                  padding: "40px 28px",
                  verticalAlign: "middle" as const,
                  backgroundColor: colors.white,
                  textAlign: "left" as const,
                }}
              >
                <h1
                  className="jx-hero-headline"
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 36,  // slightly smaller for split — narrower column
                    lineHeight: 1.15,
                    fontWeight: 500,
                    color: colors.espresso,
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
                    color: colors.espresso,
                    margin: "0 0 22px",
                  }}
                >
                  {subtitle}
                </p>
                <a href={ctaUrl} className="jx-cta-pill" style={ctaPillStyle()}>
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

HeroSplit5050.variant = "split_50_50" as const;
HeroSplit5050.dimensions = { width: 600, height: 900 };
