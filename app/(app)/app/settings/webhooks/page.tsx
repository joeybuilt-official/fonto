// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chip,
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
    if (!confirm(`Delete webhook ${endpoint.url}?`)) return;
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
    <div className="space-y-[var(--ft-space-6)] max-w-3xl">
      <div>
        <h1 className="text-[length:var(--ft-type-headline-small-size)] leading-[var(--ft-type-headline-small-line)] tracking-[var(--ft-type-headline-small-tracking)] font-medium text-[var(--ft-color-on-surface)]">
          Webhooks
        </h1>
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)] mt-[var(--ft-space-1)]">
          Receive HTTPS callbacks when assets, tags, and collections change in your workspace.
        </p>
      </div>

      {error && (
        <div className="rounded-[var(--ft-shape-small)] border border-[var(--ft-color-error)]/40 bg-[var(--ft-color-error-container)] px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-error-container)]">
          {error}
        </div>
      )}

      {revealedSecret && (
        <div className="rounded-[var(--ft-shape-small)] border border-amber-500/50 bg-amber-500/10 px-[var(--ft-space-4)] py-[var(--ft-space-3)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)] space-y-[var(--ft-space-2)]">
          <p className="font-medium">Signing secret — shown once</p>
          <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
            Save this somewhere safe. Fonto will never reveal it again.
          </p>
          <code className="block break-all rounded-[var(--ft-shape-extra-small)] bg-[var(--ft-color-surface-container-low)] border border-[var(--ft-color-outline-variant)] px-[var(--ft-space-2)] py-[var(--ft-space-1)] font-mono text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)]">
            {revealedSecret.secret}
          </code>
          <Button
            variant="text"
            size="sm"
            onClick={() => setRevealedSecret(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      <Card variant="outlined">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Endpoints
          </CardTitle>
          <Button
            variant="outlined"
            size="sm"
            onClick={() => setShowCreate((s) => !s)}
          >
            {showCreate ? "Cancel" : "Add endpoint"}
          </Button>
        </CardHeader>

        {showCreate && (
          <div className="px-[var(--ft-space-4)] py-[var(--ft-space-4)] border-y border-[var(--ft-color-outline-variant)] space-y-[var(--ft-space-3)] bg-[var(--ft-color-surface-container-low)]">
            <TextField>
              <TextFieldLabel className="uppercase">URL</TextFieldLabel>
              <TextFieldInput
                type="url"
                placeholder="https://example.com/webhooks/fonto"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
              />
            </TextField>
            <TextField>
              <TextFieldLabel className="uppercase">
                Description (optional)
              </TextFieldLabel>
              <TextFieldInput
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
            </TextField>
            <div>
              {/* Events — native checkboxes; no MD3 Checkbox primitive in
                  the @/components/ui barrel yet. Flagged in agent report. */}
              <label className="block text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] tracking-[var(--ft-type-label-small-tracking)] font-medium text-[var(--ft-color-on-surface-variant)] uppercase mb-[var(--ft-space-1)]">
                Events
              </label>
              <div className="grid grid-cols-2 gap-[var(--ft-space-1)]">
                {ALL_EVENTS.map((e) => (
                  <label
                    key={e}
                    className="flex items-center gap-[var(--ft-space-2)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]"
                  >
                    <input
                      type="checkbox"
                      checked={!!newEvents[e]}
                      onChange={(ev) =>
                        setNewEvents((prev) => ({ ...prev, [e]: ev.target.checked }))
                      }
                      className="accent-[var(--ft-color-primary)]"
                    />
                    <code className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)]">
                      {e}
                    </code>
                  </label>
                ))}
              </div>
            </div>
            <Button
              variant="filled"
              size="default"
              disabled={!newUrl || createBusy}
              onClick={() => void onCreate()}
            >
              {createBusy ? "Creating…" : "Create endpoint"}
            </Button>
          </div>
        )}

        <CardContent>
          {loading ? (
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              Loading…
            </p>
          ) : endpoints.length === 0 ? (
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              No webhook endpoints yet.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--ft-color-outline-variant)]">
              {endpoints.map((endpoint) => {
                const isExpanded = expanded === endpoint.id;
                const enabled = endpoint.disabledAt === null;
                const list = deliveries[endpoint.id];
                return (
                  <li key={endpoint.id} className="py-[var(--ft-space-3)] space-y-[var(--ft-space-2)]">
                    <div className="flex items-center justify-between gap-[var(--ft-space-3)]">
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)] truncate">
                          {endpoint.url}
                        </p>
                        <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)] flex items-center gap-[var(--ft-space-2)]">
                          <span>{endpoint.enabledEvents.length} event(s)</span>
                          <span>·</span>
                          {/* Success role from 36152c8 for "enabled"; warning
                              stays on amber until a warning role is added. */}
                          <Chip
                            variant="assist"
                            disabled
                            className={
                              enabled
                                ? "h-5 border-transparent bg-[var(--ft-color-success-container)] text-[var(--ft-color-on-success-container)] px-[var(--ft-space-2)] text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] opacity-100 disabled:opacity-100"
                                : "h-5 border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400 px-[var(--ft-space-2)] text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] opacity-100 disabled:opacity-100"
                            }
                          >
                            {enabled ? "enabled" : "disabled"}
                          </Chip>
                        </p>
                        {endpoint.description && (
                          <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)] mt-[2px]">
                            {endpoint.description}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-[var(--ft-space-1)]">
                        <Button
                          variant="outlined"
                          size="xs"
                          onClick={() => void onTest(endpoint)}
                        >
                          Test
                        </Button>
                        <Button
                          variant="outlined"
                          size="xs"
                          onClick={() => void onToggle(endpoint)}
                        >
                          {enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          variant="outlined"
                          size="xs"
                          onClick={() => onExpand(endpoint.id)}
                        >
                          {isExpanded ? "Hide" : "Deliveries"}
                        </Button>
                        <Button
                          variant="outlined"
                          size="xs"
                          onClick={() => void onDelete(endpoint)}
                          className="border-[var(--ft-color-error)]/40 text-[var(--ft-color-error)] hover:bg-[var(--ft-color-error)]/10"
                        >
                          Delete
                        </Button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-low)] overflow-x-auto">
                        {list ? (
                          list.length === 0 ? (
                            <p className="px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                              No deliveries yet.
                            </p>
                          ) : (
                            <table className="w-full text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)]">
                              <thead className="text-[var(--ft-color-on-surface-variant)]">
                                <tr>
                                  <th className="text-left px-[var(--ft-space-2)] py-[var(--ft-space-1)]">Event</th>
                                  <th className="text-left px-[var(--ft-space-2)] py-[var(--ft-space-1)]">State</th>
                                  <th className="text-left px-[var(--ft-space-2)] py-[var(--ft-space-1)]">Status</th>
                                  <th className="text-left px-[var(--ft-space-2)] py-[var(--ft-space-1)]">Attempt</th>
                                  <th className="text-left px-[var(--ft-space-2)] py-[var(--ft-space-1)]">Last attempt</th>
                                </tr>
                              </thead>
                              <tbody>
                                {list.map((d) => (
                                  <tr key={d.id} className="border-t border-[var(--ft-color-outline-variant)]">
                                    <td className="px-[var(--ft-space-2)] py-[var(--ft-space-1)] font-mono">{d.eventType}</td>
                                    <td className="px-[var(--ft-space-2)] py-[var(--ft-space-1)]">{d.state}</td>
                                    <td className="px-[var(--ft-space-2)] py-[var(--ft-space-1)]">{d.lastResponseStatus ?? "—"}</td>
                                    <td className="px-[var(--ft-space-2)] py-[var(--ft-space-1)]">{d.attempts}</td>
                                    <td className="px-[var(--ft-space-2)] py-[var(--ft-space-1)]">
                                      {d.lastAttemptAt
                                        ? new Date(d.lastAttemptAt).toLocaleString()
                                        : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )
                        ) : (
                          <p className="px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                            Loading…
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
