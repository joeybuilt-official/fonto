// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

/**
 * AI connection settings — where a user points Fonto's intelligence at a
 * provider of their choosing.
 *
 * A connection is (label, base URL, model, API key). The key is written
 * encrypted and NEVER read back: the list shows a masked last-4 only, so this
 * screen can be opened in a shared browser without leaking a secret. The first
 * connection a user saves becomes the default automatically; changing the
 * default is one click.
 *
 * When the deployment supplies a default connection (the operator's, e.g. a
 * LiteLLM gateway), that is shown too, clearly labelled as the deployment
 * fallback — so "where is my AI coming from?" always has an answer on screen.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ConfirmButton } from "@/components/confirm-button";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";

interface AiConnection {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  keyLast4: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  connections: AiConnection[];
  envFallbackAvailable: boolean;
}

const EMPTY_FORM = { id: "", label: "", baseUrl: "", model: "", apiKey: "" };

export function AiConnectionsSection() {
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const [envFallback, setEnvFallback] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/connections", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ListResponse;
      setConnections(data.connections ?? []);
      setEnvFallback(Boolean(data.envFallbackAvailable));
    } catch {
      // Non-fatal: the section simply shows nothing configured.
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(form.id ? { id: form.id } : {}),
          label: form.label,
          baseUrl: form.baseUrl,
          model: form.model,
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not save the connection.");
        return;
      }
      setForm(EMPTY_FORM);
      await load();
    } catch {
      setError("Could not save the connection.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault(id: string) {
    await fetch("/api/ai/connections", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => undefined);
    await load();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/ai/connections?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => undefined);
    await load();
  }

  function beginEdit(conn: AiConnection) {
    setForm({
      id: conn.id,
      label: conn.label,
      baseUrl: conn.baseUrl,
      model: conn.model,
      apiKey: "",
    });
    setError(null);
  }

  const busy = saving;

  return (
    <div className="space-y-[var(--ft-space-3)]">
      {envFallback && (
        <div className="flex items-center justify-between gap-[var(--ft-space-3)]">
          <div>
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
              Deployment default
            </p>
            <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
              A default connection is supplied by this deployment. Add your own
              below to override it for your requests.
            </p>
          </div>
          <Chip variant="assist" disabled className="opacity-100 disabled:opacity-100">
            Available
          </Chip>
        </div>
      )}

      {loading ? (
        <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface-variant)]">
          Loading connections…
        </p>
      ) : connections.length === 0 ? (
        <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface-variant)]">
          No personal connection configured.
        </p>
      ) : (
        <ul className="space-y-[var(--ft-space-2)]">
          {connections.map((conn) => (
            <li
              key={conn.id}
              className="flex items-center justify-between gap-[var(--ft-space-3)] rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline-variant)] p-[var(--ft-space-3)]"
            >
              <div className="min-w-0">
                <p className="truncate text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                  {conn.label}
                  {conn.isDefault && (
                    <span className="ml-[var(--ft-space-2)] text-[length:var(--ft-type-label-small-size)] text-[var(--ft-color-primary-text)]">
                      default
                    </span>
                  )}
                </p>
                <p className="truncate text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                  {conn.model} · {conn.baseUrl}
                  {conn.keyLast4 ? ` · key ••••${conn.keyLast4}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-[var(--ft-space-2)]">
                {!conn.isDefault && (
                  <Button
                    variant="outlined"
                    size="sm"
                    onClick={() => void handleSetDefault(conn.id)}
                  >
                    Make default
                  </Button>
                )}
                <Button variant="outlined" size="sm" onClick={() => beginEdit(conn)}>
                  Edit
                </Button>
                <ConfirmButton
                  onConfirm={() => void handleDelete(conn.id)}
                  destructive
                  confirmLabel="Confirm delete"
                  className="h-7 border border-[var(--ft-color-outline)] px-2.5 text-[0.8rem] font-medium text-[var(--ft-color-on-surface)]"
                >
                  Delete
                </ConfirmButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-[var(--ft-space-3)] rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline-variant)] p-[var(--ft-space-3)]">
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
          {form.id ? "Edit connection" : "Add a connection"}
        </p>
        <div className="grid gap-[var(--ft-space-3)] sm:grid-cols-2">
          <TextField>
            <TextFieldLabel>Label</TextFieldLabel>
            <TextFieldInput
              value={form.label}
              placeholder="My LiteLLM"
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
          </TextField>
          <TextField>
            <TextFieldLabel>Model</TextFieldLabel>
            <TextFieldInput
              value={form.model}
              placeholder="auto"
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            />
          </TextField>
          <TextField className="sm:col-span-2">
            <TextFieldLabel>Base URL</TextFieldLabel>
            <TextFieldInput
              value={form.baseUrl}
              placeholder="https://my-gateway.example.com/v1"
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            />
          </TextField>
          <TextField className="sm:col-span-2">
            <TextFieldLabel>
              API key {form.id ? "(leave blank to keep the stored key)" : ""}
            </TextFieldLabel>
            <TextFieldInput
              type="password"
              value={form.apiKey}
              placeholder="sk-…"
              autoComplete="off"
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            />
          </TextField>
        </div>
        {error && (
          <p className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-error)]">
            {error}
          </p>
        )}
        <div className="flex items-center gap-[var(--ft-space-2)]">
          <Button variant="filled" size="sm" onClick={() => void handleSave()} disabled={busy}>
            {busy ? "Saving…" : form.id ? "Save changes" : "Add connection"}
          </Button>
          {form.id && (
            <Button variant="outlined" size="sm" onClick={() => setForm(EMPTY_FORM)} disabled={busy}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
