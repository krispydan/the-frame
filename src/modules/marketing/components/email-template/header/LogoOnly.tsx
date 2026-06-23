import { colors, fonts, layout } from "../shared/tokens";

/**
 * Header — logo only, centered.
 *
 * Per Daniel: "ignore the menu options — we can build this into the
 * header and don't need this created, we only need the logo."
 *
 * The Glitz wordmark "Jaxy" is the logo. Email clients block web
 * fonts, so we ship the wordmark visually via text + fallback serif.
 * Future iteration: swap to <img> tag pointing at an SVG logo on
 * theframe.getjaxy.com when we have the asset hosted.
 */
export function HeaderLogoOnly() {
  return (
    <tr>
      <td style={{
        padding: "28px 0 24px",
        textAlign: "center" as const,
        backgroundColor: colors.white,
      }}>
        <span style={{
          fontFamily: fonts.logo,
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: "0.04em",
          color: colors.espresso,
        }}>
          Jaxy
        </span>
      </td>
    </tr>
  );
}

/** Block metadata — used by the dispatcher to look up dimensions. */
HeaderLogoOnly.dimensions = { width: layout.emailWidth, height: 80 };
HeaderLogoOnly.variant = "logo_only" as const;
