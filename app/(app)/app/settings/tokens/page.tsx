// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Scope = "read" | "write" | "admin";

interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  firstFour: string;
  lastFour: string;
  scopes: Scope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface CreatedToken extends TokenSummary {
  token: string;
}

const EXPIRY_OPTIONS = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never", days: null as number | null },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function TokensPage() {
  const [tokens, setTokens] = useState<TokenSummary[] | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [expiryDays, setExpiryDays] = useState<number | null>(90);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/v1/tokens");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setTokens(data.tokens);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleScope = (s: Scope) => {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scopes,
          expiresInDays: expiryDays,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({ error: r.statusText }));
        throw new Error(data.error ?? `HTTP ${r.status}`);
      }
      const created: CreatedToken = await r.json();
      setJustCreated(created);
      setName("");
      setScopes(["read"]);
      setExpiryDays(90);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (id: string) => {
    if (!confirm("Revoke this token? Any client using it will lose access immediately.")) {
      return;
    }
    try {
      const r = await fetch(`/api/v1/tokens/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const onCopy = async () => {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — user can still select+copy by hand */
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link
          href="/app/settings"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Settings
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-semibold text-foreground">API tokens</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Personal access tokens for the Fonto API. Use these from the CLI,
          the mobile app, or any 3rd-party integration. Send as
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">Authorization: Bearer fonto_pat_…</code>
          or
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">x-api-key: fonto_pat_…</code>.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {justCreated && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              Token created — copy it now
            </h2>
            <button
              type="button"
              onClick={() => setJustCreated(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            This is the <strong>only time</strong> you&apos;ll see this token in
            full. Copy it now and store it somewhere safe (a password manager).
            If you lose it, revoke it and create a new one.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all overflow-x-auto rounded-md border border-border bg-card px-3 py-2 text-xs font-mono text-foreground">
              {justCreated.token}
            </code>
            <button
              type="button"
              onClick={onCopy}
              className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <form
        onSubmit={onCreate}
        className="rounded-lg border border-border bg-card p-6 space-y-4"
      >
        <h2 className="text-sm font-semibold text-foreground">Create a token</h2>
        <div className="space-y-2">
          <label htmlFor="token-name" className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Name
          </label>
          <input
            id="token-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. MacBook CLI"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            required
            maxLength={120}
          />
        </div>

        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Scopes
          </span>
          <div className="flex flex-wrap gap-3">
            {(["read", "write", "admin"] as Scope[]).map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={() => toggleScope(s)}
                />
                <span className="capitalize">{s}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            <strong>read</strong> — list, read, search.
            <strong className="ml-2">write</strong> — upload, edit, delete.
            <strong className="ml-2">admin</strong> — manage workspace settings.
            Higher scopes imply lower ones.
          </p>
        </div>

        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Expires in
          </span>
          <div className="flex flex-wrap gap-3">
            {EXPIRY_OPTIONS.map((opt) => (
              <label key={opt.label} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="expiry"
                  checked={expiryDays === opt.days}
                  onChange={() => setExpiryDays(opt.days)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={creating || !name.trim() || scopes.length === 0}
            className="rounded-md border border-border bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create token"}
          </button>
        </div>
      </form>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Active tokens</h2>
        {tokens === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tokens yet. Create one above.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {tokens.map((t) => (
              <li key={t.id} className="py-3 flex items-center justify-between gap-4">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {t.name}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground">
                      {t.prefix}{t.firstFour}…{t.lastFour}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                    <span>scopes: {t.scopes.join(", ")}</span>
                    <span>created: {formatDate(t.createdAt)}</span>
                    <span>last used: {formatDate(t.lastUsedAt)}</span>
                    <span>expires: {formatDate(t.expiresAt)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRevoke(t.id)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
