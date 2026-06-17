// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 6. Load-time nudge: when the workspace owner has
// items waiting in the review queue, surface a one-tap toast pointing at
// /admin/review. Self-contained (no global toast provider needed); owner-gated
// by the count endpoint (403 → nothing); shown at most once per browser session
// so it never nags on every navigation.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardCheck, X } from "lucide-react";

const SESSION_KEY = "fonto-review-nudge-dismissed";

export function ReviewNudge(): React.ReactElement | null {
  const [count, setCount] = useState(0);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        if (sessionStorage.getItem(SESSION_KEY)) return;
      } catch {
        /* sessionStorage unavailable — fall through and just show */
      }
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    fetch("/api/admin/review-queue/count", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.ok || !d.total) return;
        setCount(d.total);
        setShow(true);
        timer = setTimeout(() => {
          if (alive) setShow(false);
        }, 12000);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  function dismiss() {
    setShow(false);
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  if (!show) return null;

  return (
    <div
      role="status"
      className="fixed bottom-[var(--ft-space-4)] left-1/2 z-[60] flex w-[min(560px,calc(100vw-2*var(--ft-space-4)))] -translate-x-1/2 items-center gap-[var(--ft-space-4)] rounded-[var(--ft-shape-small)] bg-[var(--ft-color-inverse-surface)] px-[var(--ft-space-4)] py-[var(--ft-space-3)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-inverse-surface)] shadow-[var(--ft-elev-3)]"
    >
      <ClipboardCheck className="h-5 w-5 shrink-0" />
      <span className="flex-1">
        {count} photo{count === 1 ? "" : "s"} need a date review.
      </span>
      <Link
        href="/admin/review"
        onClick={dismiss}
        className="shrink-0 rounded-[var(--ft-shape-full)] px-[var(--ft-space-3)] py-[var(--ft-space-1)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-inverse-primary)] hover:bg-[color-mix(in_srgb,var(--ft-color-inverse-primary)_8%,transparent)]"
      >
        Review
      </Link>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-[var(--ft-shape-full)] p-[var(--ft-space-1)] text-[var(--ft-color-on-inverse-surface)]/70 hover:bg-[color-mix(in_srgb,var(--ft-color-on-inverse-surface)_8%,transparent)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
