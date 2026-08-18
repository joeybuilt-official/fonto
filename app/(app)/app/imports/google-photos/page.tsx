// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/imports/google-photos — Google Photos import via the Picker API. When
// not connected (or connected without the new Photos scope), a Connect button
// starts the shared Google OAuth flow. Once connected, the user opens Google's
// own picker in a new tab, picks photos there, and returns; we poll the session
// until the selection is set, then import the picked items. The browser never
// talks to Google directly — every session/list/download call is server-proxied.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportsList } from "../_components/imports-list";

interface Integration {
  provider: string;
  status: "active" | "needs_reconnect" | "revoked";
}

interface ImportSummary {
  imported: number;
  skipped: number;
  failed: Array<{ id: string; error: string }>;
  total: number;
}

export default function GooglePhotosImportPage() {
  // null = still loading the initial connection check.
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/integrations")
      .then((r) => r.json())
      .then((d: { integrations?: Integration[] }) => {
        if (cancelled) return;
        const g = (d.integrations ?? []).find((i) => i.provider === "google");
        setConnected(g?.status === "active");
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6 max-w-xl md:max-w-3xl">
      <div>
        <Link
          href="/app/imports"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Imports
        </Link>
        <h1 className="text-2xl font-semibold text-foreground mt-2">
          Import from Google Photos
        </h1>
      </div>

      {connected === null ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking connection…
          </div>
        </div>
      ) : connected ? (
        <PickAndImport onDisconnected={() => setConnected(false)} />
      ) : (
        <ConnectPrompt />
      )}

      <ImportsList />
    </div>
  );
}

function ConnectPrompt() {
  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <p className="text-sm text-muted-foreground">
        Connect your Google account so Fonto can import the photos you pick.
        You&apos;ll choose exactly which photos to share in Google&apos;s own
        picker — Fonto only ever sees the items you select.
      </p>
      <p className="text-xs text-muted-foreground">
        Already connected Google for Takeout? You still need to reconnect once to
        grant the new Photos permission.
      </p>
      <Button
        onClick={() => {
          window.location.href = "/api/v1/integrations/google/auth";
        }}
      >
        Connect Google
      </Button>
    </div>
  );
}

type PickerPhase = "idle" | "opening" | "waiting" | "ready" | "importing";

function PickAndImport({ onDisconnected }: { onDisconnected: () => void }) {
  const [phase, setPhase] = useState<PickerPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pickerUri, setPickerUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const poll = useCallback((sid: string, intervalMs: number) => {
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/v1/integrations/google-photos/session?sessionId=${encodeURIComponent(sid)}`
        );
        const body = (await res.json().catch(() => ({}))) as {
          mediaItemsSet?: boolean;
          pollIntervalMs?: number;
          needsReconnect?: boolean;
          error?: string;
        };
        if (!res.ok) {
          if (body.needsReconnect) {
            setError("Your Google connection expired. Reconnect and try again.");
          } else {
            setError(body.error ?? `HTTP ${res.status}`);
          }
          setPhase("idle");
          return;
        }
        if (body.mediaItemsSet) {
          setPhase("ready");
          return;
        }
        pollRef.current = setTimeout(tick, body.pollIntervalMs ?? intervalMs);
      } catch {
        pollRef.current = setTimeout(tick, intervalMs);
      }
    };
    pollRef.current = setTimeout(tick, intervalMs);
  }, []);

  async function openPicker() {
    setPhase("opening");
    setError(null);
    setSummary(null);
    try {
      const res = await fetch("/api/v1/integrations/google-photos/session", {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        sessionId?: string;
        pickerUri?: string;
        pollIntervalMs?: number;
        needsReconnect?: boolean;
        error?: string;
      };
      if (!res.ok || !body.sessionId || !body.pickerUri) {
        if (body.needsReconnect) {
          setError(
            "Your Google connection needs the Photos permission. Disconnect and reconnect to grant it."
          );
        } else {
          setError(body.error ?? `HTTP ${res.status}`);
        }
        setPhase("idle");
        return;
      }
      setSessionId(body.sessionId);
      setPickerUri(body.pickerUri);
      // Open Google's picker in a new tab; the user picks there and returns.
      window.open(body.pickerUri, "_blank", "noopener,noreferrer");
      setPhase("waiting");
      poll(body.sessionId, body.pollIntervalMs ?? 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the picker.");
      setPhase("idle");
    }
  }

  async function handleImport() {
    if (!sessionId) return;
    if (pollRef.current) clearTimeout(pollRef.current);
    setPhase("importing");
    setError(null);
    setSummary(null);
    try {
      const res = await fetch("/api/v1/integrations/google-photos/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const body = (await res.json().catch(() => ({}))) as ImportSummary & {
        needsReconnect?: boolean;
        error?: string;
      };
      if (!res.ok) {
        if (body.needsReconnect) {
          setError("Your Google connection expired. Reconnect and try again.");
        } else {
          setError(body.error ?? `HTTP ${res.status}`);
        }
        setPhase("idle");
        return;
      }
      setSummary({
        imported: body.imported,
        skipped: body.skipped,
        failed: body.failed ?? [],
        total: body.total,
      });
      // The picked session is single-use (server deletes it); reset for another.
      setSessionId(null);
      setPickerUri(null);
      setPhase("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
      setPhase("idle");
    }
  }

  async function handleDisconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    if (pollRef.current) clearTimeout(pollRef.current);
    try {
      await fetch("/api/v1/integrations/google/revoke", { method: "POST" });
    } catch {
      // Local row is source of truth; a failed call still leaves the UI safe.
    } finally {
      setDisconnecting(false);
      onDisconnected();
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            Connected to Google
          </span>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="shrink-0"
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          Open the Google Photos picker, choose the photos you want, then come
          back here to import them.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={openPicker}
            disabled={phase === "opening" || phase === "importing"}
          >
            {phase === "opening" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Opening…
              </>
            ) : phase === "waiting" || phase === "ready" ? (
              "Reopen picker"
            ) : (
              "Open Google Photos picker"
            )}
          </Button>
          {pickerUri && (phase === "waiting" || phase === "ready") && (
            <a
              href={pickerUri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Reopen in Google
            </a>
          )}
        </div>

        {phase === "waiting" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for you to finish
            picking in Google…
          </div>
        )}
      </div>

      {phase === "ready" || phase === "importing" ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-foreground">
            Selection ready — import the photos you picked.
          </span>
          <Button
            onClick={handleImport}
            disabled={phase === "importing"}
            className="shrink-0"
          >
            {phase === "importing" ? "Importing…" : "Import selected"}
          </Button>
        </div>
      ) : null}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {summary && (
        <div className="rounded-lg border border-border bg-card p-4 text-sm space-y-1">
          <p className="font-medium text-foreground">
            Imported {summary.imported} of {summary.total}
            {summary.skipped > 0
              ? ` · ${summary.skipped} already in your library`
              : ""}
            {summary.failed.length > 0
              ? ` · ${summary.failed.length} failed`
              : ""}
          </p>
          {summary.failed.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {summary.failed.slice(0, 8).map((f) => (
                <li key={f.id} className="truncate">
                  {f.id}: {f.error}
                </li>
              ))}
              {summary.failed.length > 8 && (
                <li>…and {summary.failed.length - 8} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Icon kept exported-adjacent for the hub's provider registry parity (unused here).
export const GooglePhotosIcon = ImageIcon;
