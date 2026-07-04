// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { signIn, signUp, signInSSO, ssoProviderId } from "@/lib/auth/client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { PasskeyLogin } from "@/components/auth/passkey-login";

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
  // Mirrors the check inside <PasskeyLogin/> so the "or" divider only renders
  // when at least one alternative sign-in method will actually appear.
  const [passkeySupported, setPasskeySupported] = useState(false);

  useEffect(() => {
    if (presetEmail) setEmail(presetEmail);
  }, [presetEmail]);

  useEffect(() => {
    setPasskeySupported(browserSupportsWebAuthn());
  }, []);

  const safeCallback = (() => {
    // Only honour callback if it's a same-origin relative path. Prevents
    // open-redirect via a crafted ?callback=https://attacker.example/.
    if (!callback) return null;
    if (!callback.startsWith("/")) return null;
    if (callback.startsWith("//")) return null;
    return callback;
  })();

  // One-time sign-in link consumption (?token=<hex>). The verify endpoint
  // mints the session cookie itself and returns JSON — on success we just
  // redirect like a password login. Ref-guarded: tokens are single-use, so a
  // strict-mode double effect run must not fire the GET twice.
  const linkToken = searchParams.get("token");
  const linkConsumed = useRef(false);
  useEffect(() => {
    if (!linkToken || linkConsumed.current) return;
    linkConsumed.current = true;
    // Strip the single-use token from the URL so it never lands in
    // browser history or a Referer header.
    window.history.replaceState({}, "", "/login");
    fetch(`/api/auth/verify-link?token=${encodeURIComponent(linkToken)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          verified?: boolean;
        } | null;
        if (res.ok && data?.verified) {
          router.push(safeCallback ?? "/app/home");
        } else {
          setError("Sign-in link invalid or expired");
        }
      })
      .catch(() => setError("Sign-in link invalid or expired"));
  }, [linkToken, router, safeCallback]);

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

        {/* M14 / ADR 0056 — SSO, shown only when an IdP is configured. Mobile
            (?mobile=1) routes the post-login redirect through the PAT handoff.
            Jex — passkey sign-in shares the divider block. */}
        {(ssoProviderId || passkeySupported) && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <PasskeyLogin
              onSuccess={() => router.push(safeCallback ?? "/app/home")}
            />
            {ssoProviderId && (
              <button
                type="button"
                aria-label="Sign in with SSO"
                onClick={() =>
                  signInSSO(
                    ssoProviderId,
                    searchParams.get("mobile") === "1"
                      ? "/mobile/auth-handoff"
                      : (safeCallback ?? "/app/home")
                  )
                }
                className="w-full rounded border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary"
              >
                Sign in with SSO
              </button>
            )}
          </div>
        )}

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
