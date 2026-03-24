export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-middleware";

export const POST = apiHandler(
  async (_request: NextRequest, context) => {
    return NextResponse.json({
      ok: true,
      user: {
        id: context.user.id,
        name: context.user.name,
        role: context.user.role,
      },
    });
  },
  { auth: true }
);
