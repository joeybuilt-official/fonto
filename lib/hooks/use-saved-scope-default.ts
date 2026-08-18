// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 Phase 5 — saved default-scope hook.
//
// Reads localStorage key `fonto:scope-default` ("PERSONAL" | "all", or absent =
// PERSONAL) and, on first mount of a page that has no `?scope=` in the URL,
// pushes the user's preference into the URL. Once the URL has a `?scope=`, the
// user has explicitly chosen and this hook stays out of the way.
//
// Why a URL preference and not a server preference: scope is a query-shape
// concern that browsable surfaces already read off the URL. Persisting a
// session-wide "default to all" makes the timeline + search consistent without
// teaching every read path a second source of truth.

"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const STORAGE_KEY = "fonto:scope-default";

export type ScopeDefault = "PERSONAL" | "all";

export function loadScopeDefault(): ScopeDefault {
  if (typeof window === "undefined") return "PERSONAL";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "all" ? "all" : "PERSONAL";
  } catch {
    return "PERSONAL";
  }
}

export function saveScopeDefault(value: ScopeDefault): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // best-effort
  }
}

export function useSavedScopeDefault(): void {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (params.get("scope")) return;
    const pref = loadScopeDefault();
    if (pref === "PERSONAL") return;
    const next = new URLSearchParams(params.toString());
    next.set("scope", pref);
    router.replace(`${pathname}?${next.toString()}`);
    // Only re-run when the pathname changes (per-route apply); param-changes
    // already reflect a user choice and shouldn't retrigger the default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
}
