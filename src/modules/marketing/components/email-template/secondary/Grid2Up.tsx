import { colors, fonts, layout } from "../shared/tokens";

/**
 * Secondary image variant: 2-up grid of square images.
 *
 * For "two colorways," "two related products," or "product +
 * lifestyle." Mobile stacks to 1-column via the .jx-grid-cell
 * class hook in shared/styles.ts.
 *
 * Designer brief: TWO images, each 580×580 (1:1). Pair them
 * meaningfully — Honey + Midnight of the same frame, or one
 * product shot + one on-model crop.
 */
export interface SecondaryGrid2UpProps {
  imageUrl: string | null;
  imageUrl2: string | null;
  imageAlt: string;
  imageAlt2: string;
}

export function SecondaryGrid2Up({
  imageUrl, imageUrl2, imageAlt, imageAlt2,
}: SecondaryGrid2UpProps) {
  return (
    <tr>
      <td style={{ backgroundColor: colors.white, padding: "12px 0" }}>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={8}>
          <tbody>
            <tr>
              <td className="jx-grid-cell" width="50%" style={{ padding: "0 4px" }}>
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt={imageAlt}
                    width={290}
                    style={{ width: "100%", height: "auto", display: "block" }}
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
                    fontSize: 10,
                    fontFamily: fonts.body,
                    letterSpacing: "0.1em",
                  }}>
                    [ image 1 — 580×580 ]
                  </div>
                )}
              </td>
              <td className="jx-grid-cell" width="50%" style={{ padding: "0 4px" }}>
                {imageUrl2 ? (
                  <img
                    src={imageUrl2}
                    alt={imageAlt2}
                    width={290}
                    style={{ width: "100%", height: "auto", display: "block" }}
                  />
                ) : (
                  <div style={{
                    width: "100%",
                    aspectRatio: "1 / 1",
                    background: colors.sage,
                    color: colors.espresso,
                    display: "flex" as const,
                    alignItems: "center" as const,
                    justifyContent: "center" as const,
                    fontSize: 10,
                    fontFamily: fonts.body,
                    letterSpacing: "0.1em",
                  }}>
                    [ image 2 — 580×580 ]
                  </div>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  );
}

SecondaryGrid2Up.variant = "grid_2up" as const;
SecondaryGrid2Up.dimensions = { width: 580, height: 580, count: 2 };
