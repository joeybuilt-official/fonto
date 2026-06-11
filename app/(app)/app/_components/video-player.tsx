// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

// Phase 8b — HLS video player w/ hover-scrub sprite preview.
//
// Lifecycle:
//   1. On mount, fetch /api/v1/assets/:id/hls.
//   2. If 202 ('transcoding'), poll every 3s until ready or failed.
//   3. On ready, attach the master playlist via hls.js (Safari uses
//      native HLS — fallback path also handled).
//   4. Render a sprite-backed preview tile above the scrubber on
//      hover.
//
// Cleanup: hls.js Hls instance is destroyed on unmount + on asset
// change. Polling interval is cleared in the same tick.

import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { Loader2, AlertTriangle, Film } from "lucide-react";

interface HlsManifest {
  state: "ready" | "transcoding" | "failed" | "idle";
  playlistUrl?: string;
  spriteUrl?: string | null;
  spriteMeta?: {
    interval: number;
    columns: number;
    rows: number;
    tileWidth: number;
    tileHeight: number;
    totalFrames: number;
  } | null;
}

export interface VideoPlayerProps {
  assetId: string;
  durationSec?: number | null;
  posterUrl?: string | null;
}

const POLL_INTERVAL_MS = 3_000;

export function VideoPlayer({ assetId, durationSec, posterUrl }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [manifest, setManifest] = useState<HlsManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scrubHover, setScrubHover] = useState<{ frac: number; x: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    async function fetchOnce(): Promise<void> {
      try {
        const res = await fetch(`/api/v1/assets/${assetId}/hls`);
        if (!res.ok && res.status !== 202) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as HlsManifest;
        if (cancelled) return;
        setManifest(data);
        if (data.state === "transcoding" || data.state === "idle") {
          pollTimer = setTimeout(() => void fetchOnce(), POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Network error");
      }
    }
    void fetchOnce();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [assetId]);

  useEffect(() => {
    if (!manifest || manifest.state !== "ready" || !manifest.playlistUrl || !videoRef.current) return;
    const video = videoRef.current;
    const src = manifest.playlistUrl;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return;
    }
    if (!Hls.isSupported()) return;
    const hls = new Hls({ enableWorker: true });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) setError(`Playback error: ${data.type}/${data.details}`);
    });
    return () => { hls.destroy(); };
  }, [manifest]);

  const hlsSupportError = useMemo<string | null>(() => {
    if (typeof window === "undefined") return null;
    const probe = document.createElement("video");
    const nativeOk = probe.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (!nativeOk && !Hls.isSupported()) return "HLS not supported in this browser";
    return null;
  }, []);

  // All on-photo chrome (this player renders inside the lightbox's
  // bg-black surround) keeps text-white literals per ADR 0009 lightbox
  // rule — typography role + tracking still token-driven via --ft-type-*.
  const surfacedError = error ?? hlsSupportError;
  if (surfacedError) {
    return (
      <div className="flex flex-col items-center justify-center text-white/70 gap-[var(--ft-space-2)] p-[var(--ft-space-8)]">
        <AlertTriangle className="h-8 w-8" />
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)]">
          {surfacedError}
        </p>
      </div>
    );
  }

  if (!manifest || manifest.state === "idle" || manifest.state === "transcoding") {
    return (
      <div className="relative flex flex-col items-center justify-center gap-[var(--ft-space-3)] p-[var(--ft-space-8)]">
        {posterUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl} alt="Video preview" className="max-h-full max-w-full object-contain opacity-30 absolute inset-0 m-auto p-[var(--ft-space-8)]" />
        )}
        {/* text-white literals on photo chrome — see comment above. */}
        <Film className="h-8 w-8 text-white/40 relative z-10" />
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-white/70 relative z-10 flex items-center gap-[var(--ft-space-2)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Preparing video…
        </p>
        <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-white/40 relative z-10">
          Transcoding into 360p / 720p / 1080p — this is a one-time wait per video.
        </p>
      </div>
    );
  }

  if (manifest.state === "failed") {
    return (
      <div className="flex flex-col items-center justify-center text-white/70 gap-[var(--ft-space-2)] p-[var(--ft-space-8)]">
        <AlertTriangle className="h-8 w-8" />
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)]">
          Transcode failed. Will retry on next open.
        </p>
      </div>
    );
  }

  const meta = manifest.spriteMeta;
  const totalDur = durationSec ?? 0;

  return (
    <div ref={containerRef} className="relative flex h-full w-full items-center justify-center">
      <video
        ref={videoRef}
        controls
        playsInline
        poster={posterUrl ?? undefined}
        className="max-h-full max-w-full object-contain"
        onMouseMove={(e) => {
          if (!meta || !manifest.spriteUrl || !totalDur) return;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const yFromBottom = rect.bottom - e.clientY;
          if (yFromBottom < 0 || yFromBottom > 50) {
            setScrubHover(null);
            return;
          }
          const xFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          setScrubHover({ frac: xFrac, x: e.clientX - rect.left });
        }}
        onMouseLeave={() => setScrubHover(null)}
      />

      {scrubHover && meta && manifest.spriteUrl && (
        <ScrubPreview spriteUrl={manifest.spriteUrl} meta={meta} frac={scrubHover.frac} xOffsetPx={scrubHover.x} />
      )}
    </div>
  );
}

function ScrubPreview({ spriteUrl, meta, frac, xOffsetPx }: {
  spriteUrl: string;
  meta: NonNullable<HlsManifest["spriteMeta"]>;
  frac: number;
  xOffsetPx: number;
}) {
  const frameIdx = Math.min(meta.totalFrames - 1, Math.floor(frac * meta.totalFrames));
  const row = Math.floor(frameIdx / meta.columns);
  const col = frameIdx % meta.columns;
  const bgX = -col * meta.tileWidth;
  const bgY = -row * meta.tileHeight;

  return (
    // text-white-ring on photo chrome (live video surround) — stays
    // literal per ADR 0009.
    <div
      className="pointer-events-none absolute bottom-12 z-20 rounded-[var(--ft-shape-extra-small)] border border-white/40 shadow-[var(--ft-elev-2)]"
      style={{
        width: meta.tileWidth,
        height: meta.tileHeight,
        backgroundImage: `url(${spriteUrl})`,
        backgroundPosition: `${bgX}px ${bgY}px`,
        backgroundSize: `${meta.columns * meta.tileWidth}px ${meta.rows * meta.tileHeight}px`,
        left: Math.max(0, xOffsetPx - meta.tileWidth / 2),
      }}
    />
  );
}
