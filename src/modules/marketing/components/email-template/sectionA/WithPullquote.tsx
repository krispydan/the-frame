import { colors, fonts, layout } from "../shared/tokens";
import { sectionHeadingStyle, sectionBodyStyle, textCellStyle } from "../shared/styles";

/**
 * Section A variant: centered with one sentence pulled out larger
 * in Syne (the brand pullquote face).
 *
 * The "pullquote" is the LONGEST sentence of the body (auto-picked
 * at render time) rendered larger in italic Syne. Provides visual
 * rhythm vs the centered-only variant. Use when the body has one
 * standout line you want to land harder than the rest.
 */
export interface SectionAPullquoteProps {
  heading: string;
  body: string;
}

export function SectionAWithPullquote({ heading, body }: SectionAPullquoteProps) {
  // Find the longest sentence — the most "pull-able" line.
  const sentences = body.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const pullquote = sentences.reduce((a, b) => (b.length > a.length ? b : a), "");
  const rest = sentences.filter(s => s !== pullquote);

  return (
    <tr>
      <td className="jx-text-pad" style={textCellStyle({ padding: `40px ${layout.textPadX}px 28px` })}>
        <div className="jx-section-heading" style={{ ...sectionHeadingStyle(), marginBottom: 14 }}>
          {heading}
        </div>

        <p
          className="jx-section-body"
          style={{
            ...sectionBodyStyle(),
            fontFamily: fonts.pullquote,
            fontStyle: "italic" as const,
            fontSize: 22,
            lineHeight: 1.4,
            color: colors.espresso,
            maxWidth: 480,
            margin: "0 auto 18px",
          }}
        >
          “{pullquote}”
        </p>

        {rest.length > 0 && (
          <p className="jx-section-body" style={sectionBodyStyle()}>
            {rest.join(" ")}
          </p>
        )}
      </td>
    </tr>
  );
}

SectionAWithPullquote.variant = "with_pullquote" as const;
