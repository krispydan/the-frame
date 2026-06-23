import { colors, fonts, layout } from "../shared/tokens";

/**
 * Secondary image variant: full-bleed, no padding.
 *
 * The second visual beat of the email. Lands without text overlay
 * — it's purely the image. Most common variant — pairs cleanly
 * with any text section above + below.
 */
export interface SecondaryFullBleedProps {
  imageUrl: string | null;
  imageAlt: string;
}

export function SecondaryFullBleed({ imageUrl, imageAlt }: SecondaryFullBleedProps) {
  return (
    <tr>
      <td
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
          height: layout.secondaryHeight,
          position: "relative" as const,
        }}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={imageAlt}
            width={layout.emailWidth}
            style={{ width: "100%", height: layout.secondaryHeight, objectFit: "cover" as const, display: "block" }}
          />
        ) : (
          <div style={{
            display: "flex" as const,
            alignItems: "flex-end" as const,
            justifyContent: "center" as const,
            height: layout.secondaryHeight,
            padding: 16,
            color: colors.espresso,
            fontSize: 10,
            fontFamily: fonts.body,
            letterSpacing: "0.1em",
          }}>
            [ secondary image — 1200×800 full bleed ]
          </div>
        )}
      </td>
    </tr>
  );
}

SecondaryFullBleed.variant = "full_bleed" as const;
SecondaryFullBleed.dimensions = { width: 1200, height: 800 };
