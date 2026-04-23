"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type LoginMode = "password" | "magic-link";

function LoginForm() {
  const [mode, setMode] = useState<LoginMode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const searchParams = useSearchParams();
  const router = useRouter();
  const expiredError = searchParams.get("error") === "expired";

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/manual-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Invalid email or password");
        setLoading(false);
        return;
      }

      router.push("/dashboard");
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/magic-link/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        setLoading(false);
        return;
      }

      setSent(true);
      setLoading(false);
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
        </div>
        <div>
          <p className="text-lg font-semibold text-gray-900">Check your email</p>
          <p className="text-sm text-muted-foreground mt-1">
            We sent a sign-in link to <span className="font-medium text-gray-900">{email}</span>
          </p>
        </div>
        <button
          onClick={() => { setSent(false); setError(""); }}
          className="text-sm text-muted-foreground hover:text-gray-900 underline underline-offset-4"
        >
          Didn&apos;t receive it? Send again
        </button>
      </div>
    );
  }

  return (
    <>
      {expiredError && (
        <p className="text-sm text-amber-600 mb-4">
          That link has expired or already been used. Please request a new one.
        </p>
      )}

      {/* Mode toggle */}
      <div className="flex rounded-lg bg-muted p-1 mb-6">
        <button
          type="button"
          onClick={() => { setMode("password"); setError(""); }}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            mode === "password"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Email & Password
        </button>
        <button
          type="button"
          onClick={() => { setMode("magic-link"); setError(""); }}
          className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            mode === "magic-link"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Magic Link
        </button>
      </div>

      {mode === "password" ? (
        <form onSubmit={handlePasswordLogin} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="daniel@getjaxy.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              minLength={8}
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in..." : "Sign In"}
          </Button>
          <p className="text-xs text-center text-muted-foreground">
            No password yet?{" "}
            <button
              type="button"
              onClick={() => setMode("magic-link")}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Use a magic link instead
            </button>
          </p>
        </form>
      ) : (
        <form onSubmit={handleMagicLink} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email-ml">Email</Label>
            <Input
              id="email-ml"
              type="email"
              placeholder="daniel@getjaxy.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Sending..." : "Send Magic Link"}
          </Button>
          <p className="text-xs text-center text-muted-foreground">
            Have a password?{" "}
            <button
              type="button"
              onClick={() => setMode("password")}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Sign in with email & password
            </button>
          </p>
        </form>
      )}
    </>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-lg">
            TF
          </div>
          <CardTitle className="text-2xl">The Frame</CardTitle>
          <CardDescription>
            <span className="text-xs font-medium tracking-wider uppercase text-muted-foreground">by Jaxy</span>
            <br />
            Sign in to your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<div className="text-center text-muted-foreground">Loading...</div>}>
            <LoginForm />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
