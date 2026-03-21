export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET() {
  try {
    const user = sqlite.prepare("SELECT id, email, name, role, password_hash, is_active FROM users WHERE email = ?").get("daniel@getjaxy.com") as Record<string, unknown> | undefined;
    return NextResponse.json({
      found: !!user,
      hasPasswordHash: !!user?.password_hash,
      passwordHashLength: (user?.password_hash as string)?.length || 0,
      isActive: user?.is_active,
      role: user?.role,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
