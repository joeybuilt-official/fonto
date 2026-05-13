// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

type Status = "loading" | "connected" | "disconnected";

export function PlexoConnectionStatus() {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    fetch("/api/health/plexo")
      .then((r) => r.json())
      .then((d: { connected?: boolean }) => setStatus(d.connected ? "connected" : "disconnected"))
      .catch(() => setStatus("disconnected"));
  }, []);

  if (status === "loading") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Plexo…</span>
      </div>
    );
  }

  return (
    <div
      className={[
        "flex items-center gap-1.5 text-xs rounded-md px-2 py-1",
        status === "connected"
          ? "text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-950/30"
          : "text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-950/30",
      ].join(" ")}
    >
      {status === "connected" ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <AlertCircle className="h-3 w-3" />
      )}
      <span>
        {status === "connected" ? "Plexo connected" : "Plexo offline"}
      </span>
    </div>
  );
}
