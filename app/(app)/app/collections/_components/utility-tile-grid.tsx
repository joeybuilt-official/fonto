"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Star, Trash2, Smartphone, Archive, FileText } from "lucide-react";

interface Counts {
  favorites: number;
  trash: number;
  screenshots: number;
  archived: number;
  documents: number;
}

const TILES = [
  {
    key: "favorites" as const,
    label: "Favorites",
    icon: Star,
    href: "/app/library?favorite=1",
    iconClass: "text-yellow-500",
  },
  {
    key: "trash" as const,
    label: "Trash",
    icon: Trash2,
    href: "/app/library?lifecycle=trashed",
    iconClass: "text-red-500",
  },
  {
    key: "screenshots" as const,
    label: "Screenshots",
    icon: Smartphone,
    href: "/app/library?kind=screenshot",
    iconClass: "text-blue-500",
  },
  {
    key: "archived" as const,
    label: "Archive",
    icon: Archive,
    href: "/app/library?lifecycle=archived",
    iconClass: "text-muted-foreground",
  },
  {
    key: "documents" as const,
    label: "Documents",
    icon: FileText,
    href: "/app/library?kind=document",
    iconClass: "text-green-500",
  },
] as const;

function fmt(n: number): string {
  return n >= 1_000 ? `${Math.floor(n / 1_000)}k` : String(n);
}

export function UtilityTileGrid() {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    fetch("/api/v1/collections/stats")
      .then((r) => r.json())
      .then((d: Counts) => setCounts(d))
      .catch(() => {});
  }, []);

  return (
    <div
      role="list"
      aria-label="Quick access collections"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3"
    >
      {TILES.map(({ key, label, icon: Icon, href, iconClass }) => {
        const n = counts?.[key];
        return (
          <Link
            key={key}
            href={href}
            role="listitem"
            aria-label={n != null ? `${label}, ${fmt(n)} items` : label}
            className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:bg-accent"
          >
            <Icon className={`size-5 shrink-0 ${iconClass}`} aria-hidden />
            <span className="flex-1 text-sm font-medium text-foreground">{label}</span>
            {n != null && (
              <span className="tabular-nums text-xs text-muted-foreground">{fmt(n)}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
