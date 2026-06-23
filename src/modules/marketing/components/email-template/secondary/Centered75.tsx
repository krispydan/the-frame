import { colors, fonts, layout } from "../shared/tokens";

/**
 * Secondary image variant: 75% width, centered with ivory gutters.
 *
 * For product flat-lays where you want the eye to settle. Reads
 * less aggressive than full-bleed, more curated. Good for the
 * "about this frame" beat after a customer story or seasonal lead.
 */
export interface SecondaryCentered75Props {
  imageUrl: string | null;
  imageAlt: string;
}

export function SecondaryCentered75({ imageUrl, imageAlt }: SecondaryCentered75Props) {
  return (
    <tr>
      <td style={{ backgroundColor: colors.white, padding: "12px 0" }}>
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
                    aspectRatio: "9 / 8",
                    background: colors.lavender,
                    color: colors.espresso,
                    display: "flex" as const,
                    alignItems: "center" as const,
                    justifyContent: "center" as const,
                    fontSize: 11,
                    fontFamily: fonts.body,
                    letterSpacing: "0.1em",
                  }}>
                    [ secondary image — 900×800 centered ]
                  </div>
                )}
              </td>
              <td width="12.5%">&nbsp;</td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  );
}

SecondaryCentered75.variant = "centered_75" as const;
SecondaryCentered75.dimensions = { width: 900, height: 800 };
