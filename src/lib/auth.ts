import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { users } from "@/modules/core/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

export type UserRole = "owner" | "sales_manager" | "warehouse" | "finance" | "marketing" | "support" | "ai";

declare module "next-auth" {
  interface User {
    role: UserRole;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: UserRole;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: UserRole;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email as string;
        const password = credentials.password as string;

        // Use raw sqlite to avoid Drizzle field mapping issues
        const { sqlite } = await import("@/lib/db");
        const user = sqlite.prepare(
          "SELECT id, email, name, role, password_hash, is_active FROM users WHERE email = ?"
        ).get(email) as { id: string; email: string; name: string; role: string; password_hash: string | null; is_active: number } | undefined;

        if (!user || !user.is_active) return null;
        if (!user.password_hash) return null;

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return null;

        // Update last login
        sqlite.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), user.id);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role as UserRole,
        };
      },
    }),
  ],
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 }, // 7 days per CTO review
  pages: { signIn: "/login" },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.role = user.role as UserRole;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      return session;
    },
  },
});

// ── Role helper for API routes ──

export function requireRole(allowedRoles: UserRole[]) {
  return async () => {
    const session = await auth();
    if (!session?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    if (!allowedRoles.includes(session.user.role)) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
    }
    return null; // authorized
  };
}
