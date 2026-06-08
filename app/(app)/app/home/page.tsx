// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-1 — /app/home landing page.
//
// Audit §4 calls for a real Home (stats, memory of day, quick-jump
// tiles) separated from the Inbox (upload + recent + queue, which
// stays at /app/dashboard for now). This page is presentational over
// /api/v1/stats and the existing MemoryCard component; it carries no
// upload UI so the action bar stays uncluttered.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Calendar,
  Clock,
  FileText,
  FolderTree,
  Heart,
  Image as ImageIcon,
  Inbox,
  Layers,
  Map as MapIcon,
  Search,
  Sparkles,
  TrendingUp,
  Users,
  Video,
} from "lucide-react";
import { MemoryCard } from "../_components/memory-card";

interface Stats {
  total: number;
  images: number;
  documents: number;
  videos: number;
  other: number;
  favorites: number;
  thisMonth: number;
}

const QUICK_JUMP: Array<{
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
}> = [
  { href: "/app/library?mime=image%2F", label: "Photos", icon: ImageIcon, hint: "Browse the grid" },
  { href: "/app/library", label: "Timeline", icon: Clock, hint: "Chronological" },
  { href: "/app/memories", label: "Memories", icon: Sparkles, hint: "On this day" },
  { href: "/app/map", label: "Map", icon: MapIcon, hint: "Geo-tagged photos" },
  { href: "/app/library?pathPrefix=/", label: "Folders", icon: FolderTree, hint: "Browse by folder" },
  { href: "/app/people", label: "People", icon: Users, hint: "Face clusters" },
  { href: "/app/library?mime=application%2F", label: "Documents", icon: FileText, hint: "PDFs + text" },
  { href: "/app/collections?tab=stacks", label: "Stacks", icon: Layers, hint: "Bursts + RAW pairs" },
  { href: "/app/search", label: "Search", icon: Search, hint: "Find anything" },
  { href: "/app/updates?section=uploads", label: "Inbox", icon: Inbox, hint: "Upload + recent" },
];

function StatTile({
  label,
  value,
  icon: Icon,
  href,
  accent,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
  accent?: string;
}) {
  const inner = (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 hover:bg-muted/30 transition-colors">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
          accent ?? "bg-primary/10 text-primary"
        }`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-2xl font-semibold tabular-nums text-foreground">
          {value.toLocaleString()}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export default function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/v1/stats");
        if (r.ok) setStats((await r.json()) as Stats);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-6 px-4 py-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-foreground">
          Home
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Your library at a glance.
        </p>
      </div>

      {/* Stats grid */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Library
        </h2>
        {loading || !stats ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-20 rounded-lg border border-border bg-card animate-pulse"
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile
              label="Total"
              value={stats.total}
              icon={TrendingUp}
              href="/app/library"
            />
            <StatTile
              label="Photos"
              value={stats.images}
              icon={ImageIcon}
              href="/app/library?mime=image%2F"
              accent="bg-blue-500/10 text-blue-500"
            />
            <StatTile
              label="Documents"
              value={stats.documents}
              icon={FileText}
              href="/app/library?mime=application%2F"
              accent="bg-orange-500/10 text-orange-500"
            />
            <StatTile
              label="Videos"
              value={stats.videos}
              icon={Video}
              accent="bg-purple-500/10 text-purple-500"
            />
            <StatTile
              label="Favorites"
              value={stats.favorites}
              icon={Heart}
              accent="bg-pink-500/10 text-pink-500"
            />
            <StatTile
              label="This month"
              value={stats.thisMonth}
              icon={Calendar}
              accent="bg-green-500/10 text-green-500"
            />
          </div>
        )}
      </section>

      {/* Memory of the day */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          On this day
        </h2>
        <MemoryCard />
      </section>

      {/* Quick-jump nav */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Jump to
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {QUICK_JUMP.map((q) => (
            <Link
              key={q.href}
              href={q.href}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-muted/30"
            >
              <q.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{q.label}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {q.hint}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
