// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0009 Phase 2 (group C) — three sun/monitor/moon mode picker
// rebuilt on `<Button variant="text">`. Active mode lifts to
// `variant="tonal"` so it picks up secondary-container fill (the MD3
// "selected" surface) instead of the legacy `--primary` background.
// Theme-provider behaviour is unchanged — presentation only.
"use client";

import { Sun, Monitor, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme, type Theme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

const modes: { value: Theme; Icon: typeof Sun; label: string }[] = [
  { value: "light", Icon: Sun, label: "Light" },
  { value: "system", Icon: Monitor, label: "System" },
  { value: "dark", Icon: Moon, label: "Dark" },
];

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[var(--ft-shape-full)] bg-[var(--ft-color-surface-container-low)] p-0.5",
        className,
      )}
    >
      {modes.map(({ value, Icon, label }) => (
        <Button
          key={value}
          variant={theme === value ? "tonal" : "text"}
          size="icon-sm"
          onClick={() => setTheme(value)}
          aria-label={label}
          aria-pressed={theme === value}
          title={label}
        >
          <Icon className="h-3.5 w-3.5" />
        </Button>
      ))}
    </div>
  );
}
