// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { resetPassword } from "@/lib/auth/client";

function ResetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Better Auth's reset callback redirects here with ?token=… (and ?error=
  // INVALID_TOKEN when the link is bad or expired).
  const token = searchParams.get("token");
  const linkError = searchParams.get("error");
  const isMobile = searchParams.get("mobile") === "1";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const loginHref = isMobile ? "/login?mobile=1" : "/login";
  const forgotHref = isMobile ? "/forgot-password?mobile=1" : "/forgot-password";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!token) return;
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setLoading(true);
    try {
      const result = await resetPassword(password, token);
      if (result.error) {
        setError(result.error.message ?? "Couldn't reset password");
        return;
      }
      setDone(true);
      // Back to sign in — mobile re-auths through the PAT handoff.
      setTimeout(() => router.push(loginHref), 1200);
    } catch {
      setError("Couldn't reset password — the link may have expired.");
    } finally {
      setLoading(false);
    }
  }

  const invalidLink = !token || linkError;

  return (
    <div className="flex flex-1 items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link
            href="/"
            className="font-heading text-2xl font-semibold tracking-tight text-foreground"
          >
            <span className="text-primary">_</span>fonto
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">
            Choose a new password
          </p>
        </div>

        {invalidLink ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-destructive">
              This reset link is invalid or has expired.
            </p>
            <Link
              href={forgotHref}
              className="block text-sm font-medium text-primary-text hover:underline"
            >
              Request a new link
            </Link>
          </div>
        ) : done ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-foreground">
              Password updated. Redirecting you to sign in…
            </p>
            <Link
              href={loginHref}
              className="block text-sm font-medium text-primary-text hover:underline"
            >
              Sign in now
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <input
              type="password"
              aria-label="New password"
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <input
              type="password"
              aria-label="Confirm new password"
              placeholder="Confirm new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              className="w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />

            {error && <p className="text-sm text-destructive">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Saving…" : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center bg-background px-4">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <ResetPasswordInner />
    </Suspense>
  );
}
