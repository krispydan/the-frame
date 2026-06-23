import { colors, layout } from "../shared/tokens";
import { sectionHeadingStyle, sectionBodyStyle, textCellStyle } from "../shared/styles";

/**
 * Section A: centered heading + paragraph, no image.
 *
 * The "first text beat" of the email — sits between hero and the
 * secondary image. Sets up the secondary image emotionally.
 */
export interface SectionACenteredProps {
  heading: string;
  body: string;
}

export function SectionACentered({ heading, body }: SectionACenteredProps) {
  return (
    <tr>
      <td className="jx-text-pad" style={textCellStyle({ padding: `40px ${layout.textPadX}px 28px` })}>
        <div className="jx-section-heading" style={{ ...sectionHeadingStyle(), marginBottom: 14 }}>
          {heading}
        </div>
        <p className="jx-section-body" style={sectionBodyStyle()}>{body}</p>
      </td>
    </tr>
  );
}

SectionACentered.variant = "centered" as const;
