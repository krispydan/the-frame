export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { mcpRegistry, ensureAllToolsRegistered } from "@/modules/core/mcp/server";
import { db } from "@/lib/db";
import { apiKeys } from "@/modules/core/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

// ── Rate limiting (in-memory, 100 req/min per key) ──
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(keyHash: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(keyHash);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(keyHash, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (entry.count >= 100) return false;
  entry.count++;
  return true;
}

// ── API Key auth ──
function authenticateApiKey(request: NextRequest): { ok: true; keyHash: string } | { ok: false; error: string; status: number } {
  const apiKey = request.headers.get("x-api-key");
  if (!apiKey) {
    return { ok: false, error: "Missing X-API-Key header", status: 401 };
  }

  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
  const key = db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .get();

  if (!key) {
    return { ok: false, error: "Invalid API key", status: 401 };
  }

  if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
    return { ok: false, error: "API key expired", status: 401 };
  }

  return { ok: true, keyHash };
}

/**
 * MCP endpoint — JSON-RPC 2.0 handler.
 * Protocol: MCP 2024-11-05
 * 
 * Supports: initialize, tools/list, tools/call
 */
export async function POST(request: NextRequest) {
  ensureAllToolsRegistered();
  const auth = authenticateApiKey(request);
  if (!auth.ok) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32600, message: auth.error } },
      { status: auth.status }
    );
  }

  if (!checkRateLimit(auth.keyHash)) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32600, message: "Rate limit exceeded (100 req/min)" } },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const { method, params, id } = body;

    if (method === "initialize") {
      return NextResponse.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "the-frame", version: "1.0.0" },
        },
      });
    }

    if (method === "tools/list") {
      return NextResponse.json({
        jsonrpc: "2.0",
        id,
        result: { tools: mcpRegistry.list() },
      });
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      const result = await mcpRegistry.call(name, args || {});
      return NextResponse.json({
        jsonrpc: "2.0",
        id,
        result,
      });
    }

    return NextResponse.json(
      { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32603, message: err instanceof Error ? err.message : String(err) } },
      { status: 500 }
    );
  }
}
