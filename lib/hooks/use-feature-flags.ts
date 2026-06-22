// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Photos/Files split — client read of server-controlled feature flags.
//
// Fetches GET /api/v1/config once per page load (module-level cache so every
// hook consumer shares the same in-flight request) and exposes the resulting
// flag booleans. Defaults everything to `false` until the response lands so the
// UI renders the pre-flag experience first, then upgrades — never the reverse.

"use client";

import { useEffect, useState } from "react";

export interface FeatureFlags {
  librarySurfaceSplit: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  librarySurfaceSplit: false,
};

let cache: FeatureFlags | null = null;
let inflight: Promise<FeatureFlags> | null = null;

function fetchFlags(): Promise<FeatureFlags> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/v1/config")
    .then((r) => (r.ok ? r.json() : { features: {} }))
    .then((d: { features?: Partial<FeatureFlags> }) => {
      cache = { ...DEFAULT_FLAGS, ...(d.features ?? {}) };
      return cache;
    })
    .catch(() => {
      cache = { ...DEFAULT_FLAGS };
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useFeatureFlags(): FeatureFlags {
  const [flags, setFlags] = useState<FeatureFlags>(cache ?? DEFAULT_FLAGS);
  useEffect(() => {
    let alive = true;
    void fetchFlags().then((f) => {
      if (alive) setFlags(f);
    });
    return () => {
      alive = false;
    };
  }, []);
  return flags;
}
