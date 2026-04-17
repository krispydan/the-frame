import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

const publicPaths = ["/login", "/api/auth", "/api/webhooks", "/api/health", "/api/seed", "/api/migrate", "/api/debug-auth", "/api/auth/manual-login", "/api/admin", "/api/v1/ext", "/api/v1/proxy", "/api/mcp", "/api/images", "/api/v1/catalog/images/upload-raw", "/api/v1/catalog/images/bulk-delete", "/api/v1/catalog/images/regen-collections", "/api/v1/inventory/bulk-update"];

function isPublicPath(pathname: string): boolean {
  return publicPaths.some((p) => pathname.startsWith(p));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // Check NextAuth token OR our custom session-token cookie
  const token = await getToken({ req: request });
  const sessionToken = request.cookies.get("session-token")?.value;

  if (!token && !sessionToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
