import { colors, layout } from "../shared/tokens";
import { ctaPillStyle, sectionHeadingStyle, sectionBodyStyle, textCellStyle } from "../shared/styles";

/**
 * Section B variant: heading + body split into two columns +
 * centered CTA below.
 *
 * For emails where the body has two distinct beats (e.g. "the
 * line" + "your order" for a wholesale stock-drop), splitting them
 * visually helps the eye triage. Mobile stacks via .jx-grid-cell.
 *
 * Splits the body on `\n\n` — first paragraph goes left, second
 * goes right. If only one paragraph, falls through to the
 * Centered variant's behavior (single column).
 */
export interface SectionBTwoColumnProps {
  heading: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
}

export function SectionBTwoColumnWithCta({
  heading, body, ctaLabel, ctaUrl,
}: SectionBTwoColumnProps) {
  const paragraphs = body.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const [leftPara, rightPara] = paragraphs;

  // If only one paragraph, render single-column.
  if (!rightPara) {
    return (
      <tr>
        <td className="jx-text-pad" style={textCellStyle({ padding: `36px ${layout.textPadX}px 48px` })}>
          <div className="jx-section-heading" style={{ ...sectionHeadingStyle(), marginBottom: 14 }}>
            {heading}
          </div>
          <p className="jx-section-body" style={{ ...sectionBodyStyle(), marginBottom: 22 }}>
            {leftPara}
          </p>
          <a href={ctaUrl} className="jx-cta-pill" style={ctaPillStyle()}>
            {ctaLabel}
          </a>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="jx-text-pad" style={textCellStyle({ padding: `36px ${layout.textPadX}px 48px` })}>
        <div className="jx-section-heading" style={{ ...sectionHeadingStyle(), marginBottom: 20, textAlign: "center" as const }}>
          {heading}
        </div>

        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
          <tbody>
            <tr>
              <td className="jx-grid-cell" width="48%" style={{ verticalAlign: "top" as const, paddingRight: 12 }}>
                <p
                  className="jx-section-body"
                  style={{
                    ...sectionBodyStyle(),
                    textAlign: "left" as const,
                    marginBottom: 16,
                  }}
                >
                  {leftPara}
                </p>
              </td>
              <td className="jx-grid-cell" width="4%">&nbsp;</td>
              <td className="jx-grid-cell" width="48%" style={{ verticalAlign: "top" as const, paddingLeft: 12 }}>
                <p
                  className="jx-section-body"
                  style={{
                    ...sectionBodyStyle(),
                    textAlign: "left" as const,
                    marginBottom: 16,
                  }}
                >
                  {rightPara}
                </p>
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 12, textAlign: "center" as const }}>
          <a href={ctaUrl} className="jx-cta-pill" style={ctaPillStyle()}>
            {ctaLabel}
          </a>
        </div>
      </td>
    </tr>
  );
}

SectionBTwoColumnWithCta.variant = "two_column_with_cta" as const;
