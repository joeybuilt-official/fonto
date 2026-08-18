// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-1 — /app/home landing page.
//
// Audit §4 calls for a real Home (stats, memory of day, a small set of
// discovery links for destinations without a sidebar entry) separated
// from the Inbox (upload + recent + queue). This page is presentational
// over /api/v1/stats and the existing MemoryCard component. When the
// library is empty it collapses to a single "add your photos" onboarding
// card; otherwise it carries no upload UI so the action bar stays clean.
//
// MD3 migration (ADR 0009, Phase 2): tiles use the MD3 Card primitive
// (outlined variant) and reach for the --ft-* surface roles. Accent
// chips on stats remain hard-coded chart-style colors via `--ft-color-*`
// containers where MD3 has a role; the Photos/Documents/Videos etc.
// chips reuse tertiary/primary/secondary containers as a starting
// hint set so we don't introduce new hex literals.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ListErrorState } from "../_components/list-states";
import {
  Calendar,
  FileText,
  Heart,
  Image as ImageIcon,
  Layers,
  Map as MapIcon,
  Sparkles,
  TrendingUp,
  Upload,
  Users,
  Video,
} from "lucide-react";
import { MemoryCard } from "../_components/memory-card";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Stats {
  total: number;
  images: number;
  documents: number;
  videos: number;
  other: number;
  favorites: number;
  thisMonth: number;
}

// Discovery destinations that are NOT already a primary sidebar entry —
// Memories / Map / People / Stacks have no top-level nav row, so Home is
// where they get surfaced. The old grid also duplicated Photos / Timeline /
// Documents / Folders / Search / Inbox (all reachable from the sidebar);
// those were dropped so Home stops being a link-farm mirror of the nav.
const DISCOVER: Array<{
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
}> = [
  { href: "/app/memories", label: "Memories", icon: Sparkles, hint: "On this day" },
  { href: "/app/map", label: "Map", icon: MapIcon, hint: "Geo-tagged photos" },
  { href: "/app/people", label: "People", icon: Users, hint: "Face clusters" },
  { href: "/app/collections?tab=stacks", label: "Stacks", icon: Layers, hint: "Bursts + RAW pairs" },
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
    <Card
      variant="outlined"
      className="flex flex-row items-start gap-3 p-4 transition-colors hover:bg-[var(--ft-color-surface-container-low)]"
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ft-shape-small)] ${
          accent ?? "bg-[var(--ft-color-primary-container)] text-[var(--ft-color-on-primary-container)]"
        }`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-2xl font-semibold tabular-nums text-[var(--ft-color-on-surface)]">
          {value.toLocaleString()}
        </p>
        <p className="text-xs text-[var(--ft-color-on-surface-variant)]">{label}</p>
      </div>
    </Card>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export default function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const r = await fetch("/api/v1/stats");
      if (!r.ok) throw new Error(`stats ${r.status}`);
      setStats((await r.json()) as Stats);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  // First-run: library loaded successfully but is empty. Replace the wall of
  // zero stat tiles + discovery links (all dead ends with no content behind
  // them) with a single focused "add your photos" card — the primary
  // onboarding action.
  const isEmpty = !loading && !error && stats?.total === 0;

  if (isEmpty) {
    return (
      <div className="space-y-6 px-4 py-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">
            Welcome to fonto
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Your library is empty. Add your photos to get started.
          </p>
        </div>
        <Card
          variant="filled"
          className="flex flex-col items-center gap-[var(--ft-space-4)] px-[var(--ft-space-6)] py-[var(--ft-space-10)] text-center"
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-[var(--ft-shape-large)] bg-[var(--ft-color-primary-container)] text-[var(--ft-color-on-primary-container)]">
            <ImageIcon className="h-8 w-8" />
          </div>
          <div className="space-y-1">
            <p className="text-[length:var(--ft-type-title-medium-size)] font-medium leading-[var(--ft-type-title-medium-line)] text-[var(--ft-color-on-surface)]">
              Add your photos
            </p>
            <p className="max-w-md text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              Upload directly from this device, or import your existing
              library from Google Photos or Amazon Photos.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-[var(--ft-space-2)]">
            <Button variant="filled" render={<Link href="/app/updates?section=uploads" />}>
              <Upload className="h-4 w-4" />
              Upload photos
            </Button>
            <Button variant="outlined" render={<Link href="/app/imports" />}>
              Import from Google or Amazon
            </Button>
          </div>
        </Card>
      </div>
    );
  }

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
        {error ? (
          <ListErrorState
            message="Couldn't load your library stats. Check your connection and retry."
            onRetry={() => void loadStats()}
          />
        ) : loading || !stats ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-20 rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)] animate-pulse"
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
              href="/app/library?kind=moment"
              accent="bg-[var(--ft-color-tertiary-container)] text-[var(--ft-color-on-tertiary-container)]"
            />
            <StatTile
              label="Documents"
              value={stats.documents}
              icon={FileText}
              href="/app/library?kind=document"
              accent="bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
            />
            <StatTile
              label="Videos"
              value={stats.videos}
              icon={Video}
              accent="bg-[var(--ft-color-primary-container)] text-[var(--ft-color-on-primary-container)]"
            />
            <StatTile
              label="Favorites"
              value={stats.favorites}
              icon={Heart}
              accent="bg-[var(--ft-color-error-container)] text-[var(--ft-color-on-error-container)]"
            />
            <StatTile
              label="This month"
              value={stats.thisMonth}
              icon={Calendar}
              accent="bg-[var(--ft-color-success-container)] text-[var(--ft-color-on-success-container)]"
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

      {/* Discovery destinations without a top-level sidebar entry */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Discover
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {DISCOVER.map((q) => (
            <Link key={q.href} href={q.href}>
              <Card
                variant="outlined"
                className="flex flex-row items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--ft-color-surface-container-low)]"
              >
                <q.icon className="h-4 w-4 shrink-0 text-[var(--ft-color-on-surface-variant)]" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--ft-color-on-surface)]">{q.label}</p>
                  <p className="truncate text-[11px] text-[var(--ft-color-on-surface-variant)]">
                    {q.hint}
                  </p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
