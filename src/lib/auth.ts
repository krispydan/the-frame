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

        const user = db.select().from(users).where(eq(users.email, email)).get();
        if (!user || !user.isActive) return null;

        // Check password hash stored in user metadata or dedicated column
        const passwordHash = (user as Record<string, unknown>).passwordHash as string | undefined;
        if (!passwordHash) return null;

        const valid = await bcrypt.compare(password, passwordHash);
        if (!valid) return null;

        // Update last login
        db.update(users).set({ lastLoginAt: new Date().toISOString() }).where(eq(users.id, user.id)).run();

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
