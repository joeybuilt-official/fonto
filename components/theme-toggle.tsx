"use client";

import { Sun, Monitor, Moon } from "lucide-react";
import { useTheme, type Theme } from "@/components/theme-provider";

const modes: { value: Theme; Icon: typeof Sun; label: string }[] = [
  { value: "light", Icon: Sun, label: "Light" },
  { value: "system", Icon: Monitor, label: "System" },
  { value: "dark", Icon: Moon, label: "Dark" },
];

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className={`inline-flex items-center gap-0.5 rounded bg-secondary p-0.5 ${className}`}
    >
      {modes.map(({ value, Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          aria-label={label}
          title={label}
          className={`rounded p-1.5 transition-colors ${
            theme === value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
