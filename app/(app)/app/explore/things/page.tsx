// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 (UX consolidation) — "Things" placeholder.
//
// The full Things surface is a class-tile grid built from
// `assets.classification` + `assets.sub_classification` (Phase 4.6
// zero-shot CLIP). The 2026-05-27 recon found:
//
//   - 8 distinct top-level classes, only 1 (≥10 members) clearing
//     the threshold the design assumed (n=40 corpus).
//   - 100% of rows fell back to LLM classification — the CLIP
//     zero-shot path is producing zero confident hits, so the
//     classify_method column is "llm-fallback" everywhere.
//   - sub_classification is null across the entire table.
//
// Shipping a class-tile grid against that distribution would be
// a poor first impression (one giant "photo" tile + seven
// near-empty tiles). So Phase 4 v1 surfaces this explainer page
// instead and Phase 4.1 graduates it once the corpus grows + the
// CLIP confidence threshold is tuned.
//
// This route deliberately has no client-side fetch — it's a
// purely-static placeholder so it costs nothing to serve and
// won't generate spurious API load while the feature waits.

import Link from "next/link";
import { Sparkles, ArrowLeft, Search, FolderTree, Zap } from "lucide-react";

export default function ExploreThingsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
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
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">Things</h1>
          <p className="text-sm text-muted-foreground">
            Browse your library by what&apos;s in it — receipts, sunsets,
            screenshots, contracts, and other auto-classified categories.
            We&apos;ll surface these as tiles once your library has enough
            assets for the classifier to find clear groupings.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-sm font-medium text-foreground">
          Coming soon
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Today&apos;s classification model needs a larger sample to produce
          stable category tiles. Keep uploading — once the dataset reaches
          the threshold, Things will populate automatically with no
          action needed from you.
        </p>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-foreground">
          What you can do today
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link
            href="/app/search"
            className="group rounded-lg border border-border bg-card p-3 hover:border-primary/40 transition-colors"
          >
            <Search className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            <p className="mt-2 text-sm font-medium text-foreground">Search</p>
            <p className="text-xs text-muted-foreground">
              Visual + text search across descriptions and OCR.
            </p>
          </Link>
          <Link
            href="/app/library?type=document"
            className="group rounded-lg border border-border bg-card p-3 hover:border-primary/40 transition-colors"
          >
            <FolderTree className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            <p className="mt-2 text-sm font-medium text-foreground">Library chips</p>
            <p className="text-xs text-muted-foreground">
              Filter the unified Library by mime, classification, or folder.
            </p>
          </Link>
          <Link
            href="/app/collections?tab=smart"
            className="group rounded-lg border border-border bg-card p-3 hover:border-primary/40 transition-colors"
          >
            <Zap className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            <p className="mt-2 text-sm font-medium text-foreground">Smart Collections</p>
            <p className="text-xs text-muted-foreground">
              Save a CLIP / facet query as a permanent virtual grouping.
            </p>
          </Link>
        </div>
      </div>
    </div>
  );
}
