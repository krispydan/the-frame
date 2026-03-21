/**
 * F1-012: MCP Tools — Sales Module
 * Registers sales-related MCP tools that reuse existing API/business logic.
 */
import { mcpRegistry } from "@/modules/core/mcp/server";
import { sqlite } from "@/lib/db";
import { z } from "zod";
import { agentOrchestrator } from "@/modules/core/lib/agent-orchestrator";
import { getUnscoredCompanyIds } from "@/modules/sales/agents/icp-classifier";
// Lazy imports to avoid circular initialization
const getInstantlySync = () => import("@/modules/sales/lib/instantly-sync");
const getResponseClassifier = () => import("@/modules/sales/agents/response-classifier");

// ── sales.list_prospects ──
mcpRegistry.register(
  "sales.list_prospects",
  "Search and filter prospects with pagination. Supports FTS search, state/category/status filters, ICP range, email/phone presence.",
  z.object({
    search: z.string().optional().describe("Full-text search query"),
    page: z.number().optional().describe("Page number (default 1)"),
    limit: z.number().optional().describe("Results per page (default 25, max 100)"),
    sort: z.string().optional().describe("Sort column: name, state, city, icp_score, status, created_at"),
    order: z.string().optional().describe("Sort order: asc or desc"),
    state: z.string().optional().describe("Comma-separated state filter"),
    category: z.string().optional().describe("Comma-separated category filter"),
    status: z.string().optional().describe("Comma-separated status filter"),
    icp_min: z.number().optional().describe("Minimum ICP score"),
    icp_max: z.number().optional().describe("Maximum ICP score"),
    has_email: z.string().optional().describe("'true' or 'false'"),
    has_phone: z.string().optional().describe("'true' or 'false'"),
  }),
  async (args) => {
    const page = args.page ?? 1;
    const limit = Math.min(100, Math.max(1, args.limit ?? 25));
    const offset = (page - 1) * limit;
    const sortOrder = args.order === "desc" ? "DESC" : "ASC";

    const sortColumns: Record<string, string> = {
      name: "c.name", state: "c.state", city: "c.city",
      icp_score: "c.icp_score", status: "c.status", created_at: "c.created_at",
    };
    const sortCol = sortColumns[args.sort ?? "name"] ?? "c.name";

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (args.search) {
      try {
        const fts = sqlite.prepare("SELECT rowid FROM companies_fts WHERE companies_fts MATCH ? LIMIT 10000")
          .all(args.search + "*") as { rowid: number }[];
        if (fts.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ data: [], total: 0, page, limit, totalPages: 0 }) }] };
        }
        clauses.push(`c.rowid IN (${fts.map(r => r.rowid).join(",")})`);
      } catch {
        clauses.push("c.name LIKE ?");
        params.push(`%${args.search}%`);
      }
    }

    if (args.state) {
      const states = args.state.split(",").map(s => s.trim());
      clauses.push(`c.state IN (${states.map(() => "?").join(",")})`);
      params.push(...states);
    }
    if (args.category) {
      const cats = args.category.split(",").map(s => s.trim());
      clauses.push(`(${cats.map(() => "c.tags LIKE ?").join(" OR ")})`);
      params.push(...cats.map(c => `%${c}%`));
    }
    if (args.status) {
      const statuses = args.status.split(",").map(s => s.trim());
      clauses.push(`c.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (args.icp_min != null) { clauses.push("c.icp_score >= ?"); params.push(args.icp_min); }
    if (args.icp_max != null) { clauses.push("c.icp_score <= ?"); params.push(args.icp_max); }
    if (args.has_email === "true") clauses.push("c.email IS NOT NULL AND c.email != ''");
    else if (args.has_email === "false") clauses.push("(c.email IS NULL OR c.email = '')");
    if (args.has_phone === "true") clauses.push("c.phone IS NOT NULL AND c.phone != ''");
    else if (args.has_phone === "false") clauses.push("(c.phone IS NULL OR c.phone = '')");

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (sqlite.prepare(`SELECT count(*) as c FROM companies c ${where}`).get(...params) as { c: number }).c;
    const rows = sqlite.prepare(`
      SELECT c.id, c.name, c.city, c.state, c.type, c.source, c.phone, c.email, c.icp_score, c.icp_tier, c.status, c.tags
      FROM companies c ${where} ORDER BY ${sortCol} ${sortOrder} NULLS LAST LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Record<string, unknown>[];

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          data: rows.map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags as string) : [] })),
          total, page, limit, totalPages: Math.ceil(total / limit),
        }, null, 2),
      }],
    };
  }
);

// ── sales.get_prospect ──
mcpRegistry.register(
  "sales.get_prospect",
  "Get a single company with its stores and contacts",
  z.object({
    id: z.string().describe("Company UUID"),
  }),
  async ({ id }) => {
    const company = sqlite.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!company) {
      return { content: [{ type: "text" as const, text: "Company not found" }], isError: true };
    }
    const stores = sqlite.prepare("SELECT * FROM stores WHERE company_id = ? ORDER BY is_primary DESC, name ASC").all(id);
    const contacts = sqlite.prepare("SELECT * FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, first_name ASC").all(id);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          company: { ...company, tags: company.tags ? JSON.parse(company.tags as string) : [] },
          stores, contacts,
        }, null, 2),
      }],
    };
  }
);

// ── sales.update_prospect ──
mcpRegistry.register(
  "sales.update_prospect",
  "Update company fields (status, icp_tier, owner, tags, notes, etc.)",
  z.object({
    id: z.string().describe("Company UUID"),
    status: z.string().optional().describe("new, contacted, qualified, rejected, customer"),
    icp_tier: z.string().optional().describe("A, B, C, D, or F"),
    icp_score: z.number().optional().describe("ICP score 0-100"),
    owner_id: z.string().optional().describe("Owner user UUID"),
    tags: z.array(z.string()).optional().describe("Replace tags array"),
    notes: z.string().optional().describe("Notes text"),
  }),
  async (args) => {
    const { id, ...fields } = args;
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, val] of Object.entries(fields)) {
      if (val === undefined) continue;
      if (key === "tags") {
        sets.push("tags = ?");
        values.push(JSON.stringify(val));
      } else {
        sets.push(`${key} = ?`);
        values.push(val);
      }
    }

    if (sets.length === 0) {
      return { content: [{ type: "text" as const, text: "No fields to update" }], isError: true };
    }

    sets.push("updated_at = datetime('now')");
    values.push(id);
    sqlite.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...values);

    return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, updated: Object.keys(fields).filter(k => fields[k as keyof typeof fields] !== undefined) }) }] };
  }
);

// ── sales.bulk_action ──
mcpRegistry.register(
  "sales.bulk_action",
  "Perform bulk actions on multiple prospects: approve, reject, tag, assign",
  z.object({
    action: z.string().describe("Action: approve, reject, tag, assign"),
    ids: z.array(z.string()).describe("Array of company UUIDs"),
    tag: z.string().optional().describe("Tag name (for 'tag' action)"),
    owner_id: z.string().optional().describe("Owner UUID (for 'assign' action)"),
  }),
  async (args) => {
    const { action, ids } = args;
    if (ids.length === 0) return { content: [{ type: "text" as const, text: "No IDs provided" }], isError: true };

    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    let affected = 0;

    const run = sqlite.transaction(() => {
      switch (action) {
        case "approve":
          affected = sqlite.prepare(`UPDATE companies SET status = 'qualified', updated_at = ? WHERE id IN (${placeholders})`).run(now, ...ids).changes;
          break;
        case "reject":
          affected = sqlite.prepare(`UPDATE companies SET status = 'rejected', updated_at = ? WHERE id IN (${placeholders})`).run(now, ...ids).changes;
          break;
        case "tag": {
          if (!args.tag) throw new Error("tag required for tag action");
          for (const id of ids) {
            const row = sqlite.prepare("SELECT tags FROM companies WHERE id = ?").get(id) as { tags: string | null } | undefined;
            const existing: string[] = row?.tags ? JSON.parse(row.tags) : [];
            if (!existing.includes(args.tag)) {
              existing.push(args.tag);
              sqlite.prepare("UPDATE companies SET tags = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(existing), now, id);
            }
          }
          affected = ids.length;
          break;
        }
        case "assign":
          if (!args.owner_id) throw new Error("owner_id required for assign action");
          affected = sqlite.prepare(`UPDATE companies SET owner_id = ?, updated_at = ? WHERE id IN (${placeholders})`).run(args.owner_id, now, ...ids).changes;
          break;
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    });

    try {
      run();
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, action, affected }) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ── sales.import_csv ──
mcpRegistry.register(
  "sales.import_csv",
  "Trigger a CSV import job. Provide the file path to the CSV.",
  z.object({
    csv_path: z.string().describe("Absolute path to CSV file"),
    batch_size: z.number().optional().describe("Batch size (default 500)"),
  }),
  async ({ csv_path, batch_size }) => {
    // Dynamically import to avoid circular deps at module load
    const { importProspectsFromCSV } = await import("@/modules/sales/lib/import-engine");
    try {
      const stats = await importProspectsFromCSV(csv_path, { batchSize: batch_size });
      return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Import error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ── sales.run_icp_classifier ──
mcpRegistry.register(
  "sales.run_icp_classifier",
  "Trigger ICP classification on unscored companies (or specific IDs)",
  z.object({
    company_ids: z.array(z.string()).optional().describe("Specific company UUIDs (omit for all unscored)"),
  }),
  async ({ company_ids }) => {
    let ids = company_ids;
    if (!ids || ids.length === 0) {
      ids = getUnscoredCompanyIds();
      if (ids.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ message: "All companies already classified", count: 0 }) }] };
      }
    }

    if (ids.length <= 100) {
      const result = await agentOrchestrator.runAgentSync("icp-classifier", { companyIds: ids });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }

    const runId = await agentOrchestrator.runAgent("icp-classifier", { companyIds: ids });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ message: `ICP classification started for ${ids.length} companies`, runId, status: "running" }),
      }],
    };
  }
);

// ── sales.list_deals ──
mcpRegistry.register(
  "sales.list_deals",
  "List deals filtered by stage, owner, company",
  z.object({
    stage: z.string().optional().describe("Filter by stage: outreach, contact_made, interested, order_placed, interested_later, not_interested"),
    owner_id: z.string().optional().describe("Filter by owner UUID"),
    company_id: z.string().optional().describe("Filter by company UUID"),
    tab: z.string().optional().describe("Tab: active, snoozed, reorder (default: active)"),
  }),
  async (args) => {
    const clauses: string[] = [];
    const vals: unknown[] = [];
    const tab = args.tab || "active";

    if (tab === "snoozed") {
      clauses.push("d.snooze_until IS NOT NULL AND d.snooze_until > datetime('now')");
    } else if (tab === "reorder") {
      clauses.push("d.reorder_due_at IS NOT NULL AND d.reorder_due_at <= datetime('now', '+14 days')");
    } else {
      clauses.push("(d.snooze_until IS NULL OR d.snooze_until <= datetime('now'))");
    }
    if (args.stage) { clauses.push("d.stage = ?"); vals.push(args.stage); }
    if (args.owner_id) { clauses.push("d.owner_id = ?"); vals.push(args.owner_id); }
    if (args.company_id) { clauses.push("d.company_id = ?"); vals.push(args.company_id); }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = sqlite.prepare(`
      SELECT d.*, c.name as company_name FROM deals d LEFT JOIN companies c ON c.id = d.company_id ${where} ORDER BY d.last_activity_at DESC LIMIT 100
    `).all(...vals);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── sales.create_deal ──
mcpRegistry.register(
  "sales.create_deal",
  "Create a new deal",
  z.object({
    company_id: z.string().describe("Company UUID"),
    title: z.string().optional().describe("Deal title (defaults to company name)"),
    stage: z.string().optional().describe("Initial stage (default: outreach)"),
    channel: z.string().optional().describe("Channel: shopify, faire, phone, direct, other"),
    value: z.number().optional().describe("Deal value in USD"),
    notes: z.string().optional().describe("Initial notes"),
  }),
  async (args) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const company = sqlite.prepare("SELECT name FROM companies WHERE id = ?").get(args.company_id) as { name: string } | undefined;
    const title = args.title || company?.name || "New Deal";

    sqlite.prepare(`
      INSERT INTO deals (id, company_id, title, value, stage, channel, last_activity_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, args.company_id, title, args.value || null, args.stage || "outreach", args.channel || null, now, now, now);

    if (args.notes) {
      sqlite.prepare(`INSERT INTO deal_activities (id, deal_id, company_id, type, description, created_at) VALUES (?, ?, ?, 'note', ?, ?)`).run(crypto.randomUUID(), id, args.company_id, args.notes, now);
    }

    return { content: [{ type: "text" as const, text: JSON.stringify({ id, title, stage: args.stage || "outreach", success: true }) }] };
  }
);

// ── sales.move_deal ──
mcpRegistry.register(
  "sales.move_deal",
  "Change a deal's stage",
  z.object({
    deal_id: z.string().describe("Deal UUID"),
    stage: z.string().describe("New stage"),
  }),
  async ({ deal_id, stage }) => {
    const deal = sqlite.prepare("SELECT stage, company_id FROM deals WHERE id = ?").get(deal_id) as { stage: string; company_id: string } | undefined;
    if (!deal) return { content: [{ type: "text" as const, text: "Deal not found" }], isError: true };

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    sqlite.prepare("UPDATE deals SET stage = ?, previous_stage = ?, updated_at = ?, last_activity_at = ? WHERE id = ?").run(stage, deal.stage, now, now, deal_id);
    sqlite.prepare(`INSERT INTO deal_activities (id, deal_id, company_id, type, description, metadata, created_at) VALUES (?, ?, ?, 'stage_change', ?, ?, ?)`).run(
      crypto.randomUUID(), deal_id, deal.company_id, `${deal.stage} → ${stage}`, JSON.stringify({ from: deal.stage, to: stage }), now
    );

    if (stage === "order_placed") {
      const reorder = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 19).replace("T", " ");
      sqlite.prepare("UPDATE deals SET closed_at = ?, reorder_due_at = ? WHERE id = ?").run(now, reorder, deal_id);
    }

    return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, from: deal.stage, to: stage }) }] };
  }
);

// ── sales.snooze_deal ──
mcpRegistry.register(
  "sales.snooze_deal",
  "Snooze a deal until a specific date",
  z.object({
    deal_id: z.string().describe("Deal UUID"),
    until: z.string().describe("Snooze until date (YYYY-MM-DD)"),
    reason: z.string().optional().describe("Reason for snooze"),
  }),
  async ({ deal_id, until, reason }) => {
    const deal = sqlite.prepare("SELECT company_id FROM deals WHERE id = ?").get(deal_id) as { company_id: string } | undefined;
    if (!deal) return { content: [{ type: "text" as const, text: "Deal not found" }], isError: true };

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    sqlite.prepare("UPDATE deals SET snooze_until = ?, snooze_reason = ?, updated_at = ? WHERE id = ?").run(until, reason || null, now, deal_id);
    sqlite.prepare(`INSERT INTO deal_activities (id, deal_id, company_id, type, description, created_at) VALUES (?, ?, ?, 'snooze', ?, ?)`).run(
      crypto.randomUUID(), deal_id, deal.company_id, `Snoozed until ${until}${reason ? `: ${reason}` : ""}`, now
    );

    return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, snoozed_until: until }) }] };
  }
);

// ── sales.enrich_prospect ──
mcpRegistry.register(
  "sales.enrich_prospect",
  "Trigger enrichment for companies via Outscraper",
  z.object({
    company_ids: z.array(z.string()).optional().describe("Company UUIDs to enrich (omit for auto-select)"),
  }),
  async ({ company_ids }) => {
    const { batchEnrich, getCompaniesNeedingEnrichment } = await import("@/modules/sales/lib/enrichment");
    let ids = company_ids;
    if (!ids || ids.length === 0) {
      ids = getCompaniesNeedingEnrichment(20).map(c => c.id);
    }
    if (ids.length === 0) return { content: [{ type: "text" as const, text: JSON.stringify({ message: "No companies need enrichment" }) }] };
    const result = await batchEnrich(ids);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

// ── sales.get_reorder_queue ──
mcpRegistry.register(
  "sales.get_reorder_queue",
  "List deals with upcoming reorder dates",
  z.object({
    days_ahead: z.number().optional().describe("Look ahead days (default 14)"),
  }),
  async ({ days_ahead }) => {
    const d = days_ahead ?? 14;
    const rows = sqlite.prepare(`
      SELECT d.*, c.name as company_name FROM deals d
      LEFT JOIN companies c ON c.id = d.company_id
      WHERE d.reorder_due_at IS NOT NULL AND d.reorder_due_at <= datetime('now', '+${d} days')
      AND d.stage = 'order_placed'
      ORDER BY d.reorder_due_at ASC
    `).all();
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── sales.get_smart_lists ──
mcpRegistry.register(
  "sales.get_smart_lists",
  "List all saved smart lists with their filters and result counts",
  z.object({}),
  async () => {
    const lists = sqlite.prepare("SELECT * FROM smart_lists ORDER BY is_default DESC, name ASC").all();
    return { content: [{ type: "text" as const, text: JSON.stringify(lists, null, 2) }] };
  }
);

// ── F3-010: Campaign MCP Tools ──

mcpRegistry.register(
  "sales.list_campaigns",
  "List all campaigns with stats. Filter by type (email_sequence/calling/re_engagement/ab_test) or status (draft/active/paused/completed).",
  z.object({
    type: z.string().optional().describe("Filter by campaign type"),
    status: z.string().optional().describe("Filter by campaign status"),
  }),
  async (args) => {
    const clauses: string[] = [];
    const vals: unknown[] = [];
    if (args.type) { clauses.push("type = ?"); vals.push(args.type); }
    if (args.status) { clauses.push("status = ?"); vals.push(args.status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = sqlite.prepare(`SELECT *, (SELECT count(*) FROM campaign_leads cl WHERE cl.campaign_id = campaigns.id) as lead_count FROM campaigns ${where} ORDER BY created_at DESC`).all(...vals);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  }
);

mcpRegistry.register(
  "sales.create_campaign",
  "Create a new campaign. Returns the created campaign.",
  z.object({
    name: z.string().describe("Campaign name"),
    type: z.string().optional().describe("email_sequence, calling, re_engagement, or ab_test"),
    description: z.string().optional(),
    target_smart_list_id: z.string().optional(),
    variant_a_subject: z.string().optional(),
    variant_b_subject: z.string().optional(),
  }),
  async (args) => {
    const id = crypto.randomUUID();
    sqlite.prepare(`INSERT INTO campaigns (id, name, type, description, target_smart_list_id, variant_a_subject, variant_b_subject) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, args.name, args.type || "email_sequence", args.description, args.target_smart_list_id, args.variant_a_subject, args.variant_b_subject);
    const campaign = sqlite.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
    return { content: [{ type: "text" as const, text: JSON.stringify(campaign, null, 2) }] };
  }
);

mcpRegistry.register(
  "sales.add_leads_to_campaign",
  "Add company leads to a campaign by company IDs.",
  z.object({
    campaign_id: z.string().describe("Campaign ID"),
    company_ids: z.array(z.string()).describe("Array of company IDs to add"),
  }),
  async (args) => {
    let added = 0;
    const insert = sqlite.prepare(`INSERT INTO campaign_leads (id, campaign_id, company_id, contact_id, email) SELECT ?, ?, c.id, ct.id, ct.email FROM companies c LEFT JOIN contacts ct ON ct.company_id = c.id AND ct.is_primary = 1 WHERE c.id = ?`);
    for (const companyId of args.company_ids) {
      try {
        insert.run(crypto.randomUUID(), args.campaign_id, companyId);
        added++;
      } catch { /* skip duplicates */ }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ added, total: args.company_ids.length }) }] };
  }
);

mcpRegistry.register(
  "sales.get_campaign_stats",
  "Get detailed stats for a campaign including lead breakdown.",
  z.object({
    campaign_id: z.string().describe("Campaign ID"),
  }),
  async (args) => {
    const campaign = sqlite.prepare("SELECT * FROM campaigns WHERE id = ?").get(args.campaign_id);
    if (!campaign) return { content: [{ type: "text" as const, text: "Campaign not found" }] };
    const stats = sqlite.prepare(`SELECT status, count(*) as count FROM campaign_leads WHERE campaign_id = ? GROUP BY status`).all(args.campaign_id);
    return { content: [{ type: "text" as const, text: JSON.stringify({ campaign, lead_stats: stats }, null, 2) }] };
  }
);

mcpRegistry.register(
  "sales.sync_instantly",
  "Trigger a manual sync between The Frame and Instantly.ai. Pushes new campaigns/leads and pulls analytics.",
  z.object({}),
  async () => {
    const { runInstantlySync } = await getInstantlySync();
    const result = await runInstantlySync();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

mcpRegistry.register(
  "sales.classify_reply",
  "Classify an email reply text. Returns classification (interested, not_interested, out_of_office, wrong_person, question, auto_reply).",
  z.object({
    text: z.string().describe("Email reply text to classify"),
  }),
  async (args) => {
    const { classifyReply } = await getResponseClassifier();
    const result = classifyReply(args.text);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);
