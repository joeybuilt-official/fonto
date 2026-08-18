// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export function PasskeyLogin({ onSuccess }: { onSuccess: () => void }) {
  // Detected in an effect (not during render) to avoid an SSR hydration
  // mismatch — the server pass always sees WebAuthn as unsupported.
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);

  if (!supported) return null;

  async function handleClick() {
    setBusy(true);
    setError("");
    try {
      const startRes = await fetch("/api/auth/passkey/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "start" }),
      });
      if (!startRes.ok) throw new Error(`HTTP ${startRes.status}`);
      const optionsJSON =
        (await startRes.json()) as PublicKeyCredentialRequestOptionsJSON;

      const response = await startAuthentication({ optionsJSON });

      const finishRes = await fetch("/api/auth/passkey/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "finish", response }),
      });
      const data = (await finishRes.json().catch(() => null)) as {
        verified?: boolean;
        error?: string;
      } | null;
      if (!finishRes.ok || !data?.verified) {
        throw new Error(data?.error ?? "Passkey sign-in failed");
      }
      // Session cookie is minted server-side — just navigate. Stay busy so
      // the button can't be re-clicked during the redirect.
      onSuccess();
    } catch (err) {
      setBusy(false);
      if (err instanceof Error && err.name === "NotAllowedError") return;
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Passkey sign-in failed"
      );
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-label="Sign in with passkey"
        aria-busy={busy}
        disabled={busy}
        onClick={handleClick}
        className="w-full rounded border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
      >
        {busy ? "Waiting for passkey…" : "Sign in with passkey"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
