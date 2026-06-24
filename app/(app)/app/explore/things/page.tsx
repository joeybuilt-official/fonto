// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// "Things" — browse the library by auto-detected object/scene labels (and
// user tags). Each tile is a tag with its active-asset count and a sample
// thumbnail; clicking opens the search view filtered to that tag.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, ArrowLeft, Loader2, Tag as TagIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

interface TopTag {
  id: string;
  name: string;
  color: string;
  aiSuggested: boolean;
  count: number;
  sampleAssetId: string | null;
}

function ThingTile({ tag }: { tag: TopTag }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!tag.sampleAssetId) return;
    let alive = true;
    fetch(`/api/v1/assets/${tag.sampleAssetId}/url?variant=thumb`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { url?: string } | null) => {
        if (alive) setThumb(d?.url ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tag.sampleAssetId]);

  return (
    <Link
      href={`/app/search?tagId=${tag.id}`}
      className="group relative aspect-square overflow-hidden rounded-[var(--ft-shape-large)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container)]"
    >
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb}
          alt={tag.name}
          className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <TagIcon className="h-8 w-8 text-[var(--ft-color-on-surface-variant)] opacity-40" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[var(--ft-color-scrim)]/70 to-transparent p-2">
        <p className="truncate text-sm font-medium capitalize text-[var(--ft-color-on-inverse-surface)]">{tag.name}</p>
        <p className="text-[11px] text-[var(--ft-color-on-inverse-surface)]/70">{tag.count}</p>
      </div>
    </Link>
  );
}

export default function ExploreThingsPage() {
  const [tags, setTags] = useState<TopTag[] | null>(null);

  useEffect(() => {
    fetch("/api/v1/tags/top?limit=48")
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d: { tags?: TopTag[] }) => setTags(d.tags ?? []))
      .catch(() => setTags([]));
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <Link
        href="/app/explore"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to Explore
      </Link>

      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]">
          <Sparkles className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">Things</h1>
          <p className="text-sm text-muted-foreground">
            Browse your library by what&apos;s in it — objects, scenes, and
            concepts detected automatically, plus your own tags.
          </p>
          <Link
            href="/app/tags"
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--ft-color-primary-text)] hover:underline"
          >
            <TagIcon className="h-3 w-3" />
            Manage tags
          </Link>
        </div>
      </div>

      {tags === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : tags.length === 0 ? (
        <Card variant="outlined" className="p-6 text-center">
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
            No labels yet. As your photos are processed, detected objects and
            scenes show up here automatically.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {tags.map((t) => (
            <ThingTile key={t.id} tag={t} />
          ))}
        </div>
      )}
    </div>
  );
}
