// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { Suspense, useEffect, useState } from "react";
import { signIn, signUp } from "@/lib/auth/client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Invitation hand-off (Phase 3.3): the accept page sends users here with
  // ?callback=/invitations/<token>&invitation=<token>&email=<addr>. After
  // a successful sign-in OR sign-up we push the user back to `callback`,
  // which retriggers the accept POST.
  const callback = searchParams.get("callback");
  const invitation = searchParams.get("invitation");
  const presetEmail = searchParams.get("email");
  const [email, setEmail] = useState(presetEmail ?? "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  // Default to the signup form when arriving from an invitation — the
  // common case is a brand-new user.
  const [isSignUp, setIsSignUp] = useState(!!invitation);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (presetEmail) setEmail(presetEmail);
  }, [presetEmail]);

  const safeCallback = (() => {
    // Only honour callback if it's a same-origin relative path. Prevents
    // open-redirect via a crafted ?callback=https://attacker.example/.
    if (!callback) return null;
    if (!callback.startsWith("/")) return null;
    if (callback.startsWith("//")) return null;
    return callback;
  })();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (isSignUp) {
        const result = await signUp(email, password, name || email);
        if (result.error) {
          setError(result.error.message ?? "Sign up failed");
          return;
        }
      } else {
        const result = await signIn(email, password);
        if (result.error) {
          setError(result.error.message ?? "Sign in failed");
          return;
        }
      }
      router.push(safeCallback ?? "/app/home");
    } catch (err) {
      // better-auth throws (rather than returning result.error) on transport
      // failures — notably a 429 rate-limit, whose body comes back as
      // text/plain and fails JSON parsing. Surface something actionable.
      const status = (err as { status?: number; statusCode?: number } | null);
      const code = status?.status ?? status?.statusCode;
      const msg = String((err as { message?: string } | null)?.message ?? "");
      if (code === 429 || /too many|rate.?limit/i.test(msg)) {
        setError("Too many attempts. Please wait a minute and try again.");
      } else {
        setError("Couldn't sign in — check your connection and try again.");
      }
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
            {isSignUp ? "Create your account" : "Sign in to your account"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignUp && (
            <input
              type="text"
              aria-label="Name"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          )}
          <input
            type="email"
            aria-label="Email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            type="password"
            aria-label="Password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
            {loading ? "Loading..." : isSignUp ? "Create Account" : "Sign In"}
          </button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          {isSignUp ? "Already have an account?" : "Need an account?"}{" "}
          <button
            type="button"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError("");
            }}
            className="font-medium text-primary-text hover:underline"
          >
            {isSignUp ? "Sign in" : "Sign up"}
          </button>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary in App Router.
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center bg-background px-4">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}
