import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchResult {
  type: "prospect" | "product" | "deal" | "order";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 10, 50);

  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const pattern = `%${q}%`;
  const results: SearchResult[] = [];

  // Companies (prospects)
  try {
    const companies = sqlite
      .prepare(`SELECT id, name, city, state FROM companies WHERE name LIKE ? OR city LIKE ? OR state LIKE ? LIMIT ?`)
      .all(pattern, pattern, pattern, limit) as { id: string; name: string; city: string | null; state: string | null }[];
    for (const c of companies) {
      results.push({ type: "prospect", id: c.id, title: c.name, subtitle: [c.city, c.state].filter(Boolean).join(", ") || "Prospect", href: `/prospects/${c.id}` });
    }
  } catch { /* table may not exist */ }

  // Products
  try {
    const products = sqlite
      .prepare(`SELECT id, sku_prefix, name FROM catalog_products WHERE sku_prefix LIKE ? OR name LIKE ? LIMIT ?`)
      .all(pattern, pattern, limit) as { id: string; sku_prefix: string | null; name: string | null }[];
    for (const p of products) {
      results.push({ type: "product", id: p.id, title: p.name || p.sku_prefix || "Unnamed Product", subtitle: p.sku_prefix || "Product", href: `/catalog/${p.id}` });
    }
  } catch { /* table may not exist */ }

  // Deals
  try {
    const deals = sqlite
      .prepare(`SELECT d.id, d.title, c.name as company_name FROM deals d LEFT JOIN companies c ON d.company_id = c.id WHERE d.title LIKE ? OR c.name LIKE ? LIMIT ?`)
      .all(pattern, pattern, limit) as { id: string; title: string; company_name: string | null }[];
    for (const d of deals) {
      results.push({ type: "deal", id: d.id, title: d.title, subtitle: d.company_name || "Deal", href: `/pipeline?deal=${d.id}` });
    }
  } catch { /* table may not exist */ }

  // Orders
  try {
    const orderRows = sqlite
      .prepare(`SELECT id, order_number FROM orders WHERE order_number LIKE ? OR id LIKE ? LIMIT ?`)
      .all(pattern, pattern, limit) as { id: string; order_number: string }[];
    for (const o of orderRows) {
      results.push({ type: "order", id: o.id, title: `Order ${o.order_number}`, subtitle: "Order", href: `/orders/${o.id}` });
    }
  } catch { /* table may not exist */ }

  return NextResponse.json({ results: results.slice(0, limit) });
}
