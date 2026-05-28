// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 (UX consolidation) — Explore hub.
//
// Auto-derived discovery surface. Three tiles fan out to existing
// discovery routes:
//
//   People → /app/people (face clusters; Phase 5.1)
//   Places → /app/map    (geo-tagged photos; Phase 5.2)
//   Things → /app/explore/things (placeholder in v1)
//
// Per ADR 0004 the consolidation collapses three sidebar entries
// (People, Map, ?Things) into one Explore entry. The CLIP-class
// recon (2026-05-27) found only 1 of 8 classifications cleared
// the ≥10-member threshold needed for Things-as-tiles in v1, so
// the Things tile ships as a "coming soon" placeholder and the
// route renders a real explainer page. Phase 4.1 follow-up will
// graduate Things to a live class-grid once the corpus grows and
// the CLIP zero-shot path (currently 100% LLM-fallback) is fixed.
//
// People + Places tiles try to surface a count where the existing
// endpoint provides one cheaply; either tile gracefully renders
// without a count if the fetch fails. No N+1 — one fetch per tile,
// fired in parallel on mount.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users, Map as MapIcon, Sparkles, Compass, ArrowRight } from "lucide-react";

interface TileDef {
  href: string;
  label: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Class tint applied to the icon chip. */
  accent: string;
  /** Optional "coming soon" / disabled flag — Things in v1. */
  placeholder?: boolean;
  /** Optional async loader producing a count label rendered as a pill. */
  countLoader?: () => Promise<number | null>;
}

async function loadPersonsCount(): Promise<number | null> {
  try {
    const r = await fetch("/api/v1/persons");
    if (!r.ok) return null;
    const d = (await r.json()) as { persons?: { id: string }[] };
    return Array.isArray(d.persons) ? d.persons.length : null;
  } catch {
    return null;
  }
}

async function loadPlacesCount(): Promise<number | null> {
  // Map endpoint is `/api/v1/assets?hasGeo=1` historically; if unavailable
  // the tile just hides its count chip. Read-only probe.
  try {
    const r = await fetch("/api/v1/assets?hasGeo=1&limit=1");
    if (!r.ok) return null;
    const d = (await r.json()) as { total?: number; assets?: unknown[] };
    if (typeof d.total === "number") return d.total;
    return Array.isArray(d.assets) ? d.assets.length : null;
  } catch {
    return null;
  }
}

const TILES: TileDef[] = [
  {
    href: "/app/people",
    label: "People",
    subtitle: "Faces grouped into clusters across your library.",
    icon: Users,
    accent: "bg-blue-500/10 text-blue-500",
    countLoader: loadPersonsCount,
  },
  {
    href: "/app/map",
    label: "Places",
    subtitle: "Geo-tagged photos plotted on a map.",
    icon: MapIcon,
    accent: "bg-emerald-500/10 text-emerald-500",
    countLoader: loadPlacesCount,
  },
  {
    href: "/app/explore/things",
    label: "Things",
    subtitle: "Browse by what's in your photos — auto-classified.",
    icon: Sparkles,
    accent: "bg-amber-500/10 text-amber-500",
    placeholder: true,
  },
];

function ExploreTile({ tile }: { tile: TileDef }) {
  const [count, setCount] = useState<number | null>(null);
  const Icon = tile.icon;

  useEffect(() => {
    if (!tile.countLoader) return;
    let cancelled = false;
    void (async () => {
      const n = await tile.countLoader!();
      if (!cancelled) setCount(n);
    })();
    return () => {
      cancelled = true;
    };
  }, [tile]);

  return (
    <Link
      href={tile.href}
      className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-5 hover:border-primary/40 hover:shadow-md transition-all"
      aria-label={tile.label}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${tile.accent}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        {tile.placeholder ? (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
            Coming soon
          </span>
        ) : (
          count != null && (
            <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
              {count.toLocaleString()}
            </span>
          )
        )}
      </div>

      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground group-hover:text-primary transition-colors">
          {tile.label}
        </p>
        <p className="text-sm text-muted-foreground">{tile.subtitle}</p>
      </div>

      <div className="mt-1 flex items-center gap-1 text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
        Open
        <ArrowRight className="h-3 w-3" />
      </div>
    </Link>
  );
}

export default function ExplorePage() {
  return (
    <div className="space-y-6 px-4 py-4">
      <div className="flex items-center gap-3">
        <Compass className="h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Explore</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Auto-derived discovery — surfaces that organise your library
            without you having to tag anything.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((t) => (
          <ExploreTile key={t.href} tile={t} />
        ))}
      </div>
    </div>
  );
}
