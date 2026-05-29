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
      className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-muted/30"
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
          <TagIcon className="h-8 w-8 text-muted-foreground/40" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
        <p className="truncate text-sm font-medium capitalize text-white">{tag.name}</p>
        <p className="text-[11px] text-white/70">{tag.count}</p>
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
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
          <Sparkles className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">Things</h1>
          <p className="text-sm text-muted-foreground">
            Browse your library by what&apos;s in it — objects, scenes, and
            concepts detected automatically, plus your own tags.
          </p>
        </div>
      </div>

      {tags === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : tags.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No labels yet. As your photos are processed, detected objects and
            scenes show up here automatically.
          </p>
        </div>
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
