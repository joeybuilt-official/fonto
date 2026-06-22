// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Tidy Up — consumer-facing client island for the reconciliation review queue.
// Same data contract as the retired admin client: GET /api/admin/review-queue
// (lanes), POST /api/v1/assets/urls (thumbs, "thumb"), POST
// /api/admin/review-queue/confirm (actions). All admin vocabulary (lane, gate,
// candidate, canonical, commit, SSIM, confidence, quarantine, cluster,
// conflict) is translated to plain language in the UI.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  X,
  Sparkles,
  CalendarClock,
  Copy,
  Users,
  ChevronDown,
  RotateCcw,
  FileQuestion,
  Layers,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Card, CardContent } from "@/components/ui/card";

type Decision = "auto-commit" | "review" | "leave";

interface DateItem {
  assetId: string;
  filename: string;
  capturedAt: string | null;
  mapEstimate: string | null;
  mapPrecision: string | null;
  ciLow: string | null;
  ciHigh: string | null;
  confidence: number;
  conflict: boolean;
  reasons: string[];
}

interface VariantGroup {
  groupId: string;
  canonicalAssetId: string;
  canonicalScore: number;
  confidence: number;
  decision: Decision;
  trashCandidates: { assetId: string; ssim: number }[];
  keptDistinct: string[];
}

interface IdentityCluster {
  personId: string;
  instanceCount: number;
  coverFaceId: string | null;
}

interface QueueResponse {
  workspaceId: string;
  date: {
    review: DateItem[];
    counts: { review: number; autoCommit: number; leave: number };
  };
  variant: { count: number; groups: VariantGroup[] };
  identity: { clusters: IdentityCluster[] };
}

interface VariantBatchResponse {
  groups: VariantGroup[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

const VARIANT_PAGE_SIZE = 6;

type Section = "date" | "variant" | "identity";

// "Taken March 2024" — the headline phrasing. Precision narrows it to a year
// or month when that's all the estimate supports.
function fmtTaken(d: string | null, precision?: string | null): string {
  if (!d) return "around an unknown time";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "an unknown time";
  if (precision === "year") {
    return String(date.getUTCFullYear());
  }
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtFiled(d: string | null): string {
  if (!d) return "no date";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "no date";
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Thumb({
  url,
  alt,
  className,
}: {
  url?: string;
  alt: string;
  className?: string;
}) {
  if (!url) {
    return (
      <div
        className={`flex items-center justify-center bg-[var(--ft-color-surface-container-highest)] text-[length:var(--ft-type-label-small-size)] text-[var(--ft-color-on-surface-variant)] ${className ?? ""}`}
      >
        …
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={url}
      alt={alt}
      className={`object-cover ${className ?? ""}`}
      loading="lazy"
      decoding="async"
    />
  );
}

export function TidyUpClient(): React.ReactElement {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<Section>("date");
  const [toast, setToast] = useState<string | null>(null);
  // Aggregator hub — counts for the queues that live on OTHER surfaces, so this
  // page is the single "needs attention" overview. Unsorted = unclassified
  // (kind IS NULL) library assets; Stacks = AI stack suggestions. Both deep-link
  // out to their native surface. See plans/photos-vs-files-split.
  const [unsortedCount, setUnsortedCount] = useState(0);
  const [stackCount, setStackCount] = useState(0);

  // Variant lane is fetched lazily + paged (the SSIM manifest build is the slow
  // tail), so it lives in its own state rather than on `data`.
  const [variantGroupsState, setVariantGroupsState] = useState<VariantGroup[]>([]);
  const [variantOffset, setVariantOffset] = useState(0);
  const [variantHasMore, setVariantHasMore] = useState(false);
  const [variantLoading, setVariantLoading] = useState(false);
  const [variantLoaded, setVariantLoaded] = useState(false);

  // Optimistically removed ids so an actioned card vanishes before the refetch
  // lands. Cleared on every successful load.
  const [hiddenDates, setHiddenDates] = useState<Set<string>>(new Set());
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  // Merge a fresh batch of thumbnail URLs in for the given asset ids.
  const fetchThumbs = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      const ures = await fetch("/api/v1/assets/urls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, variant: "thumb" }),
      });
      if (ures.ok) {
        const ujson = (await ures.json()) as { urls?: Record<string, string> };
        if (ujson.urls) setUrls((prev) => ({ ...prev, ...ujson.urls }));
      }
    } catch {
      // Thumbs are best-effort; the card renders a placeholder without them.
    }
  }, []);

  // The main feed: fast SQL only (dates + identity + the variant COUNT). The
  // variant manifests are NOT here anymore — they load lazily below.
  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/review-queue", { cache: "no-store" });
      if (!res.ok) {
        setError("We couldn't load your suggestions just now. Try again?");
        return;
      }
      const json = (await res.json()) as QueueResponse;
      setData(json);
      setHiddenDates(new Set());
      setHiddenGroups(new Set());

      const dateIds = json.date.review.map((d) => d.assetId);
      await fetchThumbs(dateIds);
    } catch {
      setError("We couldn't reach the server. Check your connection and retry.");
    }
  }, [fetchThumbs]);

  // Fetch one page of variant manifests. `reset` starts from offset 0 and
  // replaces the list (used on first open / after an action refetch); otherwise
  // it appends the next page ("Show more look-alikes").
  const loadVariantBatch = useCallback(
    async (reset: boolean) => {
      setVariantLoading(true);
      const offset = reset ? 0 : variantOffset;
      try {
        const res = await fetch(
          `/api/admin/review-queue/variants?limit=${VARIANT_PAGE_SIZE}&offset=${offset}`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          showToast("We couldn't load the look-alikes just now. Try again?");
          return;
        }
        const json = (await res.json()) as VariantBatchResponse;
        setVariantGroupsState((prev) =>
          reset ? json.groups : [...prev, ...json.groups]
        );
        setVariantOffset(json.offset + json.limit);
        setVariantHasMore(json.hasMore);
        setVariantLoaded(true);

        const ids: string[] = [];
        json.groups.forEach((g) => {
          ids.push(g.canonicalAssetId);
          g.trashCandidates.forEach((c) => ids.push(c.assetId));
        });
        await fetchThumbs(ids);
      } catch {
        showToast("We lost the connection loading look-alikes — please retry.");
      } finally {
        setVariantLoading(false);
      }
    },
    [variantOffset, fetchThumbs, showToast]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Off-page queue counts for the attention summary (best-effort, parallel).
  useEffect(() => {
    let alive = true;
    fetch("/api/v1/assets/buckets?unclassified=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { buckets: [] }))
      .then((d: { buckets?: { count: number }[] }) => {
        if (alive) setUnsortedCount((d.buckets ?? []).reduce((s, b) => s + b.count, 0));
      })
      .catch(() => {});
    fetch("/api/v1/stacks/suggestions", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { suggestions?: unknown[] } | unknown[] | null) => {
        if (!alive || !d) return;
        const n = Array.isArray(d)
          ? d.length
          : Array.isArray((d as { suggestions?: unknown[] }).suggestions)
            ? (d as { suggestions: unknown[] }).suggestions.length
            : 0;
        setStackCount(n);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // First time the operator opens the look-alikes chip, pull the first batch.
  useEffect(() => {
    if (section === "variant" && !variantLoaded && !variantLoading) {
      void loadVariantBatch(true);
    }
  }, [section, variantLoaded, variantLoading, loadVariantBatch]);

  const submit = useCallback(
    async (
      payload: {
        date?: { assetId: string; action: "confirm" | "reject" | "quarantine" }[];
        variant?: { groupId: string; action: "commit" }[];
      },
      optimistic: { dates?: string[]; groups?: string[] },
      successMsg: (r: { dateOk: number; varTrash: number }) => string
    ) => {
      setBusy(true);
      // Hide the actioned cards right away.
      if (optimistic.dates?.length) {
        setHiddenDates((prev) => {
          const next = new Set(prev);
          optimistic.dates!.forEach((id) => next.add(id));
          return next;
        });
      }
      if (optimistic.groups?.length) {
        setHiddenGroups((prev) => {
          const next = new Set(prev);
          optimistic.groups!.forEach((id) => next.add(id));
          return next;
        });
      }
      try {
        const res = await fetch("/api/admin/review-queue/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          showToast("That didn't go through. Nothing was changed — please retry.");
          await load();
          return;
        }
        const json = (await res.json()) as {
          date?: { ok: boolean }[];
          variant?: { ok: boolean; trashed: number }[];
        };
        const dateOk = (json.date ?? []).filter((r) => r.ok).length;
        const varTrash = (json.variant ?? []).reduce(
          (a, r) => a + (r.ok ? r.trashed : 0),
          0
        );
        showToast(successMsg({ dateOk, varTrash }));
        await load();
      } catch {
        showToast("We lost the connection. Nothing was changed — please retry.");
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load, showToast]
  );

  const dateItems = useMemo(
    () => (data?.date.review ?? []).filter((d) => !hiddenDates.has(d.assetId)),
    [data, hiddenDates]
  );
  const variantGroups = useMemo(
    () => variantGroupsState.filter((g) => !hiddenGroups.has(g.groupId)),
    [variantGroupsState, hiddenGroups]
  );
  const clusters = data?.identity.clusters ?? [];

  // The chip shows the server's candidate COUNT (cheap, available immediately)
  // minus anything the operator has already actioned this session, so it stays
  // honest before the SSIM batches stream in.
  const variantCount = useMemo(() => {
    const base = data?.variant.count ?? 0;
    const actioned = hiddenGroups.size;
    return Math.max(0, base - actioned);
  }, [data, hiddenGroups]);

  const counts = useMemo(
    () => ({
      date: dateItems.length,
      variant: variantCount,
      identity: clusters.length,
    }),
    [dateItems, variantCount, clusters]
  );

  const nativeClear =
    !!data && counts.date === 0 && counts.variant === 0 && counts.identity === 0;
  const allClear = nativeClear && unsortedCount === 0 && stackCount === 0;

  return (
    <div>
      <header className="mb-[var(--ft-space-5)]">
        <h1 className="flex items-center gap-[var(--ft-space-2)] text-[length:var(--ft-type-headline-small-size)] leading-[var(--ft-type-headline-small-line)] font-semibold text-[var(--ft-color-on-surface)]">
          <Sparkles className="h-5 w-5 text-[var(--ft-color-primary)]" />
          Tidy Up
        </h1>
        <p className="mt-[var(--ft-space-1)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
          A few things we&apos;d love your eye on. Nothing changes until you say
          so.
        </p>
      </header>

      {error ? (
        <Card variant="outlined">
          <CardContent className="flex flex-col items-start gap-[var(--ft-space-3)]">
            <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              {error}
            </p>
            <Button variant="tonal" onClick={() => void load()}>
              <RotateCcw className="h-4 w-4" />
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : !data ? (
        <LoadingSkeleton />
      ) : (
        <>
          <AttentionSummary unsorted={unsortedCount} stacks={stackCount} />
          {allClear ? (
        <div className="flex flex-col items-center gap-[var(--ft-space-3)] py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]">
            <Check className="h-7 w-7" />
          </span>
          <p className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)] font-medium text-[var(--ft-color-on-surface)]">
            You&apos;re all caught up
          </p>
        </div>
      ) : nativeClear ? (
        <p className="py-10 text-center text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
          Nothing to confirm here — see the items above.
        </p>
      ) : (
        <>
          <div className="-mx-1 mb-[var(--ft-space-5)] flex items-center gap-[var(--ft-space-2)] overflow-x-auto px-1 pb-1">
            <Chip
              variant="filter"
              selected={section === "date"}
              onClick={() => setSection("date")}
            >
              <CalendarClock className="h-4 w-4" />
              Check these dates
              <SectionCount n={counts.date} />
            </Chip>
            <Chip
              variant="filter"
              selected={section === "variant"}
              onClick={() => setSection("variant")}
            >
              <Copy className="h-4 w-4" />
              Tidy up look-alikes
              <SectionCount n={counts.variant} />
            </Chip>
            <Chip
              variant="filter"
              selected={section === "identity"}
              onClick={() => setSection("identity")}
            >
              <Users className="h-4 w-4" />
              Who&apos;s this?
              <SectionCount n={counts.identity} />
            </Chip>
          </div>

          {section === "date" && (
            <DatesSection
              items={dateItems}
              urls={urls}
              busy={busy}
              onAction={(assetId, action) =>
                submit(
                  { date: [{ assetId, action }] },
                  { dates: [assetId] },
                  () => "Updated"
                )
              }
              onBatchConfirm={() =>
                submit(
                  {
                    date: dateItems.map((it) => ({
                      assetId: it.assetId,
                      action: "confirm" as const,
                    })),
                  },
                  { dates: dateItems.map((it) => it.assetId) },
                  ({ dateOk }) =>
                    `Updated ${dateOk} photo${dateOk === 1 ? "" : "s"}`
                )
              }
            />
          )}

          {section === "variant" && (
            <VariantsSection
              groups={variantGroups}
              urls={urls}
              busy={busy}
              loading={variantLoading}
              loaded={variantLoaded}
              hasMore={variantHasMore}
              onShowMore={() => void loadVariantBatch(false)}
              onTidy={(groupId, trashCount) =>
                submit(
                  { variant: [{ groupId, action: "commit" }] },
                  { groups: [groupId] },
                  ({ varTrash }) =>
                    `Tidied — ${varTrash || trashCount} in Trash`
                )
              }
            />
          )}

          {section === "identity" && <IdentitySection clusters={clusters} />}
            </>
          )}
        </>
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-[calc(var(--ft-space-4)+env(safe-area-inset-bottom)+72px)] left-1/2 z-[60] flex w-[min(560px,calc(100vw-2*var(--ft-space-4)))] -translate-x-1/2 items-center gap-[var(--ft-space-3)] rounded-[var(--ft-shape-small)] bg-[var(--ft-color-inverse-surface)] px-[var(--ft-space-4)] py-[var(--ft-space-3)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-inverse-surface)] shadow-[var(--ft-elev-3)] sm:bottom-[var(--ft-space-6)]"
        >
          <Check className="h-5 w-5 shrink-0 text-[var(--ft-color-inverse-primary)]" />
          <span className="flex-1">{toast}</span>
        </div>
      )}
    </div>
  );
}

// Aggregator hub — deep-link cards for queues that live on other surfaces, so
// Review is the single "needs attention" overview. Renders nothing when both
// counts are zero (the native lanes below carry the rest).
function AttentionSummary({
  unsorted,
  stacks,
}: {
  unsorted: number;
  stacks: number;
}) {
  const cards: {
    key: string;
    href: string;
    label: string;
    hint: string;
    n: number;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [];
  if (unsorted > 0)
    cards.push({
      key: "unsorted",
      href: "/app/library?surface=unsorted",
      label: "Unsorted",
      hint: "Waiting to be sorted into Photos or Files",
      n: unsorted,
      icon: FileQuestion,
    });
  if (stacks > 0)
    cards.push({
      key: "stacks",
      href: "/app/collections?tab=stacks",
      label: "Stack suggestions",
      hint: "Group bursts + look-alikes into stacks",
      n: stacks,
      icon: Layers,
    });
  if (cards.length === 0) return null;

  return (
    <div className="mb-[var(--ft-space-5)] space-y-[var(--ft-space-2)]">
      <p className="text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] font-medium uppercase tracking-wide text-[var(--ft-color-on-surface-variant)]">
        Also needs your attention
      </p>
      {cards.map((c) => (
        <Link key={c.key} href={c.href} className="block">
          <Card
            variant="outlined"
            className="flex flex-row items-center gap-[var(--ft-space-3)] p-[var(--ft-space-3)] transition-colors hover:bg-[var(--ft-color-surface-container-low)]"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ft-shape-small)] bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]">
              <c.icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[length:var(--ft-type-title-small-size)] leading-[var(--ft-type-title-small-line)] font-medium text-[var(--ft-color-on-surface)]">
                {c.label}
              </span>
              <span className="block text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                {c.hint}
              </span>
            </span>
            <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-[var(--ft-shape-full)] bg-[var(--ft-color-primary)] px-1.5 text-[length:var(--ft-type-label-small-size)] font-semibold text-[var(--ft-color-on-primary)]">
              {c.n > 99 ? "99+" : c.n}
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ft-color-on-surface-variant)]" />
          </Card>
        </Link>
      ))}
    </div>
  );
}

function SectionCount({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="ml-[var(--ft-space-1)] inline-flex h-5 min-w-5 items-center justify-center rounded-[var(--ft-shape-full)] bg-[color-mix(in_srgb,currentColor_18%,transparent)] px-1.5 text-[length:var(--ft-type-label-small-size)] font-semibold">
      {n}
    </span>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-[var(--ft-space-3)]">
      <div className="flex gap-[var(--ft-space-2)]">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-8 w-32 animate-pulse rounded-[var(--ft-shape-full)] bg-[var(--ft-color-surface-container-highest)]"
          />
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex items-center gap-[var(--ft-space-4)] rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container-low)] p-[var(--ft-space-4)]"
        >
          <div className="h-24 w-24 shrink-0 animate-pulse rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container-highest)]" />
          <div className="flex-1 space-y-[var(--ft-space-2)]">
            <div className="h-5 w-2/3 animate-pulse rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container-highest)]" />
            <div className="h-4 w-1/2 animate-pulse rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container-highest)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function DatesSection({
  items,
  urls,
  busy,
  onAction,
  onBatchConfirm,
}: {
  items: DateItem[];
  urls: Record<string, string>;
  busy: boolean;
  onAction: (assetId: string, action: "confirm" | "reject") => void;
  onBatchConfirm: () => void;
}) {
  if (items.length === 0) {
    return (
      <SectionEmpty text="No dates to double-check right now." />
    );
  }

  return (
    <div className="space-y-[var(--ft-space-3)]">
      {items.map((it) => (
        <DateCard
          key={it.assetId}
          item={it}
          url={urls[it.assetId]}
          busy={busy}
          onAction={onAction}
        />
      ))}

      {items.length > 1 && (
        <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+72px)] z-30 sm:bottom-[var(--ft-space-4)]">
          <Button
            variant="filled"
            size="lg"
            disabled={busy}
            onClick={onBatchConfirm}
            className="w-full justify-center shadow-[var(--ft-elev-2)] sm:w-auto"
          >
            <Check className="h-4 w-4" />
            Looks good — apply to all {items.length}
          </Button>
        </div>
      )}
    </div>
  );
}

function DateCard({
  item,
  url,
  busy,
  onAction,
}: {
  item: DateItem;
  url?: string;
  busy: boolean;
  onAction: (assetId: string, action: "confirm" | "reject") => void;
}) {
  const [showWhy, setShowWhy] = useState(false);
  const taken = fmtTaken(item.mapEstimate, item.mapPrecision);
  const filed = fmtFiled(item.capturedAt);

  return (
    <Card variant="outlined">
      <CardContent className="flex flex-col gap-[var(--ft-space-4)] sm:flex-row sm:items-center">
        <Thumb
          url={url}
          alt={item.filename}
          className="h-24 w-24 shrink-0 self-start rounded-[var(--ft-shape-medium)] sm:self-center"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-[var(--ft-space-2)]">
            <span className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)] font-medium text-[var(--ft-color-on-surface)]">
              Taken {taken}?
            </span>
            {item.conflict && (
              <span className="inline-flex items-center rounded-[var(--ft-shape-full)] bg-[var(--ft-color-tertiary-container,#ffe082)] px-[var(--ft-space-2)] py-0.5 text-[length:var(--ft-type-label-small-size)] font-medium text-[var(--ft-color-on-tertiary-container,#5f4400)]">
                Doesn&apos;t match
              </span>
            )}
          </div>
          <p className="mt-[var(--ft-space-1)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
            Currently filed under {filed}
          </p>
          {item.reasons.length > 0 && (
            <div className="mt-[var(--ft-space-2)]">
              <button
                type="button"
                onClick={() => setShowWhy((v) => !v)}
                className="inline-flex items-center gap-1 text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] font-medium text-[var(--ft-color-primary-text)] hover:underline"
              >
                Why?
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${showWhy ? "rotate-180" : ""}`}
                />
              </button>
              {showWhy && (
                <ul className="mt-[var(--ft-space-1)] list-disc space-y-0.5 pl-5 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                  {item.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-[var(--ft-space-2)] sm:flex-row sm:items-center">
          <Button
            variant="filled"
            disabled={busy}
            onClick={() => onAction(item.assetId, "confirm")}
            className="w-full justify-center sm:w-auto"
          >
            <Check className="h-4 w-4" />
            Yes, that&apos;s right
          </Button>
          <Button
            variant="outlined"
            disabled={busy}
            onClick={() => onAction(item.assetId, "reject")}
            className="w-full justify-center sm:w-auto"
          >
            <X className="h-4 w-4" />
            No, keep it
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function VariantsSection({
  groups,
  urls,
  busy,
  loading,
  loaded,
  hasMore,
  onShowMore,
  onTidy,
}: {
  groups: VariantGroup[];
  urls: Record<string, string>;
  busy: boolean;
  loading: boolean;
  loaded: boolean;
  hasMore: boolean;
  onShowMore: () => void;
  onTidy: (groupId: string, trashCount: number) => void;
}) {
  // First open: nothing fetched yet, manifests are building (the slow SSIM
  // pass). Show a small skeleton instead of the empty state.
  if (!loaded && loading) {
    return <VariantSkeleton />;
  }
  if (loaded && groups.length === 0) {
    return <SectionEmpty text="No look-alikes to tidy right now." />;
  }

  return (
    <div className="space-y-[var(--ft-space-3)]">
      {groups.map((g) => (
        <VariantCard
          key={g.groupId}
          group={g}
          urls={urls}
          busy={busy}
          onTidy={onTidy}
        />
      ))}

      {loading && loaded && <VariantSkeleton />}

      {hasMore && !loading && (
        <Button
          variant="tonal"
          disabled={busy}
          onClick={onShowMore}
          className="w-full justify-center sm:w-auto"
        >
          <Copy className="h-4 w-4" />
          Show more look-alikes
        </Button>
      )}
    </div>
  );
}

function VariantSkeleton() {
  return (
    <div className="space-y-[var(--ft-space-3)]">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container-low)] p-[var(--ft-space-4)]"
        >
          <div className="mb-[var(--ft-space-4)] h-5 w-3/4 animate-pulse rounded-[var(--ft-shape-small)] bg-[var(--ft-color-surface-container-highest)]" />
          <div className="flex gap-[var(--ft-space-4)]">
            <div className="h-28 w-28 animate-pulse rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container-highest)]" />
            <div className="h-20 w-20 animate-pulse rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container-highest)]" />
            <div className="h-20 w-20 animate-pulse rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container-highest)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function VariantCard({
  group,
  urls,
  busy,
  onTidy,
}: {
  group: VariantGroup;
  urls: Record<string, string>;
  busy: boolean;
  onTidy: (groupId: string, trashCount: number) => void;
}) {
  const [hidden, setHidden] = useState(false);
  const canTidy = group.decision === "auto-commit";
  const trashN = group.trashCandidates.length;
  const total = trashN + 1;

  if (hidden) {
    return (
      <Card variant="outlined">
        <CardContent className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
          Left as-is.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card variant="outlined">
      <CardContent className="space-y-[var(--ft-space-4)]">
        <p className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)] font-medium text-[var(--ft-color-on-surface)]">
          Found {total} near-copies.
          {canTidy
            ? ` Keep the best, move ${trashN} to Trash?`
            : " These look distinct — left as-is."}
        </p>

        <div className="flex flex-wrap items-start gap-[var(--ft-space-4)]">
          <figure className="flex flex-col items-center gap-[var(--ft-space-1)]">
            <Thumb
              url={urls[group.canonicalAssetId]}
              alt="the best one"
              className="h-28 w-28 rounded-[var(--ft-shape-medium)] ring-2 ring-[var(--ft-color-primary)]"
            />
            <figcaption className="inline-flex items-center gap-1 rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] px-[var(--ft-space-2)] py-0.5 text-[length:var(--ft-type-label-small-size)] font-medium text-[var(--ft-color-on-secondary-container)]">
              <Check className="h-3 w-3" />
              We&apos;ll keep this one
            </figcaption>
          </figure>

          <div className="flex flex-wrap gap-[var(--ft-space-2)]">
            {group.trashCandidates.map((c) => (
              <div key={c.assetId} className="relative">
                <Thumb
                  url={urls[c.assetId]}
                  alt="near-copy"
                  className="h-20 w-20 rounded-[var(--ft-shape-medium)] opacity-50"
                />
                {canTidy && (
                  <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-[var(--ft-shape-full)] bg-[var(--ft-color-surface)]/90 text-[var(--ft-color-on-surface-variant)] shadow-[var(--ft-elev-1)]">
                    <X className="h-3 w-3" />
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {canTidy ? (
          <>
            <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
              You can restore from Trash anytime.
            </p>
            <div className="flex flex-col gap-[var(--ft-space-2)] sm:flex-row sm:items-center">
              <Button
                variant="filled"
                disabled={busy}
                onClick={() => onTidy(group.groupId, trashN)}
                className="w-full justify-center sm:w-auto"
              >
                <Sparkles className="h-4 w-4" />
                Keep best, tidy the rest
              </Button>
              <Button
                variant="text"
                disabled={busy}
                onClick={() => setHidden(true)}
                className="w-full justify-center sm:w-auto"
              >
                Leave them
              </Button>
            </div>
          </>
        ) : (
          <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
            Looks distinct — left as-is.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function IdentitySection({ clusters }: { clusters: IdentityCluster[] }) {
  if (clusters.length === 0) {
    return <SectionEmpty text="No new faces to identify right now." />;
  }
  return (
    <div>
      <div className="flex flex-wrap gap-[var(--ft-space-4)]">
        {clusters.map((c) => (
          <Link
            key={c.personId}
            href="/app/people"
            className="flex w-28 flex-col items-center gap-[var(--ft-space-2)] text-center"
          >
            <span className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-[var(--ft-shape-full)] bg-[var(--ft-color-surface-container-highest)] text-[var(--ft-color-on-surface-variant)] ring-1 ring-[var(--ft-color-outline-variant)] transition-shadow hover:shadow-[var(--ft-elev-2)]">
              <Users className="h-8 w-8" />
            </span>
            <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
              Seen in {c.instanceCount} photo{c.instanceCount === 1 ? "" : "s"}
            </span>
          </Link>
        ))}
      </div>
      <Link
        href="/app/people"
        className="mt-[var(--ft-space-5)] inline-flex items-center gap-1 text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-primary-text)] hover:underline"
      >
        Manage people
      </Link>
    </div>
  );
}

function SectionEmpty({ text }: { text: string }) {
  return (
    <p className="py-12 text-center text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
      {text}
    </p>
  );
}
