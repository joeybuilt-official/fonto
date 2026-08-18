// SPDX-License-Identifier: MIT
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
//
// MD3 migration (ADR 0009, Phase 2): tile cards adopt the MD3 Card
// (outlined). Accent chips reuse tonal containers (tertiary/secondary
// /primary) so we don't introduce new hex literals.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users, Map as MapIcon, Sparkles, Compass, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";

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
  // Count distinct PLACES (matches the Places grid), not geo-tagged assets.
  try {
    const r = await fetch("/api/v1/assets/places");
    if (!r.ok) return null;
    const d = (await r.json()) as { places?: unknown[] };
    return Array.isArray(d.places) ? d.places.length : null;
  } catch {
    return null;
  }
}

async function loadThingsCount(): Promise<number | null> {
  try {
    const r = await fetch("/api/v1/tags/top?limit=100");
    if (!r.ok) return null;
    const d = (await r.json()) as { tags?: unknown[] };
    return Array.isArray(d.tags) ? d.tags.length : null;
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
    accent: "bg-[var(--ft-color-tertiary-container)] text-[var(--ft-color-on-tertiary-container)]",
    countLoader: loadPersonsCount,
  },
  {
    href: "/app/explore/places",
    label: "Places",
    subtitle: "Photos grouped by where they were taken.",
    icon: MapIcon,
    accent: "bg-[var(--ft-color-success-container)] text-[var(--ft-color-on-success-container)]",
    countLoader: loadPlacesCount,
  },
  {
    href: "/app/explore/things",
    label: "Things",
    subtitle: "Browse by what's in your photos — auto-detected objects & scenes.",
    icon: Sparkles,
    accent: "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]",
    countLoader: loadThingsCount,
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
    <Link href={tile.href} className="group block">
      <Card
        variant="outlined"
        className="flex flex-col gap-3 p-5 transition-all hover:border-[var(--ft-color-primary)] hover:shadow-[var(--ft-elev-2)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--ft-shape-medium)] ${tile.accent}`}
          >
            <Icon className="h-5 w-5" />
          </div>
          {tile.placeholder ? (
            <span className="rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-secondary-container)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--ft-color-on-secondary-container)]">
              Coming soon
            </span>
          ) : (
            count != null && (
              <span className="rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)] px-2 py-0.5 text-xs text-[var(--ft-color-on-surface-variant)]">
                {count.toLocaleString()}
              </span>
            )
          )}
        </div>

        <div className="space-y-1">
          <p className="text-base font-semibold text-[var(--ft-color-on-surface)] transition-colors group-hover:text-[var(--ft-color-primary-text)]">
            {tile.label}
          </p>
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">{tile.subtitle}</p>
        </div>

        <div className="mt-1 flex items-center gap-1 text-xs font-medium text-[var(--ft-color-primary-text)] opacity-0 transition-opacity group-hover:opacity-100">
          Open
          <ArrowRight className="h-3 w-3" />
        </div>
      </Card>
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
