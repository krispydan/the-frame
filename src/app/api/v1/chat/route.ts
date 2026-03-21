/**
 * Chat NL Interface — POST /api/v1/chat
 * Parses natural language, routes to MCP tools, returns structured response.
 */
import { NextRequest, NextResponse } from "next/server";
import { mcpRegistry, ensureAllToolsRegistered } from "@/modules/core/mcp/server";

interface IntentMatch {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

/**
 * Simple keyword-based intent parser. Maps NL queries to MCP tool calls.
 */
function parseIntent(message: string): IntentMatch | null {
  const m = message.toLowerCase().trim();

  // ── Prospect / Company counts ──
  if (/how many (prospects|companies|leads)/.test(m) || /prospect count/.test(m) || /total prospects/.test(m)) {
    return { tool: "sales.list_prospects", args: { limit: 1 }, label: "Counting prospects" };
  }

  // ── Prospect search ──
  if (/^(find|search|look up|show) (prospects?|companies|leads)/i.test(m)) {
    const searchTerm = m.replace(/^(find|search|look up|show)\s+(prospects?|companies|leads)\s*(for|named|called|matching|with)?\s*/i, "").trim();
    return { tool: "sales.list_prospects", args: searchTerm ? { search: searchTerm, limit: 10 } : { limit: 10 }, label: "Searching prospects" };
  }

  // ── Pipeline / Deals ──
  if (/pipeline\s*(value|summary)?/.test(m) || /deal(s)?\s*(pipeline|summary|stats)/.test(m) || /show (the )?pipeline/.test(m)) {
    return { tool: "sales.list_deals", args: {}, label: "Loading deal pipeline" };
  }
  if (/how many deals/.test(m)) {
    return { tool: "sales.list_deals", args: {}, label: "Counting deals" };
  }

  // ── Orders ──
  if (/order\s*(stats|summary|count)/.test(m) || /how many orders/.test(m) || /recent orders/.test(m) || /show orders/.test(m)) {
    return { tool: "orders.list_orders", args: { limit: 10 }, label: "Loading orders" };
  }

  // ── Inventory ──
  if (/inventory\s*(level|status|summary)?/.test(m) || /stock\s*(level|status)?/.test(m) || /low stock/.test(m)) {
    const lowOnly = /low stock/.test(m);
    return { tool: "inventory.get_stock_levels", args: lowOnly ? { lowStockOnly: true } : {}, label: lowOnly ? "Checking low stock" : "Loading inventory" };
  }
  if (/reorder\s*(recommend|suggestion)/.test(m) || /what (should|do) (we|i) (need to )?reorder/.test(m)) {
    return { tool: "inventory.get_reorder_recommendations", args: {}, label: "Getting reorder recommendations" };
  }

  // ── Revenue / Finance ──
  if (/revenue|p&l|profit|income|financial|pnl/.test(m)) {
    let period: string = "mtd";
    if (/year|ytd|annual/.test(m)) period = "ytd";
    else if (/quarter|qtd/.test(m)) period = "qtd";
    return { tool: "finance.get_pnl", args: { period }, label: `Loading ${period.toUpperCase()} P&L` };
  }
  if (/cash\s*flow/.test(m)) {
    return { tool: "finance.get_cash_flow", args: {}, label: "Loading cash flow" };
  }
  if (/expense/.test(m) && !/add|create|new/.test(m)) {
    return { tool: "finance.list_settlements", args: { limit: 10 }, label: "Loading settlements" };
  }

  // ── Top sellers / Trends ──
  if (/top\s*sell|best\s*sell|trending|hot\s*product/.test(m)) {
    return { tool: "intelligence.get_sell_through", args: {}, label: "Analyzing sell-through" };
  }
  if (/trend/.test(m)) {
    return { tool: "intelligence.get_trends", args: {}, label: "Detecting trends" };
  }

  // ── Customers ──
  if (/customer\s*(list|account|summary)/.test(m) || /how many customers/.test(m)) {
    return { tool: "customers.list_accounts", args: { limit: 10 }, label: "Loading customers" };
  }
  if (/churn|at.risk|health/.test(m) && /customer/.test(m)) {
    return { tool: "customers.get_health", args: {}, label: "Checking customer health" };
  }

  // ── Catalog ──
  if (/catalog|product\s*(list|count)/.test(m) || /how many products/.test(m) || /show products/.test(m)) {
    return { tool: "catalog.list_products", args: { limit: 10 }, label: "Loading catalog" };
  }

  // ── Campaigns ──
  if (/campaign/.test(m)) {
    return { tool: "sales.list_campaigns", args: {}, label: "Loading campaigns" };
  }

  // ── Marketing ──
  if (/seo|ranking/.test(m)) {
    return { tool: "marketing.get_seo_rankings", args: {}, label: "Loading SEO rankings" };
  }
  if (/ad\s*(stats|performance|campaign)/.test(m) || /roas/.test(m)) {
    return { tool: "marketing.get_ad_stats", args: {}, label: "Loading ad stats" };
  }
  if (/content\s*(calendar|plan|ideas)/.test(m)) {
    return { tool: "marketing.list_content", args: { limit: 10 }, label: "Loading content calendar" };
  }

  // ── Business health ──
  if (/business\s*health|health\s*score|overall\s*health/.test(m)) {
    return { tool: "intelligence.get_business_health", args: {}, label: "Calculating business health" };
  }

  // ── Geo analysis ──
  if (/geo|geographic|by state/.test(m)) {
    return { tool: "intelligence.get_geo_analysis", args: {}, label: "Loading geographic analysis" };
  }

  // ── System ──
  if (/system\s*health|status/.test(m)) {
    return { tool: "system.health", args: {}, label: "Checking system health" };
  }

  // ── Help ──
  if (/^help$|what can you/.test(m)) {
    return null; // handled specially
  }

  return null;
}

function formatResponse(toolName: string, result: { content: Array<{ type: string; text: string }>; isError?: boolean }, label: string): { response: string; data?: unknown } {
  const raw = result.content[0]?.text || "";
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  if (result.isError) {
    return { response: `❌ Error: ${raw}` };
  }

  // Generate human-friendly summary based on tool
  if (toolName === "sales.list_prospects" && parsed && typeof parsed === "object") {
    const d = parsed as { total: number; data: unknown[] };
    if (d.total !== undefined) {
      return { response: `📊 **${d.total.toLocaleString()} prospects** in the database.${d.data?.length ? ` Showing ${d.data.length}.` : ""}`, data: parsed };
    }
  }

  if (toolName === "sales.list_deals" && Array.isArray(parsed)) {
    const deals = parsed as Array<{ stage: string; value: number | null; company_name: string }>;
    const totalValue = deals.reduce((s, d) => s + (d.value || 0), 0);
    const byStage: Record<string, number> = {};
    deals.forEach(d => { byStage[d.stage] = (byStage[d.stage] || 0) + 1; });
    const stageBreakdown = Object.entries(byStage).map(([k, v]) => `${k}: ${v}`).join(", ");
    return { response: `🎯 **${deals.length} active deals** — Total pipeline: **$${totalValue.toLocaleString()}**\nStages: ${stageBreakdown}`, data: parsed };
  }

  if (toolName === "orders.list_orders" && Array.isArray(parsed)) {
    const ords = parsed as Array<{ total: number; status: string }>;
    const totalRev = ords.reduce((s, o) => s + (o.total || 0), 0);
    return { response: `📦 **${ords.length} recent orders** — Total: **$${totalRev.toLocaleString()}**`, data: parsed };
  }

  if (toolName === "inventory.get_stock_levels" && Array.isArray(parsed)) {
    const low = (parsed as Array<{ needs_reorder: number }>).filter(i => i.needs_reorder).length;
    return { response: `📦 **${(parsed as unknown[]).length} SKUs** shown. ${low > 0 ? `⚠️ ${low} need reorder.` : "All stocked."}`, data: parsed };
  }

  if (toolName === "finance.get_pnl" && parsed && typeof parsed === "object") {
    const p = parsed as { total?: { revenue?: number; netIncome?: number; grossMarginPct?: number } };
    if (p.total) {
      return { response: `💰 Revenue: **$${(p.total.revenue || 0).toLocaleString()}** | Net: **$${(p.total.netIncome || 0).toLocaleString()}** | Margin: **${p.total.grossMarginPct || 0}%**`, data: parsed };
    }
  }

  if (toolName === "intelligence.get_business_health" && parsed && typeof parsed === "object") {
    const h = parsed as { overall: number; status: string };
    return { response: `🏥 Business Health: **${h.overall}/100** (${h.status})`, data: parsed };
  }

  if (toolName === "customers.list_accounts" && parsed && typeof parsed === "object") {
    const d = parsed as { total: number };
    return { response: `👥 **${d.total} customer accounts**`, data: parsed };
  }

  if (toolName === "catalog.list_products" && parsed && typeof parsed === "object") {
    const d = parsed as { total: number };
    return { response: `📋 **${d.total} products** in catalog`, data: parsed };
  }

  // Fallback: return truncated raw
  const preview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
  return { response: `✅ ${label}\n\`\`\`\n${preview}\n\`\`\``, data: parsed };
}

const HELP_TEXT = `🤖 **The Frame AI Assistant**

Ask me things like:
• "How many prospects do we have?"
• "Show pipeline value"
• "What's our top seller?"
• "Show low stock items"
• "Revenue this month" / "YTD P&L"
• "Cash flow summary"
• "Business health score"
• "Recent orders"
• "Customer health"
• "Show campaigns"
• "SEO rankings"
• "Geographic analysis"

I can also navigate: "go to catalog", "go to pipeline"`;

export async function POST(req: NextRequest) {
  ensureAllToolsRegistered();
  try {
    const body = await req.json();
    const message = body.message?.trim();
    if (!message) {
      return NextResponse.json({ response: "Please type a message." }, { status: 400 });
    }

    // Help
    if (/^help$|what can you/i.test(message)) {
      return NextResponse.json({ response: HELP_TEXT });
    }

    const intent = parseIntent(message);
    if (!intent) {
      return NextResponse.json({
        response: `I'm not sure how to answer that yet. Try "help" to see what I can do, or ask about prospects, pipeline, orders, inventory, revenue, or trends.`,
      });
    }

    const result = await mcpRegistry.call(intent.tool, intent.args);
    const formatted = formatResponse(intent.tool, result, intent.label);

    return NextResponse.json(formatted);
  } catch (err) {
    console.error("[chat] Error:", err);
    return NextResponse.json({ response: `❌ Something went wrong: ${(err as Error).message}` }, { status: 500 });
  }
}
