import { colors, fonts, layout } from "../shared/tokens";
import { ctaPillStyle, headlineStyle, subtitleStyle } from "../shared/styles";

/**
 * Hero variant: image at 75% width centered with ivory gutters,
 * HTML text BELOW the image (not overlaid).
 *
 * Used when the image is too detailed/colorful to overlay text on
 * cleanly — e.g. customer UGC photos, busy product shots. Keeps
 * the image's integrity and gives the headline/CTA their own
 * breathing room.
 *
 * Designer brief: 900×900 square. No text overlay constraints.
 * Subject is the full visual story.
 */
export interface Image75SolidProps {
  imageUrl: string | null;
  imageAlt: string;
  headline: string;
  subtitle: string;
  ctaLabel: string;
  ctaUrl: string;
}

export function HeroImage75Solid({
  imageUrl, imageAlt, headline, subtitle, ctaLabel, ctaUrl,
}: Image75SolidProps) {
  return (
    <tr>
      <td style={{ backgroundColor: colors.white, padding: "8px 0 32px" }}>
        {/* Image row — centered, 75% width via the cream gutters */}
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
          <tbody>
            <tr>
              <td width="12.5%">&nbsp;</td>
              <td width="75%" style={{ textAlign: "center" as const }}>
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt={imageAlt}
                    width={Math.round(layout.emailWidth * 0.75)}
                    style={{ width: "100%", maxWidth: 450, height: "auto", display: "block", margin: "0 auto" }}
                  />
                ) : (
                  <div style={{
                    width: "100%",
                    aspectRatio: "1 / 1",
                    background: colors.lavender,
                    color: colors.espresso,
                    display: "flex" as const,
                    alignItems: "center" as const,
                    justifyContent: "center" as const,
                    fontSize: 11,
                    fontFamily: fonts.body,
                    letterSpacing: "0.1em",
                  }}>
                    [ hero image — 900×900 centered ]
                  </div>
                )}
              </td>
              <td width="12.5%">&nbsp;</td>
            </tr>
          </tbody>
        </table>

        {/* Text + CTA below the image */}
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
          <tbody>
            <tr>
              <td className="jx-text-pad" style={{
                padding: `28px ${layout.textPadX}px 0`,
                textAlign: "center" as const,
              }}>
                <h1 className="jx-hero-headline" style={headlineStyle()}>
                  {headline}
                </h1>
                <p className="jx-hero-subtitle" style={subtitleStyle()}>
                  {subtitle}
                </p>
                <div style={{ marginTop: 20 }}>
                  <a href={ctaUrl} className="jx-cta-pill" style={ctaPillStyle()}>
                    {ctaLabel}
                  </a>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  );
}

HeroImage75Solid.variant = "image_75_solid" as const;
HeroImage75Solid.dimensions = { width: 900, height: 900 };
