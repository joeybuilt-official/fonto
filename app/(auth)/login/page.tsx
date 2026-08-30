// SPDX-License-Identifier: MIT
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

  // Mobile PAT handoff (?mobile=1): EVERY successful sign-in — password,
  // passkey, one-time link, SSO — must bounce through /mobile/auth-handoff so
  // the native app gets its PAT deep-link instead of landing in the web UI.
  const isMobileHandoff = searchParams.get("mobile") === "1";
  const successTarget = isMobileHandoff
    ? "/mobile/auth-handoff"
    : (safeCallback ?? "/app/home");
  // Route handlers aren't in the client route tree — router.push would 404;
  // the handoff needs a real browser navigation so its redirect chain can
  // reach the app-link deep link.
  const go = () => {
    if (isMobileHandoff) window.location.assign(successTarget);
    else router.push(successTarget);
  };

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
    // browser history or a Referer header. Keep ?mobile=1 so a failed
    // consume still leaves the PAT-handoff flow intact for a retry.
    window.history.replaceState(
      {},
      "",
      searchParams.get("mobile") === "1" ? "/login?mobile=1" : "/login"
    );
    fetch(`/api/auth/verify-link?token=${encodeURIComponent(linkToken)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          verified?: boolean;
        } | null;
        if (res.ok && data?.verified) {
          go();
        } else {
          setError("Sign-in link invalid or expired");
        }
      })
      .catch(() => setError("Sign-in link invalid or expired"));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- go is stable per render inputs
  }, [linkToken]);

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
      go();
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
    <div className="flex flex-1 items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center">
            <Link
              href="/"
              className="font-heading text-2xl font-semibold tracking-tight text-foreground"
            >
              <span className="text-primary">_</span>fonto
            </Link>
          </div>
          <h1 className="text-lg font-medium tracking-tight text-foreground">
            {isSignUp ? "Create your account" : "Sign in to Fonto"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isSignUp ? "A few details and you're in." : "Your account"}
          </p>
        </div>

        <div className="rounded-md border border-border bg-card p-6">
          <form onSubmit={handleSubmit} className="space-y-3">
            {isSignUp && (
              <div>
                <label htmlFor="login-name" className="mb-1 block text-xs font-medium text-muted-foreground">
                  Name
                </label>
                <input
                  id="login-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  className="w-full rounded-md border border-border bg-card px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/20"
                />
              </div>
            )}
            <div>
              <label htmlFor="login-email" className="mb-1 block text-xs font-medium text-muted-foreground">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="w-full rounded-md border border-border bg-card px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="login-password" className="block text-xs font-medium text-muted-foreground">
                  Password
                </label>
                {!isSignUp && (
                  <Link
                    href={
                      isMobileHandoff
                        ? "/forgot-password?mobile=1"
                        : "/forgot-password"
                    }
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    Forgot?
                  </Link>
                )}
              </div>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={isSignUp ? "new-password" : "current-password"}
                // Only enforce a minimum on sign-UP. Existing accounts with a
                // legacy sub-8-char password must still be able to sign in.
                minLength={isSignUp ? 8 : undefined}
                placeholder="••••••••••••"
                className="w-full rounded-md border border-border bg-card px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/30 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
            </div>

            {error && (
              <div
                role="alert"
                aria-live="polite"
                className="rounded-md border border-border px-3 py-2 text-xs text-foreground"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Signing in…" : isSignUp ? "Create Account" : "Sign In"}
            </button>
          </form>

          {/* M14 / ADR 0056 — SSO, shown only when an IdP is configured. Mobile
              (?mobile=1) routes the post-login redirect through the PAT handoff.
              Jex — passkey sign-in shares the divider block. */}
          {(ssoProviderId || passkeySupported) && (
            <div className="mt-4 space-y-3">
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>
              <PasskeyLogin
                onSuccess={go}
              />
              {ssoProviderId && (
                <button
                  type="button"
                  aria-label="Sign in with SSO"
                  onClick={() =>
                    signInSSO(
                      ssoProviderId,
                      successTarget
                    )
                  }
                  className="flex w-full items-center justify-center rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-primary/20"
                >
                  Sign in with SSO
                </button>
              )}
            </div>
          )}
        </div>

        <p className="mt-5 text-center text-xs text-muted-foreground">
          {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
          <button
            type="button"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError("");
            }}
            className="font-medium text-foreground hover:underline"
          >
            {isSignUp ? "Sign in" : "Create one"}
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
