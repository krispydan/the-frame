export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET || "dev-secret-change-me");

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get("session-token")?.value;
    if (!token) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const { payload } = await jwtVerify(token, secret);
    return NextResponse.json({
      id: payload.id,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    });
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
}
