// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ConfirmButton } from "@/components/confirm-button";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "@/components/ui";

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
    <div className="space-y-[var(--ft-space-6)] max-w-3xl">
      <div className="flex items-center gap-[var(--ft-space-3)]">
        <Link
          href="/app/settings"
          className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
        >
          ← Settings
        </Link>
      </div>
      <div>
        <h1 className="text-[length:var(--ft-type-headline-small-size)] leading-[var(--ft-type-headline-small-line)] tracking-[var(--ft-type-headline-small-tracking)] font-medium text-[var(--ft-color-on-surface)]">
          API tokens
        </h1>
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)] mt-[var(--ft-space-1)]">
          Personal access tokens for the Fonto API. Use these from the CLI,
          the mobile app, or any 3rd-party integration. Send as
          <code className="mx-1 rounded-[var(--ft-shape-extra-small)] bg-[var(--ft-color-surface-container)] px-[var(--ft-space-1)] py-[2px] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)]">
            Authorization: Bearer fonto_pat_…
          </code>
          or
          <code className="mx-1 rounded-[var(--ft-shape-extra-small)] bg-[var(--ft-color-surface-container)] px-[var(--ft-space-1)] py-[2px] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)]">
            x-api-key: fonto_pat_…
          </code>
          .
        </p>
      </div>

      {error && (
        <div className="rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-error)]/40 bg-[var(--ft-color-error-container)] p-[var(--ft-space-3)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-error-container)]">
          {error}
        </div>
      )}

      {justCreated && (
        <Card variant="outlined" className="border-amber-500/50 bg-amber-500/5">
          <CardContent className="space-y-[var(--ft-space-3)]">
            <div className="flex items-center justify-between">
              <h2 className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)] font-medium text-[var(--ft-color-on-surface)]">
                Token created — copy it now
              </h2>
              <Button
                variant="text"
                size="sm"
                onClick={() => setJustCreated(null)}
              >
                Dismiss
              </Button>
            </div>
            <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
              This is the <strong>only time</strong> you&apos;ll see this token in
              full. Copy it now and store it somewhere safe (a password manager).
              If you lose it, revoke it and create a new one.
            </p>
            <div className="flex items-center gap-[var(--ft-space-2)]">
              <code className="flex-1 select-all overflow-x-auto rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-low)] px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] font-mono text-[var(--ft-color-on-surface)]">
                {justCreated.token}
              </code>
              <Button variant="outlined" size="sm" onClick={onCopy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card variant="outlined">
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Create a token
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="space-y-[var(--ft-space-4)]">
            <TextField>
              <TextFieldLabel htmlFor="token-name" className="uppercase tracking-wide">
                Name
              </TextFieldLabel>
              <TextFieldInput
                id="token-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. MacBook CLI"
                required
                maxLength={120}
              />
            </TextField>

            <div className="space-y-[var(--ft-space-2)]">
              {/* Scopes — multi-select checkboxes. No MD3 Checkbox primitive
                  exposed via the @/components/ui barrel yet, so the native
                  inputs stay; only labels + spacing move to tokens. Flagged
                  in agent report. */}
              <span className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] tracking-[var(--ft-type-label-small-tracking)] font-medium text-[var(--ft-color-on-surface-variant)] uppercase">
                Scopes
              </span>
              <div className="flex flex-wrap gap-[var(--ft-space-3)]">
                {(["read", "write", "admin"] as Scope[]).map((s) => (
                  <label
                    key={s}
                    className="flex items-center gap-[var(--ft-space-2)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]"
                  >
                    <input
                      type="checkbox"
                      checked={scopes.includes(s)}
                      onChange={() => toggleScope(s)}
                      className="accent-[var(--ft-color-primary)]"
                    />
                    <span className="capitalize">{s}</span>
                  </label>
                ))}
              </div>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                <strong>read</strong> — list, read, search.
                <strong className="ml-2">write</strong> — upload, edit, delete.
                <strong className="ml-2">admin</strong> — manage workspace settings.
                Higher scopes imply lower ones.
              </p>
            </div>

            <div className="space-y-[var(--ft-space-2)]">
              {/* Expiry — native radios; no MD3 RadioGroup primitive in barrel. */}
              <span className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] tracking-[var(--ft-type-label-small-tracking)] font-medium text-[var(--ft-color-on-surface-variant)] uppercase">
                Expires in
              </span>
              <div className="flex flex-wrap gap-[var(--ft-space-3)]">
                {EXPIRY_OPTIONS.map((opt) => (
                  <label
                    key={opt.label}
                    className="flex items-center gap-[var(--ft-space-2)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]"
                  >
                    <input
                      type="radio"
                      name="expiry"
                      checked={expiryDays === opt.days}
                      onChange={() => setExpiryDays(opt.days)}
                      className="accent-[var(--ft-color-primary)]"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                variant="filled"
                size="lg"
                disabled={creating || !name.trim() || scopes.length === 0}
              >
                {creating ? "Creating…" : "Create token"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Active tokens
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tokens === null ? (
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              Loading…
            </p>
          ) : tokens.length === 0 ? (
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              No tokens yet. Create one above.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--ft-color-outline-variant)]">
              {tokens.map((t) => (
                <li key={t.id} className="py-[var(--ft-space-3)] flex items-center justify-between gap-[var(--ft-space-4)]">
                  <div className="space-y-[var(--ft-space-1)] min-w-0 flex-1">
                    <div className="flex items-center gap-[var(--ft-space-2)]">
                      <span className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] font-medium text-[var(--ft-color-on-surface)] truncate">
                        {t.name}
                      </span>
                      <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] font-mono text-[var(--ft-color-on-surface-variant)]">
                        {t.prefix}{t.firstFour}…{t.lastFour}
                      </span>
                    </div>
                    <div className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)] flex flex-wrap gap-x-[var(--ft-space-3)] gap-y-[var(--ft-space-1)]">
                      <span>scopes: {t.scopes.join(", ")}</span>
                      <span>created: {formatDate(t.createdAt)}</span>
                      <span>last used: {formatDate(t.lastUsedAt)}</span>
                      <span>expires: {formatDate(t.expiresAt)}</span>
                    </div>
                  </div>
                  <ConfirmButton
                    onConfirm={() => onRevoke(t.id)}
                    confirmLabel="Confirm revoke"
                    className="h-7 shrink-0 border border-[var(--ft-color-error)]/40 px-2.5 text-[0.8rem] font-medium"
                  >
                    Revoke
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
