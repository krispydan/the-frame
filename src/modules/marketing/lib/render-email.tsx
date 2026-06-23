/**
 * Server-only helper that renders an email campaign to HTML.
 *
 * Why this lives in its own file: Next 16 + Turbopack rejects
 * direct `react-dom/server` imports inside `/app/api/.../route.tsx`
 * handlers ("You're importing a component that imports
 * react-dom/server"). Pulling the render call into a server-only
 * helper module — and importing that helper from the route — gets
 * past the check.
 *
 * The `import "server-only"` directive marks this module as never
 * being included in any client bundle.
 */

import "server-only";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EmailTemplateRenderer,
  type CampaignData,
} from "../components/email-template";
import { catalogImageUrl } from "@/lib/storage/image-url";

/**
 * Render a campaign to a full HTML document (includes DOCTYPE).
 *
 * Image paths run through catalogImageUrl() which handles the
 * relative→absolute conversion + the legacy `data/images/`
 * stripping; null return = unresolvable path, renderer falls
 * back to a placeholder block.
 */
export function renderEmailHtml(campaign: CampaignData): string {
  const body = renderToStaticMarkup(
    <EmailTemplateRenderer campaign={campaign} imageUrlFor={catalogImageUrl} />,
  );
  return `<!DOCTYPE html>\n${body}`;
}
