// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import { useSession } from "@/lib/auth/client";
import Link from "next/link";
import { PlexoConnectionStatus } from "@/components/plexo-connection-status";
import { cn } from "@/lib/utils";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chip,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui";
import {
  loadScopeDefault,
  saveScopeDefault,
  type ScopeDefault,
} from "@/lib/hooks/use-saved-scope-default";

type IntegrationStatus = "active" | "needs_reconnect" | "revoked";
interface Integration {
  provider: string;
  status: IntegrationStatus;
}

type SettingsTab = "account" | "storage" | "integrations";
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "storage", label: "Storage" },
  { id: "integrations", label: "Integrations" },
];

type StoragePolicy = "r2_only" | "mirror" | "local_only";

interface StorageInfo {
  usageBytes: number;
  quotaBytes: number | null;
  assetCount: number;
  // Phase B6 (storage placement) — effective workspace policy + mirror coverage.
  policy?: StoragePolicy;
  mirror?: { eligible: number; mirrored: number; localBytes: number };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const user = session?.user;
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [rescanScope, setRescanScope] = useState<"all" | "images" | "failed">("all");
  const [rescanBusy, setRescanBusy] = useState(false);
  const [rescanMsg, setRescanMsg] = useState<string | null>(null);
  // Phase B6 — storage-placement policy picker state.
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyMsg, setPolicyMsg] = useState<string | null>(null);
  const [googleStatus, setGoogleStatus] = useState<IntegrationStatus | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  // ADR 0008 Phase 5 — saved default-scope preference for browsable surfaces.
  // Only takes effect when no `?scope=` is in the URL (the chip strip wins).
  const [scopeDefault, setScopeDefaultState] = useState<ScopeDefault>("PERSONAL");
  useEffect(() => {
    setScopeDefaultState(loadScopeDefault());
  }, []);

  // At md+ the page renders as tabs (Account / Storage / Integrations).
  // At mobile every section is always visible — `tabClass(tab)` only emits
  // `md:hidden` for non-active sections, so the mobile flat layout is
  // unaffected. Default = account (matches the order users expect).
  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const tabClass = (tab: SettingsTab) =>
    cn(activeTab !== tab && "md:hidden");

  // M14 / ADR 0055 — surface the instance-admin console link only to admins.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch("/api/v1/admin/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsAdmin(!!d?.isInstanceAdmin))
      .catch(() => null);
  }, []);

  useEffect(() => {
    fetch("/api/v1/workspace")
      .then((r) => r.json())
      .then((d) => setStorage(d.storage ?? null))
      .catch(() => null);
  }, []);

  const refreshGoogleStatus = useCallback(() => {
    fetch("/api/v1/integrations")
      .then((r) => r.json())
      .then((d: { integrations?: Integration[] }) => {
        const google = (d.integrations ?? []).find((i) => i.provider === "google");
        // No row (or already revoked) => offer a fresh Connect.
        setGoogleStatus(google && google.status !== "revoked" ? google.status : null);
      })
      .catch(() => setGoogleStatus(null));
  }, []);

  useEffect(() => {
    refreshGoogleStatus();
  }, [refreshGoogleStatus]);

  async function handleGoogleDisconnect() {
    if (googleBusy) return;
    setGoogleBusy(true);
    try {
      await fetch("/api/v1/integrations/google/revoke", { method: "POST" });
    } catch {
      // Ignore — re-fetch reflects the real state below.
    } finally {
      setGoogleBusy(false);
      refreshGoogleStatus();
    }
  }

  async function handlePolicyChange(next: StoragePolicy) {
    if (policyBusy || !storage || storage.policy === next) return;
    setPolicyBusy(true);
    setPolicyMsg(null);
    const prev = storage.policy;
    // Optimistic — revert on failure.
    setStorage((s) => (s ? { ...s, policy: next } : s));
    try {
      const res = await fetch("/api/v1/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storagePolicy: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setPolicyMsg(
        next === "mirror"
          ? "New uploads now mirror to NAS. Existing assets backfill in the background."
          : "New uploads are stored in Cloudflare R2 only."
      );
    } catch (err) {
      setStorage((s) => (s ? { ...s, policy: prev } : s));
      setPolicyMsg(err instanceof Error ? `Failed: ${err.message}` : "Failed to change policy.");
    } finally {
      setPolicyBusy(false);
    }
  }

  // Jex — passkey enrollment + one-time sign-in link (auth routes already live).
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyMsg, setPasskeyMsg] = useState<string | null>(null);
  const [passkeyErr, setPasskeyErr] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  async function handleAddPasskey() {
    if (passkeyBusy) return;
    setPasskeyBusy(true);
    setPasskeyMsg(null);
    setPasskeyErr(null);
    try {
      const startRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "start" }),
      });
      if (startRes.status === 401) throw new Error("Session expired — sign in again to add a passkey.");
      if (!startRes.ok) throw new Error(`HTTP ${startRes.status}`);
      const optionsJSON =
        (await startRes.json()) as PublicKeyCredentialCreationOptionsJSON;
      const response = await startRegistration({ optionsJSON });
      const finishRes = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "finish", response }),
      });
      const data = (await finishRes.json().catch(() => null)) as {
        verified?: boolean;
        error?: string;
      } | null;
      if (!finishRes.ok || !data?.verified) {
        throw new Error(data?.error ?? `HTTP ${finishRes.status}`);
      }
      setPasskeyMsg("Passkey added");
    } catch (err) {
      if (!(err instanceof Error && err.name === "NotAllowedError")) {
        setPasskeyErr(
          err instanceof Error && err.message ? err.message : "Failed to add passkey."
        );
      }
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function handleGenerateLink() {
    if (linkBusy) return;
    setLinkBusy(true);
    setLinkErr(null);
    setLinkCopied(false);
    try {
      const res = await fetch("/api/auth/passkey/one-time-link", { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        link?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.link) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setOneTimeLink(window.location.origin + data.link);
    } catch (err) {
      setLinkErr(
        err instanceof Error && err.message ? err.message : "Failed to generate link."
      );
    } finally {
      setLinkBusy(false);
    }
  }

  async function handleRescanAll() {
    if (rescanBusy) return;
    setRescanBusy(true);
    setRescanMsg(null);
    try {
      const res = await fetch("/api/v1/workspace/reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: rescanScope }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { queued: number };
      setRescanMsg(`Queued ${data.queued} asset${data.queued === 1 ? "" : "s"} for re-scan.`);
    } catch (err) {
      setRescanMsg(err instanceof Error ? `Failed: ${err.message}` : "Failed to queue re-scan.");
    } finally {
      setRescanBusy(false);
    }
  }

  return (
    <div className="space-y-[var(--ft-space-6)] max-w-xl md:max-w-3xl">
      <div>
        <h1 className="text-[length:var(--ft-type-headline-small-size)] leading-[var(--ft-type-headline-small-line)] tracking-[var(--ft-type-headline-small-tracking)] font-medium text-[var(--ft-color-on-surface)]">
          Settings
        </h1>
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)] mt-[var(--ft-space-1)]">
          Manage your account and workspace
        </p>
      </div>

      {/* Desktop tab strip (md+). At mobile everything stays single-column,
          so the tab strip is hidden and tabClass() never collapses anything. */}
      <div className="hidden md:flex items-center gap-[var(--ft-space-1)] border-b border-[var(--ft-color-outline-variant)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={cn(
              "px-[var(--ft-space-4)] py-[var(--ft-space-2)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] tracking-[var(--ft-type-label-large-tracking)] font-medium border-b-2 -mb-px transition-colors",
              activeTab === t.id
                ? "border-[var(--ft-color-primary-text)] text-[var(--ft-color-on-surface)]"
                : "border-transparent text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card variant="outlined" className={tabClass("account")}>
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-[var(--ft-space-3)]">
          <div>
            <label className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] tracking-[var(--ft-type-label-small-tracking)] font-medium text-[var(--ft-color-on-surface-variant)] uppercase">
              Name
            </label>
            <p className="mt-[var(--ft-space-1)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
              {user?.name ?? "—"}
            </p>
          </div>
          <div>
            <label className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] tracking-[var(--ft-type-label-small-tracking)] font-medium text-[var(--ft-color-on-surface-variant)] uppercase">
              Email
            </label>
            <p className="mt-[var(--ft-space-1)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
              {user?.email ?? "—"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card variant="outlined" className={tabClass("storage")}>
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Storage
          </CardTitle>
        </CardHeader>
        <CardContent>
          {storage ? (
            <div className="space-y-[var(--ft-space-3)]">
              <div className="flex items-center justify-between">
                <span className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
                  Total assets
                </span>
                <span className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] font-medium text-[var(--ft-color-on-surface)]">
                  {storage.assetCount}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
                  Storage used
                </span>
                <span className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] font-medium text-[var(--ft-color-on-surface)]">
                  {formatBytes(storage.usageBytes)}
                  {storage.quotaBytes != null && (
                    <span className="text-[var(--ft-color-on-surface-variant)] font-normal">
                      {" "}
                      / {formatBytes(storage.quotaBytes)}
                    </span>
                  )}
                </span>
              </div>
              {storage.quotaBytes != null && (
                <div className="space-y-[var(--ft-space-1)]">
                  {/* Progress bar — no MD3 ProgressIndicator primitive in the
                      barrel yet; tokenised colours but keeps existing div
                      shape until a primitive lands (flagged in report). */}
                  <div className="h-2 w-full rounded-[var(--ft-shape-full)] bg-[var(--ft-color-surface-container-high)] overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-[var(--ft-shape-full)] transition-all",
                        storage.usageBytes / storage.quotaBytes >= 0.9
                          ? "bg-[var(--ft-color-error)]"
                          : storage.usageBytes / storage.quotaBytes >= 0.75
                          ? "bg-yellow-500"
                          : "bg-[var(--ft-color-primary)]"
                      )}
                      style={{ width: `${Math.min(100, (storage.usageBytes / storage.quotaBytes) * 100).toFixed(1)}%` }}
                    />
                  </div>
                  {storage.usageBytes / storage.quotaBytes >= 0.9 && (
                    <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)]">
                      Storage almost full — delete or archive assets to free space.
                    </p>
                  )}
                </div>
              )}
              {/* Phase B6 — storage-placement policy. R2-only (default) or
                  mirror to the NAS local disk + R2. local_only is deferred. */}
              {storage.policy != null && (
                <div className="pt-[var(--ft-space-3)] border-t border-[var(--ft-color-outline-variant)] space-y-[var(--ft-space-3)]">
                  <div className="flex items-center justify-between gap-[var(--ft-space-3)]">
                    <div>
                      <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                        Where originals live
                      </p>
                      <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                        Mirror keeps a copy of every original on your NAS disk
                        as well as in the cloud.
                      </p>
                    </div>
                    <Select
                      value={storage.policy === "mirror" ? "mirror" : "r2_only"}
                      onValueChange={(v) => handlePolicyChange(v as StoragePolicy)}
                      disabled={policyBusy}
                    >
                      <SelectTrigger aria-label="Storage placement" className="h-9 w-[180px] shrink-0">
                        {/* Base UI Select.Value renders the raw value unless a
                            label mapping is provided — map it to the menu label. */}
                        <SelectValue>
                          {(v) => (v === "mirror" ? "Mirror to NAS + cloud" : "Cloud only (R2)")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="r2_only">Cloud only (R2)</SelectItem>
                        <SelectItem value="mirror">Mirror to NAS + cloud</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {storage.policy === "mirror" && storage.mirror && (
                    <div className="space-y-[var(--ft-space-1)]">
                      <div className="flex items-center justify-between">
                        <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                          Mirror coverage
                        </span>
                        <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] font-medium text-[var(--ft-color-on-surface)]">
                          {storage.mirror.mirrored} / {storage.mirror.eligible} originals
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-[var(--ft-shape-full)] bg-[var(--ft-color-surface-container-high)] overflow-hidden">
                        <div
                          className="h-full rounded-[var(--ft-shape-full)] bg-[var(--ft-color-primary)] transition-all"
                          style={{
                            width: `${
                              storage.mirror.eligible > 0
                                ? Math.min(100, (storage.mirror.mirrored / storage.mirror.eligible) * 100).toFixed(1)
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                          On NAS disk
                        </span>
                        <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] font-medium text-[var(--ft-color-on-surface)]">
                          {formatBytes(storage.mirror.localBytes)}
                        </span>
                      </div>
                    </div>
                  )}

                  {policyMsg && (
                    <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                      {policyMsg}
                    </p>
                  )}
                </div>
              )}

              <div className="pt-[var(--ft-space-2)] border-t border-[var(--ft-color-outline-variant)]">
                <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                  Assets are stored securely in Cloudflare R2.
                  {storage.quotaBytes == null && " No storage quota on the current plan."}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              Loading storage info…
            </p>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined" className={tabClass("integrations")}>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Plexo AI
          </CardTitle>
          <PlexoConnectionStatus />
        </CardHeader>
        <CardContent className="space-y-[var(--ft-space-3)]">
          <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
            Plexo powers AI classification, auto-tagging, and cross-app intelligence for your assets.
          </p>
          {/* Google Photos (Takeout) — real connect/reconnect flow (Phase 4). */}
          <div className="flex items-center justify-between gap-[var(--ft-space-3)]">
            <div>
              <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                Google Photos (Takeout)
              </p>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                {googleStatus === "active"
                  ? "Connected — import a Takeout archive from the Imports page."
                  : googleStatus === "needs_reconnect"
                  ? "Reconnect required — your Google access expired."
                  : "Connect to import a Google Takeout archive of your photos."}
              </p>
            </div>
            <div className="flex items-center gap-[var(--ft-space-2)] shrink-0">
              {googleStatus === "active" ? (
                <>
                  {/* Success role — newly added in 36152c8; replaces the
                      legacy text-green-600 dark:text-green-500 literal. */}
                  <Chip
                    variant="assist"
                    disabled
                    className="border-transparent bg-[var(--ft-color-success-container)] text-[var(--ft-color-on-success-container)] opacity-100 disabled:opacity-100"
                  >
                    Connected
                  </Chip>
                  <Button
                    variant="outlined"
                    size="sm"
                    onClick={handleGoogleDisconnect}
                    disabled={googleBusy}
                  >
                    {googleBusy ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </>
              ) : (
                <Button
                  variant={googleStatus === "needs_reconnect" ? "outlined" : "filled"}
                  size="sm"
                  render={<a href="/api/v1/integrations/google/auth" />}
                >
                  {googleStatus === "needs_reconnect" ? "Reconnect" : "Connect"}
                </Button>
              )}
            </div>
          </div>

          {googleStatus === "active" && (
            <Link
              href="/app/imports"
              className="block text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] tracking-[var(--ft-type-label-large-tracking)] font-medium text-[var(--ft-color-primary-text)] hover:underline"
            >
              Go to Imports →
            </Link>
          )}

          {/* Not-yet-built providers stay as placeholders. */}
          {[
            { id: "dropbox", label: "Dropbox", desc: "Sync assets from Dropbox" },
            { id: "icloud-drive", label: "iCloud Drive", desc: "Import from iCloud Drive" },
          ].map((conn) => (
            <div key={conn.id} className="flex items-center justify-between">
              <div>
                <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                  {conn.label}
                </p>
                <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                  {conn.desc}
                </p>
              </div>
              <Chip variant="suggestion" disabled className="opacity-100 disabled:opacity-100">
                Coming soon
              </Chip>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card variant="outlined" className={tabClass("integrations")}>
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Recognition
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-[var(--ft-space-3)]">
          <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
            Re-run AI recognition (OCR, object/scene labels, descriptions, and
            face detection) across your library. Runs on the local vision engine
            and processes assets in the background.
          </p>
          <div className="flex items-center justify-between gap-[var(--ft-space-3)]">
            <div>
              <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                Re-scan assets
              </p>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                Choose which assets to re-scan.
              </p>
            </div>
            <div className="flex items-center gap-[var(--ft-space-2)] shrink-0">
              <Select
                value={rescanScope}
                onValueChange={(v) => setRescanScope(v as "all" | "images" | "failed")}
                disabled={rescanBusy}
              >
                <SelectTrigger aria-label="Re-scan scope" className="h-9 w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All assets</SelectItem>
                  <SelectItem value="images">Images only</SelectItem>
                  <SelectItem value="failed">Failed / unprocessed</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outlined"
                size="sm"
                onClick={handleRescanAll}
                disabled={rescanBusy}
              >
                {rescanBusy ? "Queuing…" : "Re-scan"}
              </Button>
            </div>
          </div>
          {rescanMsg && (
            <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
              {rescanMsg}
            </p>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined" className={tabClass("account")}>
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Library default
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-[var(--ft-space-3)]">
          <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
            Choose what shows up by default in your library, search, and timeline.
            Personal hides shoot assets; All shows everything. Per-page chip
            selectors always override this default.
          </p>
          <div className="flex items-center justify-between gap-[var(--ft-space-3)]">
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
              Default scope
            </p>
            <Select
              value={scopeDefault}
              onValueChange={(v) => {
                const next = v as ScopeDefault;
                setScopeDefaultState(next);
                saveScopeDefault(next);
              }}
            >
              <SelectTrigger aria-label="Default scope" className="h-9 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PERSONAL">Personal only</SelectItem>
                <SelectItem value="all">All (Personal + Shoots)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card variant="outlined" className={tabClass("account")}>
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Timeline &amp; Facts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                Family fact base
              </p>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                Residences, trips, events, and milestones that anchor photo
                dates, places, and people.
              </p>
            </div>
            <Button variant="outlined" size="sm" render={<Link href="/app/settings/timeline" />}>
              Edit timeline
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card variant="outlined" className={tabClass("account")}>
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Members
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                Workspace members
              </p>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                Invite collaborators as editors or viewers.
              </p>
            </div>
            <Button variant="outlined" size="sm" render={<Link href="/app/settings/members" />}>
              Manage members
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card variant="outlined" className={tabClass("account")}>
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            API access
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                Personal access tokens
              </p>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                For the CLI, mobile app, and 3rd-party integrations.
              </p>
            </div>
            <Button variant="outlined" size="sm" render={<Link href="/app/settings/tokens" />}>
              Manage tokens
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card variant="outlined" className={tabClass("account")}>
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Passkeys
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-[var(--ft-space-3)]">
          <div className="flex items-center justify-between gap-[var(--ft-space-3)]">
            <div>
              <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                Add a passkey
              </p>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                Sign in with your fingerprint, face, or device PIN — no password.
              </p>
            </div>
            <Button
              variant="outlined"
              size="sm"
              onClick={handleAddPasskey}
              disabled={passkeyBusy}
              aria-busy={passkeyBusy}
            >
              {passkeyBusy ? "Waiting…" : "Add passkey"}
            </Button>
          </div>
          {passkeyMsg && (
            <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-success-container)]">
              {passkeyMsg}
            </p>
          )}
          {passkeyErr && (
            <p role="alert" className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)]">
              {passkeyErr}
            </p>
          )}

          <div className="pt-[var(--ft-space-3)] border-t border-[var(--ft-color-outline-variant)] space-y-[var(--ft-space-3)]">
            <div className="flex items-center justify-between gap-[var(--ft-space-3)]">
              <div>
                <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                  One-time sign-in link
                </p>
                <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                  Sign in on another device without a password or passkey.
                </p>
              </div>
              <Button
                variant="outlined"
                size="sm"
                onClick={handleGenerateLink}
                disabled={linkBusy}
                aria-busy={linkBusy}
              >
                {linkBusy ? "Generating…" : "Generate link"}
              </Button>
            </div>
            {oneTimeLink && (
              <div className="space-y-[var(--ft-space-1)]">
                <label
                  htmlFor="one-time-link"
                  className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] tracking-[var(--ft-type-label-small-tracking)] font-medium text-[var(--ft-color-on-surface-variant)] uppercase"
                >
                  Sign-in link
                </label>
                <div className="flex items-center gap-[var(--ft-space-2)]">
                  <input
                    id="one-time-link"
                    type="text"
                    readOnly
                    value={oneTimeLink}
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-full min-w-0 rounded border border-[var(--ft-color-outline-variant)] bg-transparent px-3 py-2 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--ft-color-primary)]"
                  />
                  <Button
                    variant="outlined"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(oneTimeLink)
                        .then(() => setLinkCopied(true))
                        .catch(() => setLinkErr("Copy failed — select the link and copy manually."));
                    }}
                  >
                    {linkCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                  Single-use and short-lived — open it on the other device right away.
                </p>
              </div>
            )}
            {linkErr && (
              <p role="alert" className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)]">
                {linkErr}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card variant="outlined" className={tabClass("account")}>
        <CardHeader>
          <CardTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)]">
            Data
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                Export metadata
              </p>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                Download all asset metadata as JSON
              </p>
            </div>
            <Button variant="outlined" size="sm" render={<a href="/api/export" />}>
              Export JSON
            </Button>
          </div>
          {/* M14 / ADR 0057 — full library export: manifest + every original. */}
          <div className="mt-4 flex items-center justify-between border-t border-[var(--ft-color-outline-variant)] pt-4">
            <div>
              <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                Export everything
              </p>
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                Download your whole library — every original photo &amp; video, plus a manifest
              </p>
            </div>
            <Button
              variant="outlined"
              size="sm"
              render={<a href="/api/v1/assets/export/zip?scope=workspace" />}
            >
              Export .zip
            </Button>
          </div>
          {/* M14 / ADR 0055 — instance-admin console, admin-only. */}
          {isAdmin && (
            <div className="mt-4 flex items-center justify-between border-t border-[var(--ft-color-outline-variant)] pt-4">
              <div>
                <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
                  Instance admin
                </p>
                <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                  Server stats, users, and per-workspace storage quotas
                </p>
              </div>
              <Button variant="outlined" size="sm" render={<a href="/app/settings/admin" />}>
                Open console
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
