import { layout } from "../shared/tokens";
import { ctaPillStyle, sectionHeadingStyle, sectionBodyStyle, textCellStyle } from "../shared/styles";

/**
 * Section B variant: centered heading + paragraph(s) + bottom CTA.
 *
 * The "close the argument" beat. Most common variant for the
 * bottom text block.
 *
 * If `body` contains paragraph breaks (double-newlines), each
 * paragraph renders with its own <p>; otherwise one paragraph.
 */
export interface SectionBCenteredProps {
  heading: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
}

export function SectionBCenteredWithCta({
  heading, body, ctaLabel, ctaUrl,
}: SectionBCenteredProps) {
  const paragraphs = body.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

  return (
    <tr>
      <td className="jx-text-pad" style={textCellStyle({ padding: `36px ${layout.textPadX}px 48px` })}>
        <div className="jx-section-heading" style={{ ...sectionHeadingStyle(), marginBottom: 14 }}>
          {heading}
        </div>
        {paragraphs.map((p, i) => (
          <p
            key={i}
            className="jx-section-body"
            style={{ ...sectionBodyStyle(), marginBottom: i < paragraphs.length - 1 ? 12 : 22 }}
          >
            {p}
          </p>
        ))}
        <a href={ctaUrl} className="jx-cta-pill" style={ctaPillStyle()}>
          {ctaLabel}
        </a>
      </td>
    </tr>
  );
}

SectionBCenteredWithCta.variant = "centered_with_cta" as const;
