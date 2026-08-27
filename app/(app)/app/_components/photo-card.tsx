// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState, useRef, useSyncExternalStore } from "react";
import { Image as ImageIcon, Loader2, Check, MoreVertical, FolderPlus, Download, Trash2, Heart, Star, Layers, Play, Share2, CircleDot, AlertTriangle, RotateCw } from "lucide-react";
import { Card } from "@/components/ui/card";

// Shared coarse-pointer signal. One cached MediaQueryList feeds every tile so
// a large grid doesn't register thousands of listeners. Drives the always-on
// quick-actions affordance on touch devices (hover never fires there).
let coarseMql: MediaQueryList | null = null;
function coarseMedia(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  if (!coarseMql) coarseMql = window.matchMedia("(pointer: coarse)");
  return coarseMql;
}
function subscribeCoarse(cb: () => void): () => void {
  const mql = coarseMedia();
  if (!mql) return () => {};
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () => coarseMedia()?.matches ?? false,
    () => false
  );
}

export interface Asset {
  id: string;
  // Phase 7b — serializeAsset already includes this; declaring on the TS
  // interface so UI components can pass it through to share controls.
  workspaceId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  classification: string | null;
  // Task 20 / Photos-Files split — KIND partition. moment|screenshot|graphics|
  // document|video, or null when unclassified (Inbox surface). Serialized
  // straight from the row.
  kind?: string | null;
  processingState: string;
  capturedAt: string | null;
  createdAt: string;
  // Phase 3.4 — favorites + ratings. Both default to "unset" on legacy rows
  // before the backfill stamps them, so we keep these optional on the client.
  isFavorite?: boolean;
  rating?: number;
  // Phase B6 (storage placement) — per-asset policy override (null = follow the
  // workspace default) + local-mirror marker (a timestamp ⇒ a verified local
  // copy of the original exists). Serialized straight from the row.
  storagePolicyOverride?: string | null;
  localOriginalStoredAt?: string | null;
  // Phase 5.5 — manual stacks. NULL/undefined ⇒ standalone. When set, the
  // timeline only shows the primary; clicking opens the lightbox which
  // surfaces a "stack of N" badge with inline carousel of all members.
  stackId?: string | null;
  // Phase 5.5 — when this asset is the primary of a stack, the list
  // endpoint includes the member count so PhotoCard can render a badge
  // without a per-tile round trip. NULL for standalone assets.
  stackMemberCount?: number | null;
  // M12 / ADR 0014 — motion (Live) photo. `motionPhoto` true ⇒ this still
  // carries a playable clip (embedded Android MP4 or a paired Apple MOV) and
  // gets a "LIVE" badge. The clip URL is fetched on demand via
  // `/api/v1/assets/{id}/url?variant=motion` (not bundled in the grid list).
  motionPhoto?: boolean | null;
  // Phase 8a — video probe output. NULL for non-video assets.
  durationSeconds?: number | null;
  videoCodec?: string | null;
  videoWidth?: number | null;
  videoHeight?: number | null;
  // Image pixel dimensions (EXIF at ingest) + document page count (PDF
  // worker). Serialized straight from the row; null when unknown.
  widthPx?: number | null;
  heightPx?: number | null;
  pageCount?: number | null;
  // Phase 6.12 — extracted text layer (plain text / markdown / source file
  // contents). Populated on the per-asset detail endpoint, not the grid list.
  ocrText?: string | null;
  // T2.4 (fonto-perf-audit) — 4x4 WebP LQIP as a data URL (`data:image/webp;
  // base64,…`, ~50–200 bytes). Rendered as `background-image` under the lazy
  // <img> so the tile shows a blurred placeholder during load → kills the
  // white flash + reduces CLS on fast scroll. NULL on non-image assets and on
  // rows that pre-date the backfill (UI tolerates either).
  lqip?: string | null;
  // Task #32 — set on assets produced by /transform (crop / rotate-as-new);
  // points back at the source asset so the lightbox can surface a "Derived
  // from …" badge that navigates to the origin.
  derivedFromAssetId?: string | null;
  // Phase 7b — populated when the asset is being rendered through a
  // cross-workspace share (i.e. in the recipient's grid). Absent for
  // assets the caller owns directly. Used to render the "shared from
  // <workspace>" badge + tooltip.
  sharedFrom?: {
    workspaceId: string;
    workspaceName: string;
    accessLevel: string;
    createdBy: string;
    sharedAt: string;
  } | null;
}

// M3a retry — bounded confirmation poll after a reprocess is queued. Fast at
// first (a cheap derivative regen lands in seconds), then backs off, because a
// real re-classification of a large asset runs for minutes and a 30s window
// would stop watching long before anything is knowable. ~2m52s over 15
// requests; past that the tile reports what it actually knows (queued) rather
// than asserting a second failure.
const RETRY_POLL_DELAYS_MS = [
  3000, 3000, 3000, 3000,
  8000, 8000, 8000, 8000, 8000,
  20000, 20000, 20000, 20000, 20000, 20000,
];

// The tile unmounts as the virtualizer scrolls it out, so component state can't
// carry "already retried" — the remounted row still reads "failed" and would
// offer a Retry that enqueues a duplicate job. Module scope survives that;
// entries expire past the poll window plus margin, and every write sweeps the
// expired ones so the map stays bounded by the assets retried in one TTL.
const RETRY_QUEUED_TTL_MS = 5 * 60 * 1000;
const recentRetries = new Map<string, number>();

function markRetried(assetId: string) {
  const now = Date.now();
  for (const [id, expiresAt] of recentRetries) {
    if (expiresAt <= now) recentRetries.delete(id);
  }
  recentRetries.set(assetId, now + RETRY_QUEUED_TTL_MS);
}

function retriedRecently(assetId: string): boolean {
  const expiresAt = recentRetries.get(assetId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    recentRetries.delete(assetId);
    return false;
  }
  return true;
}

/** Phase 8a — "1:23" / "12:34" / "1:02:03". Plays nicely w/ the grid chip. */
function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(ss)}` : `${m}:${p2(ss)}`;
}

interface QuickActionsProps {
  asset: Asset;
  onAddToCollection?: (assetId: string) => void;
  onRemove?: (assetId: string) => void;
  /** Fired after a successful move-to-trash so the parent can drop the tile
   *  from its list without a full reload. */
  onTrashed?: (assetId: string) => void;
  showRemove?: boolean;
}

function QuickActionsMenu({ asset, onAddToCollection, onRemove, onTrashed, showRemove }: QuickActionsProps) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    setErr(null);
    try {
      const r = await fetch(`/api/v1/assets/${asset.id}/url`);
      if (!r.ok) throw new Error(`url ${r.status}`);
      const d = (await r.json()) as { url?: string };
      if (d.url) {
        const a = document.createElement("a");
        a.href = d.url;
        a.download = asset.filename;
        a.click();
      }
      setOpen(false);
    } catch {
      setErr("Couldn't download.");
    }
  }

  async function handleTrash(e: React.MouseEvent) {
    e.stopPropagation();
    setErr(null);
    try {
      const r = await fetch(`/api/v1/assets/${asset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trash: true }),
      });
      if (!r.ok) throw new Error(`trash ${r.status}`);
      setOpen(false);
      onTrashed?.(asset.id);
    } catch {
      setErr("Couldn't move to trash.");
    }
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium bg-black/60 text-white hover:bg-black/80 transition-colors"
      >
        <MoreVertical className="h-3 w-3" />
        <span>More</span>
      </button>
      {open && (
        <div className="absolute bottom-7 right-0 z-20 min-w-36 rounded-[var(--ft-shape-extra-small)] bg-[var(--ft-color-surface-container)] shadow-[var(--ft-elev-2)] py-[var(--ft-space-2)]">
          {err && (
            <p className="px-[var(--ft-space-3)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)]">
              {err}
            </p>
          )}
          {onAddToCollection && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddToCollection(asset.id); setOpen(false); }}
              className="flex w-full items-center gap-[var(--ft-space-2)] px-[var(--ft-space-3)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              Add to Collection
            </button>
          )}
          <button
            onClick={handleDownload}
            className="flex w-full items-center gap-[var(--ft-space-2)] px-[var(--ft-space-3)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
          {showRemove && onRemove && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(asset.id); setOpen(false); }}
              className="flex w-full items-center gap-[var(--ft-space-2)] px-[var(--ft-space-3)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove from Collection
            </button>
          )}
          {!showRemove && (
            <button
              onClick={handleTrash}
              className="flex w-full items-center gap-[var(--ft-space-2)] px-[var(--ft-space-3)] py-1.5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Move to Trash
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface PhotoCardProps {
  asset: Asset;
  selected?: boolean;
  onSelect?: (e?: React.MouseEvent) => void;
  selectMode?: boolean;
  showQuickActions?: boolean;
  onRemove?: (assetId: string) => void;
  onAddToCollection?: (assetId: string) => void;
  /** Fired after the per-tile quick action moves this asset to trash, so the
   *  parent grid can drop it optimistically instead of waiting for a reload. */
  onTrashed?: (assetId: string) => void;
  /** Fired once a retried asset has actually left "failed", so the parent can
   *  refresh whatever it cached for the row (thumb URLs signed while no
   *  derivative existed). */
  onReprocessed?: (assetId: string) => void;
  onClick?: () => void;
  /** UX-3 — pre-resolved thumb URL from the batch URL endpoint. When set the
   *  card skips its per-tile /api/v1/assets/:id/url fetch entirely. AssetGrid
   *  uses this; legacy call-sites that pass nothing keep the old behavior. */
  thumbUrl?: string | null;
  /** T2.3b — per-variant URLs from the batch URL endpoint when called with
   *  the responsive variant set (thumb-256-avif, thumb-512-{webp,avif},
   *  thumb-1024-{webp,avif}, plus legacy thumb). When present the card
   *  renders a <picture> with AVIF/WebP <source> srcsets so the browser
   *  picks the smallest format it supports. Absent ⇒ falls back to the
   *  single `thumbUrl` rendering. */
  responsiveUrls?: Record<string, string> | null;
}

export function PhotoCard({
  asset,
  selected = false,
  onSelect,
  selectMode = false,
  showQuickActions = true,
  onRemove,
  onAddToCollection,
  onTrashed,
  onReprocessed,
  onClick,
  thumbUrl,
  responsiveUrls,
}: PhotoCardProps) {
  // Two sources for the displayed url:
  //   - `thumbUrl` prop (UX-3 batch URL endpoint): supplied by AssetGrid, wins.
  //   - `fetchedUrl` state: legacy per-card fetch fallback for call-sites
  //     that don't go through AssetGrid yet.
  // Derived `url` keeps setState out of effects (React 19 compiler complains
  // about effects that sync prop → state).
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  const url = thumbUrl !== undefined ? thumbUrl : fetchedUrl;
  // Initialise from the mime so non-image rows never flash the spinner
  // for the one frame between mount and effect-fire. If a batch URL was
  // already supplied we're never in loading state.
  const [loading, setLoading] = useState(() =>
    thumbUrl !== undefined ? false : asset.mimeType.startsWith("image/")
  );
  const [hovered, setHovered] = useState(false);
  const coarsePointer = useCoarsePointer();

  // Only pulse for states the worker is *actively* moving through. "captured"
  // is the initial post-upload state — if it stays there it means the worker
  // never picked the row up, which is a stuck condition we don't want to
  // animate forever (that's the flashing the user sees across the grid).
  // "failed" is terminal and also gets no pulse.
  const isProcessing =
    asset.processingState === "processing" ||
    asset.processingState === "extracted";

  // M3a — the worker only terminalizes to "failed" on the last attempt
  // (worker/index.ts) and the reaper does the same for stuck rows, so the
  // state is genuinely dead-ended and the tile offers the one action that
  // helps. `retryQueued` is optimistic: the row still reads "failed" until
  // the poll below sees it leave that state (nothing else refetches the row,
  // so without the poll the queued spinner would never resolve).
  const isFailed = asset.processingState === "failed";
  const [retryQueued, setRetryQueued] = useState(false);
  // Known-queued but no longer watched: either the poll window elapsed or this
  // tile remounted onto an asset retried within the TTL. Either way the only
  // honest claim is that a retry is in flight, so the card says that instead of
  // re-offering Retry.
  const [retryPending, setRetryPending] = useState(
    () => isFailed && retriedRecently(asset.id)
  );
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryResolved, setRetryResolved] = useState(false);
  // The tile unmounts as the virtualizer scrolls it out; the token lets an
  // in-flight poll stop instead of setting state on a dead card.
  const retryPollRef = useRef<{ cancelled: boolean } | null>(null);
  useEffect(
    () => () => {
      if (retryPollRef.current) retryPollRef.current.cancelled = true;
    },
    []
  );

  async function pollUntilReprocessed(token: { cancelled: boolean }) {
    for (const delayMs of RETRY_POLL_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (token.cancelled) return;
      try {
        const r = await fetch(`/api/v1/assets/${asset.id}`);
        if (!r.ok) throw new Error(`asset ${r.status}`);
        const d = (await r.json()) as { asset?: { processingState?: string } };
        if (token.cancelled) return;
        if (d.asset && d.asset.processingState !== "failed") {
          recentRetries.delete(asset.id);
          setRetryQueued(false);
          setRetryResolved(true);
          onReprocessed?.(asset.id);
          return;
        }
      } catch (err) {
        console.error("[fonto-photo-card] reprocess poll failed:", asset.id, err);
      }
    }
    if (token.cancelled) return;
    setRetryQueued(false);
    setRetryPending(true);
  }

  async function handleRetry(e: React.MouseEvent) {
    e.stopPropagation();
    setRetryError(null);
    setRetryQueued(true);
    try {
      const r = await fetch(`/api/v1/assets/${asset.id}/reprocess`, { method: "POST" });
      if (!r.ok) throw new Error(`reprocess ${r.status}`);
      const d = (await r.json()) as { queued?: boolean };
      if (!d.queued) throw new Error("reprocess not queued");
    } catch (err) {
      console.error("[fonto-photo-card] reprocess failed:", asset.id, err);
      setRetryQueued(false);
      setRetryError("Retry failed.");
      return;
    }
    markRetried(asset.id);
    const token = { cancelled: false };
    retryPollRef.current = token;
    void pollUntilReprocessed(token);
  }

  useEffect(() => {
    // UX-3 — when a batch URL is supplied, derived `url` covers it; skip the
    // legacy per-card fetch entirely.
    if (thumbUrl !== undefined) return;
    // Non-image rows never enter loading state (initial useState handles
    // that), so nothing to do here either.
    if (!asset.mimeType.startsWith("image/")) return;
    // Phase 1.1 — grid cells request the 256px thumb variant. The URL route
    // transparently falls back to the original if the derivative hasn't been
    // generated yet (legacy assets, in-flight backfill), so unbackfilled
    // rows still render — just slowly, like before.
    fetch(`/api/v1/assets/${asset.id}/url?variant=thumb`)
      .then((r) => r.json())
      .then((d) => setFetchedUrl(d.url ?? null))
      .catch(() => setFetchedUrl(null))
      .finally(() => setLoading(false));
  }, [asset.id, asset.mimeType, thumbUrl]);

  function handleClick(e: React.MouseEvent) {
    if (selectMode && onSelect) {
      onSelect(e);
    } else if (onClick) {
      onClick();
    }
  }

  // WCAG 2.1.1 — the tile is the primary browse control, so it must be
  // focusable and operable by keyboard. Enter/Space mirror a click.
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (selectMode && onSelect) onSelect();
      else onClick?.();
    }
  }

  const activationLabel = asset.description ?? asset.filename;

  return (
    // ADR 0009 phase 2 (group D) — outer chrome now resolves through the
    // MD3 <Card variant="filled"> primitive (surface-container-highest +
    // 12 px shape). Image, badges, checkbox, and quick-actions positioning
    // are unchanged per migration rule 1.
    <Card
      variant="filled"
      role="button"
      tabIndex={0}
      aria-label={selectMode ? `Select ${activationLabel}` : `Open ${activationLabel}`}
      aria-pressed={selectMode ? selected : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // UX-2 — drag handle for the /folders drop target. Carries the
      // asset id under a fonto-scoped MIME type so other drop zones
      // can recognise it without sniffing text payloads.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-fonto-asset", asset.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`relative cursor-pointer overflow-hidden transition-all ${
        selected
          ? "ring-2 ring-[var(--ft-color-primary)] ring-offset-1"
          : "ring-0"
      } ${isProcessing ? "animate-pulse ring-1 ring-[var(--ft-color-tertiary)]/50" : ""}`}
    >
      {/* Image. T2.4 — the outer div carries the 4x4 WebP LQIP as a
          background image (sized cover, blurred via filter) so the tile
          shows a coloured placeholder during lazy-load instead of a white
          flash. The real <img> sits on top and covers it once loaded. */}
      <div
        className="aspect-square bg-[var(--ft-color-surface-container)]/30 flex items-center justify-center overflow-hidden relative"
        style={
          asset.lqip
            ? {
                backgroundImage: `url(${asset.lqip})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
      >
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-[var(--ft-color-on-surface-variant)]" />
        ) : responsiveUrls ? (
          // T2.3b — <picture> w/ AVIF + WebP srcsets at 256/512/1024. The
          // browser picks the smallest format it supports; ancient browsers
          // hit the <img> fallback (which is always the legacy 256 webp so
          // unbackfilled rows still render). `sizes` matches the grid tile
          // width at each common breakpoint (the parent uses
          // minmax(0, 1fr) cols so actual width depends on container width
          // and column count — the values below are the ~p95 tile widths
          // observed on the photos grid).
          <picture>
            {(() => {
              const u256w = responsiveUrls["thumb"];
              const u256a = responsiveUrls["thumb-256-avif"];
              const u512w = responsiveUrls["thumb-512-webp"];
              const u512a = responsiveUrls["thumb-512-avif"];
              const u1024w = responsiveUrls["thumb-1024-webp"];
              const u1024a = responsiveUrls["thumb-1024-avif"];
              const avifSrcset = [
                u256a && `${u256a} 256w`,
                u512a && `${u512a} 512w`,
                u1024a && `${u1024a} 1024w`,
              ]
                .filter(Boolean)
                .join(", ");
              const webpSrcset = [
                u256w && `${u256w} 256w`,
                u512w && `${u512w} 512w`,
                u1024w && `${u1024w} 1024w`,
              ]
                .filter(Boolean)
                .join(", ");
              const sizes =
                "(min-width: 1280px) 220px, (min-width: 768px) 180px, 33vw";
              const fallback = u256w ?? url ?? "";
              return (
                <>
                  {avifSrcset && (
                    <source type="image/avif" srcSet={avifSrcset} sizes={sizes} />
                  )}
                  {webpSrcset && (
                    <source type="image/webp" srcSet={webpSrcset} sizes={sizes} />
                  )}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={fallback}
                    alt={asset.description ?? asset.filename}
                    className="h-full w-full object-cover relative"
                    loading="lazy"
                    decoding="async"
                  />
                </>
              );
            })()}
          </picture>
        ) : url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={asset.description ?? asset.filename}
            className="h-full w-full object-cover relative"
            loading="lazy"
            // Phase 3 perf — decode off-main-thread so a new month entering
            // the viewport doesn't block the scroll frame on image decode.
            decoding="async"
          />
        ) : (
          <ImageIcon className="h-8 w-8 text-[var(--ft-color-on-surface-variant)]" />
        )}
      </div>

      {/* Phase 8a — video play-icon overlay + duration chip. Renders for
          any video/* mime; duration shows only when probed. Bottom-right
          chip uses the same visual weight as the stack-count badge. */}
      {asset.mimeType.startsWith("video/") && (
        <>
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="rounded-full bg-black/60 p-2.5">
              <Play
                className="h-5 w-5 text-white"
                fill="currentColor"
              />
            </div>
          </div>
          {asset.durationSeconds != null && (
            <div className="pointer-events-none absolute bottom-1.5 right-1.5 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {formatDuration(asset.durationSeconds)}
            </div>
          )}
        </>
      )}

      {/* M12 / ADR 0014 — motion (Live) photo badge. Top-left so it clears the
          stack badge (top-right) + favorite heart (bottom-left). Stills only. */}
      {asset.motionPhoto && !asset.mimeType.startsWith("video/") && (
        <div className="pointer-events-none absolute top-1.5 left-1.5 z-10 flex items-center gap-0.5 rounded-full bg-black/65 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
          <CircleDot className="h-2.5 w-2.5" />
          Live
        </div>
      )}

      {/* M3a — terminal processing failure + per-asset retry. Centred so it
          clears every corner badge; z-20 keeps it above them and above the
          video play glyph. */}
      {isFailed && !retryResolved && (
        <div className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-[var(--ft-shape-extra-small)] bg-[var(--ft-color-error-container)] px-[var(--ft-space-2)] py-1.5">
          {retryQueued ? (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-[var(--ft-color-on-error-container)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Queued
            </span>
          ) : retryPending ? (
            <span className="flex max-w-40 items-center gap-1 text-center text-[10px] font-semibold text-[var(--ft-color-on-error-container)]">
              <RotateCw className="h-4 w-4 shrink-0" />
              Queued — may take a few minutes.
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-[var(--ft-color-on-error-container)]">
                <AlertTriangle className="h-4 w-4" />
                Processing failed
              </span>
              <button
                type="button"
                onClick={handleRetry}
                // The tile itself is role="button" with an Enter/Space handler,
                // so a keyboard activation here would also open the lightbox.
                onKeyDown={(e) => e.stopPropagation()}
                aria-label={`Retry processing ${asset.filename}`}
                className="flex items-center gap-1 rounded-[var(--ft-shape-full)] bg-[var(--ft-color-error)] px-2 py-1 text-[10px] font-medium text-[var(--ft-color-on-error)] transition-colors hover:bg-[var(--ft-color-error)]/90 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCw className="h-4 w-4" />
                Retry
              </button>
              {retryError && (
                <span role="alert" className="text-[10px] font-medium text-[var(--ft-color-on-error-container)]">
                  {retryError}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Hover overlay */}
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity duration-150 ${
          hovered || selected || selectMode ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Phase 5.5 — stack badge. Top-right when no checkbox, slides
          left to make room for the checkbox when select mode is on. */}
      {asset.stackMemberCount != null && asset.stackMemberCount > 1 && (
        <div
          className={`absolute top-1.5 z-10 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white pointer-events-none ${
            selectMode || hovered || selected ? "right-8" : "right-1.5"
          }`}
        >
          <Layers className="h-2.5 w-2.5" />
          {asset.stackMemberCount}
        </div>
      )}

      {/* Phase 3.4 — favorite heart (always visible when set; subtle).
          Lives bottom-left so it doesn't fight with checkbox (top-right)
          or quick actions (bottom-right). */}
      {asset.isFavorite && (
        <div className="absolute bottom-1.5 left-1.5 z-10 pointer-events-none">
          <Heart
            className="h-3.5 w-3.5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
            fill="currentColor"
          />
        </div>
      )}

      {/* Phase 7b — cross-workspace share badge. Shown only when the
          asset is rendered through a share grant (recipient view). Sits
          to the right of the favorite heart so both can coexist. */}
      {asset.sharedFrom && (
        <div
          className={`absolute bottom-1.5 z-10 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white pointer-events-none ${
            asset.isFavorite ? "left-7" : "left-1.5"
          }`}
          title={`Shared from ${asset.sharedFrom.workspaceName} (${asset.sharedFrom.accessLevel})`}
        >
          <Share2 className="h-2.5 w-2.5" />
          {asset.sharedFrom.workspaceName}
        </div>
      )}
      {/* Phase 3.4 — star rating badge. Top-left, tiny. Only shown when
          rated > 0 so unrated assets stay visually quiet. */}
      {asset.rating !== undefined && asset.rating > 0 && (
        <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white pointer-events-none">
          <Star className="h-2.5 w-2.5" fill="currentColor" />
          {asset.rating}
        </div>
      )}

      {/* Top-right: checkbox. The 20px dot keeps its visual position (top/right
          1.5) but the clickable wrapper is a 44×44 target (WCAG 2.5.5) that
          extends down-left into the tile so it's tappable on touch. */}
      {(selectMode || hovered || selected) && (
        <div
          className="absolute top-0 right-0 z-10 flex h-11 w-11 items-start justify-end p-1.5"
          onClick={(e) => { e.stopPropagation(); onSelect?.(e); }}
        >
          <div
            className={`h-5 w-5 rounded-[var(--ft-shape-full)] border-2 flex items-center justify-center transition-colors ${
              selected
                ? "bg-[var(--ft-color-primary)] border-[var(--ft-color-primary)]"
                : "bg-black/40 border-white/80"
            }`}
          >
            {selected && <Check className="h-3 w-3 text-[var(--ft-color-on-primary)]" />}
          </div>
        </div>
      )}

      {/* Bottom: quick actions. Hover reveals them on fine-pointer devices;
          on coarse (touch) pointers hover never fires, so keep them mounted
          there — otherwise the per-tile actions are unreachable on mobile. */}
      {showQuickActions && (hovered || coarsePointer) && !selectMode && (
        <div className="absolute bottom-1.5 right-1.5 z-10">
          <QuickActionsMenu
            asset={asset}
            onAddToCollection={onAddToCollection}
            onRemove={onRemove}
            onTrashed={onTrashed}
            showRemove={!!onRemove}
          />
        </div>
      )}
    </Card>
  );
}
