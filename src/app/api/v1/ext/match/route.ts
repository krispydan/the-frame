export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-middleware";
import { sqlite } from "@/lib/db";

export const GET = apiHandler(
  async (request: NextRequest) => {
    const domain = request.nextUrl.searchParams.get("domain")?.trim().replace(/^www\./, "");
    if (!domain) {
      return NextResponse.json({ error: "domain parameter required" }, { status: 400 });
    }

    // Match by domain column or by extracting domain from website URL
    const prospect = sqlite
      .prepare(
        `SELECT id, name, website, domain,
                (SELECT cp.phone FROM company_phones cp
                  WHERE cp.company_id = companies.id
                  ORDER BY cp.is_primary DESC, cp.created_at ASC LIMIT 1) AS phone,
                (SELECT ct.email FROM contacts ct
                  WHERE ct.company_id = companies.id
                    AND TRIM(COALESCE(ct.email, '')) <> ''
                  ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS email,
                city, state, status, socials, contact_form_url
         FROM companies
         WHERE domain = ? OR domain = ? OR website LIKE ? OR website LIKE ?
         LIMIT 1`
      )
      .get(domain, `www.${domain}`, `%://${domain}%`, `%://www.${domain}%`) as Record<string, unknown> | undefined;

    if (prospect) {
      // Parse socials JSON if present
      if (prospect.socials && typeof prospect.socials === "string") {
        try {
          prospect.socials = JSON.parse(prospect.socials as string);
        } catch {
          prospect.socials = {};
        }
      }
      return NextResponse.json({ prospect });
    }

    return NextResponse.json({ prospect: null });
  },
  { auth: true }
);
