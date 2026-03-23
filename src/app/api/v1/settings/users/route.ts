import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sqlite } from "@/lib/db";
import { sendInviteEmail } from "@/lib/email";
import bcrypt from "bcryptjs";

// GET /api/v1/settings/users — list all users
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const users = sqlite
    .prepare("SELECT id, email, name, role, is_active, last_login_at, created_at FROM users ORDER BY created_at ASC")
    .all();

  return NextResponse.json(users);
}

// POST /api/v1/settings/users — invite new user
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "owner") {
    return NextResponse.json({ error: "Only owners can invite users" }, { status: 403 });
  }

  const { name, email, role } = await req.json();
  if (!name || !email || !role) {
    return NextResponse.json({ error: "Name, email, and role are required" }, { status: 400 });
  }

  // Check if email already exists
  const existing = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 });
  }

  // Generate temp password
  const tempPassword = crypto.randomUUID().slice(0, 12);
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  const id = crypto.randomUUID();

  sqlite
    .prepare(
      "INSERT INTO users (id, email, name, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))"
    )
    .run(id, email, name, passwordHash, role);

  // Send invite email
  const baseUrl = process.env.NEXTAUTH_URL || "https://theframe.getjaxy.com";
  const loginUrl = `${baseUrl}/login`;
  await sendInviteEmail(email, name, tempPassword, loginUrl);

  return NextResponse.json({ id, email, name, role, invited: true });
}
