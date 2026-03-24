export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-middleware";
import { sqlite } from "@/lib/db";

interface CaptureBody {
  prospect_id?: string | null;
  domain?: string;
  website?: string;
  business_name?: string;
  email?: string;
  phone?: string;
  socials?: Record<string, string>;
  contact_form_url?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  source_url?: string;
  notes?: string | null;
}

export const POST = apiHandler(
  async (request: NextRequest, context) => {
    const body: CaptureBody = await request.json();
    const now = new Date().toISOString();

    if (body.prospect_id) {
      // Update existing prospect
      const updates: string[] = [];
      const params: unknown[] = [];

      // Only update fields that are provided and non-empty
      const fieldMap: Record<string, string> = {
        website: "website",
        email: "email",
        phone: "phone",
        address: "address",
        city: "city",
        state: "state",
        zip: "zip",
      };

      for (const [bodyKey, colName] of Object.entries(fieldMap)) {
        const val = body[bodyKey as keyof CaptureBody];
        if (val && typeof val === "string") {
          updates.push(`${colName} = ?`);
          params.push(val);
        }
      }

      // Domain
      if (body.domain) {
        updates.push("domain = ?");
        params.push(body.domain.replace(/^www\./, ""));
      }

      // Socials — merge with existing
      if (body.socials && Object.keys(body.socials).length > 0) {
        const existing = sqlite
          .prepare("SELECT socials FROM companies WHERE id = ?")
          .get(body.prospect_id) as { socials?: string } | undefined;

        let merged = {};
        if (existing?.socials) {
          try {
            merged = JSON.parse(existing.socials);
          } catch {}
        }
        merged = { ...merged, ...body.socials };
        updates.push("socials = ?");
        params.push(JSON.stringify(merged));
      }

      // Contact form URL
      if (body.contact_form_url) {
        updates.push("contact_form_url = ?");
        params.push(body.contact_form_url);
      }

      // Notes — append, don't overwrite
      if (body.notes) {
        const existing = sqlite
          .prepare("SELECT notes FROM companies WHERE id = ?")
          .get(body.prospect_id) as { notes?: string } | undefined;

        const noteEntry = `[Chrome Extension ${now.split("T")[0]}] ${body.notes}`;
        const newNotes = existing?.notes ? `${existing.notes}\n${noteEntry}` : noteEntry;
        updates.push("notes = ?");
        params.push(newNotes);
      }

      // Always add enrichment note
      const enrichNote = `Enriched via Chrome extension from ${body.source_url || body.website || "unknown"} on ${now.split("T")[0]}`;
      // Append to notes
      if (!body.notes) {
        const existing = sqlite
          .prepare("SELECT notes FROM companies WHERE id = ?")
          .get(body.prospect_id) as { notes?: string } | undefined;
        const newNotes = existing?.notes ? `${existing.notes}\n${enrichNote}` : enrichNote;
        updates.push("notes = ?");
        params.push(newNotes);
      }

      updates.push("updated_at = ?");
      params.push(now);
      params.push(body.prospect_id);

      if (updates.length > 1) {
        sqlite
          .prepare(`UPDATE companies SET ${updates.join(", ")} WHERE id = ?`)
          .run(...params);
      }

      const updated = sqlite
        .prepare("SELECT id, name, domain, status FROM companies WHERE id = ?")
        .get(body.prospect_id) as Record<string, unknown>;

      return NextResponse.json({ prospect: updated, created: false });
    } else {
      // Create new prospect
      const id = crypto.randomUUID();
      const domain = body.domain?.replace(/^www\./, "") || null;
      const enrichNote = `Enriched via Chrome extension from ${body.source_url || body.website || "unknown"} on ${now.split("T")[0]}`;
      const notes = body.notes ? `${body.notes}\n${enrichNote}` : enrichNote;

      sqlite
        .prepare(
          `INSERT INTO companies (id, name, domain, website, email, phone, address, city, state, zip, socials, contact_form_url, notes, status, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'chrome_extension', ?, ?)`
        )
        .run(
          id,
          body.business_name || domain || "Unknown",
          domain,
          body.website || null,
          body.email || null,
          body.phone || null,
          body.address || null,
          body.city || null,
          body.state || null,
          body.zip || null,
          body.socials ? JSON.stringify(body.socials) : null,
          body.contact_form_url || null,
          notes,
          now,
          now
        );

      return NextResponse.json({
        prospect: { id, name: body.business_name || domain, domain, status: "new" },
        created: true,
      });
    }
  },
  { auth: true, audit: true }
);
