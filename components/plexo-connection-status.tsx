// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

type Status = "loading" | "connected" | "disconnected";

export function PlexoConnectionStatus() {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    fetch("/api/health/plexo", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .then((d: { connected?: boolean }) => setStatus(d.connected ? "connected" : "disconnected"))
      .catch(() => setStatus("disconnected"));
  }, []);

  // Mobile: icon-only badge. Tailwind's `hidden sm:inline` on the label
  // span doesn't honour the breakpoint cleanly here (computed display
  // resolves to `block` at 390px — utility ordering or layer precedence
  // bite). Splitting into two siblings — icon-only chip with `sm:hidden`,
  // full chip with `hidden sm:flex` — avoids any cascade ambiguity.
  if (status === "loading") {
    return (
      <>
        <div
          aria-label="Plexo loading"
          className="flex items-center text-xs text-muted-foreground sm:hidden"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
        </div>
        <div className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Plexo…</span>
        </div>
      </>
    );
  }

  const tone =
    status === "connected"
      ? "text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-950/30"
      : "text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/30";
  const Icon = status === "connected" ? CheckCircle2 : AlertCircle;
  const fullText = status === "connected" ? "Plexo connected" : "Plexo offline";

  return (
    <>
      <div
        aria-label={fullText}
        title={fullText}
        className={`flex items-center rounded-md px-1.5 py-1 text-xs ${tone} sm:hidden`}
      >
        <Icon className="h-3 w-3" />
      </div>
      <div
        className={`hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs sm:flex ${tone}`}
      >
        <Icon className="h-3 w-3" />
        <span>{fullText}</span>
      </div>
    </>
  );
}
