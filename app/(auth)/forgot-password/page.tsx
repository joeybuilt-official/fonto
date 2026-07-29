// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { requestPasswordReset } from "@/lib/auth/client";

function ForgotPasswordInner() {
  const searchParams = useSearchParams();
  // Carry ?mobile=1 through the reset flow so the confirm page can bounce the
  // user back to the mobile login (PAT handoff) after they set a new password.
  const isMobile = searchParams.get("mobile") === "1";
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // The link lands on /reset-password?token=… (Better Auth appends the
      // token). We ignore the result on purpose — always show the same
      // generic confirmation so we never reveal whether an address exists.
      await requestPasswordReset(
        email,
        isMobile ? "/reset-password?mobile=1" : "/reset-password"
      );
      setSent(true);
    } catch {
      setSent(true);
    } finally {
      setLoading(false);
    }
  }

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
            Reset your password
          </p>
        </div>

        {sent ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-foreground">
              If an account exists for that email, we&apos;ve sent a link to
              reset your password.
            </p>
            <p className="text-sm text-muted-foreground">
              Didn&apos;t get it? Check your spam folder, or{" "}
              <button
                type="button"
                onClick={() => setSent(false)}
                className="font-medium text-primary-text hover:underline"
              >
                try again
              </button>
              .
            </p>
            <Link
              href={isMobile ? "/login?mobile=1" : "/login"}
              className="block text-sm font-medium text-primary-text hover:underline"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="email"
                aria-label="Email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />

              {error && <p className="text-sm text-destructive">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? "Sending…" : "Send reset link"}
              </button>
            </form>

            <p className="text-center text-sm text-muted-foreground">
              Remembered it?{" "}
              <Link
                href={isMobile ? "/login?mobile=1" : "/login"}
                className="font-medium text-primary-text hover:underline"
              >
                Sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center bg-background px-4">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <ForgotPasswordInner />
    </Suspense>
  );
}
