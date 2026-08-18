// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// MD3 migration (ADR 0009, Phase 2 — app chrome). The three-mode toggle
// renders as MD3 `text` Buttons with the active mode flipped to the
// `tonal` variant (secondary-container pill) so selection reads at a
// glance without hex literals. Layout container uses
// surface-container-highest as a low-elevation segmented backdrop per
// MD3 segmented-button guidance.
"use client";

import { Sun, Monitor, Moon } from "lucide-react";
import { useTheme, type Theme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const modes: { value: Theme; Icon: typeof Sun; label: string }[] = [
  { value: "light", Icon: Sun, label: "Light" },
  { value: "system", Icon: Monitor, label: "System" },
  { value: "dark", Icon: Moon, label: "Dark" },
];

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme, mounted } = useTheme();

  return (
    <div
      className={cn(
        "inline-flex items-center gap-[var(--ft-space-1)] rounded-[var(--ft-shape-full)] bg-[var(--ft-color-surface-container-highest)] p-[var(--ft-space-1)]",
        className,
      )}
    >
      {modes.map(({ value, Icon, label }) => {
        // Until mounted, render no active pill so SSR and the first client
        // render agree (server can't read localStorage). Post-mount the real
        // selection lights up.
        const active = mounted && theme === value;
        return (
          <Button
            key={value}
            variant={active ? "tonal" : "text"}
            size="icon-sm"
            onClick={() => setTheme(value)}
            aria-label={label}
            aria-pressed={active}
            title={label}
            className={cn(
              "size-7",
              !active && "text-[var(--ft-color-on-surface-variant)]",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </Button>
        );
      })}
    </div>
  );
}
