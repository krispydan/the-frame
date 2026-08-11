/**
 * MCP API-key management (ops-token guarded).
 *
 * GET  /api/admin/ops/mcp-key            → list keys (names + metadata, never the key)
 * POST /api/admin/ops/mcp-key?confirm=1  → mint a key: {name, expiresDays?}
 *        Returns the PLAINTEXT key ONCE — only the SHA-256 hash is stored,
 *        so losing it means minting a new one.
 * DELETE /api/admin/ops/mcp-key?confirm=1 → revoke: {name} or {id}
 *
 * This is the missing front door to /api/mcp: the server authenticated
 * against api_keys but nothing could create one. Usage: docs/mcp.md.
 */
export const dynamic = "force-dynamic";

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { requireOpsToken } from "@/lib/ops-auth";

export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  const keys = sqlite.prepare(
    `SELECT id, name, last_used_at, expires_at, created_at FROM api_keys ORDER BY created_at DESC`,
  ).all();
  return NextResponse.json({ ok: true, keys });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const existing = sqlite.prepare(`SELECT id FROM api_keys WHERE name = ?`).get(name);
  if (existing) {
    return NextResponse.json({ error: `A key named '${name}' already exists — revoke it first or pick a new name` }, { status: 409 });
  }

  // frame_ prefix makes leaked keys grep-able; 32 random bytes of entropy.
  const key = `frame_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = crypto.createHash("sha256").update(key).digest("hex");
  const expiresAt =
    typeof body.expiresDays === "number" && body.expiresDays > 0
      ? new Date(Date.now() + body.expiresDays * 86_400_000).toISOString()
      : null;

  sqlite.prepare(
    `INSERT INTO api_keys (id, name, key_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(crypto.randomUUID(), name, keyHash, expiresAt);

  return NextResponse.json({
    ok: true,
    name,
    key, // shown exactly once — only the hash is stored
    expiresAt,
    note: "Store this now. It cannot be retrieved again.",
  }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const res = typeof body.id === "string" && body.id
    ? sqlite.prepare(`DELETE FROM api_keys WHERE id = ?`).run(body.id)
    : typeof body.name === "string" && body.name
      ? sqlite.prepare(`DELETE FROM api_keys WHERE name = ?`).run(body.name)
      : null;
  if (!res) return NextResponse.json({ error: "Provide id or name" }, { status: 400 });
  if (res.changes === 0) return NextResponse.json({ error: "No such key" }, { status: 404 });
  return NextResponse.json({ ok: true, revoked: res.changes });
}
