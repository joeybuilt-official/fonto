// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import {
  Button,
  Card,
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "@/components/ui";

interface WebhookEndpoint {
  id: string;
  url: string;
  enabledEvents: string[];
  description: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDelivery {
  id: string;
  eventType: string;
  state: string;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastResponseStatus: number | null;
  lastResponseBody: string | null;
  createdAt: string;
}

const ALL_EVENTS = [
  "asset.uploaded",
  "asset.processed",
  "asset.deleted",
  "tag.created",
  "collection.created",
  "collection.shared",
];

export default function WebhooksSettingsPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newEvents, setNewEvents] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(ALL_EVENTS.map((e) => [e, true]))
  );
  const [createBusy, setCreateBusy] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{
    endpointId: string;
    secret: string;
  } | null>(null);

  // Per-endpoint expansion + deliveries
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});

  const loadEndpoints = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/webhooks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { endpoints: WebhookEndpoint[] };
      setEndpoints(data.endpoints);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEndpoints();
  }, [loadEndpoints]);

  const onCreate = async () => {
    setCreateBusy(true);
    setError(null);
    try {
      const enabledEvents = ALL_EVENTS.filter((e) => newEvents[e]);
      const res = await fetch("/api/v1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: newUrl,
          enabledEvents,
          description: newDescription || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        endpoint: WebhookEndpoint;
        signingSecret: string;
      };
      setRevealedSecret({ endpointId: body.endpoint.id, secret: body.signingSecret });
      setShowCreate(false);
      setNewUrl("");
      setNewDescription("");
      await loadEndpoints();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create");
    } finally {
      setCreateBusy(false);
    }
  };

  const onToggle = async (endpoint: WebhookEndpoint) => {
    const next = endpoint.disabledAt === null ? false : true;
    const res = await fetch(`/api/v1/webhooks/${endpoint.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setError(`Toggle failed: HTTP ${res.status}`);
      return;
    }
    await loadEndpoints();
  };

  const onDelete = async (endpoint: WebhookEndpoint) => {
    const res = await fetch(`/api/v1/webhooks/${endpoint.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(`Delete failed: HTTP ${res.status}`);
      return;
    }
    await loadEndpoints();
  };

  const onTest = async (endpoint: WebhookEndpoint) => {
    const res = await fetch(`/api/v1/webhooks/${endpoint.id}/test`, { method: "POST" });
    if (!res.ok) {
      setError(`Test failed: HTTP ${res.status}`);
      return;
    }
    // Refresh deliveries view for this endpoint.
    await loadDeliveries(endpoint.id);
  };

  const loadDeliveries = async (endpointId: string) => {
    try {
      const res = await fetch(`/api/v1/webhooks/${endpointId}/deliveries?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { deliveries: WebhookDelivery[] };
      setDeliveries((prev) => ({ ...prev, [endpointId]: data.deliveries }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load deliveries");
    }
  };

  const onExpand = (endpointId: string) => {
    if (expanded === endpointId) {
      setExpanded(null);
      return;
    }
    setExpanded(endpointId);
    if (!deliveries[endpointId]) void loadDeliveries(endpointId);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--ft-color-on-surface)]">Webhooks</h1>
        <p className="text-sm text-[var(--ft-color-on-surface-variant)] mt-1">
          Receive HTTPS callbacks when assets, tags, and collections change in your workspace.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-[var(--ft-color-error)]/40 bg-[var(--ft-color-error)]/10 px-3 py-2 text-sm text-[var(--ft-color-error)]">
          {error}
        </div>
      )}

      {revealedSecret && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm space-y-2">
          <p className="font-medium">Signing secret — shown once</p>
          <p className="text-xs text-[var(--ft-color-on-surface-variant)]">
            Save this somewhere safe. Fonto will never reveal it again.
          </p>
          <code className="block break-all rounded bg-[var(--ft-color-surface-container-low)] border border-[var(--ft-color-outline-variant)] px-2 py-1 font-mono text-xs">
            {revealedSecret.secret}
          </code>
          <button
            className="text-xs underline"
            onClick={() => setRevealedSecret(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <Card variant="outlined" className="p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--ft-color-outline-variant)]">
          <h2 className="text-sm font-semibold">Endpoints</h2>
          <Button
            variant="outlined"
            size="sm"
            onClick={() => setShowCreate((s) => !s)}
          >
            {showCreate ? "Cancel" : "Add endpoint"}
          </Button>
        </div>

        {showCreate && (
          <div className="px-4 py-4 border-b border-[var(--ft-color-outline-variant)] space-y-3 bg-[var(--ft-color-surface-container-high)]/40">
            <TextField name="webhook-url">
              <TextFieldLabel className="uppercase">URL</TextFieldLabel>
              <TextFieldInput
                type="url"
                placeholder="https://example.com/webhooks/fonto"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
              />
            </TextField>
            <TextField name="webhook-description">
              <TextFieldLabel className="uppercase">Description (optional)</TextFieldLabel>
              <TextFieldInput
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
            </TextField>
            <div>
              <label className="block text-xs font-medium text-[var(--ft-color-on-surface-variant)] uppercase mb-1">
                Events
              </label>
              <div className="grid grid-cols-2 gap-1">
                {ALL_EVENTS.map((e) => (
                  <label key={e} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!newEvents[e]}
                      onChange={(ev) =>
                        setNewEvents((prev) => ({ ...prev, [e]: ev.target.checked }))
                      }
                    />
                    <code className="text-xs">{e}</code>
                  </label>
                ))}
              </div>
            </div>
            <Button
              variant="filled"
              size="sm"
              disabled={!newUrl || createBusy}
              onClick={() => void onCreate()}
            >
              {createBusy ? "Creating…" : "Create endpoint"}
            </Button>
          </div>
        )}

        {loading ? (
          <p className="px-4 py-6 text-sm text-[var(--ft-color-on-surface-variant)]">Loading…</p>
        ) : endpoints.length === 0 ? (
          <p className="px-4 py-6 text-sm text-[var(--ft-color-on-surface-variant)]">No webhook endpoints yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--ft-color-outline-variant)]">
            {endpoints.map((endpoint) => {
              const isExpanded = expanded === endpoint.id;
              const enabled = endpoint.disabledAt === null;
              const list = deliveries[endpoint.id];
              return (
                <li key={endpoint.id} className="px-4 py-3 space-y-2">
                  {/* At 390px the URL + four action buttons overflow a single
                      row, so stack the actions under the URL on mobile and go
                      inline again at sm+. */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm truncate">{endpoint.url}</p>
                      <p className="text-xs text-[var(--ft-color-on-surface-variant)]">
                        {endpoint.enabledEvents.length} event(s) ·{" "}
                        <span className={enabled ? "text-[var(--ft-color-success,oklch(0.6_0.13_160))]" : "text-amber-600"}>
                          {enabled ? "enabled" : "disabled"}
                        </span>
                      </p>
                      {endpoint.description && (
                        <p className="text-xs text-[var(--ft-color-on-surface-variant)] mt-0.5">
                          {endpoint.description}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        variant="text"
                        size="xs"
                        onClick={() => void onTest(endpoint)}
                      >
                        Test
                      </Button>
                      <Button
                        variant="text"
                        size="xs"
                        onClick={() => void onToggle(endpoint)}
                      >
                        {enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        variant="text"
                        size="xs"
                        onClick={() => onExpand(endpoint.id)}
                      >
                        {isExpanded ? "Hide" : "Deliveries"}
                      </Button>
                      <ConfirmButton
                        onConfirm={() => void onDelete(endpoint)}
                        confirmLabel="Confirm delete"
                        className="h-6 px-2 text-xs"
                      >
                        Delete
                      </ConfirmButton>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="rounded border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-high)]/30 overflow-x-auto">
                      {list ? (
                        list.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-[var(--ft-color-on-surface-variant)]">
                            No deliveries yet.
                          </p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead className="text-[var(--ft-color-on-surface-variant)]">
                              <tr>
                                <th className="text-left px-2 py-1">Event</th>
                                <th className="text-left px-2 py-1">State</th>
                                <th className="text-left px-2 py-1">Status</th>
                                <th className="text-left px-2 py-1">Attempt</th>
                                <th className="text-left px-2 py-1">Last attempt</th>
                                <th className="text-left px-2 py-1">Response</th>
                              </tr>
                            </thead>
                            <tbody>
                              {list.map((d) => (
                                <tr key={d.id} className="border-t border-[var(--ft-color-outline-variant)]">
                                  <td className="px-2 py-1 font-mono">{d.eventType}</td>
                                  <td className="px-2 py-1">{d.state}</td>
                                  <td className="px-2 py-1">{d.lastResponseStatus ?? "—"}</td>
                                  <td className="px-2 py-1">{d.attempts}</td>
                                  <td className="px-2 py-1">
                                    {d.lastAttemptAt
                                      ? new Date(d.lastAttemptAt).toLocaleString()
                                      : "—"}
                                  </td>
                                  <td className="px-2 py-1">
                                    {d.lastResponseBody ? (
                                      // Native <details> is keyboard-accessible;
                                      // surfaces the response body that used to be
                                      // fetched but never rendered.
                                      <details>
                                        <summary className="cursor-pointer text-[var(--ft-color-primary-text)]">
                                          view
                                        </summary>
                                        <pre className="mt-1 max-w-[40ch] whitespace-pre-wrap break-all font-mono text-[10px] text-[var(--ft-color-on-surface-variant)]">
                                          {d.lastResponseBody}
                                        </pre>
                                      </details>
                                    ) : (
                                      "—"
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )
                      ) : (
                        <p className="px-3 py-2 text-xs text-[var(--ft-color-on-surface-variant)]">Loading…</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
