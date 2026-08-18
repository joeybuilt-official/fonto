// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core (Phase 6) — single source of truth for the owner-only
// review-queue count. Previously three independent consumers
// (AppSidebar desktop copy, AppSidebar mobile-drawer copy, ReviewNudge) each
// fetched `/api/admin/review-queue/count`, producing 2-3 duplicate requests
// per load plus a fresh fetch every time the mobile drawer mounted. Hoisting
// the fetch into a provider mounted once at the app shell dedupes it to a
// single request; every consumer reads the shared value.
//
// `count === null` means the value is unknown OR the caller is a non-owner
// (the endpoint 403s), so owner-only surfaces stay hidden.
"use client";

import { createContext, useContext, useEffect, useState } from "react";

type ReviewQueueCountValue = { count: number | null };

const ReviewQueueCountContext = createContext<ReviewQueueCountValue>({
  count: null,
});

export function ReviewQueueCountProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/review-queue/count", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.ok) setCount(typeof d.total === "number" ? d.total : 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <ReviewQueueCountContext.Provider value={{ count }}>
      {children}
    </ReviewQueueCountContext.Provider>
  );
}

export function useReviewQueueCount() {
  return useContext(ReviewQueueCountContext);
}
